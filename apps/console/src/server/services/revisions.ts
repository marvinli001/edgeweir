import {
  compileNodeConfig,
  decodeNodeConfig,
  encodeNodeConfig,
  type SiteModel,
} from "@edgeweir/config-compiler";
import type { Revision } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import type { NodeConfig } from "@edgeweir/proto";
import { and, asc, desc, eq, inArray, lt, sql } from "drizzle-orm";
import { CONFIG_CHANNEL } from "../lib/events";

export type Tx = Parameters<Parameters<Database["transaction"]>[0]>[0];
export type Executor = Database | Tx;

export const REVISION_RETENTION = 200;

type RevisionRow = typeof schema.configRevision.$inferSelect;

export function toRevisionDto(row: RevisionRow): Revision {
  return {
    clusterId: row.clusterId,
    revision: row.revision,
    contentHash: row.contentHash,
    siteCount: row.siteCount,
    reason: row.reason,
    createdAt: row.createdAt.toISOString(),
  };
}

/** Loads every site of a cluster with its domains, origins and rules. */
export async function loadSiteModels(db: Executor, clusterId: string): Promise<SiteModel[]> {
  const sites = await db
    .select()
    .from(schema.site)
    .where(eq(schema.site.clusterId, clusterId))
    .orderBy(asc(schema.site.id));
  if (sites.length === 0) return [];
  const siteIds = sites.map((s) => s.id);
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const domains = await db
    .select()
    .from(schema.siteDomain)
    .where(inArray(schema.siteDomain.siteId, siteIds));
  const pools = await db
    .select()
    .from(schema.originPool)
    .where(inArray(schema.originPool.siteId, siteIds));
  const rules = await db
    .select()
    .from(schema.cacheRule)
    .where(inArray(schema.cacheRule.siteId, siteIds));
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
    : [];

  return sites.map((s): SiteModel => {
    const pool = pools.find((p) => p.siteId === s.id);
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      cacheGeneration: s.cacheGeneration,
      domains: domains
        .filter((d) => d.siteId === s.id)
        .map((d) => ({ name: d.name, wildcard: d.wildcard })),
      originPool: {
        id: pool?.id ?? s.id,
        policy: (pool?.policy ?? "weighted_random") as SiteModel["originPool"]["policy"],
        origins: origins
          .filter((o) => o.poolId === pool?.id)
          .map((o) => ({
            id: o.id,
            address: o.address,
            port: o.port,
            scheme: o.scheme === "https" ? "https" : "http",
            weight: o.weight,
            backup: o.backup,
            hostHeader: o.hostHeader,
            sni: o.sni,
          })),
      },
      cacheRules: rules
        .filter((r) => r.siteId === s.id)
        .map((r) => ({
          id: r.id,
          priority: r.priority,
          pathPrefixes: r.pathPrefixes,
          extensions: r.extensions,
          expression: r.expression,
          action: r.action === "bypass" ? "bypass" : "cache",
          edgeTtlSeconds: r.edgeTtlSeconds,
          originCacheControl: r.originCacheControl === "respect" ? "respect" : "override",
        })),
    };
  });
}

export async function latestRevision(
  db: Executor,
  clusterId: string,
): Promise<RevisionRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.configRevision)
    .where(eq(schema.configRevision.clusterId, clusterId))
    .orderBy(desc(schema.configRevision.revision))
    .limit(1);
  return row;
}

export async function getRevision(
  db: Executor,
  clusterId: string,
  revision: number,
): Promise<RevisionRow | undefined> {
  const [row] = await db
    .select()
    .from(schema.configRevision)
    .where(
      and(
        eq(schema.configRevision.clusterId, clusterId),
        eq(schema.configRevision.revision, revision),
      ),
    );
  return row;
}

async function insertRevision(
  tx: Tx,
  clusterId: string,
  build: (revision: bigint) => NodeConfig,
  reason: string,
  userId: string | null,
): Promise<{ row: RevisionRow; created: boolean }> {
  const latest = await latestRevision(tx, clusterId);
  const next = BigInt((latest?.revision ?? 0) + 1);
  const config = build(next);
  if (latest && latest.contentHash === config.contentHash) {
    return { row: latest, created: false };
  }
  const [row] = await tx
    .insert(schema.configRevision)
    .values({
      clusterId,
      revision: Number(next),
      contentHash: config.contentHash,
      ir: encodeNodeConfig(config),
      siteCount: config.sites.length,
      reason,
      createdByUserId: userId,
    })
    .returning();
  if (!row) throw new Error("failed to insert revision");
  // Delivered to every console instance when the transaction commits.
  await tx.execute(
    sql`select pg_notify(${CONFIG_CHANNEL}, ${JSON.stringify({
      clusterId,
      revision: row.revision,
      contentHash: row.contentHash,
    })})`,
  );
  return { row, created: true };
}

/**
 * Compiles the cluster's current sites into a NodeConfig and stores it as the
 * next revision. Identical content does not produce a new revision.
 * Must run inside a transaction; serialised per cluster with an advisory lock.
 */
export async function publishRevision(
  tx: Tx,
  opts: { clusterId: string; reason: string; userId?: string | null },
): Promise<{ row: RevisionRow; created: boolean }> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.publish.${opts.clusterId}`}))`,
  );
  const sites = await loadSiteModels(tx, opts.clusterId);
  return insertRevision(
    tx,
    opts.clusterId,
    (revision) => compileNodeConfig({ clusterId: opts.clusterId, sites }, revision),
    opts.reason,
    opts.userId ?? null,
  );
}

/** Publishes the content of an older revision as a new revision. */
export async function rollbackToRevision(
  tx: Tx,
  opts: { clusterId: string; revision: number; userId?: string | null },
): Promise<{ row: RevisionRow; created: boolean } | undefined> {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.publish.${opts.clusterId}`}))`,
  );
  const target = await getRevision(tx, opts.clusterId, opts.revision);
  if (!target) return undefined;
  const old = decodeNodeConfig(target.ir);
  return insertRevision(
    tx,
    opts.clusterId,
    (revision) => {
      const config = decodeNodeConfig(target.ir);
      config.revision = revision;
      config.contentHash = old.contentHash;
      return config;
    },
    `rollback to revision ${opts.revision}`,
    opts.userId ?? null,
  );
}

/** Deletes revisions beyond the retention window, keeping the newest ones. */
export async function pruneRevisions(db: Executor, keep = REVISION_RETENTION): Promise<number> {
  const clusters = await db.select({ id: schema.cluster.id }).from(schema.cluster);
  let removed = 0;
  for (const { id } of clusters) {
    const latest = await latestRevision(db, id);
    if (!latest || latest.revision <= keep) continue;
    const deleted = await db
      .delete(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, id),
          lt(schema.configRevision.revision, latest.revision - keep + 1),
        ),
      )
      .returning({ id: schema.configRevision.id });
    removed += deleted.length;
  }
  return removed;
}
