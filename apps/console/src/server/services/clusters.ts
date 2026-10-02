import { decodeNodeConfig } from "@edgeweir/config-compiler";
import type { Cluster, Revision, RollbackPreview } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, count, eq, gt, ne, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { type Actor, recordAudit } from "./audit";
import { siteChanges } from "./config-changes";
import { assertBindingReleased } from "./dns";
import { isOnline, ONLINE_WINDOW_SECONDS } from "./nodes";
import {
  type Executor,
  latestRevision,
  publishRevision,
  rolloutTargets,
  type Tx,
  targetFor,
  toRevisionDto,
} from "./revisions";
import { rollbackContent, rollbackToRevision } from "./rollback";

/**
 * Online active nodes of a cluster, and how many of them run their target
 * revision: the stable one, or the candidate on the canary nodes of a
 * running window (nodes never apply a lower revision, so a higher one counts).
 */
export async function clusterDelivery(db: Executor, clusterId: string, now = Date.now()) {
  const rows = await db
    .select({
      id: schema.node.id,
      lastSeenAt: schema.node.lastSeenAt,
      appliedRevision: schema.nodeConfigStatus.appliedRevision,
    })
    .from(schema.node)
    .leftJoin(schema.nodeConfigStatus, eq(schema.nodeConfigStatus.nodeId, schema.node.id))
    .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")));
  const live = rows.filter((n) => isOnline(n.lastSeenAt, now));
  if (!live.length) return { live: 0, applied: 0 };
  const targets = await rolloutTargets(db, clusterId);
  const applied = live.filter((n) => {
    const target = targetFor(n, targets);
    return !!target && (n.appliedRevision ?? 0) >= target.revision;
  }).length;
  return { live: live.length, applied };
}

async function toClusterDto(
  db: Executor,
  row: typeof schema.cluster.$inferSelect,
): Promise<Cluster> {
  const since = sql`now() - make_interval(secs => ${ONLINE_WINDOW_SECONDS})`;
  // Sequential on purpose: `db` may be a transaction, i.e. a single connection.
  const [nodes] = await db
    .select({ n: count() })
    .from(schema.node)
    .where(eq(schema.node.clusterId, row.id));
  const [online] = await db
    .select({ n: count() })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, row.id), gt(schema.node.lastSeenAt, since)));
  const [sites] = await db
    .select({ n: count() })
    .from(schema.site)
    .where(eq(schema.site.clusterId, row.id));
  const latest = await latestRevision(db, row.id);
  const delivery = await clusterDelivery(db, row.id);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    nodeCount: nodes?.n ?? 0,
    onlineNodeCount: online?.n ?? 0,
    liveNodeCount: delivery.live,
    appliedNodeCount: delivery.applied,
    siteCount: sites?.n ?? 0,
    latestRevision: latest ? toRevisionDto(latest) : null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listClusters(db: Database): Promise<Cluster[]> {
  const rows = await db.select().from(schema.cluster).orderBy(asc(schema.cluster.createdAt));
  return Promise.all(rows.map((r) => toClusterDto(db, r)));
}

async function findCluster(db: Executor, id: string) {
  const [row] = await db.select().from(schema.cluster).where(eq(schema.cluster.id, id));
  if (!row) fail("CLUSTER_NOT_FOUND", "cluster not found");
  return row;
}

export async function getCluster(db: Database, id: string): Promise<Cluster> {
  return toClusterDto(db, await findCluster(db, id));
}

async function assertNameFree(db: Executor, name: string, exceptId?: string) {
  const [existing] = await db
    .select({ id: schema.cluster.id })
    .from(schema.cluster)
    .where(
      and(eq(schema.cluster.name, name), exceptId ? ne(schema.cluster.id, exceptId) : undefined),
    );
  if (existing) fail("CLUSTER_NAME_TAKEN", `cluster name already exists: ${name}`, { name });
}

/** Creates a cluster with its default node group and publishes revision 1. */
export async function createClusterTx(
  tx: Tx,
  input: { name: string; description: string },
  actor: Actor,
) {
  await assertNameFree(tx, input.name);
  const [row] = await tx.insert(schema.cluster).values(input).returning();
  if (!row) throw new Error("cluster insert failed");
  await tx.insert(schema.nodeGroup).values({ clusterId: row.id, name: "default", isDefault: true });
  await publishRevision(tx, {
    clusterId: row.id,
    reason: { code: "cluster_created", params: { cluster: row.name } },
    actor,
  });
  await recordAudit(tx, actor, {
    action: "cluster.create",
    targetType: "cluster",
    targetId: row.id,
    targetName: row.name,
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

export async function updateCluster(
  db: Database,
  input: { id: string; name?: string; description?: string },
  actor: Actor,
): Promise<Cluster> {
  const row = await db.transaction(async (tx) => {
    const before = await findCluster(tx, input.id);
    if (input.name !== undefined) await assertNameFree(tx, input.name, input.id);
    const [updated] = await tx
      .update(schema.cluster)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
      })
      .where(eq(schema.cluster.id, input.id))
      .returning();
    if (!updated) throw new Error("cluster update failed");
    await recordAudit(tx, actor, {
      action: "cluster.update",
      targetType: "cluster",
      targetId: updated.id,
      targetName: updated.name,
      metadata: { from: { name: before.name, description: before.description }, ...input },
    });
    return updated;
  });
  return toClusterDto(db, row);
}

/** Deletes an empty cluster; refused while nodes or sites still belong to it. */
export async function deleteCluster(db: Database, id: string, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const row = await findCluster(tx, id);
    const [nodes] = await tx
      .select({ n: count() })
      .from(schema.node)
      .where(eq(schema.node.clusterId, id));
    const [sites] = await tx
      .select({ n: count() })
      .from(schema.site)
      .where(eq(schema.site.clusterId, id));
    const nodeCount = nodes?.n ?? 0;
    const siteCount = sites?.n ?? 0;
    if (nodeCount > 0 || siteCount > 0) {
      fail("CLUSTER_NOT_EMPTY", `cluster still has ${nodeCount} node(s) and ${siteCount} site(s)`, {
        nodes: nodeCount,
        sites: siteCount,
      });
    }
    await assertBindingReleased(tx, id);
    await tx.delete(schema.cluster).where(eq(schema.cluster.id, id));
    await recordAudit(tx, actor, {
      action: "cluster.delete",
      targetType: "cluster",
      targetId: id,
      targetName: row.name,
      metadata: { name: row.name },
    });
  });
}

/**
 * Publishes the content of an older revision as the cluster's next revision
 * and audits it in the same transaction (nothing is written when the
 * revision does not exist).
 */
/** Thrown to roll the preview's transaction back once it holds the result. */
class PreviewDone extends Error {
  constructor(readonly preview: RollbackPreview) {
    super("rollback preview");
  }
}

/**
 * What rolling back to `revision` would publish, against the latest
 * revision. The content is built as the rollback builds it, in a
 * transaction that is rolled back: nothing it writes persists.
 */
export async function previewRollback(
  db: Database,
  input: { id: string; revision: number },
): Promise<RollbackPreview> {
  try {
    await db.transaction(async (tx) => {
      const cluster = await findCluster(tx, input.id);
      const content = await rollbackContent(tx, cluster.id, input.revision);
      if (!content) fail("REVISION_NOT_FOUND", "revision not found");
      const latest = await latestRevision(tx, cluster.id);
      throw new PreviewDone({
        revision: input.revision,
        currentRevision: latest?.revision ?? null,
        unchanged: latest?.contentHash === content.contentHash,
        sites: siteChanges(latest ? decodeNodeConfig(latest.ir) : undefined, content),
      });
    });
  } catch (error) {
    if (error instanceof PreviewDone) return error.preview;
    throw error;
  }
  throw new Error("rollback preview ended without a result");
}

export async function rollbackCluster(
  db: Database,
  input: { id: string; revision: number },
  actor: Actor,
): Promise<Revision> {
  return db.transaction(async (tx) => {
    const cluster = await findCluster(tx, input.id);
    const result = await rollbackToRevision(tx, {
      clusterId: cluster.id,
      revision: input.revision,
      actor,
    });
    if (!result) fail("REVISION_NOT_FOUND", "revision not found");
    await recordAudit(tx, actor, {
      action: "cluster.rollback",
      targetType: "cluster",
      targetId: cluster.id,
      targetName: cluster.name,
      metadata: {
        toRevision: input.revision,
        revision: result.row.revision,
        contentHash: result.row.contentHash,
        // false: the target's content is already the latest revision.
        created: result.created,
      },
    });
    return toRevisionDto(result.row);
  });
}

/** The cluster a new site lands on when none is specified: the oldest cluster. */
export async function defaultClusterId(db: Executor): Promise<string> {
  const [row] = await db
    .select({ id: schema.cluster.id })
    .from(schema.cluster)
    .orderBy(asc(schema.cluster.createdAt))
    .limit(1);
  if (!row) fail("NO_CLUSTER", "no cluster exists yet");
  return row.id;
}
