import { randomUUID } from "node:crypto";
import { formatDomain, parseDomain } from "@edgeweir/config-compiler";
import type {
  Revision,
  Site,
  StarredSite,
  siteCreateInput,
  siteUpdateInput,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  ne,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type * as z from "zod";
import {
  cacheConditionLists,
  storedCacheExpression,
  structuredForm,
} from "../lib/cache-conditions";
import { readCacheKey } from "../lib/cache-key";
import { assertCertificateNames } from "../lib/certificate-names";
import type { MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { lockStats } from "../lib/locks";
import { readActiveHealthCheck, readSessionAffinity } from "../lib/pool-settings";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { defaultClusterId } from "./clusters";
import { assertOriginsAllowed } from "./origin-allow-list";
import {
  type Executor,
  latestRevision,
  listBindings,
  publisher,
  publishRevision,
  type Tx,
  toRevisionDto,
} from "./revisions";
import { actionOriginGroup, availableLists } from "./rules";
import { siteDeliveries } from "./site-delivery";
import { flushSiteUsage } from "./usage";

type SiteCreate = z.output<typeof siteCreateInput>;
type SiteUpdate = z.output<typeof siteUpdateInput>;
type OriginInput = SiteCreate["origins"][number];
type CacheRuleInput = SiteCreate["cacheRules"][number];
type OriginSettingsInput = SiteCreate["originSettings"];
type CacheSettingsInput = SiteCreate["cacheSettings"];

/** Envelope binding of an S3 secret access key: the column and the credential row (AAD). */
export const S3_SECRET_PURPOSE = "origin_credential.secret_envelope";
export const s3SecretBinding = (credentialId: string) => ({
  purpose: S3_SECRET_PURPOSE,
  recordId: credentialId,
});
/** The purpose version 1 envelopes were sealed with (no record id). */
export const LEGACY_S3_SECRET_PURPOSE = "origin-credential/s3-secret";

type SiteRow = typeof schema.site.$inferSelect;

async function toSiteDtos(db: Executor, rows: SiteRow[]): Promise<Site[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const domains = await db
    .select()
    .from(schema.siteDomain)
    .where(inArray(schema.siteDomain.siteId, ids))
    .orderBy(asc(schema.siteDomain.createdAt), asc(schema.siteDomain.name));
  const pools = await db
    .select()
    .from(schema.originPool)
    .where(inArray(schema.originPool.siteId, ids));
  const rules = await db
    .select()
    .from(schema.cacheRule)
    .where(inArray(schema.cacheRule.siteId, ids))
    .orderBy(asc(schema.cacheRule.priority), asc(schema.cacheRule.createdAt));
  const clusters = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster);
  const origins = pools.length
    ? await db
        .select()
        .from(schema.origin)
        .where(
          inArray(
            schema.origin.poolId,
            pools.map((p) => p.id),
          ),
        )
        .orderBy(asc(schema.origin.createdAt), asc(schema.origin.id))
    : [];
  const credentials = await db
    .select({ id: schema.originCredential.id, accessKeyId: schema.originCredential.accessKeyId })
    .from(schema.originCredential)
    .where(inArray(schema.originCredential.siteId, ids));
  const deliveries = await siteDeliveries(db, rows);
  return rows.map((r) => {
    const sitePools = pools
      .filter((p) => p.siteId === r.id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const poolIds = new Set(sitePools.map((p) => p.id));
    const pool = sitePools[0];
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      clusterId: r.clusterId,
      clusterName: clusters.find((c) => c.id === r.clusterId)?.name ?? "",
      delivery: deliveries.get(r.id) ?? {
        state: "pending",
        totalNodes: 0,
        servingNodes: 0,
        currentNodes: 0,
      },
      cacheGeneration: r.cacheGeneration,
      domains: domains.filter((d) => d.siteId === r.id).map(formatDomain),
      origins: origins
        .filter((o) => poolIds.has(o.poolId))
        .map((o) => ({
          id: o.id,
          address: o.address,
          port: o.port,
          scheme: o.scheme === "https" ? "https" : "http",
          weight: o.weight,
          backup: o.backup,
          hostHeader: o.hostHeader,
          sni: o.sni,
          group: o.groupName,
          s3: o.credentialId
            ? {
                region: o.s3Region,
                bucket: o.s3Bucket,
                accessKeyId: credentials.find((c) => c.id === o.credentialId)?.accessKeyId ?? "",
              }
            : null,
        })),
      cacheRules: rules
        .filter((c) => c.siteId === r.id)
        .map((c) => {
          const expression = storedCacheExpression(c);
          const structured = structuredForm(expression);
          return {
            id: c.id,
            priority: c.priority,
            expression,
            // The builder's form of the condition when it has one.
            pathPrefixes: structured?.pathPrefixes ?? [],
            paths: structured?.paths ?? [],
            extensions: structured?.extensions ?? [],
            statusCodes: c.statusCodes,
            minSizeBytes: c.minSizeBytes,
            maxSizeBytes: c.maxSizeBytes,
            action: c.action === "bypass" ? "bypass" : "cache",
            edgeTtlSeconds: c.edgeTtlSeconds,
            originCacheControl: c.originCacheControl === "respect" ? "respect" : "override",
            staleWhileRevalidateSeconds: c.staleWhileRevalidateSeconds,
            staleIfErrorSeconds: c.staleIfErrorSeconds,
            cacheAuthorized: c.cacheAuthorized,
            browserTtlSeconds: c.browserTtlSeconds,
          };
        }),
      originSettings: {
        policy: (pool?.policy ?? "weighted_random") as Site["originSettings"]["policy"],
        tlsVerify: pool?.tlsVerify ?? true,
        maxFails: pool?.maxFails ?? 3,
        recoverySeconds: pool?.recoverySeconds ?? 30,
        connectTimeoutMs: pool?.connectTimeoutMs ?? 10_000,
        sendTimeoutMs: pool?.sendTimeoutMs ?? 60_000,
        readTimeoutMs: pool?.readTimeoutMs ?? 60_000,
        keepalive: pool?.keepalive ?? true,
        keepaliveIdleSeconds: pool?.keepaliveIdleSeconds ?? 60,
        keepaliveMaxRequests: pool?.keepaliveMaxRequests ?? 1000,
        websocket: r.websocket,
        activeHealthCheck: readActiveHealthCheck(pool?.activeHealthCheck),
        sessionAffinity: readSessionAffinity(pool?.sessionAffinity),
      },
      cacheSettings: {
        cacheKey: readCacheKey(r.cacheKey),
        rangeSlice: r.rangeSlice,
        keepCacheTag: r.keepCacheTag,
      },
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** One page of sites, filtered by name/domain search and cluster. */
export async function listSites(
  db: Database,
  query: { search?: string; clusterId?: string; page: number; pageSize: number },
): Promise<{ items: Site[]; total: number }> {
  const filters: (SQL | undefined)[] = [];
  if (query.clusterId) filters.push(eq(schema.site.clusterId, query.clusterId));
  if (query.search) {
    const pattern = `%${query.search.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    filters.push(
      or(
        ilike(schema.site.name, pattern),
        exists(
          db
            .select({ one: sql`1` })
            .from(schema.siteDomain)
            .where(
              and(
                eq(schema.siteDomain.siteId, schema.site.id),
                // Wildcards are stored without "*." but match searches like "*.demo".
                ilike(
                  sql`case when ${schema.siteDomain.wildcard} then '*.' || ${schema.siteDomain.name} else ${schema.siteDomain.name} end`,
                  pattern,
                ),
              ),
            ),
        ),
      ),
    );
  }
  const where = and(...filters);
  const [total] = await db.select({ n: count() }).from(schema.site).where(where);
  const rows = await db
    .select()
    .from(schema.site)
    .where(where)
    .orderBy(asc(schema.site.createdAt), asc(schema.site.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { items: await toSiteDtos(db, rows), total: total?.n ?? 0 };
}

export async function findSite(db: Executor, id: string, lock = false) {
  const query = db.select().from(schema.site).where(eq(schema.site.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) fail("SITE_NOT_FOUND", "site not found");
  return row;
}

export async function getSite(db: Database, id: string): Promise<Site> {
  const row = await findSite(db, id);
  const [dto] = await toSiteDtos(db, [row]);
  if (!dto) fail("SITE_NOT_FOUND", "site not found");
  return dto;
}

function uniqueDomains(values: string[]) {
  return [...new Map(values.map((d) => [d, parseDomain(d)])).values()];
}

/**
 * Child rows inserted in one statement share now(); explicit, increasing
 * timestamps keep them in the order the user entered them.
 */
const ordered = (index: number, base = Date.now()) => new Date(base + index);

/**
 * Serializes changes to the same host names for the rest of the transaction,
 * so the check below and the insert after it cannot interleave.
 */
async function lockDomains(tx: Tx, names: string[]) {
  for (const name of [...new Set(names)].sort())
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.domain.${name}`}))`);
}

/** Every domain routes to exactly one site. */
async function assertDomainsFree(
  tx: Tx,
  domains: { name: string; wildcard: boolean }[],
  exceptSiteId?: string,
) {
  await lockDomains(
    tx,
    domains.map((d) => d.name),
  );
  const taken = await tx
    .select({ name: schema.siteDomain.name, wildcard: schema.siteDomain.wildcard })
    .from(schema.siteDomain)
    .where(
      and(
        or(
          ...domains.map((d) =>
            and(eq(schema.siteDomain.name, d.name), eq(schema.siteDomain.wildcard, d.wildcard)),
          ),
        ),
        exceptSiteId ? ne(schema.siteDomain.siteId, exceptSiteId) : undefined,
      ),
    );
  if (taken.length) {
    const list = taken.map(formatDomain).join(", ");
    fail("DOMAIN_IN_USE", `domain already in use: ${list}`, { domains: list });
  }
}

/**
 * Resolves the credential of every S3 origin: a given secret creates or
 * rotates the site's credential for that access key (version + 1); without a
 * secret the stored credential of the same access key is kept. Credentials no
 * origin uses any more are deleted.
 */
async function syncCredentials(
  tx: Tx,
  siteId: string,
  origins: OriginInput[],
  masterKey: MasterKey,
): Promise<Map<string, string>> {
  const existing = await tx
    .select()
    .from(schema.originCredential)
    .where(eq(schema.originCredential.siteId, siteId));
  const byKey = new Map(existing.map((c) => [c.accessKeyId, c]));
  const used = new Map<string, string>();
  for (const o of origins) {
    if (!o.s3) continue;
    const { accessKeyId, secretAccessKey } = o.s3;
    const current = byKey.get(accessKeyId);
    if (secretAccessKey) {
      // The id is part of the envelope's AAD, so a new row gets its id first.
      const id = current?.id ?? randomUUID();
      const secretEnvelope = JSON.stringify(masterKey.seal(secretAccessKey, s3SecretBinding(id)));
      if (current) {
        const [row] = await tx
          .update(schema.originCredential)
          .set({ secretEnvelope, version: current.version + 1 })
          .where(eq(schema.originCredential.id, current.id))
          .returning();
        if (row) byKey.set(accessKeyId, row);
      } else {
        const [row] = await tx
          .insert(schema.originCredential)
          .values({ id, siteId, accessKeyId, secretEnvelope })
          .returning();
        if (row) byKey.set(accessKeyId, row);
      }
    } else if (!current) {
      fail("S3_SECRET_REQUIRED", `secret access key required for ${accessKeyId}`, {
        accessKeyId,
      });
    }
    const credential = byKey.get(accessKeyId);
    if (credential) used.set(accessKeyId, credential.id);
  }
  const unused = existing.filter((c) => !used.has(c.accessKeyId)).map((c) => c.id);
  if (unused.length) {
    await tx.delete(schema.originCredential).where(inArray(schema.originCredential.id, unused));
  }
  return used;
}

/**
 * Writes a pool's origins in the given order. An existing origin with the
 * same scheme, address and port keeps its id (and with it the passive health
 * state nodes report for it); the others are inserted or deleted.
 */
async function writeOrigins(
  tx: Tx,
  pool: { id: string; siteId: string },
  origins: OriginInput[],
  masterKey: MasterKey,
) {
  const credentials = await syncCredentials(tx, pool.siteId, origins, masterKey);
  const existing = await tx
    .select({
      id: schema.origin.id,
      address: schema.origin.address,
      port: schema.origin.port,
      scheme: schema.origin.scheme,
    })
    .from(schema.origin)
    .where(eq(schema.origin.poolId, pool.id))
    .orderBy(asc(schema.origin.createdAt));
  const base = Date.now();
  const kept = new Set<string>();
  for (const [i, o] of origins.entries()) {
    const values = {
      createdAt: ordered(i, base),
      poolId: pool.id,
      address: o.address,
      port: o.port,
      scheme: o.scheme,
      weight: o.weight,
      backup: o.backup,
      hostHeader: o.hostHeader,
      sni: o.sni,
      groupName: o.group,
      credentialId: o.s3 ? (credentials.get(o.s3.accessKeyId) ?? null) : null,
      s3Region: o.s3?.region ?? "",
      s3Bucket: o.s3?.bucket ?? "",
    };
    const match = existing.find(
      (e) =>
        !kept.has(e.id) && e.address === o.address && e.port === o.port && e.scheme === o.scheme,
    );
    if (match) {
      kept.add(match.id);
      await tx.update(schema.origin).set(values).where(eq(schema.origin.id, match.id));
    } else {
      await tx.insert(schema.origin).values(values);
    }
  }
  const removed = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
  if (removed.length) await tx.delete(schema.origin).where(inArray(schema.origin.id, removed));
}

/** Pool columns of the settings; health check and affinity only when given (kept otherwise). */
function poolSettingsValues(
  settings: Omit<OriginSettingsInput, "activeHealthCheck" | "sessionAffinity"> &
    Partial<Pick<OriginSettingsInput, "activeHealthCheck" | "sessionAffinity">>,
) {
  return {
    policy: settings.policy,
    tlsVerify: settings.tlsVerify,
    maxFails: settings.maxFails,
    recoverySeconds: settings.recoverySeconds,
    connectTimeoutMs: settings.connectTimeoutMs,
    sendTimeoutMs: settings.sendTimeoutMs,
    readTimeoutMs: settings.readTimeoutMs,
    keepalive: settings.keepalive,
    keepaliveIdleSeconds: settings.keepaliveIdleSeconds,
    keepaliveMaxRequests: settings.keepaliveMaxRequests,
    ...(settings.activeHealthCheck ? { activeHealthCheck: settings.activeHealthCheck } : {}),
    ...(settings.sessionAffinity ? { sessionAffinity: settings.sessionAffinity } : {}),
  };
}

/** Site columns of the cache settings; keepCacheTag only when given (kept otherwise). */
function cacheSettingsValues(
  settings: Omit<CacheSettingsInput, "keepCacheTag"> & { keepCacheTag?: boolean },
) {
  return {
    cacheKey: settings.cacheKey,
    rangeSlice: settings.rangeSlice,
    ...(settings.keepCacheTag !== undefined ? { keepCacheTag: settings.keepCacheTag } : {}),
  };
}

/** Cache rule columns that make up a rule's content. */
const CACHE_RULE_FIELDS = [
  "priority",
  "expression",
  "listIds",
  "pathPrefixes",
  "paths",
  "extensions",
  "statusCodes",
  "minSizeBytes",
  "maxSizeBytes",
  "action",
  "edgeTtlSeconds",
  "originCacheControl",
  "staleWhileRevalidateSeconds",
  "staleIfErrorSeconds",
  "cacheAuthorized",
  "browserTtlSeconds",
] as const;

/**
 * Replaces a site's cache rules, with their condition as an expression (the
 * builder's expression of the structured lists when they have none) and
 * the IP lists it references; the structured columns stay empty.
 * Priorities are unique (an omitted one is the rule's position,
 * (index + 1) × 10), so rules apply in a fixed order; a rule saved
 * unchanged keeps its id, so saving the same rules again publishes nothing.
 */
async function replaceCacheRules(tx: Tx, site: { id: string }, rules: CacheRuleInput[]) {
  const priorities = new Set<number>();
  for (const [i, rule] of rules.entries()) {
    const priority = rule.priority ?? (i + 1) * 10;
    if (priorities.has(priority))
      fail("CACHE_RULE_PRIORITY_DUPLICATE", "cache rule priorities must be unique", { priority });
    priorities.add(priority);
  }
  const previous = await tx
    .delete(schema.cacheRule)
    .where(eq(schema.cacheRule.siteId, site.id))
    .returning();
  if (rules.length === 0) return;
  const expressions = rules.map(storedCacheExpression);
  const references = expressions.map((expression) => {
    try {
      return cacheConditionLists(expression);
    } catch (error) {
      return fail("RULE_INVALID", `invalid cache rule condition: ${(error as Error).message}`);
    }
  });
  const bindings = references.some((names) => names.length)
    ? listBindings(await availableLists(tx, true))
    : {};
  const listIds = references.map((names) =>
    names.map((name) => {
      const id = bindings[name];
      if (!id) fail("IP_LIST_NOT_FOUND", "expression references an unavailable IP list");
      return id;
    }),
  );
  const values = rules.map((r, i) => ({
    priority: r.priority ?? (i + 1) * 10,
    expression: expressions[i] ?? "true",
    listIds: listIds[i] ?? [],
    pathPrefixes: [],
    paths: [],
    extensions: [],
    statusCodes: r.statusCodes,
    minSizeBytes: r.minSizeBytes,
    maxSizeBytes: r.maxSizeBytes,
    action: r.action,
    edgeTtlSeconds: r.edgeTtlSeconds,
    originCacheControl: r.originCacheControl,
    staleWhileRevalidateSeconds: r.staleWhileRevalidateSeconds,
    staleIfErrorSeconds: r.staleIfErrorSeconds,
    cacheAuthorized: r.cacheAuthorized,
    browserTtlSeconds: r.browserTtlSeconds,
  }));
  const content = (rule: Partial<Record<(typeof CACHE_RULE_FIELDS)[number], unknown>>) =>
    JSON.stringify(CACHE_RULE_FIELDS.map((field) => rule[field]));
  const ids = new Map<string, string[]>();
  for (const row of previous) ids.set(content(row), [...(ids.get(content(row)) ?? []), row.id]);
  await tx.insert(schema.cacheRule).values(
    values.map((rule, i) => {
      const id = ids.get(content(rule))?.shift();
      return { ...(id ? { id } : {}), createdAt: ordered(i), siteId: site.id, ...rule };
    }),
  );
}

/** Refuses origins without a group that a rule of the site still chooses. */
async function assertRuleGroups(tx: Tx, siteId: string, origins: OriginInput[]) {
  const groups = new Set(origins.map((origin) => origin.group));
  const rules = await tx
    .select({ name: schema.edgeRule.name, action: schema.edgeRule.action })
    .from(schema.edgeRule)
    .where(eq(schema.edgeRule.siteId, siteId));
  for (const rule of rules) {
    const group = actionOriginGroup(rule.action);
    if (group && !groups.has(group))
      fail("RULE_INVALID", `origin group ${group} is used by rule ${rule.name}`);
  }
}

/** The site's origin pool (the oldest one; sites have exactly one). */
async function sitePool(tx: Tx, siteId: string) {
  let [pool] = await tx
    .select()
    .from(schema.originPool)
    .where(eq(schema.originPool.siteId, siteId))
    .orderBy(asc(schema.originPool.createdAt))
    .limit(1);
  if (!pool) [pool] = await tx.insert(schema.originPool).values({ siteId }).returning();
  if (!pool) throw new Error("origin pool missing");
  return pool;
}

/**
 * Creates a site with its domains, origin pool and cache rules, then publishes
 * a new revision for the site's cluster in the same transaction. Without an
 * explicit cluster the site lands on the default (oldest) cluster.
 */
export async function createSite(
  db: Database,
  input: SiteCreate,
  ctx: { actor: Actor; masterKey: MasterKey },
): Promise<{ site: Site; revision: Revision }> {
  const domains = uniqueDomains(input.domains);
  return db.transaction(async (tx) => {
    const clusterId = input.clusterId ?? (await defaultClusterId(tx));
    const [clusterRow] = await tx
      .select({ id: schema.cluster.id })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    if (!clusterRow) fail("CLUSTER_NOT_FOUND", "cluster not found");
    await assertDomainsFree(tx, domains);
    await assertOriginsAllowed(tx, input.origins);

    const [siteRow] = await tx
      .insert(schema.site)
      .values({
        clusterId,
        name: input.name,
        websocket: input.originSettings.websocket,
        ...cacheSettingsValues(input.cacheSettings),
      })
      .returning();
    if (!siteRow) throw new Error("site insert failed");
    await tx
      .insert(schema.siteDomain)
      .values(domains.map((d, i) => ({ siteId: siteRow.id, createdAt: ordered(i), ...d })));
    const [pool] = await tx
      .insert(schema.originPool)
      .values({ siteId: siteRow.id, ...poolSettingsValues(input.originSettings) })
      .returning();
    if (!pool) throw new Error("origin pool insert failed");
    await writeOrigins(tx, pool, input.origins, ctx.masterKey);
    await replaceCacheRules(tx, siteRow, input.cacheRules);
    const { row: revision } = await publishRevision(tx, {
      clusterId,
      reason: { code: "site_created", params: { site: input.name } },
      userId: publisher(ctx.actor),
      site: siteRow.id,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.create",
      targetType: "site",
      targetId: siteRow.id,
      targetName: siteRow.name,
      metadata: { name: input.name, domains: input.domains, revision: revision.revision },
    });
    const [dto] = await toSiteDtos(tx, [siteRow]);
    if (!dto) throw new Error("site not readable after insert");
    return { site: dto, revision: toRevisionDto(revision) };
  });
}

/**
 * Updates a site's name, domains, origins and/or cache rules. Every save
 * publishes a new revision (unless the compiled configuration is unchanged,
 * in which case the current revision is returned).
 */
export async function updateSite(
  db: Database,
  input: SiteUpdate,
  ctx: { actor: Actor; masterKey: MasterKey },
): Promise<{ site: Site; revision: Revision }> {
  return db.transaction(async (tx) => {
    const row = await findSite(tx, input.id, true);
    const changed: string[] = [];
    if (input.name !== undefined && input.name !== row.name) {
      await tx.update(schema.site).set({ name: input.name }).where(eq(schema.site.id, row.id));
      changed.push("name");
    }
    if (input.domains) {
      const domains = uniqueDomains(input.domains);
      if (row.certificateId) {
        const [certificate] = await tx
          .select()
          .from(schema.certificate)
          .where(eq(schema.certificate.id, row.certificateId));
        if (!certificate) fail("CERTIFICATE_NOT_FOUND", "bound certificate not found");
        assertCertificateNames(certificate.chainPem, certificate.names, domains);
      }
      await assertDomainsFree(tx, domains, row.id);
      await tx.delete(schema.siteDomain).where(eq(schema.siteDomain.siteId, row.id));
      await tx
        .insert(schema.siteDomain)
        .values(domains.map((d, i) => ({ siteId: row.id, createdAt: ordered(i), ...d })));
      changed.push("domains");
    }
    if (input.origins) {
      await assertOriginsAllowed(tx, input.origins);
      await assertRuleGroups(tx, row.id, input.origins);
      const pool = await sitePool(tx, row.id);
      await writeOrigins(tx, pool, input.origins, ctx.masterKey);
      changed.push("origins");
    }
    if (input.originSettings) {
      const pool = await sitePool(tx, row.id);
      await tx
        .update(schema.originPool)
        .set(poolSettingsValues(input.originSettings))
        .where(eq(schema.originPool.id, pool.id));
      await tx
        .update(schema.site)
        .set({ websocket: input.originSettings.websocket })
        .where(eq(schema.site.id, row.id));
      changed.push("originSettings");
    }
    if (input.cacheSettings) {
      await tx
        .update(schema.site)
        .set(cacheSettingsValues(input.cacheSettings))
        .where(eq(schema.site.id, row.id));
      changed.push("cacheSettings");
    }
    if (input.cacheRules) {
      await replaceCacheRules(tx, row, input.cacheRules);
      changed.push("cacheRules");
    }
    // Touch updated_at even when only child rows changed.
    const [updated] = await tx
      .update(schema.site)
      .set({ updatedAt: new Date() })
      .where(eq(schema.site.id, row.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "site_updated", params: { site: updated.name } },
      userId: publisher(ctx.actor),
      site: row.id,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.update",
      targetType: "site",
      targetId: row.id,
      targetName: updated.name,
      metadata: {
        changed,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.domains ? { domains: input.domains } : {}),
        ...(input.origins
          ? { origins: input.origins.map((o) => `${o.scheme}://${o.address}:${o.port}`) }
          : {}),
        ...(input.cacheRules ? { cacheRules: input.cacheRules.length } : {}),
        ...(input.originSettings ? { originSettings: input.originSettings } : {}),
        ...(input.cacheSettings ? { cacheSettings: input.cacheSettings } : {}),
        revision: revision.revision,
      },
    });
    const [dto] = await toSiteDtos(tx, [updated]);
    if (!dto) throw new Error("site not readable after update");
    return { site: dto, revision: toRevisionDto(revision) };
  });
}

export async function deleteSite(
  db: Database,
  id: string,
  ctx: { actor: Actor },
): Promise<{ revision: Revision }> {
  return db.transaction(async (tx) => {
    // Its statistics go with the site: no ingestion or rollup may be in
    // flight, and the usage of windows not computed yet is computed first.
    await lockStats(tx, "exclusive");
    const row = await findSite(tx, id);
    await flushSiteUsage(tx, row.id);
    await tx.delete(schema.site).where(eq(schema.site.id, row.id));
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "site_deleted", params: { site: row.name } },
      userId: publisher(ctx.actor),
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.delete",
      targetType: "site",
      targetId: row.id,
      targetName: row.name,
      metadata: { name: row.name, revision: revision.revision },
    });
    return { revision: toRevisionDto(revision) };
  });
}

/**
 * Turns a site on or off. Unchanged state returns the current site and
 * revision without a new revision or audit entry; a change publishes the
 * cluster and writes the audit entry in the same transaction.
 */
export async function setSiteEnabled(
  db: Database,
  input: { id: string; enabled: boolean; expectedUpdatedAt?: string },
  ctx: { actor: Actor },
): Promise<{ site: Site; revision: Revision }> {
  return db.transaction(async (tx) => {
    const row = await findSite(tx, input.id, true);
    if (row.enabled === input.enabled) {
      const latest = await latestRevision(tx, row.clusterId);
      if (!latest) throw new Error("cluster has no revision");
      const [dto] = await toSiteDtos(tx, [row]);
      if (!dto) throw new Error("site not readable");
      return { site: dto, revision: toRevisionDto(latest) };
    }
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const [updated] = await tx
      .update(schema.site)
      .set({ enabled: input.enabled, updatedAt: new Date() })
      .where(eq(schema.site.id, row.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const action = input.enabled ? "enable" : "disable";
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: {
        code: input.enabled ? "site_enabled" : "site_disabled",
        params: { site: row.name },
      },
      userId: publisher(ctx.actor),
      site: row.id,
    });
    await recordAudit(tx, ctx.actor, {
      action: `site.${action}`,
      targetType: "site",
      targetId: row.id,
      targetName: row.name,
      metadata: { revision: revision.revision },
    });
    const [dto] = await toSiteDtos(tx, [updated]);
    if (!dto) throw new Error("site not readable after update");
    return { site: dto, revision: toRevisionDto(revision) };
  });
}

export async function countSites(db: Database): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.site);
  return row?.n ?? 0;
}

/** The user's starred sites, most recently starred first. */
export async function starredSites(db: Database, userId: string): Promise<StarredSite[]> {
  const rows = await db
    .select({ id: schema.site.id, name: schema.site.name })
    .from(schema.siteStar)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteStar.siteId))
    .where(eq(schema.siteStar.userId, userId))
    .orderBy(desc(schema.siteStar.createdAt), asc(schema.site.name));
  if (rows.length === 0) return [];
  const domains = await db
    .select()
    .from(schema.siteDomain)
    .where(
      inArray(
        schema.siteDomain.siteId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(schema.siteDomain.createdAt), asc(schema.siteDomain.name));
  return rows.map((r) => ({
    ...r,
    domains: domains.filter((d) => d.siteId === r.id).map(formatDomain),
  }));
}

/** Stars or un-stars a visible site for the user (a personal preference, not audited). */
export async function setSiteStarred(
  db: Database,
  input: { userId: string; siteId: string; starred: boolean },
): Promise<void> {
  const row = await findSite(db, input.siteId);
  if (input.starred) {
    await db
      .insert(schema.siteStar)
      .values({ userId: input.userId, siteId: row.id })
      .onConflictDoNothing();
  } else {
    await db
      .delete(schema.siteStar)
      .where(and(eq(schema.siteStar.userId, input.userId), eq(schema.siteStar.siteId, row.id)));
  }
}
