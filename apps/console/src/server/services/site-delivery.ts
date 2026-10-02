import { decodeNodeConfig, siteBytes } from "@edgeweir/config-compiler";
import type { SiteDelivery } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray } from "drizzle-orm";
import { isOnline } from "../lib/node-online";
import { type Executor, getRevision, latestRevision, loadRollout } from "./revisions";

/**
 * Compiled sites of revisions (site id → siteBytes), by cluster, revision and content hash:
 * revisions never change, so a decoded one serves every later request.
 */
const revisionSites = new Map<string, Map<string, string>>();
const CACHED_REVISIONS = 64;

async function sitesOf(
  db: Executor,
  clusterId: string,
  revision: number,
  contentHash: string,
  ir?: Uint8Array,
): Promise<Map<string, string> | undefined> {
  const key = `${clusterId}:${revision}:${contentHash}`;
  const cached = revisionSites.get(key);
  if (cached) return cached;
  const bytes = ir ?? (await getRevision(db, clusterId, revision))?.ir;
  if (!bytes) return undefined;
  const config = decodeNodeConfig(bytes);
  // A pruned or rewritten revision cannot tell what the node runs.
  if (config.contentHash !== contentHash) return undefined;
  const sites = new Map(config.sites.map((site) => [site.id, siteBytes(site)]));
  if (revisionSites.size >= CACHED_REVISIONS) {
    const oldest = revisionSites.keys().next().value;
    if (oldest !== undefined) revisionSites.delete(oldest);
  }
  revisionSites.set(key, sites);
  return sites;
}

const RUNNING_CANARY = new Set(["canary", "awaiting_promotion"]);

/**
 * The cluster's running canary window when its candidate is the latest
 * revision: when the window ends, whether it promotes itself, and the
 * sites of the stable revision the other nodes keep meanwhile.
 */
async function runningCanary(
  db: Executor,
  clusterId: string,
  latest: { revision: number } | undefined,
) {
  const row = await loadRollout(db, clusterId);
  if (
    !row?.enabled ||
    !RUNNING_CANARY.has(row.state) ||
    !row.windowStartedAt ||
    row.stableRevision === null ||
    row.candidateRevision === null ||
    row.candidateRevision !== latest?.revision
  )
    return undefined;
  const stable = await getRevision(db, clusterId, row.stableRevision);
  return {
    endsAt: new Date(row.windowStartedAt.getTime() + row.windowSeconds * 1000).toISOString(),
    autoPromote: row.autoPromote,
    stable: stable
      ? await sitesOf(db, clusterId, stable.revision, stable.contentHash, stable.ir)
      : undefined,
  };
}

/**
 * Where each site runs: the online active nodes of its cluster, those whose applied
 * configuration has the site, and those running its version of the cluster's latest revision
 * (the newest publication: canary candidates included) with a healthy data plane. A site
 * whose latest version the cluster's canary holds back from the other nodes says until when.
 * A disabled site counts the nodes that still run it.
 */
export async function siteDeliveries(
  db: Executor,
  sites: { id: string; clusterId: string; enabled: boolean }[],
  now = Date.now(),
): Promise<Map<string, SiteDelivery>> {
  const result = new Map<string, SiteDelivery>();
  const clusterIds = [...new Set(sites.map((s) => s.clusterId))];
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const nodes = clusterIds.length
    ? await db
        .select({
          clusterId: schema.node.clusterId,
          lastSeenAt: schema.node.lastSeenAt,
          appliedRevision: schema.nodeConfigStatus.appliedRevision,
          appliedContentHash: schema.nodeConfigStatus.appliedContentHash,
          dataPlaneHealthy: schema.nodeConfigStatus.dataPlaneHealthy,
        })
        .from(schema.node)
        .leftJoin(schema.nodeConfigStatus, eq(schema.nodeConfigStatus.nodeId, schema.node.id))
        .where(and(inArray(schema.node.clusterId, clusterIds), eq(schema.node.status, "active")))
    : [];
  for (const clusterId of clusterIds) {
    const latest = await latestRevision(db, clusterId);
    const target = latest
      ? await sitesOf(db, clusterId, latest.revision, latest.contentHash, latest.ir)
      : undefined;
    const canary = sites.some((s) => s.enabled && s.clusterId === clusterId)
      ? await runningCanary(db, clusterId, latest)
      : undefined;
    const online = nodes.filter((n) => n.clusterId === clusterId && isOnline(n.lastSeenAt, now));
    const applied: { sites: Map<string, string> | undefined; healthy: boolean }[] = [];
    for (const node of online) {
      applied.push({
        sites: node.appliedRevision
          ? await sitesOf(db, clusterId, node.appliedRevision, node.appliedContentHash ?? "")
          : undefined,
        healthy: node.dataPlaneHealthy === true,
      });
    }
    for (const site of sites) {
      if (site.clusterId !== clusterId) continue;
      const totalNodes = online.length;
      const servingNodes = applied.filter((a) => a.sites?.has(site.id)).length;
      if (!site.enabled) {
        result.set(site.id, {
          state: "disabled",
          totalNodes,
          servingNodes,
          currentNodes: 0,
          canary: null,
        });
        continue;
      }
      const version = target?.get(site.id);
      const currentNodes = applied.filter(
        (a) => a.healthy && version !== undefined && a.sites?.get(site.id) === version,
      ).length;
      const held = !!canary && version !== undefined && canary.stable?.get(site.id) !== version;
      result.set(site.id, {
        state: servingNodes === 0 ? "pending" : currentNodes === totalNodes ? "live" : "partial",
        totalNodes,
        servingNodes,
        currentNodes,
        canary: held && canary ? { endsAt: canary.endsAt, autoPromote: canary.autoPromote } : null,
      });
    }
  }
  return result;
}
