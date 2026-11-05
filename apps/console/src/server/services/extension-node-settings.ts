import { decodeNodeConfig } from "@edgeweir/config-compiler";
import {
  type ExtensionManifest,
  type ExtensionNodeSettings,
  type ExtensionNodeSettingsView,
  extensionManifest,
  extensionNodeSettings,
  extensionRequiredFeatures,
  TIERED_CACHE_DEFAULTS,
  tieredCacheSettings,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { lockListenerPorts } from "../lib/locks";
import { assertNodeFeatures } from "../lib/node-features";
import { type Actor, recordAudit } from "./audit";
import { type Executor, latestRevision, publishClusters } from "./revisions";

type PortRange = { start: number; end: number };
type ClusterRow = typeof schema.cluster.$inferSelect;
const portRange = (port: number) => ({ start: port, end: port });
const covers = (range: PortRange, port: number) => range.start <= port && port <= range.end;

async function requireNodeExtension(db: Executor, id: string) {
  const [row] = await db
    .select({ extension: schema.extension, version: schema.extensionVersion })
    .from(schema.extension)
    .innerJoin(
      schema.extensionVersion,
      and(
        eq(schema.extensionVersion.extensionId, schema.extension.id),
        eq(schema.extensionVersion.version, schema.extension.activeVersion),
      ),
    )
    .where(eq(schema.extension.id, id));
  if (!row) fail("EXTENSION_NOT_FOUND", "no such extension");
  const manifest = extensionManifest.parse(row.version.manifest);
  if (manifest.scope !== "node")
    fail("EXTENSION_SCOPE_MISMATCH", "node settings need node scope", { scope: "node" });
  return { ...row, manifest };
}

function parseSettings(manifest: ExtensionManifest, value: unknown): ExtensionNodeSettings {
  const parsed = extensionNodeSettings(manifest, []).safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    fail("EXTENSION_NODE_SETTINGS_INVALID", "invalid node settings", {
      path: issue?.path.join(".") ?? "",
      issue: issue?.code ?? "custom",
    });
  }
  return parsed.data;
}

export async function readNodeExtensionSettings(
  db: Executor,
  id: string,
  manifest: ExtensionManifest,
): Promise<ExtensionNodeSettings> {
  const [row] = await db
    .select()
    .from(schema.extensionNodeSetting)
    .where(eq(schema.extensionNodeSetting.extensionId, id));
  return parseSettings(manifest, row?.settings ?? {});
}

export async function nodeExtensionClusters(db: Executor, settings: ExtensionNodeSettings) {
  const clusters = await db.select().from(schema.cluster).orderBy(asc(schema.cluster.id));
  if (settings.clusterIds == null) return clusters;
  const missing = settings.clusterIds.find((id) => !clusters.some((cluster) => cluster.id === id));
  if (missing) fail("CLUSTER_NOT_FOUND", "target cluster not found", { clusterId: missing });
  return clusters.filter((cluster) => settings.clusterIds?.includes(cluster.id));
}

/** Disabled extensions retain explicit targets; dropping one would leave invalid saved settings. */
export async function assertNodeExtensionClusterReleased(db: Executor, clusterId: string) {
  const references = await db
    .select({ id: schema.extensionNodeSetting.extensionId })
    .from(schema.extensionNodeSetting)
    .where(
      sql`(${schema.extensionNodeSetting.settings} -> 'clusterIds') @> ${JSON.stringify([clusterId])}::jsonb`,
    )
    .orderBy(asc(schema.extensionNodeSetting.extensionId))
    .limit(5);
  if (references.length)
    fail("CLUSTER_NODE_EXTENSION_IN_USE", "node extension settings still target this cluster", {
      extensions: references.map((row) => row.id).join(", "),
    });
}

/** The tier port stays reserved even with the default topology off: sites may override it. */
async function tierPort(db: Executor) {
  const [row] = await db
    .select({ value: schema.systemSetting.value })
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, "tiered_cache"));
  return tieredCacheSettings.parse({ ...TIERED_CACHE_DEFAULTS, ...row?.value }).port;
}

/** Effective bindings only; disabled settings remain saved for a later, checked enable. */
async function activeBindings(db: Executor) {
  const [killSwitch] = await db
    .select({ value: schema.systemSetting.value })
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, "extensions"));
  if (killSwitch?.value.disabled === true) return [];
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
    .where(eq(schema.extension.enabled, true))
    .orderBy(asc(schema.extension.id));
  const bindings: {
    id: string;
    name: string;
    port: number;
    clusterIds?: string[] | null;
  }[] = [];
  for (const { extension, version } of rows) {
    const manifest = extensionManifest.parse(version.manifest);
    if (manifest.scope !== "node") continue;
    const settings = await readNodeExtensionSettings(db, extension.id, manifest);
    for (const [name, listener] of Object.entries(settings.listeners)) {
      if (listener)
        bindings.push({
          id: extension.id,
          name,
          port: listener.port,
          clusterIds: settings.clusterIds,
        });
    }
  }
  return bindings;
}

const targets = (binding: { clusterIds?: string[] | null }, clusterId: string) =>
  binding.clusterIds == null || binding.clusterIds.includes(clusterId);

function portConflict(port: number, cluster: ClusterRow, owner: string): never {
  return fail("PORT_BINDING_CONFLICT", "listener port is reserved", {
    port,
    cluster: cluster.name,
    clusterId: cluster.id,
    owner,
  });
}

/** Called under lockListenerPorts by existing infrastructure setters. */
export async function assertNoNodeListenerConflict(
  db: Executor,
  clusterId: string | undefined,
  ranges: readonly PortRange[],
): Promise<void> {
  const clusters = await db
    .select()
    .from(schema.cluster)
    .where(clusterId ? eq(schema.cluster.id, clusterId) : undefined)
    .orderBy(asc(schema.cluster.id));
  for (const binding of await activeBindings(db)) {
    const cluster = clusters.find((cluster) => targets(binding, cluster.id));
    if (cluster && ranges.some((range) => covers(range, binding.port)))
      portConflict(binding.port, cluster, `extension:${binding.id}.${binding.name}`);
  }
}

/** Validate against a fresh snapshot held by the caller's listener-port transaction lock. */
export async function validateNodeExtensionSettings(
  db: Executor,
  id: string,
  manifest: ExtensionManifest,
  value: unknown,
): Promise<{ settings: ExtensionNodeSettings; targetClusterIds: string[] }> {
  const settings = parseSettings(manifest, value);
  const clusters = await nodeExtensionClusters(db, settings);
  const bindings = (await activeBindings(db)).filter((binding) => binding.id !== id);
  const tier = await tierPort(db);
  const clusterIds = clusters.map((cluster) => cluster.id);
  const pools = clusterIds.length
    ? await db
        .select()
        .from(schema.clusterPortPool)
        .where(inArray(schema.clusterPortPool.clusterId, clusterIds))
    : [];
  const apps = clusterIds.length
    ? await db.select().from(schema.l4App).where(inArray(schema.l4App.clusterId, clusterIds))
    : [];
  for (const cluster of clusters) {
    const latest = await latestRevision(db, cluster.id);
    const config = latest ? decodeNodeConfig(latest.ir) : null;
    const reserved = [
      ...[80, 443, 8443, ...cluster.extraHttpPorts, ...cluster.extraHttpsPorts].map((port) => ({
        ...portRange(port),
        owner: "edge/internal",
      })),
      { ...portRange(tier), owner: "tiered_cache" },
      ...pools
        .filter((pool) => pool.clusterId === cluster.id)
        .map((pool) => ({ start: pool.portFrom, end: pool.portTo, owner: "l4_pool" })),
      ...apps
        .filter((app) => app.clusterId === cluster.id)
        .map((app) => ({ start: app.port, end: app.portEnd ?? app.port, owner: "l4_app" })),
      ...(config?.listeners ?? []).map((listener) => ({
        ...portRange(listener.port),
        owner: "edge_revision",
      })),
      ...(config?.l4Apps ?? []).map((app) => ({
        start: app.port,
        end: Math.max(app.port, app.portEnd),
        owner: "l4_revision",
      })),
      ...(config?.tieredCache
        ? [{ ...portRange(config.tieredCache.port), owner: "tiered_revision" }]
        : []),
      ...bindings
        .filter((binding) => targets(binding, cluster.id))
        .map((binding) => ({
          ...portRange(binding.port),
          owner: `extension:${binding.id}.${binding.name}`,
        })),
    ];
    const checked = extensionNodeSettings(manifest, reserved).safeParse(settings);
    if (!checked.success) {
      const name = checked.error.issues[0]?.path[1] as string;
      const listener = settings.listeners[name];
      const hit = listener && reserved.find((range) => covers(range, listener.port));
      if (listener && hit) portConflict(listener.port, cluster, hit.owner);
      return fail("EXTENSION_NODE_SETTINGS_INVALID", "invalid node listener port", {
        path: `listeners.${name}.port`,
        issue: "custom",
      });
    }
  }
  return { settings, targetClusterIds: clusterIds };
}

/** Re-enabling the kill switch or adding a cluster must check the new target set. */
export async function validateEnabledNodeExtensions(db: Executor): Promise<void> {
  const [killSwitch] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, "extensions"));
  if (killSwitch?.value.disabled === true) return;
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
    .where(eq(schema.extension.enabled, true));
  for (const { extension, version } of rows) {
    const manifest = extensionManifest.parse(version.manifest);
    if (manifest.scope === "node") {
      const checked = await validateNodeExtensionSettings(
        db,
        extension.id,
        manifest,
        await readNodeExtensionSettings(db, extension.id, manifest),
      );
      await assertNodeFeatures(
        db,
        checked.targetClusterIds,
        extensionRequiredFeatures(manifest),
        "nodes without extension support",
      );
    }
  }
}

export async function getNodeExtensionSettings(
  db: Executor,
  id: string,
): Promise<ExtensionNodeSettingsView> {
  const { manifest } = await requireNodeExtension(db, id);
  const settings = await readNodeExtensionSettings(db, id, manifest);
  return {
    id,
    settings,
    targetClusterIds: (await nodeExtensionClusters(db, settings)).map((cluster) => cluster.id),
  };
}

export async function checkNodeExtensionSettings(
  db: Database,
  input: { id: string; settings: unknown },
): Promise<ExtensionNodeSettingsView> {
  return db.transaction(async (tx) => {
    await lockListenerPorts(tx);
    const { extension, manifest } = await requireNodeExtension(tx, input.id);
    const checked = await validateNodeExtensionSettings(tx, input.id, manifest, input.settings);
    if (extension.enabled)
      await assertNodeFeatures(
        tx,
        checked.targetClusterIds,
        extensionRequiredFeatures(manifest),
        "nodes without extension support",
      );
    return {
      id: input.id,
      ...checked,
    };
  });
}

export async function updateNodeExtensionSettings(
  db: Database,
  input: { id: string; settings: unknown },
  actor: Actor,
): Promise<ExtensionNodeSettingsView> {
  return db.transaction(async (tx) => {
    await lockListenerPorts(tx);
    const { extension, manifest } = await requireNodeExtension(tx, input.id);
    const checked = await validateNodeExtensionSettings(tx, input.id, manifest, input.settings);
    if (extension.enabled)
      await assertNodeFeatures(
        tx,
        checked.targetClusterIds,
        extensionRequiredFeatures(manifest),
        "nodes without extension support",
      );
    const previousClusters = extension.enabled
      ? await nodeExtensionClusters(tx, await readNodeExtensionSettings(tx, input.id, manifest))
      : [];
    await tx
      .insert(schema.extensionNodeSetting)
      .values({ extensionId: input.id, settings: checked.settings })
      .onConflictDoUpdate({
        target: schema.extensionNodeSetting.extensionId,
        set: { settings: checked.settings, updatedAt: new Date() },
      });
    const revisions: Record<string, number> = {};
    if (extension.enabled) {
      const published = await publishClusters(
        tx,
        [...previousClusters.map((cluster) => cluster.id), ...checked.targetClusterIds],
        { reason: { code: "extension_updated", params: { extension: input.id } }, actor },
      );
      for (const [clusterId, result] of published) revisions[clusterId] = result.row.revision;
    }
    await recordAudit(tx, actor, {
      action: "extension.node_settings_update",
      targetType: "extension",
      targetId: input.id,
      targetName: manifest.name.en,
      metadata: {
        listeners: Object.keys(checked.settings.listeners),
        targetClusterIds: checked.targetClusterIds,
        revisions,
      },
    });
    return { id: input.id, ...checked };
  });
}
