import type { EdgeModel } from "@edgeweir/config-compiler";
import {
  CLIENT_IP_FEATURE,
  type ClientIpInput,
  type ClusterClientIp,
  type ClusterListenPorts,
  EDGE_PORTS_FEATURE,
  type ListenPortsInput,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq } from "drizzle-orm";
import { fail } from "../lib/errors";
import { lockClusterL4 } from "../lib/locks";
import { type Actor, recordAudit } from "./audit";
import { loadPortPools } from "./l4-config";
import { type Executor, publishRevision } from "./revisions";

type ClusterRow = typeof schema.cluster.$inferSelect;

async function findCluster(db: Executor, id: string, lock = false): Promise<ClusterRow> {
  const query = db.select().from(schema.cluster).where(eq(schema.cluster.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) fail("CLUSTER_NOT_FOUND", "cluster not found");
  return row;
}

/** Active nodes of a cluster that do not report `feature`, by name. */
export async function nodesWithout(db: Executor, clusterId: string, feature: string) {
  const nodes = await db
    .select({ id: schema.node.id, name: schema.node.name, features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")))
    .orderBy(asc(schema.node.name));
  return nodes
    .filter((node) => !nodeSupportsFeature(node.features, feature))
    .map((node) => ({ id: node.id, name: node.name }));
}

/** The client address setting of a cluster row (null is direct). */
export function clientIpOf(row: Pick<ClusterRow, "clientIp">): ClusterClientIp["settings"] {
  const stored = row.clientIp;
  return stored
    ? {
        mode: stored.mode,
        trustedCidrs: [...stored.trustedCidrs],
        header: stored.header,
        dropForwardedFor: stored.dropForwardedFor,
      }
    : { mode: "direct", trustedCidrs: [], header: "", dropForwardedFor: false };
}

/** The cluster's listener ports and client address setting as the compiler takes them. */
export function edgeModelOf(
  row: Pick<ClusterRow, "extraHttpPorts" | "extraHttpsPorts" | "clientIp">,
): EdgeModel {
  return {
    httpPorts: [...row.extraHttpPorts],
    httpsPorts: [...row.extraHttpsPorts],
    clientIp: row.clientIp ? clientIpOf(row) : null,
  };
}

export async function loadEdgeModel(db: Executor, clusterId: string): Promise<EdgeModel> {
  return edgeModelOf(await findCluster(db, clusterId));
}

export async function getListenPorts(db: Executor, clusterId: string): Promise<ClusterListenPorts> {
  const row = await findCluster(db, clusterId);
  return {
    clusterId,
    httpPorts: [...row.extraHttpPorts],
    httpsPorts: [...row.extraHttpsPorts],
    nodesWithout: await nodesWithout(db, clusterId, EDGE_PORTS_FEATURE),
  };
}

const poolLabel = (pool: { protocol: string; portFrom: number; portTo: number }) =>
  `${pool.portFrom}-${pool.portTo}/${pool.protocol}`;

/**
 * Replaces a cluster's extra listener ports, audits and publishes the
 * change. A port is HTTP or HTTPS (LISTEN_PORT_CONFLICT), never inside a
 * port pool of the cluster, whatever its protocol (LISTEN_PORT_IN_POOL), and
 * stays while a site of the cluster is bound to it (LISTEN_PORT_IN_USE).
 * Runs under the cluster's layer-4 lock, like the port pools.
 */
export async function setListenPorts(
  db: Database,
  input: ListenPortsInput,
  actor: Actor,
): Promise<ClusterListenPorts> {
  await db.transaction(async (tx) => {
    const found = await findCluster(tx, input.clusterId);
    await lockClusterL4(tx, found.id);
    const cluster = await findCluster(tx, found.id, true);
    const conflict = input.httpPorts.find((port) => input.httpsPorts.includes(port));
    if (conflict !== undefined)
      fail("LISTEN_PORT_CONFLICT", `port ${conflict} is listed for HTTP and HTTPS`, {
        port: conflict,
      });
    const pools = await loadPortPools(tx, cluster.id);
    for (const port of [...input.httpPorts, ...input.httpsPorts]) {
      const hit = pools.filter((pool) => pool.portFrom <= port && port <= pool.portTo);
      if (hit.length)
        fail("LISTEN_PORT_IN_POOL", `port ${port} is inside a port pool`, {
          port,
          pools: hit.map(poolLabel).join(", "),
        });
    }
    const sites = await tx
      .select({
        name: schema.site.name,
        httpPorts: schema.site.httpPorts,
        httpsPorts: schema.site.httpsPorts,
      })
      .from(schema.site)
      .where(eq(schema.site.clusterId, cluster.id))
      .orderBy(asc(schema.site.name));
    const removed = [
      ...cluster.extraHttpPorts
        .filter((port) => !input.httpPorts.includes(port))
        .map((port) => ({ port, https: false })),
      ...cluster.extraHttpsPorts
        .filter((port) => !input.httpsPorts.includes(port))
        .map((port) => ({ port, https: true })),
    ];
    for (const { port, https } of removed) {
      const users = sites.filter((site) =>
        (https ? site.httpsPorts : site.httpPorts).includes(port),
      );
      if (users.length)
        fail("LISTEN_PORT_IN_USE", `sites still use port ${port}`, {
          port,
          sites: users
            .slice(0, 5)
            .map((site) => site.name)
            .join(", "),
        });
    }
    const same =
      cluster.extraHttpPorts.join() === input.httpPorts.join() &&
      cluster.extraHttpsPorts.join() === input.httpsPorts.join();
    if (same) return;
    await tx
      .update(schema.cluster)
      .set({
        extraHttpPorts: input.httpPorts,
        extraHttpsPorts: input.httpsPorts,
        updatedAt: new Date(),
      })
      .where(eq(schema.cluster.id, cluster.id));
    const { row: revision } = await publishRevision(tx, {
      clusterId: cluster.id,
      reason: { code: "listen_ports_updated", params: {} },
      actor,
    });
    await recordAudit(tx, actor, {
      action: "cluster.listen_ports_update",
      targetType: "cluster",
      targetId: cluster.id,
      targetName: cluster.name,
      metadata: {
        from: { httpPorts: cluster.extraHttpPorts, httpsPorts: cluster.extraHttpsPorts },
        to: { httpPorts: input.httpPorts, httpsPorts: input.httpsPorts },
        revision: revision.revision,
      },
    });
  });
  return getListenPorts(db, input.clusterId);
}

export async function getClientIp(db: Executor, clusterId: string): Promise<ClusterClientIp> {
  const row = await findCluster(db, clusterId);
  return {
    clusterId,
    settings: clientIpOf(row),
    nodesWithout: await nodesWithout(db, clusterId, CLIENT_IP_FEATURE),
  };
}

/**
 * Replaces a cluster's client address setting, audits and publishes it.
 * Only the fields of the mode are kept (direct without dropping
 * X-Forwarded-For is stored as null, the default).
 */
export async function setClientIp(
  db: Database,
  input: ClientIpInput,
  actor: Actor,
): Promise<ClusterClientIp> {
  await db.transaction(async (tx) => {
    const cluster = await findCluster(tx, input.clusterId, true);
    const s = input.settings;
    const stored =
      s.mode === "direct" && !s.dropForwardedFor
        ? null
        : {
            mode: s.mode,
            trustedCidrs: s.mode === "header" ? s.trustedCidrs : [],
            header: s.mode === "header" ? s.header : "",
            dropForwardedFor: s.mode === "direct" && s.dropForwardedFor,
          };
    const before = clientIpOf(cluster);
    if (JSON.stringify(stored) === JSON.stringify(cluster.clientIp ?? null)) return;
    await tx
      .update(schema.cluster)
      .set({ clientIp: stored, updatedAt: new Date() })
      .where(eq(schema.cluster.id, cluster.id));
    const { row: revision } = await publishRevision(tx, {
      clusterId: cluster.id,
      reason: { code: "client_ip_updated", params: {} },
      actor,
    });
    await recordAudit(tx, actor, {
      action: "cluster.client_ip_update",
      targetType: "cluster",
      targetId: cluster.id,
      targetName: cluster.name,
      metadata: { from: before, to: clientIpOf({ clientIp: stored }), revision: revision.revision },
    });
  });
  return getClientIp(db, input.clusterId);
}
