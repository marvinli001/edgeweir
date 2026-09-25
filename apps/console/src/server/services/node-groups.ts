import type { NodeGroup } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, count, desc, eq, inArray, ne } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

type GroupRow = typeof schema.nodeGroup.$inferSelect;

async function toDtos(db: Executor, rows: GroupRow[]): Promise<NodeGroup[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const counts = await db
    .select({ groupId: schema.node.nodeGroupId, n: count() })
    .from(schema.node)
    .where(inArray(schema.node.nodeGroupId, ids))
    .groupBy(schema.node.nodeGroupId);
  const regionIds = [...new Set(rows.map((r) => r.regionId).filter((v): v is string => !!v))];
  const regions = regionIds.length
    ? await db.select().from(schema.region).where(inArray(schema.region.id, regionIds))
    : [];
  return rows.map((r) => {
    const region = regions.find((g) => g.id === r.regionId);
    return {
      id: r.id,
      clusterId: r.clusterId,
      name: r.name,
      isDefault: r.isDefault,
      regionId: r.regionId,
      regionName: region?.name ?? null,
      regionCode: region?.code ?? null,
      nodeCount: counts.find((c) => c.groupId === r.id)?.n ?? 0,
      createdAt: r.createdAt.toISOString(),
    };
  });
}

export async function listNodeGroups(db: Database, clusterId?: string): Promise<NodeGroup[]> {
  const rows = await db
    .select()
    .from(schema.nodeGroup)
    .where(clusterId ? eq(schema.nodeGroup.clusterId, clusterId) : undefined)
    .orderBy(desc(schema.nodeGroup.isDefault), asc(schema.nodeGroup.createdAt));
  return toDtos(db, rows);
}

export async function findNodeGroup(db: Executor, id: string): Promise<GroupRow> {
  const [row] = await db.select().from(schema.nodeGroup).where(eq(schema.nodeGroup.id, id));
  if (!row) fail("NODE_GROUP_NOT_FOUND", "node group not found");
  return row;
}

async function assertNameFree(db: Executor, clusterId: string, name: string, exceptId?: string) {
  const [existing] = await db
    .select({ id: schema.nodeGroup.id })
    .from(schema.nodeGroup)
    .where(
      and(
        eq(schema.nodeGroup.clusterId, clusterId),
        eq(schema.nodeGroup.name, name),
        exceptId ? ne(schema.nodeGroup.id, exceptId) : undefined,
      ),
    );
  if (existing) fail("NODE_GROUP_NAME_TAKEN", `node group already exists: ${name}`, { name });
}

async function assertRegion(db: Executor, regionId: string | null | undefined) {
  if (!regionId) return;
  const [row] = await db
    .select({ id: schema.region.id })
    .from(schema.region)
    .where(eq(schema.region.id, regionId));
  if (!row) fail("REGION_NOT_FOUND", "region not found");
}

export async function createNodeGroup(
  db: Database,
  input: { clusterId: string; name: string; regionId: string | null },
  actor: Actor,
): Promise<NodeGroup> {
  const row = await db.transaction(async (tx) => {
    const [cluster] = await tx
      .select()
      .from(schema.cluster)
      .where(eq(schema.cluster.id, input.clusterId));
    if (!cluster) fail("CLUSTER_NOT_FOUND", "cluster not found");
    await assertNameFree(tx, input.clusterId, input.name);
    await assertRegion(tx, input.regionId);
    const [created] = await tx.insert(schema.nodeGroup).values(input).returning();
    if (!created) throw new Error("node group insert failed");
    await recordAudit(tx, actor, {
      action: "node_group.create",
      targetType: "node_group",
      targetId: created.id,
      targetName: created.name,
      metadata: { clusterId: cluster.id, cluster: cluster.name, regionId: input.regionId },
    });
    return created;
  });
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("node group not readable");
  return dto;
}

export async function updateNodeGroup(
  db: Database,
  input: { id: string; name?: string; regionId?: string | null },
  actor: Actor,
): Promise<NodeGroup> {
  const row = await db.transaction(async (tx) => {
    const before = await findNodeGroup(tx, input.id);
    if (input.name !== undefined) await assertNameFree(tx, before.clusterId, input.name, input.id);
    await assertRegion(tx, input.regionId);
    const [updated] = await tx
      .update(schema.nodeGroup)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.regionId !== undefined ? { regionId: input.regionId } : {}),
      })
      .where(eq(schema.nodeGroup.id, input.id))
      .returning();
    if (!updated) throw new Error("node group update failed");
    await recordAudit(tx, actor, {
      action: "node_group.update",
      targetType: "node_group",
      targetId: updated.id,
      targetName: updated.name,
      metadata: { from: { name: before.name, regionId: before.regionId }, ...input },
    });
    return updated;
  });
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("node group not readable");
  return dto;
}

/** Deletes a node group; its nodes move back to the cluster's default group. */
export async function deleteNodeGroup(db: Database, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await findNodeGroup(tx, id);
    if (row.isDefault) fail("NODE_GROUP_IS_DEFAULT", "the default node group cannot be deleted");
    const [fallback] = await tx
      .select()
      .from(schema.nodeGroup)
      .where(
        and(eq(schema.nodeGroup.clusterId, row.clusterId), eq(schema.nodeGroup.isDefault, true)),
      );
    const moved = await tx
      .update(schema.node)
      .set({ nodeGroupId: fallback?.id ?? null })
      .where(eq(schema.node.nodeGroupId, id))
      .returning({ id: schema.node.id });
    await tx.delete(schema.nodeGroup).where(eq(schema.nodeGroup.id, id));
    await recordAudit(tx, actor, {
      action: "node_group.delete",
      targetType: "node_group",
      targetId: id,
      targetName: row.name,
      metadata: { clusterId: row.clusterId, movedNodes: moved.length },
    });
  });
}
