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
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { defaultClusterId } from "./clusters";
import { type Executor, publishRevision, type Tx, toRevisionDto } from "./revisions";

type SiteCreate = z.output<typeof siteCreateInput>;
type SiteUpdate = z.output<typeof siteUpdateInput>;
type OriginInput = SiteCreate["origins"][number];
type CacheRuleInput = SiteCreate["cacheRules"][number];

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
  return rows.map((r) => {
    const poolIds = new Set(pools.filter((p) => p.siteId === r.id).map((p) => p.id));
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
        })),
      cacheRules: rules
        .filter((c) => c.siteId === r.id)
        .map((c) => ({
          id: c.id,
          priority: c.priority,
          pathPrefixes: c.pathPrefixes,
          extensions: c.extensions,
          action: c.action === "bypass" ? "bypass" : "cache",
          edgeTtlSeconds: c.edgeTtlSeconds,
          originCacheControl: c.originCacheControl === "respect" ? "respect" : "override",
        })),
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    };
  });
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

async function findSite(db: Executor, id: string, scope: SiteScope) {
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

async function insertOrigins(tx: Tx, poolId: string, origins: OriginInput[]) {
  await tx.insert(schema.origin).values(
    origins.map((o, i) => ({
      createdAt: ordered(i),
      poolId,
      address: o.address,
      port: o.port,
      scheme: o.scheme,
      weight: o.weight,
      backup: o.backup,
      hostHeader: o.hostHeader,
    })),
  );
}

async function insertCacheRules(tx: Tx, siteId: string, rules: CacheRuleInput[]) {
  if (rules.length === 0) return;
  await tx.insert(schema.cacheRule).values(
    rules.map((r, i) => ({
      createdAt: ordered(i),
      siteId,
      priority: r.priority,
      pathPrefixes: r.pathPrefixes,
      extensions: r.extensions,
      action: r.action,
      edgeTtlSeconds: r.edgeTtlSeconds,
      originCacheControl: r.originCacheControl,
    })),
  );
}

/**
 * Creates a site with its domains, origin pool and cache rules, then publishes
 * a new revision for the site's cluster in the same transaction. Without an
 * explicit cluster the site lands on the organization's default cluster.
 */
export async function createSite(
  db: Database,
  input: SiteCreate,
  ctx: { organizationId: string; actor: Actor },
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
      .values({ organizationId: ctx.organizationId, clusterId, name: input.name })
      .returning();
    if (!siteRow) throw new Error("site insert failed");
    await tx
      .insert(schema.siteDomain)
      .values(domains.map((d, i) => ({ siteId: siteRow.id, createdAt: ordered(i), ...d })));
    const [pool] = await tx.insert(schema.originPool).values({ siteId: siteRow.id }).returning();
    if (!pool) throw new Error("origin pool insert failed");
    await insertOrigins(tx, pool.id, input.origins);
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
  ctx: { scope: SiteScope; actor: Actor },
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
      let [pool] = await tx
        .select()
        .from(schema.originPool)
        .where(eq(schema.originPool.siteId, row.id))
        .orderBy(asc(schema.originPool.createdAt))
        .limit(1);
      if (!pool) [pool] = await tx.insert(schema.originPool).values({ siteId: row.id }).returning();
      if (!pool) throw new Error("origin pool missing");
      await tx.delete(schema.origin).where(eq(schema.origin.poolId, pool.id));
      await insertOrigins(tx, pool.id, input.origins);
      changed.push("origins");
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

export async function countSites(db: Database, scope: SiteScope): Promise<number> {
  const [row] = await db.select({ n: count() }).from(schema.site).where(scopeFilter(scope));
  return row?.n ?? 0;
}

/** The user's starred sites within the scope, most recently starred first. */
export async function starredSites(
  db: Database,
  scope: SiteScope,
  userId: string,
): Promise<StarredSite[]> {
  const rows = await db
    .select({ id: schema.site.id, name: schema.site.name })
    .from(schema.siteStar)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteStar.siteId))
    .where(and(eq(schema.siteStar.userId, userId), scopeFilter(scope)))
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
  scope: SiteScope,
  input: { userId: string; siteId: string; starred: boolean },
): Promise<void> {
  const row = await findSite(db, input.siteId, scope);
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
