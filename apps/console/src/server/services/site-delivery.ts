import { decodeNodeConfig, siteBytes } from "@edgeweir/config-compiler";
import type { SiteDelivery } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray } from "drizzle-orm";
import { isOnline } from "../lib/node-online";
import { type Executor, getRevision, latestRevision } from "./revisions";

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

/**
 * Where each site runs: the online active nodes of its cluster, those whose applied
 * configuration has the site, and those running its version of the cluster's latest revision
 * (the newest publication: canary candidates included) with a healthy data plane.
 */
export async function siteDeliveries(
  db: Executor,
  sites: { id: string; clusterId: string; enabled: boolean }[],
  now = Date.now(),
): Promise<Map<string, SiteDelivery>> {
  const result = new Map<string, SiteDelivery>();
  const clusterIds = [...new Set(sites.filter((s) => s.enabled).map((s) => s.clusterId))];
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
      if (!site.enabled || site.clusterId !== clusterId) continue;
      const version = target?.get(site.id);
      const servingNodes = applied.filter((a) => a.sites?.has(site.id)).length;
      const currentNodes = applied.filter(
        (a) => a.healthy && version !== undefined && a.sites?.get(site.id) === version,
      ).length;
      const totalNodes = online.length;
      result.set(site.id, {
        state: servingNodes === 0 ? "pending" : currentNodes === totalNodes ? "live" : "partial",
        totalNodes,
        servingNodes,
        currentNodes,
      });
    }
  }
  for (const site of sites) {
    if (!site.enabled)
      result.set(site.id, { state: "disabled", totalNodes: 0, servingNodes: 0, currentNodes: 0 });
  }
  return result;
}
