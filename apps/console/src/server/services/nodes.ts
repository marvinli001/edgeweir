import { decodeNodeConfig, nodeRequirements } from "@edgeweir/config-compiler";
import { type Node, nodeSupportsFeature } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { asc, eq, inArray } from "drizzle-orm";
import { fail } from "../lib/errors";
import { isOnline, ONLINE_WINDOW_SECONDS } from "../lib/node-online";
import { type Actor, recordAudit } from "./audit";
import { skipNodeTasks } from "./cache-tasks";
import { findNodeGroup } from "./node-groups";
import { type Executor, latestRevision, notifyClusterTargets } from "./revisions";

export { isOnline, ONLINE_WINDOW_SECONDS };

type NodeRow = typeof schema.node.$inferSelect;

async function toNodeDtos(db: Executor, rows: NodeRow[]): Promise<Node[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const statuses = await db
    .select()
    .from(schema.nodeConfigStatus)
    .where(inArray(schema.nodeConfigStatus.nodeId, ids));
  const ips = await db.select().from(schema.nodeIp).where(inArray(schema.nodeIp.nodeId, ids));
  const clusters = await db
    .select({ id: schema.cluster.id, name: schema.cluster.name })
    .from(schema.cluster);
  const groupIds = [...new Set(rows.map((r) => r.nodeGroupId).filter((v): v is string => !!v))];
  const groups = groupIds.length
    ? await db
        .select({
          id: schema.nodeGroup.id,
          name: schema.nodeGroup.name,
          regionName: schema.region.name,
        })
        .from(schema.nodeGroup)
        .leftJoin(schema.region, eq(schema.region.id, schema.nodeGroup.regionId))
        .where(inArray(schema.nodeGroup.id, groupIds))
    : [];
  const required = new Map<string, string[]>();
  for (const clusterId of new Set(rows.map((r) => r.clusterId))) {
    const latest = await latestRevision(db, clusterId);
    required.set(clusterId, latest ? nodeRequirements(decodeNodeConfig(latest.ir)) : []);
  }
  return rows.map((r) => {
    const st = statuses.find((s) => s.nodeId === r.id);
    const group = groups.find((g) => g.id === r.nodeGroupId);
    return {
      id: r.id,
      name: r.name,
      clusterId: r.clusterId,
      clusterName: clusters.find((c) => c.id === r.clusterId)?.name ?? "",
      nodeGroupId: r.nodeGroupId,
      nodeGroupName: group?.name ?? null,
      regionName: group?.regionName ?? null,
      hostname: r.hostname,
      status: r.status === "disabled" ? "disabled" : "active",
      online: isOnline(r.lastSeenAt),
      lastSeenAt: r.lastSeenAt?.toISOString() ?? null,
      enrolledAt: r.enrolledAt?.toISOString() ?? null,
      agentVersion: r.agentVersion,
      supportedFeatures: r.supportedFeatures,
      upgradeRequired:
        (!!r.agentVersion && !r.supportedFeatures.includes("stats-sequence-v1")) ||
        (required.get(r.clusterId) ?? []).some((f) => !nodeSupportsFeature(r.supportedFeatures, f)),
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

async function findNode(db: Executor, id: string): Promise<NodeRow> {
  const [row] = await db.select().from(schema.node).where(eq(schema.node.id, id));
  if (!row) fail("NODE_NOT_FOUND", "node not found");
  return row;
}

export async function getNode(db: Executor, id: string): Promise<Node> {
  const [dto] = await toNodeDtos(db, [await findNode(db, id)]);
  if (!dto) fail("NODE_NOT_FOUND", "node not found");
  return dto;
}

/** Renames a node and/or moves it to another node group of the same cluster. */
export async function updateNode(
  db: Database,
  input: { id: string; name?: string; nodeGroupId?: string },
  actor: Actor,
): Promise<Node> {
  return db.transaction(async (tx) => {
    const before = await findNode(tx, input.id);
    let groupName: string | undefined;
    if (input.nodeGroupId !== undefined) {
      const group = await findNodeGroup(tx, input.nodeGroupId);
      if (group.clusterId !== before.clusterId) {
        fail(
          "NODE_GROUP_CLUSTER_MISMATCH",
          "the node group belongs to another cluster than the node",
        );
      }
      groupName = group.name;
    }
    const [updated] = await tx
      .update(schema.node)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.nodeGroupId !== undefined ? { nodeGroupId: input.nodeGroupId } : {}),
      })
      .where(eq(schema.node.id, input.id))
      .returning();
    if (!updated) throw new Error("node update failed");
    const moved = input.nodeGroupId !== undefined && input.nodeGroupId !== before.nodeGroupId;
    // Moving in or out of a canary group changes the node's target revision.
    if (moved) await notifyClusterTargets(tx, before.clusterId);
    await recordAudit(tx, actor, {
      action: moved && input.name === undefined ? "node.move" : "node.update",
      targetType: "node",
      targetId: updated.id,
      targetName: updated.name,
      metadata: {
        from: { name: before.name, nodeGroupId: before.nodeGroupId },
        ...input,
        ...(groupName ? { nodeGroup: groupName } : {}),
      },
    });
    return getNode(tx, updated.id);
  });
}

/**
 * Disables or re-enables a node. A disabled node is refused by the node
 * channel (it keeps serving its last-known-good configuration) until enabled;
 * its unfinished cache task deliveries are marked skipped, and the purges it
 * missed are made up with whole-site purges once it pulls tasks again.
 */
export async function setNodeStatus(
  db: Database,
  id: string,
  status: "active" | "disabled",
  actor: Actor,
): Promise<Node> {
  return db.transaction(async (tx) => {
    const row = await findNode(tx, id);
    await tx.update(schema.node).set({ status }).where(eq(schema.node.id, id));
    const skippedTasks = status === "disabled" ? await skipNodeTasks(tx, id) : 0;
    await recordAudit(tx, actor, {
      action: status === "disabled" ? "node.disable" : "node.enable",
      targetType: "node",
      targetId: id,
      targetName: row.name,
      ...(skippedTasks ? { metadata: { skippedTasks } } : {}),
    });
    return getNode(tx, id);
  });
}

/**
 * Deletes a node and revokes its client certificate: the node channel refuses
 * the certificate from now on, so the agent cannot reconnect without a new
 * enrollment token.
 */
export async function deleteNode(db: Database, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await findNode(tx, id);
    if (row.certSerial) {
      await tx
        .insert(schema.nodeCertificateRevocation)
        .values({
          serial: normalizeSerial(row.certSerial),
          nodeId: row.id,
          fingerprintSha256: row.certFingerprint ?? "",
          reason: "node deleted",
        })
        .onConflictDoNothing();
    }
    await tx.delete(schema.node).where(eq(schema.node.id, id));
    await recordAudit(tx, actor, {
      action: "node.delete",
      targetType: "node",
      targetId: id,
      targetName: row.name,
      metadata: {
        clusterId: row.clusterId,
        certSerial: row.certSerial,
        certFingerprint: row.certFingerprint,
      },
    });
  });
}

/** Canonical form of a certificate serial for comparisons (hex, no colons or leading zeros). */
export function normalizeSerial(serial: string | null | undefined): string {
  return (serial ?? "").toLowerCase().replace(/:/g, "").replace(/^0+/, "");
}

export async function isSerialRevoked(db: Executor, serial: string | undefined): Promise<boolean> {
  const key = normalizeSerial(serial);
  if (!key) return false;
  const [row] = await db
    .select({ serial: schema.nodeCertificateRevocation.serial })
    .from(schema.nodeCertificateRevocation)
    .where(eq(schema.nodeCertificateRevocation.serial, key));
  return !!row;
}
