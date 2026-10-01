import type { Region } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, count, eq, inArray, ne } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";

type RegionRow = typeof schema.region.$inferSelect;

async function toDtos(db: Executor, rows: RegionRow[]): Promise<Region[]> {
  if (rows.length === 0) return [];
  const counts = await db
    .select({ regionId: schema.nodeGroup.regionId, n: count() })
    .from(schema.nodeGroup)
    .where(
      inArray(
        schema.nodeGroup.regionId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(schema.nodeGroup.regionId);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    code: r.code,
    nodeGroupCount: counts.find((c) => c.regionId === r.id)?.n ?? 0,
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function listRegions(db: Database): Promise<Region[]> {
  const rows = await db.select().from(schema.region).orderBy(asc(schema.region.code));
  return toDtos(db, rows);
}

async function findRegion(db: Executor, id: string): Promise<RegionRow> {
  const [row] = await db.select().from(schema.region).where(eq(schema.region.id, id));
  if (!row) fail("REGION_NOT_FOUND", "region not found");
  return row;
}

async function assertCodeFree(db: Executor, code: string, exceptId?: string) {
  const [existing] = await db
    .select({ id: schema.region.id })
    .from(schema.region)
    .where(
      and(eq(schema.region.code, code), exceptId ? ne(schema.region.id, exceptId) : undefined),
    );
  if (existing) fail("REGION_CODE_TAKEN", `region code already exists: ${code}`, { code });
}

export async function createRegion(
  db: Database,
  input: { name: string; code: string },
  actor: Actor,
): Promise<Region> {
  const row = await db.transaction(async (tx) => {
    await assertCodeFree(tx, input.code);
    const [created] = await tx.insert(schema.region).values(input).returning();
    if (!created) throw new Error("region insert failed");
    await recordAudit(tx, actor, {
      action: "region.create",
      targetType: "region",
      targetId: created.id,
      targetName: created.name,
      metadata: { code: created.code },
    });
    return created;
  });
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("region not readable");
  return dto;
}

export async function updateRegion(
  db: Database,
  input: { id: string; name?: string; code?: string },
  actor: Actor,
): Promise<Region> {
  const row = await db.transaction(async (tx) => {
    const before = await findRegion(tx, input.id);
    if (input.code !== undefined) await assertCodeFree(tx, input.code, input.id);
    const [updated] = await tx
      .update(schema.region)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.code !== undefined ? { code: input.code } : {}),
      })
      .where(eq(schema.region.id, input.id))
      .returning();
    if (!updated) throw new Error("region update failed");
    await recordAudit(tx, actor, {
      action: "region.update",
      targetType: "region",
      targetId: updated.id,
      targetName: updated.name,
      metadata: { from: { name: before.name, code: before.code }, ...input },
    });
    return updated;
  });
  const [dto] = await toDtos(db, [row]);
  if (!dto) throw new Error("region not readable");
  return dto;
}

/**
 * Deletes a region; node groups that referenced it keep existing without
 * one. Refused while probes belong to it (REGION_IN_USE).
 */
export async function deleteRegion(db: Database, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await findRegion(tx, id);
    const [probes] = await tx
      .select({ n: count() })
      .from(schema.probe)
      .where(eq(schema.probe.regionId, id));
    if (probes?.n) fail("REGION_IN_USE", "probes belong to this region", { probes: probes.n });
    await tx.delete(schema.region).where(eq(schema.region.id, id));
    await recordAudit(tx, actor, {
      action: "region.delete",
      targetType: "region",
      targetId: id,
      targetName: row.name,
      metadata: { code: row.code },
    });
  });
}
