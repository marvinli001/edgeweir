import { create } from "@bufbuild/protobuf";
import { timestampDate, timestampFromDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  demoAddress,
  NODE_DEBUG_LOG_LIMITS,
  NODE_DEBUG_LOGS_FEATURE,
  NODE_LOG_LIMITS,
  type NodeDebugLog,
  type NodeDebugLogEntry,
  type NodeDebugLogLevel,
  type NodeDebugLogList,
  type NodeDebugLogPullInput,
  type NodeDebugLogState,
  type NodeDebugLogSummary,
  type NodeLogSource,
  nodeSupportsFeature,
  redactNodeLogField,
  redactNodeLogText,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  DebugLogsTaskSchema,
  NodeLogLevel as Level,
  NodeLogSource as Source,
  NodeTaskSchema,
  type ReportTaskResultRequest,
  TaskState,
  type UploadDebugLogsRequest,
} from "@edgeweir/proto";
import { and, desc, eq, getTableColumns, inArray, lt, notInArray, or, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { TASKS_CHANNEL } from "../lib/events";
import { type Actor, recordAudit } from "./audit";
import { nodeLogRetentionSetting } from "./node-logs";
import type { Executor } from "./revisions";

/*
 * Debug log pulls (debug-logs-v1, ADR-0050): the operator asks a node for
 * the debug log buffer it keeps in memory. The pull is handed to the node as
 * a DebugLogsTask; the node uploads the matching entries once
 * (UploadDebugLogs) and reports the task's result. A pull the node has not
 * answered by its deadline fails (debug_logs_timeout); one handed out but
 * not answered within the lease is handed out again.
 */

const t = schema.nodeDebugLog;
const { entries: _entries, ...summaryColumns } = getTableColumns(t);
type NodeDebugLogRow = NonNullable<typeof t.$inferSelect.entries>[number];
const OPEN = ["pending", "running"];
const LEASE_MS = 60_000;
const DAY = 86_400_000;

const LEVELS: Partial<Record<Level, NodeDebugLogLevel>> = {
  [Level.DEBUG]: "debug",
  [Level.INFO]: "info",
  [Level.WARN]: "warn",
  [Level.ERROR]: "error",
};
const SOURCES: Partial<Record<Source, NodeLogSource>> = {
  [Source.AGENT]: "agent",
  [Source.SUPERVISOR]: "supervisor",
  [Source.NGINX]: "nginx",
  [Source.LUA]: "lua",
};
const PROTO_SOURCES: Record<NodeLogSource, Source> = {
  agent: Source.AGENT,
  supervisor: Source.SUPERVISOR,
  nginx: Source.NGINX,
  lua: Source.LUA,
};
const FIELD_KEY = /^[a-z0-9_.-]{1,64}$/;
/** Control characters other than newline and tab removed. */
const clean = (s: string) => s.replace(/(?![\n\t])\p{Cc}/gu, "");

/** Fails the open pulls past their deadline (of one node, or all). */
async function expirePulls(db: Executor, nodeId?: string, now = new Date()) {
  await db
    .update(t)
    .set({
      state: "failed",
      errorCode: "debug_logs_timeout",
      message: "the node did not answer in time",
      finishedAt: now,
      leaseUntil: null,
    })
    .where(
      and(
        inArray(t.state, OPEN),
        lt(t.deadlineAt, now),
        nodeId ? eq(t.nodeId, nodeId) : undefined,
      ),
    );
}

/** Asks the node for its debug log buffer (one open pull per node). */
export async function pullDebugLogs(
  app: AppContext,
  actor: Actor,
  input: NodeDebugLogPullInput,
): Promise<NodeDebugLogSummary> {
  const [node] = await app.db
    .select({
      id: schema.node.id,
      name: schema.node.name,
      clusterId: schema.node.clusterId,
      supportedFeatures: schema.node.supportedFeatures,
    })
    .from(schema.node)
    .where(eq(schema.node.id, input.id));
  if (!node) return fail("NODE_NOT_FOUND", "node not found");
  if (!nodeSupportsFeature(node.supportedFeatures, NODE_DEBUG_LOGS_FEATURE))
    return fail("NODE_CAPABILITY_REQUIRED", "the node keeps no debug logs", {
      features: NODE_DEBUG_LOGS_FEATURE,
      nodes: node.name,
    });
  const row = await app.db.transaction(async (tx) => {
    await expirePulls(tx, node.id);
    const now = new Date();
    const [created] = await tx
      .insert(t)
      .values({
        nodeId: node.id,
        since: input.from ? new Date(input.from) : null,
        until: input.to ? new Date(input.to) : null,
        components: [...new Set(input.components)],
        sources: [...new Set(input.sources)],
        createdAt: now,
        deadlineAt: new Date(now.getTime() + NODE_DEBUG_LOG_LIMITS.timeoutSeconds * 1000),
      })
      .onConflictDoNothing()
      .returning();
    if (!created) return fail("NODE_DEBUG_LOGS_BUSY", "a debug log pull of the node is open");
    await recordAudit(tx, actor, {
      action: "node.debug_logs_pull",
      targetType: "node",
      targetId: node.id,
      targetName: node.name,
      metadata: {
        pullId: created.id,
        from: input.from ?? null,
        to: input.to ?? null,
        components: created.components,
        sources: created.sources,
      },
    });
    await tx.execute(
      sql`select pg_notify(${TASKS_CHANNEL}, ${JSON.stringify({ clusterIds: [node.clusterId] })})`,
    );
    return created;
  });
  return toSummary(row);
}

/** The node's pulls, newest first, without their entries. */
export async function listDebugLogs(db: Database, nodeId: string): Promise<NodeDebugLogList> {
  const [node] = await db
    .select({ id: schema.node.id, supportedFeatures: schema.node.supportedFeatures })
    .from(schema.node)
    .where(eq(schema.node.id, nodeId));
  if (!node) return fail("NODE_NOT_FOUND", "node not found");
  await expirePulls(db, node.id);
  const rows = await db
    .select(summaryColumns)
    .from(t)
    .where(eq(t.nodeId, node.id))
    .orderBy(desc(t.createdAt))
    .limit(NODE_DEBUG_LOG_LIMITS.kept);
  return {
    pulls: rows.map(toSummary),
    supported: nodeSupportsFeature(node.supportedFeatures, NODE_DEBUG_LOGS_FEATURE),
  };
}

/** One pull with its entries; demo: client addresses reduced. */
export async function getDebugLog(
  db: Database,
  input: { id: string; pullId: string },
  demo = false,
): Promise<NodeDebugLog> {
  await expirePulls(db, input.id);
  const [row] = await db
    .select()
    .from(t)
    .where(and(eq(t.id, input.pullId), eq(t.nodeId, input.id)));
  if (!row) return fail("NODE_DEBUG_LOG_NOT_FOUND", "debug log pull not found");
  return {
    ...toSummary(row),
    entries: (row.entries ?? []).map((e) => toEntry(e, demo)),
  };
}

function toEntry(e: NodeDebugLogRow, demo: boolean): NodeDebugLogEntry {
  const fields = { ...e.fields };
  if (demo && fields.client) fields.client = demoAddress(fields.client);
  return {
    time: e.time,
    level: e.level as NodeDebugLogLevel,
    source: e.source as NodeLogSource,
    component: e.component,
    message: e.message,
    fields,
    truncated: e.truncated,
    event: e.event,
  };
}

function toSummary(r: Omit<typeof t.$inferSelect, "entries">): NodeDebugLogSummary {
  return {
    id: r.id,
    nodeId: r.nodeId,
    state: r.state as NodeDebugLogState,
    from: r.since?.toISOString() ?? null,
    to: r.until?.toISOString() ?? null,
    components: r.components,
    sources: r.sources as NodeLogSource[],
    createdAt: r.createdAt.toISOString(),
    deadlineAt: r.deadlineAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
    errorCode: r.errorCode,
    errorParams: r.errorParams,
    entryCount: r.entryCount,
    truncated: r.truncated,
    bufferSince: r.bufferSince?.toISOString() ?? null,
    overwritten: r.overwritten,
    supervisorMissing: r.supervisorMissing,
  };
}

/** Whether the node has a pull to hand out (heartbeat tasks_pending). */
export async function hasDebugLogTasks(db: Executor, nodeId: string): Promise<boolean> {
  const now = new Date();
  const rows = await db
    .select({ id: t.id })
    .from(t)
    .where(and(eq(t.nodeId, nodeId), deliverable(now)))
    .limit(1);
  return rows.length > 0;
}

const deliverable = (now: Date) =>
  and(
    sql`${t.deadlineAt} >= ${now}`,
    or(eq(t.state, "pending"), and(eq(t.state, "running"), lt(t.leaseUntil, now))),
  );

/** The node's open pull as a DebugLogsTask (leased), or null. */
export async function pullDebugLogTask(app: AppContext, node: { id: string }) {
  return app.db.transaction(async (tx) => {
    await expirePulls(tx, node.id);
    const now = new Date();
    const [row] = await tx
      .select()
      .from(t)
      .where(and(eq(t.nodeId, node.id), deliverable(now)))
      .limit(1)
      .for("update");
    if (!row) return null;
    await tx
      .update(t)
      .set({ state: "running", leaseUntil: new Date(now.getTime() + LEASE_MS) })
      .where(eq(t.id, row.id));
    return create(NodeTaskSchema, {
      id: row.id,
      createdAt: timestampFromDate(row.createdAt),
      kind: {
        case: "debugLogs",
        value: create(DebugLogsTaskSchema, {
          since: row.since ? timestampFromDate(row.since) : undefined,
          until: row.until ? timestampFromDate(row.until) : undefined,
          components: row.components,
          sources: row.sources.map((s) => PROTO_SOURCES[s as NodeLogSource]),
        }),
      },
    });
  });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Stores the node's answer to its open pull: entries the console cannot read
 * are left out, secrets removed again, sizes capped. A second upload, or one
 * after the deadline, is refused.
 */
export async function uploadDebugLogs(
  app: AppContext,
  node: { id: string },
  req: UploadDebugLogsRequest,
  now = new Date(),
): Promise<number> {
  if (!UUID.test(req.taskId) || req.entries.length > NODE_DEBUG_LOG_LIMITS.entries)
    throw new ConnectError("invalid debug log upload", Code.InvalidArgument);
  const entries: NodeDebugLogRow[] = [];
  let bytes = 0;
  for (const e of req.entries) {
    const level = LEVELS[e.level];
    const source = SOURCES[e.source];
    if (!level || !source) continue;
    let time = e.time ? timestampDate(e.time).getTime() : Number.NaN;
    if (!Number.isFinite(time)) time = now.getTime();
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(e.fields)) {
      if (!FIELD_KEY.test(key) || Object.keys(fields).length >= NODE_LOG_LIMITS.fields) continue;
      fields[key] = redactNodeLogField(key, clean(value)).slice(0, NODE_LOG_LIMITS.fieldValue);
    }
    const row: NodeDebugLogRow = {
      time: new Date(time).toISOString(),
      level,
      source,
      component: FIELD_KEY.test(e.component) ? e.component : "",
      message: redactNodeLogText(clean(e.message)).slice(0, NODE_LOG_LIMITS.message),
      fields,
      truncated: e.truncated,
      event: FIELD_KEY.test(e.event) ? e.event : "",
    };
    bytes += row.message.length + JSON.stringify(row.fields).length + 64;
    if (bytes > NODE_DEBUG_LOG_LIMITS.bytes)
      throw new ConnectError("debug log upload too large", Code.InvalidArgument);
    entries.push(row);
  }
  const [stored] = await app.db
    .update(t)
    .set({
      state: "succeeded",
      finishedAt: now,
      leaseUntil: null,
      entries,
      entryCount: entries.length,
      truncated: req.truncated,
      bufferSince: req.bufferSince ? timestampDate(req.bufferSince) : null,
      overwritten: Math.min(Number(req.overwritten), Number.MAX_SAFE_INTEGER),
      supervisorMissing: req.supervisorMissing,
    })
    .where(
      and(
        eq(t.id, req.taskId),
        eq(t.nodeId, node.id),
        inArray(t.state, OPEN),
        sql`${t.deadlineAt} >= ${now}`,
      ),
    )
    .returning({ id: t.id });
  if (!stored)
    throw new ConnectError("no open debug log pull with this id", Code.FailedPrecondition);
  return entries.length;
}

/**
 * Records the result of a DebugLogsTask; false when the task is not a pull of
 * the node. A failure ends an open pull; a success without an upload too.
 */
export async function reportDebugLogResult(
  app: AppContext,
  nodeId: string,
  result: ReportTaskResultRequest,
): Promise<boolean> {
  const [row] = await app.db
    .select({ id: t.id, state: t.state })
    .from(t)
    .where(and(eq(t.id, result.taskId), eq(t.nodeId, nodeId)));
  if (!row) return false;
  if (!OPEN.includes(row.state)) return true;
  const failed = result.state === TaskState.FAILED;
  await app.db
    .update(t)
    .set({
      state: "failed",
      errorCode: failed ? result.errorCode.slice(0, 64) || "debug_logs_failed" : "debug_logs_failed",
      errorParams: failed ? limitParams(result.errorParams) : { reason: "upload_failed" },
      message: result.message.slice(0, 1000),
      finishedAt: result.finishedAt ? timestampDate(result.finishedAt) : new Date(),
      leaseUntil: null,
    })
    .where(and(eq(t.id, row.id), inArray(t.state, OPEN)));
  return true;
}

function limitParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => FIELD_KEY.test(key))
      .slice(0, 8)
      .map(([key, value]) => [key, value.slice(0, 200)]),
  );
}

/**
 * Deletes pulls older than the node log retention and each node's oldest
 * beyond NODE_DEBUG_LOG_LIMITS.kept. Returns the pulls deleted.
 */
export async function pruneNodeDebugLogs(db: Database, now = new Date()): Promise<number> {
  const { days } = await nodeLogRetentionSetting.read(db);
  await expirePulls(db, undefined, now);
  const old = await db
    .delete(t)
    .where(and(lt(t.createdAt, new Date(now.getTime() - days * DAY)), notInArray(t.state, OPEN)))
    .returning({ id: t.id });
  const over = await db.execute<{ id: string }>(sql`
    delete from ${t} where ${t.id} in (
      select id from (
        select id, row_number() over (partition by node_id order by created_at desc) as n
        from ${t}
      ) ranked where n > ${NODE_DEBUG_LOG_LIMITS.kept}
    ) returning id`);
  return old.length + over.rows.length;
}
