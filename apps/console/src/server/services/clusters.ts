import type { Cluster } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { asc, count, eq, gt, sql } from "drizzle-orm";
import { type Actor, recordAudit } from "./audit";
import { ONLINE_WINDOW_SECONDS } from "./nodes";
import {
  type Executor,
  latestRevision,
  publishRevision,
  type Tx,
  toRevisionDto,
} from "./revisions";

async function toClusterDto(
  db: Executor,
  row: typeof schema.cluster.$inferSelect,
): Promise<Cluster> {
  const since = sql`now() - make_interval(secs => ${ONLINE_WINDOW_SECONDS})`;
  const [[nodes], [online], [sites], latest] = await Promise.all([
    db.select({ n: count() }).from(schema.node).where(eq(schema.node.clusterId, row.id)),
    db
      .select({ n: count() })
      .from(schema.node)
      .where(sql`${schema.node.clusterId} = ${row.id} and ${gt(schema.node.lastSeenAt, since)}`),
    db.select({ n: count() }).from(schema.site).where(eq(schema.site.clusterId, row.id)),
    latestRevision(db, row.id),
  ]);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodeCount: nodes?.n ?? 0,
    onlineNodeCount: online?.n ?? 0,
    siteCount: sites?.n ?? 0,
    latestRevision: latest ? toRevisionDto(latest) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listClusters(db: Database): Promise<Cluster[]> {
  const rows = await db.select().from(schema.cluster).orderBy(asc(schema.cluster.createdAt));
  return Promise.all(rows.map((r) => toClusterDto(db, r)));
}

export async function getCluster(db: Database, id: string): Promise<Cluster> {
  const [row] = await db.select().from(schema.cluster).where(eq(schema.cluster.id, id));
  if (!row) throw new ORPCError("NOT_FOUND", { message: "cluster not found" });
  return toClusterDto(db, row);
}

/** Creates a cluster with its default node group and publishes revision 1. */
export async function createClusterTx(
  tx: Tx,
  input: { name: string; description: string },
  actor: Actor,
) {
  const existing = await tx
    .select()
    .from(schema.cluster)
    .where(eq(schema.cluster.name, input.name));
  if (existing.length) throw new ORPCError("CONFLICT", { message: "cluster name already exists" });
  const [row] = await tx.insert(schema.cluster).values(input).returning();
  if (!row) throw new Error("cluster insert failed");
  await tx.insert(schema.nodeGroup).values({ clusterId: row.id, name: "default", isDefault: true });
  await publishRevision(tx, {
    clusterId: row.id,
    reason: "cluster created",
    userId: actor.type === "user" ? actor.id : null,
  });
  await recordAudit(tx, actor, {
    action: "cluster.create",
    targetType: "cluster",
    targetId: row.id,
    metadata: { name: row.name },
  });
  return row;
}

export async function createCluster(
  db: Database,
  input: { name: string; description: string },
  actor: Actor,
): Promise<Cluster> {
  const row = await db.transaction((tx) => createClusterTx(tx, input, actor));
  return toClusterDto(db, row);
}

/** The cluster new sites land on when none is specified (the oldest one). */
export async function defaultClusterId(db: Executor): Promise<string> {
  const [row] = await db
    .select({ id: schema.cluster.id })
    .from(schema.cluster)
    .orderBy(asc(schema.cluster.createdAt))
    .limit(1);
  if (!row) throw new ORPCError("PRECONDITION_FAILED", { message: "no cluster exists yet" });
  return row.id;
}
