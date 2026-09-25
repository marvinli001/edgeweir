import { formatDomain, parseDomain } from "@edgeweir/config-compiler";
import type { Revision, Site, siteCreateInput } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import type * as z from "zod";
import { type Actor, recordAudit } from "./audit";
import { defaultClusterId } from "./clusters";
import { type Executor, publishRevision, toRevisionDto } from "./revisions";

type SiteCreate = z.output<typeof siteCreateInput>;

/** Which sites a caller may see: all (platform admin) or one organization. */
export type SiteScope = { all: true } | { all: false; organizationId: string };

function scopeFilter(scope: SiteScope) {
  return scope.all ? undefined : eq(schema.site.organizationId, scope.organizationId);
}

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
    .orderBy(asc(schema.cacheRule.priority), asc(schema.cacheRule.id));
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
  return rows.map((r) => {
    const poolIds = new Set(pools.filter((p) => p.siteId === r.id).map((p) => p.id));
    return {
      id: r.id,
      name: r.name,
      enabled: r.enabled,
      organizationId: r.organizationId,
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

export async function listSites(db: Database, scope: SiteScope): Promise<Site[]> {
  const rows = await db
    .select()
    .from(schema.site)
    .where(scopeFilter(scope))
    .orderBy(asc(schema.site.createdAt));
  return toSiteDtos(db, rows);
}

async function findSite(db: Executor, id: string, scope: SiteScope) {
  const [row] = await db
    .select()
    .from(schema.site)
    .where(and(eq(schema.site.id, id), scopeFilter(scope)));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "site not found" });
  return row;
}

export async function getSite(db: Database, id: string, scope: SiteScope): Promise<Site> {
  const row = await findSite(db, id, scope);
  const [dto] = await toSiteDtos(db, [row]);
  if (!dto) throw new ORPCError("NOT_FOUND", { message: "site not found" });
  return dto;
}

/**
 * Creates a site with its domains, origin pool and cache rules, then publishes
 * a new revision for the site's cluster in the same transaction.
 */
export async function createSite(
  db: Database,
  input: SiteCreate,
  ctx: { organizationId: string; actor: Actor },
): Promise<{ site: Site; revision: Revision }> {
  const domains = [...new Map(input.domains.map((d) => [d, parseDomain(d)])).values()];
  return db.transaction(async (tx) => {
    const clusterId = input.clusterId ?? (await defaultClusterId(tx));
    const [clusterRow] = await tx
      .select({ id: schema.cluster.id })
      .from(schema.cluster)
      .where(eq(schema.cluster.id, clusterId));
    if (!clusterRow) throw new ORPCError("NOT_FOUND", { message: "cluster not found" });

    const taken = await tx
      .select({ name: schema.siteDomain.name, wildcard: schema.siteDomain.wildcard })
      .from(schema.siteDomain)
      .where(
        or(
          ...domains.map((d) =>
            and(eq(schema.siteDomain.name, d.name), eq(schema.siteDomain.wildcard, d.wildcard)),
          ),
        ),
      );
    if (taken.length) {
      throw new ORPCError("CONFLICT", {
        message: `domain already in use: ${taken.map(formatDomain).join(", ")}`,
      });
    }

    const [siteRow] = await tx
      .insert(schema.site)
      .values({ organizationId: ctx.organizationId, clusterId, name: input.name })
      .returning();
    if (!siteRow) throw new Error("site insert failed");
    await tx.insert(schema.siteDomain).values(domains.map((d) => ({ siteId: siteRow.id, ...d })));
    const [pool] = await tx.insert(schema.originPool).values({ siteId: siteRow.id }).returning();
    if (!pool) throw new Error("origin pool insert failed");
    await tx.insert(schema.origin).values(
      input.origins.map((o) => ({
        poolId: pool.id,
        address: o.address,
        port: o.port,
        scheme: o.scheme,
        weight: o.weight,
        backup: o.backup,
        hostHeader: o.hostHeader,
      })),
    );
    if (input.cacheRules.length) {
      await tx.insert(schema.cacheRule).values(
        input.cacheRules.map((r) => ({
          siteId: siteRow.id,
          priority: r.priority,
          pathPrefixes: r.pathPrefixes,
          extensions: r.extensions,
          action: r.action,
          edgeTtlSeconds: r.edgeTtlSeconds,
          originCacheControl: r.originCacheControl,
        })),
      );
    }
    const { row: revision } = await publishRevision(tx, {
      clusterId,
      reason: `site ${input.name} created`,
      userId: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.create",
      organizationId: ctx.organizationId,
      targetType: "site",
      targetId: siteRow.id,
      metadata: { name: input.name, domains: input.domains, revision: revision.revision },
    });
    const [dto] = await toSiteDtos(tx, [siteRow]);
    if (!dto) throw new Error("site not readable after insert");
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
      reason: `site ${row.name} deleted`,
      userId: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.delete",
      organizationId: row.organizationId,
      targetType: "site",
      targetId: row.id,
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
      reason: `site ${row.name} purged`,
      userId: ctx.actor.type === "user" ? ctx.actor.id : null,
    });
    await recordAudit(tx, ctx.actor, {
      action: "site.purge_all",
      organizationId: row.organizationId,
      targetType: "site",
      targetId: row.id,
      metadata: { cacheGeneration: updated.cacheGeneration, revision: revision.revision },
    });
    const [dto] = await toSiteDtos(tx, [updated]);
    if (!dto) throw new Error("site not readable after update");
    return { site: dto, revision: toRevisionDto(revision) };
  });
}
