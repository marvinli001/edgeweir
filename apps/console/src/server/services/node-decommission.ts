import { randomUUID } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { NODE_DECOMMISSION_FEATURE, type Node, nodeSupportsFeature } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  DecommissionTaskSchema,
  NodeTaskSchema,
  type ReportTaskResultRequest,
  TaskState,
} from "@edgeweir/proto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { TASKS_CHANNEL } from "../lib/events";
import { type Actor, recordAudit } from "./audit";
import { deleteNode, getNode } from "./nodes";

/*
 * Decommission (decommission-v1, ADR-0067): the operator retires a node
 * without SSH. The node row keeps the request and the id the
 * DecommissionTask is handed out with until the node answers; a node that
 * is offline gets it when it connects again. SUCCEEDED: the node stopped
 * serving and forgot its identity, so the console revokes its certificate
 * and deletes it. FAILED: the request ends with the node's error code.
 */

const n = schema.node;
const ERROR_MAX = 200;

/** Asks the node to retire itself; the node is deleted once it has. */
export async function requestDecommission(
  app: AppContext,
  actor: Actor,
  id: string,
): Promise<Node> {
  return app.db.transaction(async (tx) => {
    const [row] = await tx.select().from(n).where(eq(n.id, id)).for("update");
    if (!row) return fail("NODE_NOT_FOUND", "node not found");
    if (!nodeSupportsFeature(row.supportedFeatures, NODE_DECOMMISSION_FEATURE))
      return fail("NODE_CAPABILITY_REQUIRED", "the node cannot decommission itself", {
        features: NODE_DECOMMISSION_FEATURE,
        nodes: row.name,
      });
    if (row.status !== "active")
      return fail("NODE_DECOMMISSION_DISABLED", "a disabled node takes no tasks");
    if (row.decommissionRequestedAt)
      return fail("NODE_DECOMMISSION_PENDING", "the node's decommission is already waiting");
    const taskId = randomUUID();
    await tx
      .update(n)
      .set({
        decommissionRequestedAt: new Date(),
        decommissionTaskId: taskId,
        decommissionError: null,
      })
      .where(eq(n.id, id));
    await recordAudit(tx, actor, {
      action: "node.decommission",
      targetType: "node",
      targetId: id,
      targetName: row.name,
      metadata: { clusterId: row.clusterId, taskId },
    });
    await tx.execute(
      sql`select pg_notify(${TASKS_CHANNEL}, ${JSON.stringify({ clusterIds: [row.clusterId] })})`,
    );
    return getNode(tx, id);
  });
}

/** Withdraws a decommission the node has not answered (a node that already ran it is gone). */
export async function cancelDecommission(app: AppContext, actor: Actor, id: string): Promise<Node> {
  return app.db.transaction(async (tx) => {
    const [row] = await tx.select().from(n).where(eq(n.id, id)).for("update");
    if (!row) return fail("NODE_NOT_FOUND", "node not found");
    if (!row.decommissionRequestedAt)
      return fail("NODE_DECOMMISSION_NOT_PENDING", "no decommission of the node is waiting");
    await tx
      .update(n)
      .set({ decommissionRequestedAt: null, decommissionTaskId: null })
      .where(eq(n.id, id));
    await recordAudit(tx, actor, {
      action: "node.decommission_cancel",
      targetType: "node",
      targetId: id,
      targetName: row.name,
      metadata: { taskId: row.decommissionTaskId },
    });
    return getNode(tx, id);
  });
}

export async function hasDecommissionTask(db: Database, nodeId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: n.id })
    .from(n)
    .where(and(eq(n.id, nodeId), isNotNull(n.decommissionTaskId)));
  return !!row;
}

/** The node's DecommissionTask, while one waits (handed out again until the node answers). */
export async function pullDecommissionTask(db: Database, node: { id: string }) {
  const [row] = await db
    .select({ taskId: n.decommissionTaskId, requestedAt: n.decommissionRequestedAt })
    .from(n)
    .where(eq(n.id, node.id));
  if (!row?.taskId || !row.requestedAt) return null;
  return create(NodeTaskSchema, {
    id: row.taskId,
    createdAt: timestampFromDate(row.requestedAt),
    kind: { case: "decommission", value: create(DecommissionTaskSchema, {}) },
  });
}

/**
 * The node's answer to its DecommissionTask (false: not that task).
 * SUCCEEDED deletes the node and revokes its certificate.
 */
export async function reportDecommissionResult(
  app: AppContext,
  node: { id: string; name: string },
  req: ReportTaskResultRequest,
): Promise<boolean> {
  const [row] = await app.db
    .select({ taskId: n.decommissionTaskId })
    .from(n)
    .where(eq(n.id, node.id));
  if (!row?.taskId || row.taskId !== req.taskId) return false;
  const actor: Actor = { type: "node", id: node.id, name: node.name };
  if (req.state === TaskState.SUCCEEDED) {
    await deleteNode(app.db, node.id, actor, { decommissioned: true });
    app.log.info("node decommissioned", { nodeId: node.id, name: node.name });
    return true;
  }
  const reason = req.errorParams.reason ?? req.message;
  const error = `${req.errorCode || "decommission_failed"}${reason ? `: ${reason}` : ""}`.slice(
    0,
    ERROR_MAX,
  );
  await app.db.transaction(async (tx) => {
    await tx
      .update(n)
      .set({ decommissionRequestedAt: null, decommissionTaskId: null, decommissionError: error })
      .where(eq(n.id, node.id));
    await recordAudit(tx, actor, {
      action: "node.decommission_failed",
      targetType: "node",
      targetId: node.id,
      targetName: node.name,
      metadata: {
        taskId: req.taskId,
        errorCode: req.errorCode,
        reason: reason.slice(0, ERROR_MAX),
      },
    });
  });
  app.log.warn("node decommission failed", { nodeId: node.id, errorCode: req.errorCode });
  return true;
}
