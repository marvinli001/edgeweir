import { nodeSupportsFeature } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq, inArray } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { defaultResolver, type Pointing, pointing } from "../lib/dns-check";
import { fail } from "../lib/errors";
import { isOnline } from "../lib/node-online";
import { nodeIpRows, schedulingAddressesOf } from "./node-addresses";
import type { Executor } from "./revisions";

const HTTP01 = "http01-v1";

/** The cluster serving each name (the site that has it as a plain domain). */
async function servingClusters(db: Executor, names: readonly string[]) {
  const rows = names.length
    ? await db
        .selectDistinct({ name: schema.siteDomain.name, clusterId: schema.site.clusterId })
        .from(schema.siteDomain)
        .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
        .where(
          and(inArray(schema.siteDomain.name, [...names]), eq(schema.siteDomain.kind, "exact")),
        )
    : [];
  return new Map(rows.map((row) => [row.name, row.clusterId]));
}

/** Active nodes of the clusters. */
async function activeNodes(db: Executor, clusterIds: readonly string[]) {
  return clusterIds.length
    ? db
        .select({
          id: schema.node.id,
          name: schema.node.name,
          clusterId: schema.node.clusterId,
          lastSeenAt: schema.node.lastSeenAt,
          features: schema.node.supportedFeatures,
        })
        .from(schema.node)
        .where(
          and(inArray(schema.node.clusterId, [...clusterIds]), eq(schema.node.status, "active")),
        )
    : [];
}

/**
 * Where each name points compared with the addresses of the active nodes
 * of the cluster serving it: their configured scheduling addresses and the
 * public addresses they report. A cluster without any is `unknown`.
 */
export async function http01Pointing(
  app: AppContext,
  db: Executor,
  names: readonly string[],
): Promise<Map<string, Pointing>> {
  const clusters = await servingClusters(db, names);
  const nodes = await activeNodes(db, [...new Set(clusters.values())]);
  const ips = await nodeIpRows(
    db,
    nodes.map((n) => n.id),
  );
  const addresses = new Map<string, Set<string>>();
  for (const node of nodes) {
    const rows = ips.get(node.id) ?? [];
    const set = addresses.get(node.clusterId) ?? new Set<string>();
    for (const group of [
      rows.filter((r) => r.source === "configured"),
      rows.filter((r) => r.source !== "configured"),
    ])
      for (const a of schedulingAddressesOf(group)) set.add(a.address);
    addresses.set(node.clusterId, set);
  }
  const resolver = app.resolver ?? defaultResolver();
  const out = new Map<string, Pointing>();
  await Promise.all(
    names.map(async (name) => {
      const clusterId = clusters.get(name);
      const set = clusterId ? addresses.get(clusterId) : undefined;
      out.set(name, set?.size ? await pointing(resolver, name, set) : "unknown");
    }),
  );
  return out;
}

/** Names the CA would not reach the nodes at (unresolved or pointing elsewhere). */
export const notPointing = (result: Map<string, Pointing>) =>
  [...result].filter(([, p]) => p === "unresolved" || p === "elsewhere").map(([name]) => name);

/**
 * Who would answer the HTTP-01 challenges of `names`: the clusters serving
 * them that have no online active node (`offline`, by name) and the online
 * active nodes there without http01-v1 (`lacking`, by name), both sorted.
 */
export async function http01Readiness(db: Executor, names: readonly string[]) {
  const clusters = await servingClusters(db, names);
  const clusterIds = [...new Set(clusters.values())];
  const online = (await activeNodes(db, clusterIds)).filter((n) => isOnline(n.lastSeenAt));
  const lacking = online
    .filter((n) => !nodeSupportsFeature(n.features, HTTP01))
    .map((n) => n.name)
    .sort();
  const empty = clusterIds.filter((id) => !online.some((n) => n.clusterId === id));
  const offline = empty.length
    ? (
        await db
          .select({ name: schema.cluster.name })
          .from(schema.cluster)
          .where(inArray(schema.cluster.id, empty))
      )
        .map((c) => c.name)
        .sort()
    : [];
  return { offline, lacking };
}

/**
 * Refuses an HTTP-01 request the nodes cannot answer: every cluster serving
 * its names needs an online active node, and every online active node there
 * http01-v1 (the issuance needs them all to apply the challenge); unless
 * skipped, every name must resolve to the cluster's nodes only
 * (CERTIFICATE_DNS_NOT_POINTING). Lookups that fail or nodes without a known
 * public address never refuse. The first failure only (https.check lists
 * them all).
 */
export async function assertHttp01Ready(
  app: AppContext,
  names: readonly string[],
  opts: { skipDnsCheck: boolean },
) {
  const { offline, lacking } = await http01Readiness(app.db, names);
  if (lacking.length)
    fail("NODE_CAPABILITY_REQUIRED", "cluster nodes cannot answer HTTP-01", {
      features: HTTP01,
      nodes: lacking.slice(0, 5).join(", "),
    });
  if (offline.length)
    fail("CERTIFICATE_NODES_OFFLINE", "no online node answers HTTP-01", {
      clusters: offline.slice(0, 5).join(", "),
    });
  if (opts.skipDnsCheck) return;
  const failed = notPointing(await http01Pointing(app, app.db, names));
  if (failed.length)
    fail("CERTIFICATE_DNS_NOT_POINTING", "names do not resolve to the nodes", {
      names: failed.sort().slice(0, 5).join(", "),
    });
}
