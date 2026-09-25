import type { Node } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { asc, eq, inArray } from "drizzle-orm";

/** A node counts as online if it sent a heartbeat within this window. */
export const ONLINE_WINDOW_SECONDS = 45;

export function isOnline(lastSeenAt: Date | null, now = Date.now()): boolean {
  return !!lastSeenAt && now - lastSeenAt.getTime() <= ONLINE_WINDOW_SECONDS * 1000;
}

async function toNodeDtos(
  db: Database,
  rows: (typeof schema.node.$inferSelect)[],
): Promise<Node[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const [statuses, ips, clusters] = await Promise.all([
    db.select().from(schema.nodeConfigStatus).where(inArray(schema.nodeConfigStatus.nodeId, ids)),
    db.select().from(schema.nodeIp).where(inArray(schema.nodeIp.nodeId, ids)),
    db.select({ id: schema.cluster.id, name: schema.cluster.name }).from(schema.cluster),
  ]);
  return rows.map((r) => {
    const st = statuses.find((s) => s.nodeId === r.id);
    return {
      id: r.id,
      name: r.name,
      clusterId: r.clusterId,
      clusterName: clusters.find((c) => c.id === r.clusterId)?.name ?? "",
      hostname: r.hostname,
      status: r.status === "disabled" ? "disabled" : "active",
      online: isOnline(r.lastSeenAt),
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      enrolledAt: r.enrolledAt?.toISOString() ?? null,
      agentVersion: r.agentVersion,
      engine: r.engine,
      engineVersion: r.engineVersion,
      os: r.os,
      arch: r.arch,
      ipAddresses: ips
        .filter((i) => i.nodeId === r.id)
        .map((i) => i.address)
        .sort(),
      certFingerprint: r.certFingerprint,
      certNotAfter: r.certNotAfter?.toISOString() ?? null,
      appliedRevision: st?.appliedRevision ?? 0,
      appliedContentHash: st?.appliedContentHash ?? "",
      applyState: (st?.state as Node["applyState"]) ?? null,
      applyMessage: st?.message ?? "",
      dataPlaneHealthy: st?.dataPlaneHealthy ?? false,
    };
  });
}

export async function listNodes(db: Database, clusterId?: string): Promise<Node[]> {
  const rows = await db
    .select()
    .from(schema.node)
    .where(clusterId ? eq(schema.node.clusterId, clusterId) : undefined)
    .orderBy(asc(schema.node.createdAt));
  return toNodeDtos(db, rows);
}

export async function getNode(db: Database, id: string): Promise<Node> {
  const rows = await db.select().from(schema.node).where(eq(schema.node.id, id));
  const [dto] = await toNodeDtos(db, rows);
  if (!dto) throw new ORPCError("NOT_FOUND", { message: "node not found" });
  return dto;
}
