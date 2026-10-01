import { decodeNodeConfig, MAX_L4_APPS_PER_CLUSTER } from "@edgeweir/config-compiler";
import {
  type ClusterPortPools,
  L4_APP_DEFAULTS,
  L4_FEATURE,
  type L4App,
  type L4AppCreateInput,
  type L4AppMutationResult,
  type L4AppSetEnabledInput,
  type L4AppUpdateInput,
  type L4Stats,
  type L4StatsInput,
  nodeSupportsFeature,
  type PortPoolsInput,
  type Revision,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, count, eq, gte, inArray, lt, ne, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit } from "./audit";
import { cnameTargets } from "./dns";
import { loadPortPools, poolCovers } from "./l4-config";
import { assertOriginsAllowed } from "./origin-allow-list";
import {
  type Executor,
  latestRevision,
  publisher,
  publishRevision,
  type Tx,
  toRevisionDto,
} from "./revisions";
import { addTrafficCounter } from "./stats-counter";

type AppRow = typeof schema.l4App.$inferSelect;
type Pool = { protocol: string; from: number; to: number };

/**
 * Serializes changes to a cluster's port pools and layer-4 applications
 * (ports are checked against both). Taken before the cluster's publish lock.
 */
const lockClusterL4 = (tx: Executor, clusterId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.l4.${clusterId}`}))`);

const appLabel = (app: Pick<AppRow, "name" | "port" | "protocol">) =>
  `${app.name} (${app.port}/${app.protocol})`;
const poolLabel = (pool: Pool) => `${pool.from}-${pool.to}/${pool.protocol}`;

async function findCluster(db: Executor, id: string) {
  const [row] = await db.select().from(schema.cluster).where(eq(schema.cluster.id, id));
  if (!row) fail("CLUSTER_NOT_FOUND", "cluster not found");
  return row;
}

async function findApp(db: Executor, id: string, lock = false) {
  const query = db.select().from(schema.l4App).where(eq(schema.l4App.id, id));
  const [row] = lock ? await query.for("update") : await query;
  if (!row) fail("L4_APP_NOT_FOUND", "L4 application not found");
  return row;
}

/** The compiler's HTTP(S) listeners: 80, and 443 once a site has a certificate. */
const HTTP_PORTS = [80, 443];

/**
 * Ports no pool or application may use: the cluster's HTTP(S) listener
 * ports, those of its latest revision included.
 */
export async function reservedPorts(db: Executor, clusterId: string): Promise<number[]> {
  const latest = await latestRevision(db, clusterId);
  const listeners = latest ? decodeNodeConfig(latest.ir).listeners.map((l) => l.port) : [];
  return [...new Set([...HTTP_PORTS, ...listeners])].sort((a, b) => a - b);
}

export async function getPortPools(db: Executor, clusterId: string): Promise<ClusterPortPools> {
  await findCluster(db, clusterId);
  const pools = await loadPortPools(db, clusterId);
  const nodes = await db
    .select({
      id: schema.node.id,
      name: schema.node.name,
      features: schema.node.supportedFeatures,
    })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")))
    .orderBy(asc(schema.node.name));
  return {
    clusterId,
    pools: pools.map((pool) => ({
      protocol: pool.protocol as ClusterPortPools["pools"][number]["protocol"],
      from: pool.portFrom,
      to: pool.portTo,
    })),
    reservedPorts: await reservedPorts(db, clusterId),
    nodesWithoutL4: nodes
      .filter((node) => !nodeSupportsFeature(node.features, L4_FEATURE))
      .map((node) => ({ id: node.id, name: node.name })),
  };
}

/**
 * Replaces a cluster's port pools and audits the change. Pools sharing a
 * port of a protocol (`both` counts for either) are refused with
 * L4_PORT_POOL_OVERLAP, a listener port with L4_PORT_RESERVED, and pools
 * that would leave an application's port (enabled or not) outside with
 * L4_PORT_IN_USE. Nodes never see the pools: no revision is published.
 */
export async function setPortPools(
  db: Database,
  input: PortPoolsInput,
  actor: Actor,
): Promise<ClusterPortPools> {
  const pools = [...input.pools].sort((a, b) =>
    a.from !== b.from ? a.from - b.from : a.protocol < b.protocol ? -1 : 1,
  );
  await db.transaction(async (tx) => {
    const cluster = await findCluster(tx, input.clusterId);
    await lockClusterL4(tx, cluster.id);
    for (const [i, a] of pools.entries())
      for (const b of pools.slice(i + 1)) {
        const shared = a.protocol === "both" || b.protocol === "both" || a.protocol === b.protocol;
        if (shared && a.from <= b.to && b.from <= a.to) {
          const labels = `${poolLabel(a)}, ${poolLabel(b)}`;
          fail("L4_PORT_POOL_OVERLAP", `port pools overlap: ${labels}`, { pools: labels });
        }
      }
    const reserved = await reservedPorts(tx, cluster.id);
    for (const pool of pools) {
      const port = reserved.find((p) => pool.from <= p && p <= pool.to);
      if (port !== undefined)
        fail("L4_PORT_RESERVED", `port ${port} belongs to the cluster's HTTP listeners`, { port });
    }
    const apps = await tx
      .select()
      .from(schema.l4App)
      .where(eq(schema.l4App.clusterId, cluster.id))
      .orderBy(asc(schema.l4App.port), asc(schema.l4App.protocol));
    const outside = apps.filter(
      (app) =>
        !pools.some((pool) =>
          poolCovers(
            { protocol: pool.protocol, portFrom: pool.from, portTo: pool.to },
            app.protocol,
            app.port,
          ),
        ),
    );
    if (outside.length) {
      const labels = outside.map(appLabel).join(", ");
      fail("L4_PORT_IN_USE", `applications still use these ports: ${labels}`, { apps: labels });
    }
    const before = await loadPortPools(tx, cluster.id);
    await tx.delete(schema.clusterPortPool).where(eq(schema.clusterPortPool.clusterId, cluster.id));
    if (pools.length)
      await tx.insert(schema.clusterPortPool).values(
        pools.map((pool) => ({
          clusterId: cluster.id,
          protocol: pool.protocol,
          portFrom: pool.from,
          portTo: pool.to,
        })),
      );
    await recordAudit(tx, actor, {
      action: "cluster.port_pools_update",
      targetType: "cluster",
      targetId: cluster.id,
      targetName: cluster.name,
      metadata: {
        from: before.map((pool) =>
          poolLabel({ protocol: pool.protocol, from: pool.portFrom, to: pool.portTo }),
        ),
        pools: pools.map(poolLabel),
      },
    });
  });
  return getPortPools(db, input.clusterId);
}

async function toDtos(db: Executor, rows: AppRow[]): Promise<L4App[]> {
  if (!rows.length) return [];
  const origins = await db
    .select()
    .from(schema.l4Origin)
    .where(
      inArray(
        schema.l4Origin.appId,
        rows.map((row) => row.id),
      ),
    )
    .orderBy(asc(schema.l4Origin.position));
  const clusterIds = [...new Set(rows.map((row) => row.clusterId))];
  const clusters = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster)
    .where(inArray(schema.cluster.id, clusterIds));
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const names = new Map<string, Awaited<ReturnType<typeof cnameTargets>>>();
  for (const clusterId of clusterIds) names.set(clusterId, await cnameTargets(db, clusterId));
  return rows.map((row) => {
    const dns = names.get(row.clusterId)?.(row.id) ?? null;
    return {
      id: row.id,
      clusterId: row.clusterId,
      clusterName: clusters.find((c) => c.id === row.clusterId)?.name ?? "",
      name: row.name,
      protocol: row.protocol === "udp" ? "udp" : "tcp",
      port: row.port,
      enabled: row.enabled,
      acceptProxyProtocol: row.acceptProxyProtocol,
      proxyProtocolVersion: row.proxyProtocolVersion,
      origins: origins
        .filter((origin) => origin.appId === row.id)
        .map((origin) => ({
          id: origin.id,
          address: origin.address,
          port: origin.port,
          weight: origin.weight,
          backup: origin.backup,
        })),
      maxFails: row.maxFails,
      failTimeoutSeconds: row.failTimeoutSeconds,
      connectTimeoutMs: row.connectTimeoutMs,
      idleTimeoutSeconds: row.idleTimeoutSeconds,
      allowListIds: row.allowListIds,
      blockListIds: row.blockListIds,
      maxConnections: row.maxConnections,
      newConnectionsPerSecond: row.newConnectionsPerSecond,
      dnsTarget: dns?.target ?? null,
      dnsLines: dns?.lines ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  });
}

async function toDto(db: Executor, row: AppRow): Promise<L4App> {
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("L4 application not readable");
  return dto;
}

export async function listL4Apps(db: Database, clusterId?: string): Promise<L4App[]> {
  if (clusterId) await findCluster(db, clusterId);
  const rows = await db
    .select()
    .from(schema.l4App)
    .where(clusterId ? eq(schema.l4App.clusterId, clusterId) : undefined)
    .orderBy(asc(schema.l4App.port), asc(schema.l4App.protocol), asc(schema.l4App.id));
  return toDtos(db, rows);
}

export async function getL4App(db: Database, id: string): Promise<L4App> {
  return toDto(db, await findApp(db, id));
}

/** What a create or update leaves of an application, as validateApp checks it. */
interface AppState {
  protocol: "tcp" | "udp";
  port: number;
  acceptProxyProtocol: boolean;
  proxyProtocolVersion: number;
  allowListIds: string[];
  blockListIds: string[];
}

/**
 * Checks an application against its cluster: PROXY protocol only on TCP
 * (L4_PROXY_PROTOCOL_UNSUPPORTED), the port neither a listener port
 * (L4_PORT_RESERVED) nor outside the pools of its protocol
 * (L4_PORT_OUTSIDE_POOL) nor used by another application of the protocol
 * (L4_PORT_IN_USE), and every IP list present (IP_LIST_NOT_FOUND; the lists
 * are share-locked so they cannot be deleted before the change commits).
 * Runs under the cluster's L4 lock.
 */
async function validateApp(tx: Tx, clusterId: string, app: AppState, exceptId?: string) {
  if (app.protocol === "udp" && (app.acceptProxyProtocol || app.proxyProtocolVersion !== 0))
    fail("L4_PROXY_PROTOCOL_UNSUPPORTED", "PROXY protocol is for TCP applications only");
  if ((await reservedPorts(tx, clusterId)).includes(app.port))
    fail("L4_PORT_RESERVED", `port ${app.port} belongs to the cluster's HTTP listeners`, {
      port: app.port,
    });
  const pools = await loadPortPools(tx, clusterId);
  if (!pools.some((pool) => poolCovers(pool, app.protocol, app.port)))
    fail("L4_PORT_OUTSIDE_POOL", `port ${app.port} is outside the cluster's port pools`, {
      port: app.port,
    });
  const [clash] = await tx
    .select()
    .from(schema.l4App)
    .where(
      and(
        eq(schema.l4App.clusterId, clusterId),
        eq(schema.l4App.protocol, app.protocol),
        eq(schema.l4App.port, app.port),
        exceptId ? ne(schema.l4App.id, exceptId) : undefined,
      ),
    );
  if (clash)
    fail("L4_PORT_IN_USE", `port ${app.port}/${app.protocol} is in use`, {
      apps: appLabel(clash),
    });
  const listIds = [...new Set([...app.allowListIds, ...app.blockListIds])];
  if (listIds.length) {
    const lists = await tx
      .select({ id: schema.ipList.id })
      .from(schema.ipList)
      .where(inArray(schema.ipList.id, listIds))
      .for("share");
    if (lists.length !== listIds.length) fail("IP_LIST_NOT_FOUND", "IP list not found");
  }
}

/**
 * Replaces an application's origins in the given order. An origin with the
 * address and port of an existing one keeps its id (the nodes' passive
 * health state is keyed by it).
 */
async function writeOrigins(
  tx: Tx,
  appId: string,
  origins: L4AppCreateInput["origins"],
): Promise<void> {
  const existing = await tx
    .select({
      id: schema.l4Origin.id,
      address: schema.l4Origin.address,
      port: schema.l4Origin.port,
    })
    .from(schema.l4Origin)
    .where(eq(schema.l4Origin.appId, appId))
    .orderBy(asc(schema.l4Origin.position));
  const kept = new Set<string>();
  for (const [position, origin] of origins.entries()) {
    const values = {
      appId,
      address: origin.address,
      port: origin.port,
      weight: origin.weight,
      backup: origin.backup,
      position,
    };
    const match = existing.find(
      (e) => !kept.has(e.id) && e.address === origin.address && e.port === origin.port,
    );
    if (match) {
      kept.add(match.id);
      await tx.update(schema.l4Origin).set(values).where(eq(schema.l4Origin.id, match.id));
    } else await tx.insert(schema.l4Origin).values(values);
  }
  const removed = existing.filter((e) => !kept.has(e.id)).map((e) => e.id);
  if (removed.length) await tx.delete(schema.l4Origin).where(inArray(schema.l4Origin.id, removed));
}

const originLabels = (origins: readonly { address: string; port: number }[]) =>
  origins.map((origin) =>
    origin.address.includes(":")
      ? `[${origin.address}]:${origin.port}`
      : `${origin.address}:${origin.port}`,
  );

/**
 * Creates an application, publishes its cluster and audits it, in one
 * transaction. A cluster has at most MAX_L4_APPS_PER_CLUSTER applications
 * (L4_APP_LIMIT); origins follow the origin address policy
 * (ORIGIN_ADDRESS_FORBIDDEN); see validateApp for the rest.
 */
export async function createL4App(
  db: Database,
  input: L4AppCreateInput,
  actor: Actor,
): Promise<L4AppMutationResult> {
  return db.transaction(async (tx) => {
    const cluster = await findCluster(tx, input.clusterId);
    await lockClusterL4(tx, cluster.id);
    const [apps] = await tx
      .select({ n: count() })
      .from(schema.l4App)
      .where(eq(schema.l4App.clusterId, cluster.id));
    if ((apps?.n ?? 0) >= MAX_L4_APPS_PER_CLUSTER)
      fail("L4_APP_LIMIT", "cluster L4 application limit reached", {
        limit: MAX_L4_APPS_PER_CLUSTER,
      });
    const idleTimeoutSeconds =
      input.idleTimeoutSeconds ?? L4_APP_DEFAULTS.idleTimeoutSeconds[input.protocol];
    await validateApp(tx, cluster.id, input);
    await assertOriginsAllowed(tx, input.origins);
    const [row] = await tx
      .insert(schema.l4App)
      .values({
        clusterId: cluster.id,
        name: input.name,
        protocol: input.protocol,
        port: input.port,
        enabled: input.enabled,
        acceptProxyProtocol: input.acceptProxyProtocol,
        proxyProtocolVersion: input.proxyProtocolVersion,
        maxFails: input.maxFails,
        failTimeoutSeconds: input.failTimeoutSeconds,
        connectTimeoutMs: input.connectTimeoutMs,
        idleTimeoutSeconds,
        allowListIds: input.allowListIds,
        blockListIds: input.blockListIds,
        maxConnections: input.maxConnections,
        newConnectionsPerSecond: input.newConnectionsPerSecond,
      })
      .returning();
    if (!row) throw new Error("L4 application insert failed");
    await writeOrigins(tx, row.id, input.origins);
    const { row: revision } = await publishRevision(tx, {
      clusterId: cluster.id,
      reason: { code: "l4_app_created", params: { app: row.name } },
      userId: publisher(actor),
    });
    await recordAudit(tx, actor, {
      action: "l4_app.create",
      targetType: "l4_app",
      targetId: row.id,
      targetName: row.name,
      metadata: {
        clusterId: cluster.id,
        protocol: row.protocol,
        port: row.port,
        enabled: row.enabled,
        origins: originLabels(input.origins),
        revision: revision.revision,
      },
    });
    return { app: await toDto(tx, row), revision: toRevisionDto(revision) };
  });
}

/** The columns an update may change. */
const UPDATABLE = [
  "name",
  "protocol",
  "port",
  "acceptProxyProtocol",
  "proxyProtocolVersion",
  "maxFails",
  "failTimeoutSeconds",
  "connectTimeoutMs",
  "idleTimeoutSeconds",
  "allowListIds",
  "blockListIds",
  "maxConnections",
  "newConnectionsPerSecond",
] as const;

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** A strictly later updated_at, so that optimistic concurrency always sees a change. */
const nextUpdatedAt = (row: AppRow) => new Date(Math.max(Date.now(), row.updatedAt.getTime() + 1));

/**
 * Changes the fields given (origins replace the list), validates the result
 * like createL4App, publishes the cluster and audits the changed fields.
 */
export async function updateL4App(
  db: Database,
  input: L4AppUpdateInput,
  actor: Actor,
): Promise<L4AppMutationResult> {
  return db.transaction(async (tx) => {
    const found = await findApp(tx, input.id);
    await lockClusterL4(tx, found.clusterId);
    const row = await findApp(tx, input.id, true);
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const values: Partial<AppRow> = {};
    const from: Record<string, unknown> = {};
    const to: Record<string, unknown> = {};
    for (const field of UPDATABLE) {
      const value = input[field];
      if (value === undefined || same(value, row[field])) continue;
      from[field] = row[field];
      to[field] = value;
      Object.assign(values, { [field]: value });
    }
    const next = { ...row, ...values };
    const protocol = next.protocol === "udp" ? "udp" : "tcp";
    await validateApp(tx, row.clusterId, { ...next, protocol }, row.id);
    const changed = Object.keys(to);
    if (input.origins) {
      await assertOriginsAllowed(tx, input.origins);
      const before = await tx
        .select({ address: schema.l4Origin.address, port: schema.l4Origin.port })
        .from(schema.l4Origin)
        .where(eq(schema.l4Origin.appId, row.id))
        .orderBy(asc(schema.l4Origin.position));
      await writeOrigins(tx, row.id, input.origins);
      changed.push("origins");
      from.origins = originLabels(before);
      to.origins = originLabels(input.origins);
    }
    const [updated] = await tx
      .update(schema.l4App)
      .set({ ...values, updatedAt: nextUpdatedAt(row) })
      .where(eq(schema.l4App.id, row.id))
      .returning();
    if (!updated) throw new Error("L4 application update failed");
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "l4_app_updated", params: { app: updated.name } },
      userId: publisher(actor),
    });
    await recordAudit(tx, actor, {
      action: "l4_app.update",
      targetType: "l4_app",
      targetId: row.id,
      targetName: updated.name,
      metadata: { changed, from, to, revision: revision.revision },
    });
    return { app: await toDto(tx, updated), revision: toRevisionDto(revision) };
  });
}

/**
 * Turns an application on or off. A disabled application keeps its port
 * and settings; it is not shipped to nodes and has no DNS record. Setting
 * the current state changes nothing and returns the latest revision.
 */
export async function setL4AppEnabled(
  db: Database,
  input: L4AppSetEnabledInput,
  actor: Actor,
): Promise<L4AppMutationResult> {
  return db.transaction(async (tx) => {
    const found = await findApp(tx, input.id);
    await lockClusterL4(tx, found.clusterId);
    const row = await findApp(tx, input.id, true);
    if (row.enabled === input.enabled) {
      const latest = await latestRevision(tx, row.clusterId);
      if (!latest) throw new Error("cluster has no revision");
      return { app: await toDto(tx, row), revision: toRevisionDto(latest) };
    }
    assertUpdatedAt(row.updatedAt, input.expectedUpdatedAt);
    const [updated] = await tx
      .update(schema.l4App)
      .set({ enabled: input.enabled, updatedAt: nextUpdatedAt(row) })
      .where(eq(schema.l4App.id, row.id))
      .returning();
    if (!updated) throw new Error("L4 application update failed");
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "l4_app_updated", params: { app: row.name } },
      userId: publisher(actor),
    });
    await recordAudit(tx, actor, {
      action: input.enabled ? "l4_app.enable" : "l4_app.disable",
      targetType: "l4_app",
      targetId: row.id,
      targetName: row.name,
      metadata: { revision: revision.revision },
    });
    return { app: await toDto(tx, updated), revision: toRevisionDto(revision) };
  });
}

/** Deletes an application with its origins and statistics, publishes the cluster and audits it. */
export async function deleteL4App(
  db: Database,
  id: string,
  actor: Actor,
): Promise<{ revision: Revision }> {
  return db.transaction(async (tx) => {
    const found = await findApp(tx, id);
    await lockClusterL4(tx, found.clusterId);
    const row = await findApp(tx, id, true);
    await tx.delete(schema.l4App).where(eq(schema.l4App.id, row.id));
    const { row: revision } = await publishRevision(tx, {
      clusterId: row.clusterId,
      reason: { code: "l4_app_deleted", params: { app: row.name } },
      userId: publisher(actor),
    });
    await recordAudit(tx, actor, {
      action: "l4_app.delete",
      targetType: "l4_app",
      targetId: row.id,
      targetName: row.name,
      metadata: {
        clusterId: row.clusterId,
        protocol: row.protocol,
        port: row.port,
        revision: revision.revision,
      },
    });
    return { revision: toRevisionDto(revision) };
  });
}

/** Width of an l4Apps.stats point for a range of `spanMs`. */
export function l4StatsBucketSeconds(spanMs: number): number {
  return spanMs <= 86_400_000 ? 60 : spanMs <= 5 * 86_400_000 ? 300 : 3600;
}

type Counters = Omit<L4Stats["totals"], never>;
const zero = (): Counters => ({
  connections: 0,
  refused: 0,
  peakConcurrent: 0,
  bytesReceived: 0,
  bytesSent: 0,
});
/** Sums counters; the peak is the higher one (concurrency does not add up over time). */
function accumulate(into: Counters, add: Counters) {
  into.connections = addTrafficCounter(into.connections, add.connections);
  into.refused = addTrafficCounter(into.refused, add.refused);
  into.peakConcurrent = Math.max(into.peakConcurrent, add.peakConcurrent);
  into.bytesReceived = addTrafficCounter(into.bytesReceived, add.bytesReceived);
  into.bytesSent = addTrafficCounter(into.bytesSent, add.bytesSent);
}

/**
 * An application's statistics over [from, to): per-minute counters summed
 * over nodes (the peak per minute is the sum of the nodes' peaks), in
 * points of l4StatsBucketSeconds from the bucket of `from`, the totals and
 * each node's share.
 */
export async function l4AppStats(db: Database, input: L4StatsInput): Promise<L4Stats> {
  const app = await findApp(db, input.id);
  const from = new Date(input.from);
  const to = new Date(input.to);
  const bucketSeconds = l4StatsBucketSeconds(to.getTime() - from.getTime());
  const bucketMs = bucketSeconds * 1000;
  const start = Math.floor(from.getTime() / bucketMs) * bucketMs;
  const t = schema.l4MinuteStats;
  const capped = (value: ReturnType<typeof sql>) =>
    sql<string>`least(9007199254740991::numeric, coalesce(${value}, 0))`;
  const counters = (peak: "sum" | "max") => ({
    connections: capped(sql`sum(${t.connections})`),
    refused: capped(sql`sum(${t.refused})`),
    peakConcurrent: capped(
      peak === "sum" ? sql`sum(${t.peakConcurrent})` : sql`max(${t.peakConcurrent})`,
    ),
    bytesReceived: capped(sql`sum(${t.bytesReceived})`),
    bytesSent: capped(sql`sum(${t.bytesSent})`),
  });
  const toCounters = (row: Record<keyof Counters, string | number>): Counters => ({
    connections: Number(row.connections),
    refused: Number(row.refused),
    peakConcurrent: Number(row.peakConcurrent),
    bytesReceived: Number(row.bytesReceived),
    bytesSent: Number(row.bytesSent),
  });
  const range = and(eq(t.appId, app.id), gte(t.minute, new Date(start)), lt(t.minute, to));
  const minutes = await db
    .select({ minute: t.minute, ...counters("sum") })
    .from(t)
    .where(range)
    .groupBy(t.minute);
  const points = new Map<number, Counters>();
  for (let time = start; time < to.getTime(); time += bucketMs) points.set(time, zero());
  const totals = zero();
  for (const row of minutes) {
    const value = toCounters(row);
    const bucket = Math.floor(row.minute.getTime() / bucketMs) * bucketMs;
    const point = points.get(bucket);
    if (point) accumulate(point, value);
    accumulate(totals, value);
  }
  const perNode = await db
    .select({ nodeId: t.nodeId, ...counters("max") })
    .from(t)
    .where(range)
    .groupBy(t.nodeId);
  const nodeNames = perNode.length
    ? await db
        .select({ id: schema.node.id, name: schema.node.name })
        .from(schema.node)
        .where(
          inArray(
            schema.node.id,
            perNode.map((n) => n.nodeId),
          ),
        )
    : [];
  return {
    appId: app.id,
    from: from.toISOString(),
    to: to.toISOString(),
    bucketSeconds,
    points: [...points].map(([time, value]) => ({ time: new Date(time).toISOString(), ...value })),
    totals,
    nodes: perNode
      .map((row) => ({
        nodeId: row.nodeId,
        nodeName: nodeNames.find((n) => n.id === row.nodeId)?.name ?? "",
        ...toCounters(row),
      }))
      .sort(
        (a, b) =>
          b.connections - a.connections ||
          b.bytesSent - a.bytesSent ||
          (a.nodeName < b.nodeName ? -1 : a.nodeName > b.nodeName ? 1 : 0),
      ),
  };
}
