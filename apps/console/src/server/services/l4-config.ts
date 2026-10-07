import type { L4AppModel } from "@edgeweir/config-compiler";
import { certificateUnloadable } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { L4Protocol, type NodeConfig } from "@edgeweir/proto";
import { and, asc, eq, inArray } from "drizzle-orm";
import { fail } from "../lib/errors";
import type { Executor } from "./revisions";

type PoolRow = Pick<typeof schema.clusterPortPool.$inferSelect, "protocol" | "portFrom" | "portTo">;

/** Whether a pool (tcp, udp or both) holds `port` of `protocol`. */
export const poolCovers = (pool: PoolRow, protocol: string, port: number) =>
  (pool.protocol === "both" || pool.protocol === protocol) &&
  pool.portFrom <= port &&
  port <= pool.portTo;

/** The cluster's port pools by first port, then protocol. */
export function loadPortPools(db: Executor, clusterId: string) {
  return db
    .select()
    .from(schema.clusterPortPool)
    .where(eq(schema.clusterPortPool.clusterId, clusterId))
    .orderBy(asc(schema.clusterPortPool.portFrom), asc(schema.clusterPortPool.protocol));
}

/** Every layer-4 application of a cluster with its origins, as the compiler takes them. */
export async function loadL4AppModels(db: Executor, clusterId: string): Promise<L4AppModel[]> {
  const apps = await db
    .select()
    .from(schema.l4App)
    .where(eq(schema.l4App.clusterId, clusterId))
    .orderBy(asc(schema.l4App.id));
  if (!apps.length) return [];
  const origins = await db
    .select()
    .from(schema.l4Origin)
    .where(
      inArray(
        schema.l4Origin.appId,
        apps.map((app) => app.id),
      ),
    )
    .orderBy(asc(schema.l4Origin.position));
  return apps.map((app) => ({
    id: app.id,
    enabled: app.enabled,
    protocol: app.protocol === "udp" ? "udp" : "tcp",
    port: app.port,
    acceptProxyProtocol: app.acceptProxyProtocol,
    proxyProtocolVersion: app.proxyProtocolVersion,
    origins: origins
      .filter((origin) => origin.appId === app.id)
      .map((origin) => ({
        id: origin.id,
        address: origin.address,
        port: origin.port,
        weight: origin.weight,
        backup: origin.backup,
      })),
    maxFails: app.maxFails,
    failTimeoutSeconds: app.failTimeoutSeconds,
    connectTimeoutMs: app.connectTimeoutMs,
    idleTimeoutSeconds: app.idleTimeoutSeconds,
    allowListIds: app.allowListIds,
    blockListIds: app.blockListIds,
    maxConnections: app.maxConnections,
    newConnectionsPerSecond: app.newConnectionsPerSecond,
    portEnd: app.portEnd,
    originPortMode: app.originPortMode === "same" ? "same" : "fixed",
    certificateId: app.protocol === "tcp" ? app.certificateId : null,
    tlsMinimumVersion: app.tlsMinimumVersion === "1.3" ? "1.3" : "1.2",
  }));
}

/** Whether the pools hold every port from..to of a protocol (one pool or adjacent ones). */
export function poolsCoverRange(
  pools: readonly PoolRow[],
  protocol: string,
  from: number,
  to: number,
) {
  let port = from;
  while (port <= to) {
    const pool = pools.find((p) => poolCovers(p, protocol, port));
    if (!pool) return false;
    port = pool.portTo + 1;
  }
  return true;
}

/**
 * The layer-4 applications of an earlier configuration as they may be
 * published now: an application that is disabled now is dropped (enabling
 * is current policy, as for sites). One deleted since, whose port is no
 * longer inside a port pool for its protocol or that refers to a deleted IP
 * list: `strict` (the operator's rollback) refuses with
 * ROLLBACK_RESOURCE_UNAVAILABLE; otherwise (the canary's stable revision)
 * it is dropped.
 */
export async function restoreL4Apps(
  tx: Executor,
  clusterId: string,
  apps: NodeConfig["l4Apps"],
  opts: { strict: boolean },
): Promise<NodeConfig["l4Apps"]> {
  if (!apps.length) return [];
  const current = await tx
    .select({ id: schema.l4App.id, enabled: schema.l4App.enabled })
    .from(schema.l4App)
    .where(
      and(
        eq(schema.l4App.clusterId, clusterId),
        inArray(
          schema.l4App.id,
          apps.map((app) => app.id),
        ),
      ),
    );
  const pools = await loadPortPools(tx, clusterId);
  const lists = new Set(
    (await tx.select({ id: schema.ipList.id }).from(schema.ipList)).map((list) => list.id),
  );
  const certificateIds = [...new Set(apps.map((app) => app.certificateId).filter(Boolean))];
  const certificates = certificateIds.length
    ? await tx
        .select({
          id: schema.certificate.id,
          notAfter: schema.certificate.notAfter,
          status: schema.certificate.status,
          lastError: schema.certificate.lastError,
        })
        .from(schema.certificate)
        .where(inArray(schema.certificate.id, certificateIds))
    : [];
  const restored: NodeConfig["l4Apps"] = [];
  for (const app of apps) {
    const row = current.find((c) => c.id === app.id);
    const protocol = app.protocol === L4Protocol.UDP ? "udp" : "tcp";
    const certificate = certificates.find((c) => c.id === app.certificateId);
    const available =
      !!row &&
      poolsCoverRange(pools, protocol, app.port, Math.max(app.port, app.portEnd)) &&
      [...app.allowListIds, ...app.blockListIds].every((id) => lists.has(id)) &&
      (!app.certificateId ||
        (!!certificate?.notAfter && certificate.notAfter.getTime() > Date.now()));
    if (!available && opts.strict)
      fail(
        "ROLLBACK_RESOURCE_UNAVAILABLE",
        "rollback references a removed L4 application, port or IP list",
      );
    // As for sites: an operator's rollback ships no certificate nodes cannot load.
    if (opts.strict && row?.enabled && certificate && certificateUnloadable(certificate))
      fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback certificate cannot be loaded by nodes");
    if (available && row.enabled) restored.push(app);
  }
  return restored;
}
