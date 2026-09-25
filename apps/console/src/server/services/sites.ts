import { formatDomain, parseDomain } from "@edgeweir/config-compiler";
import type { Revision, Site, siteCreateInput, siteUpdateInput } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, count, eq, exists, ilike, inArray, ne, or, type SQL, sql } from "drizzle-orm";
import type * as z from "zod";
import { readCacheKey } from "../lib/cache-key";
import type { MasterKey } from "../lib/envelope";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { defaultClusterId } from "./clusters";
import { type Executor, publishRevision, type Tx, toRevisionDto } from "./revisions";

type SiteCreate = z.output<typeof siteCreateInput>;
type SiteUpdate = z.output<typeof siteUpdateInput>;
type OriginInput = SiteCreate["origins"][number];
type CacheRuleInput = SiteCreate["cacheRules"][number];
type OriginSettingsInput = SiteCreate["originSettings"];
type CacheSettingsInput = SiteCreate["cacheSettings"];

/** Envelope purpose of S3 secret access keys (bound as AAD). */
export const S3_SECRET_PURPOSE = "origin-credential/s3-secret";

/** Which sites a caller may see: all (platform admin) or one organization. */
export type SiteScope = { all: true } | { all: false; organizationId: string };

function scopeFilter(scope: SiteScope) {
  return scope.all ? undefined : eq(schema.site.organizationId, scope.organizationId);
}

const userId = (actor: Actor) => (actor.type === "user" ? actor.id : null);

async function toSiteDtos(
  db: Executor,
  rows: (typeof schema.site.$inferSelect)[],
): Promise<Site[]> {
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
  const orgs = await db
    .select({ id: schema.organization.id, name: schema.organization.name })
    .from(schema.organization)
    .where(inArray(schema.organization.id, [...new Set(rows.map((r) => r.organizationId))]));
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
      organizationId: r.organizationId,
      organizationName: orgs.find((o) => o.id === r.organizationId)?.name ?? "",
      clusterId: r.clusterId,
      clusterName: clusters.find((c) => c.id === r.clusterId)?.name ?? "",
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
        .map((c) => ({
          id: c.id,
          priority: c.priority,
          pathPrefixes: c.pathPrefixes,
          paths: c.paths,
          extensions: c.extensions,
          statusCodes: c.statusCodes,
          minSizeBytes: c.minSizeBytes,
          maxSizeBytes: c.maxSizeBytes,
          action: c.action === "bypass" ? "bypass" : "cache",
          edgeTtlSeconds: c.edgeTtlSeconds,
          originCacheControl: c.originCacheControl === "respect" ? "respect" : "override",
          staleWhileRevalidateSeconds: c.staleWhileRevalidateSeconds,
          staleIfErrorSeconds: c.staleIfErrorSeconds,
        })),
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
      },
      cacheSettings: { cacheKey: readCacheKey(r.cacheKey), rangeSlice: r.rangeSlice },
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
}

/** All sites of the scope, oldest first (overview statistics). */
export async function allSites(db: Database, scope: SiteScope): Promise<Site[]> {
  const rows = await db
    .select()
    .from(schema.site)
    .where(scopeFilter(scope))
    .orderBy(asc(schema.site.createdAt));
  return toSiteDtos(db, rows);
}

/** One page of sites, filtered by name/domain search and (for admins) cluster. */
export async function listSites(
  db: Database,
  scope: SiteScope,
  query: { search?: string; clusterId?: string; page: number; pageSize: number },
): Promise<{ items: Site[]; total: number }> {
  const filters: (SQL | undefined)[] = [scopeFilter(scope)];
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

export async function findSite(db: Executor, id: string, scope: SiteScope) {
  const [row] = await db
    .select()
    .from(schema.site)
    .where(and(eq(schema.site.id, id), scopeFilter(scope)));
  if (!row) fail("SITE_NOT_FOUND", "site not found");
  return row;
}

export async function getSite(db: Database, id: string, scope: SiteScope): Promise<Site> {
  const row = await findSite(db, id, scope);
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

/** Every domain routes to exactly one site across the platform. */
async function assertDomainsFree(
  tx: Tx,
  domains: { name: string; wildcard: boolean }[],
  exceptSiteId?: string,
) {
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
      const secretEnvelope = JSON.stringify(masterKey.seal(secretAccessKey, S3_SECRET_PURPOSE));
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
          .values({ siteId, accessKeyId, secretEnvelope })
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

function poolSettingsValues(settings: OriginSettingsInput) {
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
  };
}

function cacheSettingsValues(settings: CacheSettingsInput) {
  return { cacheKey: settings.cacheKey, rangeSlice: settings.rangeSlice };
}

async function insertCacheRules(tx: Tx, siteId: string, rules: CacheRuleInput[]) {
  if (rules.length === 0) return;
  await tx.insert(schema.cacheRule).values(
    rules.map((r, i) => ({
      createdAt: ordered(i),
      siteId,
      priority: r.priority,
      pathPrefixes: r.pathPrefixes,
      paths: r.paths,
      extensions: r.extensions,
      statusCodes: r.statusCodes,
      minSizeBytes: r.minSizeBytes,
      maxSizeBytes: r.maxSizeBytes,
      action: r.action,
      edgeTtlSeconds: r.edgeTtlSeconds,
      originCacheControl: r.originCacheControl,
      staleWhileRevalidateSeconds: r.staleWhileRevalidateSeconds,
      staleIfErrorSeconds: r.staleIfErrorSeconds,
    })),
  );
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
 * explicit cluster the site lands on the organization's default cluster.
 */
export async function createSite(
  db: Database,
  input: SiteCreate,
  ctx: { organizationId: string; actor: Actor; masterKey: MasterKey },
): Promise<{ site: Site; revision: Revision }> {
  const domains = uniqueDomains(input.domains);
  return db.transaction(async (tx) => {
    const clusterId = input.clusterId ?? (await defaultClusterId(tx, ctx.organizationId));
    const [clusterRow] = await tx
      .select({ id: schema.cluster.id })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    if (!clusterRow) fail("CLUSTER_NOT_FOUND", "cluster not found");
    await assertDomainsFree(tx, domains);

    const [siteRow] = await tx
      .insert(schema.site)
      .values({
        organizationId: ctx.organizationId,
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
    await insertCacheRules(tx, siteRow.id, input.cacheRules);
    const { row: revision } = await publishRevision(tx, {
      clusterId,
      reason: { code: "site_created", params: { site: input.name } },
      userId: userId(ctx.actor),
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.create",
      organizationId: ctx.organizationId,
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
  ctx: { scope: SiteScope; actor: Actor; masterKey: MasterKey },
): Promise<{ site: Site; revision: Revision }> {
  return db.transaction(async (tx) => {
    const row = await findSite(tx, input.id, ctx.scope);
    const changed: string[] = [];
    if (input.name !== undefined && input.name !== row.name) {
      await tx.update(schema.site).set({ name: input.name }).where(eq(schema.site.id, row.id));
      changed.push("name");
    }
    if (input.domains) {
      const domains = uniqueDomains(input.domains);
      await assertDomainsFree(tx, domains, row.id);
      await tx.delete(schema.siteDomain).where(eq(schema.siteDomain.siteId, row.id));
      await tx
        .insert(schema.siteDomain)
        .values(domains.map((d, i) => ({ siteId: row.id, createdAt: ordered(i), ...d })));
      changed.push("domains");
    }
    if (input.origins) {
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
      await tx.delete(schema.cacheRule).where(eq(schema.cacheRule.siteId, row.id));
      await insertCacheRules(tx, row.id, input.cacheRules);
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
      userId: userId(ctx.actor),
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.update",
      organizationId: row.organizationId,
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
  ctx: { scope: SiteScope; actor: Actor },
): Promise<{ revision: Revision }> {
  return db.transaction(async (tx) => {
    const row = await findSite(tx, id, ctx.scope);
    await tx.delete(schema.site).where(eq(schema.site.id, row.id));
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "site_deleted", params: { site: row.name } },
      userId: userId(ctx.actor),
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.delete",
      organizationId: row.organizationId,
      targetType: "site",
      targetId: row.id,
      targetName: row.name,
      metadata: { name: row.name, revision: revision.revision },
    });
    return { revision: toRevisionDto(revision) };
  });
}

/** Invalidates every cached object of a site by bumping its cache generation. */
export async function purgeSite(
  db: Database,
  id: string,
  ctx: { scope: SiteScope; actor: Actor },
): Promise<{ site: Site; revision: Revision }> {
  return db.transaction(async (tx) => {
    const row = await findSite(tx, id, ctx.scope);
    const [updated] = await tx
      .update(schema.site)
      .set({ cacheGeneration: sql`${schema.site.cacheGeneration} + 1` })
      .where(eq(schema.site.id, row.id))
      .returning();
    if (!updated) throw new Error("site update failed");
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "site_purged", params: { site: row.name } },
      userId: userId(ctx.actor),
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.purge_all",
      organizationId: row.organizationId,
      targetType: "site",
      targetId: row.id,
      targetName: row.name,
      metadata: { cacheGeneration: updated.cacheGeneration, revision: revision.revision },
    });
    const [dto] = await toSiteDtos(tx, [updated]);
    if (!dto) throw new Error("site not readable after update");
    return { site: dto, revision: toRevisionDto(revision) };
  });
}
