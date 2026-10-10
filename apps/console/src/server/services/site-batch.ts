import type { AuditAction, BatchResult, RevisionReasonCode } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq, inArray, notExists, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { lockStats } from "../lib/locks";
import { type Actor, recordAudit } from "./audit";
import { publishRevision, type Tx } from "./revisions";
import { flushSiteUsage } from "./usage";

type SiteRow = typeof schema.site.$inferSelect;

/**
 * The sites in id order, locked for update unless `lock` is false (the
 * order every writer of several sites takes them in); all must exist.
 */
async function findSites(tx: Tx, ids: readonly string[], lock = true): Promise<SiteRow[]> {
  const query = tx
    .select()
    .from(schema.site)
    .where(inArray(schema.site.id, [...ids]))
    .orderBy(asc(schema.site.id));
  const rows = await (lock ? query.for("update") : query);
  if (rows.length !== new Set(ids).size) fail("SITE_NOT_FOUND", "site not found");
  return rows;
}

/**
 * Publishes the clusters of the changed sites once each (in cluster id
 * order, as publishClusters), then audits every site with its cluster's
 * revision. A cluster with one changed site gets that site's reason.
 */
async function publishBatch(
  tx: Tx,
  actor: Actor,
  sites: SiteRow[],
  change: {
    single: RevisionReasonCode;
    several: RevisionReasonCode;
    action: AuditAction;
    metadata: Record<string, unknown>;
  },
): Promise<BatchResult> {
  const byCluster = new Map<string, SiteRow[]>();
  for (const site of sites)
    byCluster.set(site.clusterId, [...(byCluster.get(site.clusterId) ?? []), site]);
  const revisions: BatchResult["revisions"] = [];
  for (const clusterId of [...byCluster.keys()].sort()) {
    const members = byCluster.get(clusterId) ?? [];
    const [only] = members;
    const { row, created } = await publishRevision(tx, {
      clusterId,
      reason:
        members.length === 1 && only
          ? { code: change.single, params: { site: only.name } }
          : { code: change.several, params: { count: members.length } },
      actor,
      ...(members.length === 1 && only ? { site: only.id } : {}),
    });
    revisions.push({ clusterId, revision: row.revision, created });
    for (const site of members)
      await recordAudit(tx, actor, {
        action: change.action,
        targetType: "site",
        targetId: site.id,
        targetName: site.name,
        metadata: { ...change.metadata, revision: row.revision },
      });
  }
  return {
    changed: sites.map((site) => ({ id: site.id, name: site.name })),
    revisions,
  };
}

/**
 * Turns sites on or off in one transaction. Sites already in the state are
 * left alone (no audit entry); the clusters of the others are published once.
 */
export async function batchSetEnabled(
  db: Database,
  input: { ids: string[]; enabled: boolean },
  ctx: { actor: Actor },
): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    const sites = (await findSites(tx, input.ids)).filter((site) => site.enabled !== input.enabled);
    if (sites.length)
      await tx
        .update(schema.site)
        .set({ enabled: input.enabled, updatedAt: new Date() })
        .where(
          inArray(
            schema.site.id,
            sites.map((site) => site.id),
          ),
        );
    return publishBatch(tx, ctx.actor, sortByName(sites), {
      single: input.enabled ? "site_enabled" : "site_disabled",
      several: input.enabled ? "sites_enabled" : "sites_disabled",
      action: input.enabled ? "site.enable" : "site.disable",
      metadata: { batch: input.ids.length },
    });
  });
}

/**
 * Deletes sites in one transaction, as deleteSite does each: their usage
 * is computed first, alert subscriptions left without sites go, and their
 * clusters are published once each.
 */
export async function batchDeleteSites(
  db: Database,
  ids: string[],
  ctx: { actor: Actor },
): Promise<BatchResult> {
  return db.transaction(async (tx) => {
    // As deleteSite: no ingestion or rollup may be in flight, the usage of
    // windows not computed yet is computed first, and each row is locked
    // only by its deletion (in id order).
    await lockStats(tx, "exclusive");
    const sites = await findSites(tx, ids, false);
    for (const site of sites) await flushSiteUsage(tx, site.id);
    for (const site of sites) await tx.delete(schema.site).where(eq(schema.site.id, site.id));
    const member = schema.alertSubscriptionSite;
    await tx
      .delete(schema.alertSubscription)
      .where(
        and(
          eq(schema.alertSubscription.allSites, false),
          notExists(
            tx
              .select({ one: sql`1` })
              .from(member)
              .where(eq(member.subscriptionId, schema.alertSubscription.id)),
          ),
        ),
      );
    return publishBatch(tx, ctx.actor, sortByName(sites), {
      single: "site_deleted",
      several: "sites_deleted",
      action: "site.delete",
      metadata: { batch: ids.length },
    });
  });
}

const sortByName = (sites: SiteRow[]) =>
  [...sites].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
