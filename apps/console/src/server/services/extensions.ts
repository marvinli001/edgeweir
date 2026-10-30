import { createHash, randomBytes } from "node:crypto";
import type { ExtensionModel, SiteModel } from "@edgeweir/config-compiler";
import {
  applyExtensionConfig,
  EXTENSIONS_FEATURE,
  EXTENSIONS_V2_FEATURE,
  type ExtensionConfigSchema,
  type ExtensionDetail,
  type ExtensionKeyView,
  type ExtensionManifest,
  type ExtensionSiteDataItem,
  type ExtensionSummary,
  extensionManifest,
  maskExtensionConfig,
  type NodeExtensionState,
  nodeSupportsFeature,
  type SiteExtensionView,
  unmaskExtensionConfig,
  type VerifiedExtensionPackage,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { registerExtensionFields } from "@edgeweir/rule-engine";
import { type AnyColumn, and, asc, eq, inArray, isNotNull, like, sql } from "drizzle-orm";
import type { Envelope, MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import {
  decodePackage,
  jwkThumbprint,
  parsePublicKey,
  type VerifiedPackage,
  verifyPackage,
} from "../lib/extension-package";
import { assertNodeFeatures } from "../lib/node-features";
import { type Actor, recordAudit } from "./audit";
import { type Executor, publishClusters, type Tx } from "./revisions";
import { publishSiteChange } from "./site-change";

/**
 * Node extensions (docs/reference/extensions.md): the trust store, verified
 * package versions, their operator settings and the sites that turn them on.
 * Every change publishes the clusters whose sites use the extension and is
 * audited in the same transaction.
 */

const SETTINGS_KEY = "extensions";
const LOCK_KEY = 0x65787431; // "ext1": serializes installs, activations and uninstalls.

type ExtensionRow = typeof schema.extension.$inferSelect;
type VersionRow = typeof schema.extensionVersion.$inferSelect;

async function lockExtensions(tx: Tx) {
  await tx.execute(sql`select pg_advisory_xact_lock(${LOCK_KEY})`);
}

const manifestOf = (row: Pick<VersionRow, "manifest">): ExtensionManifest =>
  extensionManifest.parse(row.manifest);

/** The node features an extension needs (Lua API 2: extensions-v2). */
const extensionFeatures = (manifest: ExtensionManifest) =>
  manifest.requires.lua_api >= 2
    ? [EXTENSIONS_FEATURE, EXTENSIONS_V2_FEATURE]
    : [EXTENSIONS_FEATURE];

// ---------------------------------------------------------------------------
// Secrets (manifest `secret: true`, version 1.1)

/** Envelope binding of an extension's secrets: the column and the extension (AAD). */
export const extensionSecretBinding = (id: string) => ({
  purpose: "extension.secret_envelope",
  recordId: id,
});

const SECRET_BYTES = 32;

/** Seals the current secret followed by the previous one (absent before the first rotation). */
function sealSecrets(masterKey: MasterKey, id: string, current: Buffer, previous?: Buffer) {
  return JSON.stringify(
    masterKey.seal(
      previous ? Buffer.concat([current, previous]) : current,
      extensionSecretBinding(id),
    ),
  );
}

function openSecrets(
  masterKey: MasterKey,
  id: string,
  envelope: string,
): { current: Buffer; previous: Buffer | null } {
  const plain = masterKey.open(JSON.parse(envelope) as Envelope, extensionSecretBinding(id));
  return {
    current: plain.subarray(0, SECRET_BYTES),
    previous:
      plain.length >= 2 * SECRET_BYTES ? plain.subarray(SECRET_BYTES, 2 * SECRET_BYTES) : null,
  };
}

/** Generates the secret (version 1) when the active version declares one and none exists. */
async function ensureSecret(tx: Tx, masterKey: MasterKey, id: string, manifest: ExtensionManifest) {
  if (!manifest.secret) return;
  const [row] = await tx
    .select({ envelope: schema.extension.secretEnvelope, version: schema.extension.secretVersion })
    .from(schema.extension)
    .where(eq(schema.extension.id, id));
  if (!row || row.envelope) return;
  await tx
    .update(schema.extension)
    .set({
      secretEnvelope: sealSecrets(masterKey, id, randomBytes(SECRET_BYTES)),
      secretVersion: row.version + 1,
    })
    .where(eq(schema.extension.id, id));
}

const schemaOf = (manifest: ExtensionManifest, scope: "global" | "site") =>
  manifest.config[scope] as ExtensionConfigSchema | undefined;

/**
 * The configuration with defaults filled in, or EXTENSION_CONFIG_INVALID. With
 * `partial` (a disabled extension or site) missing required values pass.
 */
function validConfig(
  manifest: ExtensionManifest,
  scope: "global" | "site",
  value: unknown,
  partial = false,
): Record<string, unknown> {
  const schema = schemaOf(manifest, scope);
  const result = applyExtensionConfig(
    partial && schema ? { ...schema, required: [] } : schema,
    value,
  );
  if (!result.ok) {
    const issue = result.issues[0];
    fail("EXTENSION_CONFIG_INVALID", `invalid ${scope} configuration`, {
      scope,
      path: issue?.path.join(".") ?? "",
      issue: issue?.code ?? "type",
    });
  }
  return result.value;
}

// ---------------------------------------------------------------------------
// Rule fields

/** Registers the rule fields of every installed extension's active version. */
export async function refreshExtensionFields(db: Executor): Promise<void> {
  const rows = await db
    .select({ manifest: schema.extensionVersion.manifest })
    .from(schema.extension)
    .innerJoin(
      schema.extensionVersion,
      and(
        eq(schema.extensionVersion.extensionId, schema.extension.id),
        eq(schema.extensionVersion.version, schema.extension.activeVersion),
      ),
    );
  registerExtensionFields(
    rows.flatMap((row) => {
      const manifest = manifestOf(row);
      return manifest.fields.map(
        (field) =>
          [`ext.${manifest.id}.${field.name}`, field.type] as [
            string,
            "string" | "number" | "boolean",
          ],
      );
    }),
  );
}

/** Rules (site and platform) whose expression mentions one of the extension's fields. */
async function ruleReferences(
  db: Executor,
  id: string,
): Promise<{ name: string; expression: string }[]> {
  return db
    .select({ name: schema.edgeRule.name, expression: schema.edgeRule.expression })
    .from(schema.edgeRule)
    .where(like(schema.edgeRule.expression, `%ext.${id}.%`))
    .orderBy(asc(schema.edgeRule.name));
}

/** Refuses when rules read fields of `id` that `manifest` (null: none) does not provide with the same type. */
async function assertFieldsKept(
  db: Executor,
  id: string,
  before: ExtensionManifest | null,
  after: ExtensionManifest | null,
) {
  const kept = new Map((after?.fields ?? []).map((f) => [f.name, f.type]));
  const dropped = (before?.fields ?? [])
    .filter((f) => kept.get(f.name) !== f.type)
    .map((f) => `ext.${id}.${f.name}`);
  if (dropped.length === 0 && after !== null) return;
  const rules = (await ruleReferences(db, id)).filter((rule) =>
    after === null
      ? true
      : dropped.some((field) =>
          new RegExp(`(^|[^A-Za-z0-9_.])${field.replaceAll(".", "\\.")}($|[^A-Za-z0-9_])`).test(
            rule.expression,
          ),
        ),
  );
  if (rules.length === 0) return;
  fail("EXTENSION_IN_USE", "rules read the extension's fields", {
    rules: rules
      .slice(0, 5)
      .map((rule) => rule.name)
      .join(", "),
  });
}

// ---------------------------------------------------------------------------
// Publishing

/** Clusters with an enabled site that turns the extension on (or any extension). */
async function clustersUsing(db: Executor, id?: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ clusterId: schema.site.clusterId })
    .from(schema.siteExtension)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteExtension.siteId))
    .where(
      and(
        eq(schema.siteExtension.enabled, true),
        eq(schema.site.enabled, true),
        ...(id ? [eq(schema.siteExtension.extensionId, id)] : []),
      ),
    );
  return rows.map((row) => row.clusterId);
}

async function publishUsing(
  tx: Tx,
  actor: Actor,
  clusterIds: string[],
  code: "extension_updated" | "extension_removed",
  id: string,
) {
  const published = await publishClusters(tx, clusterIds, {
    reason: { code, params: { extension: id } },
    actor,
  });
  return Object.fromEntries(
    [...published].map(([cluster, result]) => [cluster, result.row.revision]),
  );
}

/** JSON with object keys sorted, so that a configuration always encodes alike. */
function canonicalJson(value: Record<string, unknown>): string {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  );
}

/**
 * What compiles into a cluster's configuration: installed extensions in hook
 * order and each site's enabled entries (set on the site models).
 */
export async function loadExtensionInput(
  db: Executor,
  sites: SiteModel[],
): Promise<{ extensions: ExtensionModel[]; extensionsDisabled: boolean }> {
  const rows = await db
    .select({
      extension: schema.extension,
      version: schema.extensionVersion,
      key: schema.extensionKey,
    })
    .from(schema.extension)
    .innerJoin(
      schema.extensionVersion,
      and(
        eq(schema.extensionVersion.extensionId, schema.extension.id),
        eq(schema.extensionVersion.version, schema.extension.activeVersion),
      ),
    )
    .innerJoin(schema.extensionKey, eq(schema.extensionKey.kid, schema.extensionVersion.kid))
    .orderBy(asc(schema.extension.installedAt), asc(schema.extension.id));
  if (rows.length === 0) return { extensions: [], extensionsDisabled: false };
  const siteIds = sites.map((s) => s.id);
  const entries = siteIds.length
    ? await db
        .select()
        .from(schema.siteExtension)
        .where(
          and(
            inArray(schema.siteExtension.siteId, siteIds),
            eq(schema.siteExtension.enabled, true),
          ),
        )
    : [];
  const manifests = new Map(rows.map((row) => [row.extension.id, manifestOf(row.version)]));
  // Data items of the enabled entries whose extension takes data (version 1.1).
  const withData = entries.filter((entry) => manifests.get(entry.extensionId)?.data);
  const items = withData.length
    ? await db
        .select({
          siteId: schema.siteExtensionData.siteId,
          extensionId: schema.siteExtensionData.extensionId,
          name: schema.siteExtensionData.name,
          sha256: schema.siteExtensionData.sha256,
          size: schema.siteExtensionData.size,
        })
        .from(schema.siteExtensionData)
        .where(
          and(
            inArray(
              schema.siteExtensionData.siteId,
              withData.map((entry) => entry.siteId),
            ),
            inArray(
              schema.siteExtensionData.extensionId,
              withData.map((entry) => entry.extensionId),
            ),
          ),
        )
        .orderBy(asc(schema.siteExtensionData.name))
    : [];
  for (const site of sites) {
    site.extensions = entries
      .filter((entry) => entry.siteId === site.id)
      .map((entry) => ({
        id: entry.extensionId,
        configJson: canonicalJson(entry.config),
        data: manifests.get(entry.extensionId)?.data
          ? items
              .filter((item) => item.siteId === site.id && item.extensionId === entry.extensionId)
              .map(({ name, sha256, size }) => ({ name, sha256, size }))
          : [],
      }));
  }
  const extensions = rows.map(({ extension, version, key }): ExtensionModel => {
    const manifest = manifests.get(extension.id) ?? manifestOf(version);
    return {
      id: extension.id,
      version: version.version,
      publisher: manifest.publisher,
      sha256: version.sha256,
      size: version.size,
      signature: version.signature,
      publicKey: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: key.x }),
      enabled: extension.enabled,
      failureMode: extension.failureMode === "closed" ? "closed" : "open",
      configJson: canonicalJson(extension.config),
      sharedDicts: manifest.shared_dicts.map((d) => ({ name: d.name, sizeKb: d.size_kb })),
      luaApi: manifest.requires.lua_api,
      secretVersion: manifest.secret ? extension.secretVersion : 0,
    };
  });
  return { extensions, extensionsDisabled: (await getExtensionSettings(db)).disabled };
}

// ---------------------------------------------------------------------------
// Trust store

async function keyLookup(db: Executor) {
  const keys = await db.select().from(schema.extensionKey);
  const byKid = new Map(keys.map((k) => [k.kid, k]));
  return (kid: string) => byKid.get(kid);
}

export async function listExtensionKeys(db: Executor): Promise<ExtensionKeyView[]> {
  const keys = await db
    .select()
    .from(schema.extensionKey)
    .orderBy(asc(schema.extensionKey.publisher), asc(schema.extensionKey.createdAt));
  const counts = await db
    .select({ kid: schema.extensionVersion.kid, count: sql<number>`count(*)::int` })
    .from(schema.extensionVersion)
    .groupBy(schema.extensionVersion.kid);
  const byKid = new Map(counts.map((c) => [c.kid, c.count]));
  return keys.map((key) => ({
    kid: key.kid,
    publisher: key.publisher,
    jwk: { kty: "OKP", crv: "Ed25519", x: key.x },
    label: key.label,
    createdAt: key.createdAt.toISOString(),
    versions: byKid.get(key.kid) ?? 0,
  }));
}

export async function addExtensionKey(
  db: Database,
  input: { publisher: string; key: string; label: string },
  actor: Actor,
): Promise<ExtensionKeyView> {
  const jwk = parsePublicKey(input.key);
  const kid = jwkThumbprint(jwk.x);
  return db.transaction(async (tx) => {
    const [existing] = await tx
      .select()
      .from(schema.extensionKey)
      .where(eq(schema.extensionKey.kid, kid));
    if (existing) fail("EXTENSION_KEY_EXISTS", "the key is already trusted", { kid });
    const [row] = await tx
      .insert(schema.extensionKey)
      .values({ kid, publisher: input.publisher, x: jwk.x, label: input.label })
      .returning();
    await recordAudit(tx, actor, {
      action: "extension_key.add",
      targetType: "extension_key",
      targetId: kid,
      targetName: input.publisher,
      metadata: { publisher: input.publisher, label: input.label },
    });
    return {
      kid,
      publisher: input.publisher,
      jwk,
      label: input.label,
      createdAt: (row as { createdAt: Date }).createdAt.toISOString(),
      versions: 0,
    };
  });
}

export async function removeExtensionKey(db: Database, kid: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    await lockExtensions(tx);
    const [key] = await tx
      .select()
      .from(schema.extensionKey)
      .where(eq(schema.extensionKey.kid, kid));
    if (!key) fail("EXTENSION_KEY_NOT_FOUND", "no such key");
    const used = await tx
      .select({ id: schema.extensionVersion.extensionId, version: schema.extensionVersion.version })
      .from(schema.extensionVersion)
      .where(eq(schema.extensionVersion.kid, kid));
    if (used.length)
      fail("EXTENSION_KEY_IN_USE", "stored versions are signed by the key", {
        versions: used
          .slice(0, 5)
          .map((v) => `${v.id}@${v.version}`)
          .join(", "),
      });
    await tx.delete(schema.extensionKey).where(eq(schema.extensionKey.kid, kid));
    await recordAudit(tx, actor, {
      action: "extension_key.remove",
      targetType: "extension_key",
      targetId: kid,
      targetName: key?.publisher ?? "",
      metadata: { publisher: key?.publisher },
    });
  });
}

// ---------------------------------------------------------------------------
// Packages

async function verified(
  db: Executor,
  input: { package: string; signature: string },
): Promise<VerifiedPackage> {
  return verifyPackage(decodePackage(input.package), input.signature, await keyLookup(db));
}

export async function verifyExtensionPackage(
  db: Executor,
  input: { package: string; signature: string },
): Promise<VerifiedExtensionPackage> {
  const pkg = await verified(db, input);
  const key = (await keyLookup(db))(pkg.kid);
  const [installed] = await db
    .select()
    .from(schema.extension)
    .where(eq(schema.extension.id, pkg.manifest.id));
  const [stored] = await db
    .select({ sha256: schema.extensionVersion.sha256 })
    .from(schema.extensionVersion)
    .where(
      and(
        eq(schema.extensionVersion.extensionId, pkg.manifest.id),
        eq(schema.extensionVersion.version, pkg.manifest.version),
      ),
    );
  return {
    manifest: pkg.manifest,
    sha256: pkg.sha256,
    size: pkg.size,
    key: { kid: pkg.kid, publisher: key?.publisher ?? "", label: key?.label ?? "" },
    installedVersion: installed?.activeVersion ?? null,
    stored: stored?.sha256 === pkg.sha256,
  };
}

/**
 * Installs a package: a new id is installed disabled with the defaults of
 * its global schema; for an installed id the version is stored (or found
 * stored with the same digest) and becomes active, with the global and site
 * configurations revalidated against its schemas.
 */
export async function installExtension(
  db: Database,
  masterKey: MasterKey,
  input: { package: string; signature: string },
  actor: Actor,
): Promise<ExtensionDetail> {
  const bytes = decodePackage(input.package);
  const id = await db.transaction(async (tx) => {
    await lockExtensions(tx);
    const pkg = verifyPackage(bytes, input.signature, await keyLookup(tx));
    const { manifest } = pkg;
    const [existing] = await tx
      .select()
      .from(schema.extension)
      .where(eq(schema.extension.id, manifest.id));
    const [stored] = await tx
      .select()
      .from(schema.extensionVersion)
      .where(
        and(
          eq(schema.extensionVersion.extensionId, manifest.id),
          eq(schema.extensionVersion.version, manifest.version),
        ),
      );
    if (stored && stored.sha256 !== pkg.sha256)
      fail("EXTENSION_VERSION_EXISTS", "the version is stored with another digest", {
        version: manifest.version,
      });
    if (!existing) {
      await tx.insert(schema.extension).values({
        id: manifest.id,
        activeVersion: manifest.version,
        enabled: false,
        config: validConfig(manifest, "global", {}, true),
      });
    }
    if (!stored) {
      await tx.insert(schema.extensionVersion).values({
        extensionId: manifest.id,
        version: manifest.version,
        sha256: pkg.sha256,
        size: pkg.size,
        package: bytes,
        signature: input.signature.trim(),
        kid: pkg.kid,
        manifest: manifest as unknown as Record<string, unknown>,
      });
    }
    if (!existing) {
      await recordAudit(tx, actor, {
        action: "extension.install",
        targetType: "extension",
        targetId: manifest.id,
        targetName: manifest.name.en,
        metadata: {
          version: manifest.version,
          sha256: pkg.sha256,
          kid: pkg.kid,
          capabilities: manifest.capabilities,
        },
      });
      await ensureSecret(tx, masterKey, manifest.id, manifest);
      await refreshExtensionFields(tx);
      return manifest.id;
    }
    await activate(tx, masterKey, existing, manifest.version, actor, "extension.upgrade", {
      sha256: pkg.sha256,
      kid: pkg.kid,
    });
    return manifest.id;
  });
  return getExtension(db, id);
}

async function activate(
  tx: Tx,
  masterKey: MasterKey,
  existing: ExtensionRow,
  version: string,
  actor: Actor,
  action: "extension.upgrade" | "extension.activate",
  metadata: Record<string, unknown> = {},
) {
  const versions = await tx
    .select()
    .from(schema.extensionVersion)
    .where(
      and(
        eq(schema.extensionVersion.extensionId, existing.id),
        inArray(schema.extensionVersion.version, [existing.activeVersion, version]),
      ),
    );
  const target = versions.find((v) => v.version === version);
  if (!target) return fail("EXTENSION_VERSION_NOT_FOUND", "no such version", { version });
  if (existing.activeVersion === version) return;
  const before = versions.find((v) => v.version === existing.activeVersion);
  const manifest = manifestOf(target);
  await assertFieldsKept(tx, existing.id, before ? manifestOf(before) : null, manifest);
  // Configurations follow the new schemas: kept where valid, defaults filled in.
  const config = validConfig(
    manifest,
    "global",
    pruneTo(manifest, "global", existing.config),
    !existing.enabled,
  );
  const sites = await tx
    .select()
    .from(schema.siteExtension)
    .where(eq(schema.siteExtension.extensionId, existing.id));
  for (const entry of sites) {
    await tx
      .update(schema.siteExtension)
      .set({
        config: validConfig(
          manifest,
          "site",
          pruneTo(manifest, "site", entry.config),
          !entry.enabled,
        ),
      })
      .where(
        and(
          eq(schema.siteExtension.siteId, entry.siteId),
          eq(schema.siteExtension.extensionId, existing.id),
        ),
      );
  }
  await tx
    .update(schema.extension)
    .set({ activeVersion: version, config })
    .where(eq(schema.extension.id, existing.id));
  await ensureSecret(tx, masterKey, existing.id, manifest);
  await refreshExtensionFields(tx);
  const clusters = await clustersUsing(tx, existing.id);
  if (existing.enabled)
    await assertNodeFeatures(
      tx,
      clusters,
      extensionFeatures(manifest),
      "nodes without extension support",
    );
  const revisions = await publishUsing(tx, actor, clusters, "extension_updated", existing.id);
  await recordAudit(tx, actor, {
    action,
    targetType: "extension",
    targetId: existing.id,
    targetName: manifest.name.en,
    metadata: { ...metadata, from: existing.activeVersion, to: version, revisions },
  });
}

/** Keeps the keys a schema still declares, so that a removed property does not fail validation. */
function pruneTo(
  manifest: ExtensionManifest,
  scope: "global" | "site",
  value: Record<string, unknown>,
) {
  const properties = schemaOf(manifest, scope)?.properties ?? {};
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => Object.hasOwn(properties, key)),
  );
}

async function requireExtension(db: Executor, id: string): Promise<ExtensionRow> {
  const [row] = await db.select().from(schema.extension).where(eq(schema.extension.id, id));
  if (!row) return fail("EXTENSION_NOT_FOUND", "no such extension");
  return row;
}

async function activeVersion(db: Executor, row: ExtensionRow): Promise<VersionRow> {
  const [version] = await db
    .select()
    .from(schema.extensionVersion)
    .where(
      and(
        eq(schema.extensionVersion.extensionId, row.id),
        eq(schema.extensionVersion.version, row.activeVersion),
      ),
    );
  if (!version)
    return fail("EXTENSION_VERSION_NOT_FOUND", "active version missing", {
      version: row.activeVersion,
    });
  return version;
}

export async function activateExtensionVersion(
  db: Database,
  masterKey: MasterKey,
  input: { id: string; version: string },
  actor: Actor,
): Promise<ExtensionDetail> {
  await db.transaction(async (tx) => {
    await lockExtensions(tx);
    await activate(
      tx,
      masterKey,
      await requireExtension(tx, input.id),
      input.version,
      actor,
      "extension.activate",
    );
  });
  return getExtension(db, input.id);
}

export async function deleteExtensionVersion(
  db: Database,
  input: { id: string; version: string },
  actor: Actor,
): Promise<ExtensionDetail> {
  await db.transaction(async (tx) => {
    await lockExtensions(tx);
    const row = await requireExtension(tx, input.id);
    if (row.activeVersion === input.version)
      fail("EXTENSION_VERSION_ACTIVE", "the active version cannot be deleted", {
        version: input.version,
      });
    const deleted = await tx
      .delete(schema.extensionVersion)
      .where(
        and(
          eq(schema.extensionVersion.extensionId, input.id),
          eq(schema.extensionVersion.version, input.version),
        ),
      )
      .returning({ sha256: schema.extensionVersion.sha256 });
    if (!deleted.length)
      fail("EXTENSION_VERSION_NOT_FOUND", "no such version", { version: input.version });
    await recordAudit(tx, actor, {
      action: "extension.delete_version",
      targetType: "extension",
      targetId: input.id,
      targetName: input.id,
      metadata: { version: input.version, sha256: deleted[0]?.sha256 },
    });
  });
  return getExtension(db, input.id);
}

export async function updateExtension(
  db: Database,
  input: {
    id: string;
    enabled?: boolean;
    failureMode?: "open" | "closed";
    config?: Record<string, unknown>;
  },
  actor: Actor,
): Promise<ExtensionDetail> {
  await db.transaction(async (tx) => {
    await lockExtensions(tx);
    const row = await requireExtension(tx, input.id);
    const manifest = manifestOf(await activeVersion(tx, row));
    const enabled = input.enabled ?? row.enabled;
    const config = validConfig(
      manifest,
      "global",
      input.config === undefined
        ? row.config
        : unmaskExtensionConfig(schemaOf(manifest, "global"), input.config, row.config),
      !enabled,
    );
    const clusters = await clustersUsing(tx, row.id);
    if (input.enabled && !row.enabled)
      await assertNodeFeatures(
        tx,
        clusters,
        extensionFeatures(manifest),
        "nodes without extension support",
      );
    const changed = {
      enabled,
      failureMode: input.failureMode ?? (row.failureMode as "open" | "closed"),
      config,
    };
    await tx.update(schema.extension).set(changed).where(eq(schema.extension.id, row.id));
    const revisions = await publishUsing(tx, actor, clusters, "extension_updated", row.id);
    await recordAudit(tx, actor, {
      action: "extension.update",
      targetType: "extension",
      targetId: row.id,
      targetName: manifest.name.en,
      metadata: {
        enabled: changed.enabled,
        failureMode: changed.failureMode,
        configChanged:
          input.config !== undefined && JSON.stringify(config) !== JSON.stringify(row.config),
        revisions,
      },
    });
  });
  return getExtension(db, input.id);
}

/**
 * Makes a new current secret and keeps the old one as previous (version + 1),
 * then publishes the clusters that get the extension.
 */
export async function rotateExtensionSecret(
  db: Database,
  masterKey: MasterKey,
  id: string,
  actor: Actor,
): Promise<ExtensionDetail> {
  await db.transaction(async (tx) => {
    await lockExtensions(tx);
    const row = await requireExtension(tx, id);
    const manifest = manifestOf(await activeVersion(tx, row));
    if (!manifest.secret) fail("EXTENSION_SECRET_NOT_SUPPORTED", "the extension has no secret");
    const previous = row.secretEnvelope
      ? openSecrets(masterKey, id, row.secretEnvelope).current
      : undefined;
    const version = row.secretVersion + 1;
    await tx
      .update(schema.extension)
      .set({
        secretEnvelope: sealSecrets(masterKey, id, randomBytes(SECRET_BYTES), previous),
        secretVersion: version,
      })
      .where(eq(schema.extension.id, id));
    const revisions = await publishUsing(
      tx,
      actor,
      await clustersUsing(tx, id),
      "extension_updated",
      id,
    );
    await recordAudit(tx, actor, {
      action: "extension.rotate_secret",
      targetType: "extension",
      targetId: id,
      targetName: manifest.name.en,
      metadata: { secretVersion: version, revisions },
    });
  });
  return getExtension(db, id);
}

export async function uninstallExtension(db: Database, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    await lockExtensions(tx);
    const row = await requireExtension(tx, id);
    const manifest = manifestOf(await activeVersion(tx, row));
    await assertFieldsKept(tx, id, manifest, null);
    const clusters = await clustersUsing(tx, id);
    await tx.delete(schema.extension).where(eq(schema.extension.id, id));
    await refreshExtensionFields(tx);
    const revisions = await publishUsing(tx, actor, clusters, "extension_removed", id);
    await recordAudit(tx, actor, {
      action: "extension.uninstall",
      targetType: "extension",
      targetId: id,
      targetName: manifest.name.en,
      metadata: { version: row.activeVersion, revisions },
    });
  });
}

// ---------------------------------------------------------------------------
// Kill switch

export async function getExtensionSettings(db: Executor): Promise<{ disabled: boolean }> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, SETTINGS_KEY));
  return { disabled: row?.value.disabled === true };
}

export async function updateExtensionSettings(
  db: Database,
  input: { disabled: boolean },
  actor: Actor,
): Promise<{ disabled: boolean }> {
  return db.transaction(async (tx) => {
    await lockExtensions(tx);
    const before = await getExtensionSettings(tx);
    if (before.disabled === input.disabled) return before;
    await tx
      .insert(schema.systemSetting)
      .values({ key: SETTINGS_KEY, value: { disabled: input.disabled } })
      .onConflictDoUpdate({
        target: schema.systemSetting.key,
        set: { value: { disabled: input.disabled } },
      });
    const published = await publishClusters(tx, await clustersUsing(tx), {
      reason: { code: "extensions_settings_updated", params: {} },
      actor,
    });
    await recordAudit(tx, actor, {
      action: "extension.settings_update",
      targetType: "system_setting",
      targetId: SETTINGS_KEY,
      targetName: SETTINGS_KEY,
      metadata: {
        disabled: input.disabled,
        revisions: Object.fromEntries([...published].map(([c, r]) => [c, r.row.revision])),
      },
    });
    return { disabled: input.disabled };
  });
}

// ---------------------------------------------------------------------------
// Per site

export async function listSiteExtensions(
  db: Executor,
  siteId: string,
): Promise<SiteExtensionView[]> {
  await requireSite(db, siteId);
  const rows = await db
    .select({ extension: schema.extension, version: schema.extensionVersion })
    .from(schema.extension)
    .innerJoin(
      schema.extensionVersion,
      and(
        eq(schema.extensionVersion.extensionId, schema.extension.id),
        eq(schema.extensionVersion.version, schema.extension.activeVersion),
      ),
    )
    .orderBy(asc(schema.extension.installedAt), asc(schema.extension.id));
  const entries = await db
    .select()
    .from(schema.siteExtension)
    .where(eq(schema.siteExtension.siteId, siteId));
  return rows.map(({ extension, version }) =>
    siteView(
      extension,
      version,
      entries.find((e) => e.extensionId === extension.id),
    ),
  );
}

function siteView(
  extension: ExtensionRow,
  version: VersionRow,
  entry: typeof schema.siteExtension.$inferSelect | undefined,
): SiteExtensionView {
  const manifest = manifestOf(version);
  const siteSchema = schemaOf(manifest, "site") ?? null;
  const defaults = applyExtensionConfig(
    siteSchema ? { ...siteSchema, required: [] } : undefined,
    {},
  );
  const config = entry?.config ?? (defaults.ok ? defaults.value : {});
  return {
    id: extension.id,
    name: manifest.name,
    version: version.version,
    installedEnabled: extension.enabled,
    enabled: entry?.enabled ?? false,
    config: maskExtensionConfig(siteSchema ?? undefined, config),
    schema: siteSchema,
    capabilities: manifest.capabilities,
    updatedAt: entry?.updatedAt.toISOString() ?? null,
    dataLimits: manifest.data
      ? {
          maxBytes: manifest.data.max_bytes,
          maxItems: manifest.data.max_items,
          maxTotalBytes: manifest.data.max_total_bytes,
        }
      : null,
  };
}

async function requireSite(db: Executor, siteId: string) {
  const [site] = await db
    .select({
      id: schema.site.id,
      name: schema.site.name,
      clusterId: schema.site.clusterId,
      enabled: schema.site.enabled,
    })
    .from(schema.site)
    .where(eq(schema.site.id, siteId));
  if (!site) return fail("SITE_NOT_FOUND", "site not found");
  return site;
}

export async function updateSiteExtension(
  db: Database,
  input: { siteId: string; id: string; enabled: boolean; config: Record<string, unknown> },
  actor: Actor,
): Promise<SiteExtensionView> {
  return db.transaction(async (tx) => {
    await lockExtensions(tx);
    const site = await requireSite(tx, input.siteId);
    const extension = await requireExtension(tx, input.id);
    const version = await activeVersion(tx, extension);
    const manifest = manifestOf(version);
    const [entry] = await tx
      .select()
      .from(schema.siteExtension)
      .where(
        and(
          eq(schema.siteExtension.siteId, site.id),
          eq(schema.siteExtension.extensionId, extension.id),
        ),
      );
    const config = validConfig(
      manifest,
      "site",
      unmaskExtensionConfig(schemaOf(manifest, "site"), input.config, entry?.config ?? {}),
      !input.enabled,
    );
    if (input.enabled && !entry?.enabled)
      await assertNodeFeatures(
        tx,
        [site.clusterId],
        extensionFeatures(manifest),
        "nodes without extension support",
      );
    const [row] = await tx
      .insert(schema.siteExtension)
      .values({ siteId: site.id, extensionId: extension.id, enabled: input.enabled, config })
      .onConflictDoUpdate({
        target: [schema.siteExtension.siteId, schema.siteExtension.extensionId],
        set: { enabled: input.enabled, config, updatedAt: new Date() },
      })
      .returning();
    await publishSiteChange(tx, actor, site, {
      reason: "site_extension_updated",
      params: { extension: extension.id, site: site.name },
      action: "site.extension_update",
      metadata: {
        extension: extension.id,
        enabled: input.enabled,
        configChanged: JSON.stringify(config) !== JSON.stringify(entry?.config ?? null),
      },
    });
    return siteView(extension, version, row);
  });
}

// ---------------------------------------------------------------------------
// Site data (manifest `data`, version 1.1)

const dataView = (row: {
  name: string;
  sha256: string;
  size: number;
  updatedAt: Date;
}): ExtensionSiteDataItem => ({
  name: row.name,
  sha256: row.sha256,
  size: row.size,
  updatedAt: row.updatedAt.toISOString(),
});

const dataOf = (siteId: string, extensionId: string) =>
  and(
    eq(schema.siteExtensionData.siteId, siteId),
    eq(schema.siteExtensionData.extensionId, extensionId),
  );

export async function listSiteExtensionData(
  db: Executor,
  input: { siteId: string; id: string },
): Promise<ExtensionSiteDataItem[]> {
  await requireSite(db, input.siteId);
  await requireExtension(db, input.id);
  const rows = await db
    .select({
      name: schema.siteExtensionData.name,
      sha256: schema.siteExtensionData.sha256,
      size: schema.siteExtensionData.size,
      updatedAt: schema.siteExtensionData.updatedAt,
    })
    .from(schema.siteExtensionData)
    .where(dataOf(input.siteId, input.id))
    .orderBy(asc(schema.siteExtensionData.name));
  return rows.map(dataView);
}

/**
 * Creates or replaces a data item within the active manifest's `data` limits
 * (the item, the number of items and their total size per site and
 * extension) and publishes the site's cluster.
 */
export async function putSiteExtensionData(
  db: Database,
  input: { siteId: string; id: string; name: string; content: string },
  actor: Actor,
): Promise<ExtensionSiteDataItem> {
  const content = new Uint8Array(Buffer.from(input.content, "base64"));
  return db.transaction(async (tx) => {
    await lockExtensions(tx);
    const site = await requireSite(tx, input.siteId);
    const extension = await requireExtension(tx, input.id);
    const limits = manifestOf(await activeVersion(tx, extension)).data;
    if (!limits) return fail("EXTENSION_DATA_NOT_SUPPORTED", "the extension takes no site data");
    const tooLarge = (limit: "max_bytes" | "max_items" | "max_total_bytes") =>
      fail("EXTENSION_DATA_TOO_LARGE", `over the extension's ${limit}`, {
        limit,
        max: limits[limit],
      });
    if (content.length > limits.max_bytes) tooLarge("max_bytes");
    const others = (
      await tx
        .select({ name: schema.siteExtensionData.name, size: schema.siteExtensionData.size })
        .from(schema.siteExtensionData)
        .where(dataOf(site.id, extension.id))
    ).filter((item) => item.name !== input.name);
    if (others.length + 1 > limits.max_items) tooLarge("max_items");
    if (others.reduce((sum, item) => sum + item.size, 0) + content.length > limits.max_total_bytes)
      tooLarge("max_total_bytes");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const updatedAt = new Date();
    const values = { sha256, size: content.length, content, updatedAt };
    const [row] = await tx
      .insert(schema.siteExtensionData)
      .values({ siteId: site.id, extensionId: extension.id, name: input.name, ...values })
      .onConflictDoUpdate({
        target: [
          schema.siteExtensionData.siteId,
          schema.siteExtensionData.extensionId,
          schema.siteExtensionData.name,
        ],
        set: values,
      })
      .returning({
        name: schema.siteExtensionData.name,
        sha256: schema.siteExtensionData.sha256,
        size: schema.siteExtensionData.size,
        updatedAt: schema.siteExtensionData.updatedAt,
      });
    await publishSiteChange(tx, actor, site, {
      reason: "site_extension_updated",
      params: { extension: extension.id, site: site.name },
      action: "site.extension_data_put",
      metadata: { extension: extension.id, name: input.name, sha256, size: content.length },
    });
    return dataView(row ?? { name: input.name, ...values });
  });
}

export async function deleteSiteExtensionData(
  db: Database,
  input: { siteId: string; id: string; name: string },
  actor: Actor,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockExtensions(tx);
    const site = await requireSite(tx, input.siteId);
    const extension = await requireExtension(tx, input.id);
    const [deleted] = await tx
      .delete(schema.siteExtensionData)
      .where(and(dataOf(site.id, extension.id), eq(schema.siteExtensionData.name, input.name)))
      .returning({ sha256: schema.siteExtensionData.sha256 });
    if (!deleted) return fail("EXTENSION_DATA_NOT_FOUND", "no such data item");
    await publishSiteChange(tx, actor, site, {
      reason: "site_extension_updated",
      params: { extension: extension.id, site: site.name },
      action: "site.extension_data_delete",
      metadata: { extension: extension.id, name: input.name, sha256: deleted.sha256 },
    });
  });
}

// ---------------------------------------------------------------------------
// Views

function nodeStates(
  extension: ExtensionRow,
  version: VersionRow,
  clusters: Set<string>,
  nodes: (typeof schema.node.$inferSelect)[],
): NodeExtensionState[] {
  const features = extensionFeatures(manifestOf(version));
  return nodes
    .filter((node) => clusters.has(node.clusterId) && node.status === "active")
    .map((node) => {
      const reported = node.extensionStatus.find((s) => s.id === extension.id);
      const supported = features.every((f) => nodeSupportsFeature(node.supportedFeatures, f));
      const current = reported && reported.sha256 === version.sha256;
      return {
        nodeId: node.id,
        nodeName: node.name,
        clusterId: node.clusterId,
        state: !supported ? "unsupported" : current ? reported.state : "pending",
        version: reported?.version ?? "",
        message: reported?.message ?? "",
        faults: reported?.faults ?? 0,
        trips: reported?.trips ?? 0,
        details: reported?.details ?? {},
      };
    });
}

async function summaries(
  db: Executor,
  only?: string,
): Promise<
  (ExtensionSummary & { _row: ExtensionRow; _version: VersionRow; _nodes: NodeExtensionState[] })[]
> {
  const rows = await db
    .select({ extension: schema.extension, version: schema.extensionVersion })
    .from(schema.extension)
    .innerJoin(
      schema.extensionVersion,
      and(
        eq(schema.extensionVersion.extensionId, schema.extension.id),
        eq(schema.extensionVersion.version, schema.extension.activeVersion),
      ),
    )
    .where(only ? eq(schema.extension.id, only) : undefined)
    .orderBy(asc(schema.extension.installedAt), asc(schema.extension.id));
  if (rows.length === 0) return [];
  const usage = await db
    .select({
      id: schema.siteExtension.extensionId,
      clusterId: schema.site.clusterId,
      siteEnabled: schema.site.enabled,
    })
    .from(schema.siteExtension)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteExtension.siteId))
    .where(eq(schema.siteExtension.enabled, true));
  const nodes = await db.select().from(schema.node);
  return rows.map(({ extension, version }) => {
    const manifest = manifestOf(version);
    const used = usage.filter((u) => u.id === extension.id);
    const clusters = new Set(used.filter((u) => u.siteEnabled).map((u) => u.clusterId));
    const states = nodeStates(extension, version, clusters, nodes);
    return {
      id: extension.id,
      version: extension.activeVersion,
      publisher: manifest.publisher,
      name: manifest.name,
      enabled: extension.enabled,
      failureMode: extension.failureMode === "closed" ? "closed" : "open",
      sites: used.length,
      nodesLoaded: states.filter((s) => s.state === "loaded").length,
      nodesFailing: states.filter((s) =>
        ["failed", "incompatible", "unsupported"].includes(s.state),
      ).length,
      installedAt: extension.installedAt.toISOString(),
      updatedAt: extension.updatedAt.toISOString(),
      _row: extension,
      _version: version,
      _nodes: states,
    };
  });
}

export async function listExtensions(db: Executor): Promise<ExtensionSummary[]> {
  return (await summaries(db)).map(({ _row, _version, _nodes, ...summary }) => summary);
}

export async function getExtension(db: Executor, id: string): Promise<ExtensionDetail> {
  const [found] = await summaries(db, id);
  if (!found) return fail("EXTENSION_NOT_FOUND", "no such extension");
  const { _row: row, _version: version, _nodes: nodes, ...summary } = found;
  const manifest = manifestOf(version);
  const versions = await db
    .select({
      version: schema.extensionVersion.version,
      sha256: schema.extensionVersion.sha256,
      size: schema.extensionVersion.size,
      kid: schema.extensionVersion.kid,
      uploadedAt: schema.extensionVersion.uploadedAt,
    })
    .from(schema.extensionVersion)
    .where(eq(schema.extensionVersion.extensionId, id))
    .orderBy(asc(schema.extensionVersion.uploadedAt));
  const sites = await db
    .select({ id: schema.site.id, name: schema.site.name, config: schema.siteExtension.config })
    .from(schema.siteExtension)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteExtension.siteId))
    .where(and(eq(schema.siteExtension.extensionId, id), eq(schema.siteExtension.enabled, true)))
    .orderBy(asc(schema.site.name));
  const siteSchema = schemaOf(manifest, "site");
  return {
    ...summary,
    manifest,
    sha256: version.sha256,
    config: maskExtensionConfig(schemaOf(manifest, "global"), row.config),
    versions: versions
      .map((v) => ({
        ...v,
        uploadedAt: v.uploadedAt.toISOString(),
        active: v.version === row.activeVersion,
      }))
      .reverse(),
    siteList: sites.map((s) => ({ ...s, config: maskExtensionConfig(siteSchema, s.config) })),
    nodes,
    ruleReferences: (await ruleReferences(db, id)).length,
    secretVersion: manifest.secret ? row.secretVersion : 0,
  };
}

// ---------------------------------------------------------------------------
// Node channel

/** At most this much of a package or a data item goes into one node channel answer. */
const EXTENSION_CHUNK_BYTES = 4 * 1024 * 1024;

const toBytes = (value: Uint8Array) => new Uint8Array(value);

/** A part of a bytea column from `offset` (at most EXTENSION_CHUNK_BYTES) and its whole size. */
const chunkOf = (column: AnyColumn, offset: number) => ({
  data: sql<Uint8Array>`substring(${column} from ${offset + 1}::int for ${EXTENSION_CHUNK_BYTES}::int)`.mapWith(
    toBytes,
  ),
  total: sql<number>`octet_length(${column})`.mapWith(Number),
});

/**
 * A part of the package bytes for a node (from `offset`, at most
 * EXTENSION_CHUNK_BYTES) and the package's size: a stored version of an
 * extension that an enabled site of the node's cluster turns on (the active
 * one, or an older one a rollback revision may still reference).
 */
export async function packageForNode(
  db: Executor,
  clusterId: string,
  sha256: string,
  offset = 0,
): Promise<{ data: Uint8Array; total: number } | null> {
  const [row] = await db
    .select(chunkOf(schema.extensionVersion.package, offset))
    .from(schema.extensionVersion)
    .innerJoin(
      schema.siteExtension,
      eq(schema.siteExtension.extensionId, schema.extensionVersion.extensionId),
    )
    .innerJoin(schema.site, eq(schema.site.id, schema.siteExtension.siteId))
    .where(and(eq(schema.extensionVersion.sha256, sha256), eq(schema.site.clusterId, clusterId)))
    .limit(1);
  return row ?? null;
}

/**
 * The secrets (current, previous) of the extensions an enabled site of the
 * node's cluster turns on whose active version declares `secret: true`;
 * `ids` narrows them (empty: all).
 */
export async function secretsForNode(
  db: Executor,
  masterKey: MasterKey,
  clusterId: string,
  ids: string[],
): Promise<{ id: string; version: number; current: Uint8Array; previous: Uint8Array }[]> {
  const rows = await db
    .select({
      id: schema.extension.id,
      envelope: schema.extension.secretEnvelope,
      version: schema.extension.secretVersion,
      manifest: schema.extensionVersion.manifest,
    })
    .from(schema.extension)
    .innerJoin(
      schema.extensionVersion,
      and(
        eq(schema.extensionVersion.extensionId, schema.extension.id),
        eq(schema.extensionVersion.version, schema.extension.activeVersion),
      ),
    )
    .innerJoin(schema.siteExtension, eq(schema.siteExtension.extensionId, schema.extension.id))
    .innerJoin(schema.site, eq(schema.site.id, schema.siteExtension.siteId))
    .where(
      and(
        eq(schema.site.clusterId, clusterId),
        eq(schema.site.enabled, true),
        eq(schema.siteExtension.enabled, true),
        isNotNull(schema.extension.secretEnvelope),
        ...(ids.length ? [inArray(schema.extension.id, ids)] : []),
      ),
    )
    .orderBy(asc(schema.extension.id));
  const seen = new Set<string>();
  const secrets: { id: string; version: number; current: Uint8Array; previous: Uint8Array }[] = [];
  for (const row of rows) {
    if (seen.has(row.id) || !row.envelope || !manifestOf(row).secret) continue;
    seen.add(row.id);
    const { current, previous } = openSecrets(masterKey, row.id, row.envelope);
    secrets.push({
      id: row.id,
      version: row.version,
      current: new Uint8Array(current),
      previous: previous ? new Uint8Array(previous) : new Uint8Array(),
    });
  }
  return secrets;
}

/**
 * A part of a data item for a node (from `offset`, at most
 * EXTENSION_CHUNK_BYTES) and its size: an item of a site of the node's
 * cluster that turns the extension on.
 */
export async function dataForNode(
  db: Executor,
  clusterId: string,
  item: { extensionId: string; siteId: string; sha256: string },
  offset = 0,
): Promise<{ data: Uint8Array; total: number } | null> {
  const [row] = await db
    .select(chunkOf(schema.siteExtensionData.content, offset))
    .from(schema.siteExtensionData)
    .innerJoin(
      schema.siteExtension,
      and(
        eq(schema.siteExtension.siteId, schema.siteExtensionData.siteId),
        eq(schema.siteExtension.extensionId, schema.siteExtensionData.extensionId),
      ),
    )
    .innerJoin(schema.site, eq(schema.site.id, schema.siteExtensionData.siteId))
    .where(
      and(
        eq(schema.siteExtensionData.siteId, item.siteId),
        eq(schema.siteExtensionData.extensionId, item.extensionId),
        eq(schema.siteExtensionData.sha256, item.sha256),
        eq(schema.siteExtension.enabled, true),
        eq(schema.site.clusterId, clusterId),
      ),
    )
    .limit(1);
  return row ?? null;
}
