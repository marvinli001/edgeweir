import { timestampDate } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import {
  demoAddress,
  NODE_LOG_EVENTS,
  NODE_LOG_LIMITS,
  NODE_LOG_RETENTION_DEFAULTS,
  NODE_LOGS_FEATURE,
  type NodeLogEntry,
  type NodeLogLevel,
  type NodeLogPage,
  type NodeLogQuery,
  type NodeLogSource,
  nodeLogRetention,
  nodeSupportsFeature,
  redactNodeLogField,
  redactNodeLogText,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  NodeLogLevel as Level,
  type ReportNodeLogsRequest,
  NodeLogSource as Source,
} from "@edgeweir/proto";
import { and, desc, eq, gte, inArray, lt, lte, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { tryLockNodeLogEntries } from "../lib/locks";
import { deleteInBatches } from "../lib/retention";
import type { Executor } from "./revisions";
import { defineSetting } from "./settings";

/** System setting: days node logs are kept and at most how many per node (ADR-0050). */
export const nodeLogRetentionSetting = defineSetting({
  key: "node_log_retention",
  schema: nodeLogRetention,
  defaults: { ...NODE_LOG_RETENTION_DEFAULTS },
  auditAction: "system.node_log_retention_update",
});

const DAY = 86_400_000;
/** Entries dated this far ahead of the console's clock are dated when they arrived. */
const MAX_AHEAD = 300_000;
const MAX_SEQUENCE = 9223372036854775807n;

const LEVELS: Partial<Record<Level, NodeLogLevel>> = {
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
const EVENTS: ReadonlySet<string> = new Set(NODE_LOG_EVENTS);
const FIELD_KEY = /^[a-z0-9_.-]{1,64}$/;

/** Control characters other than newline and tab removed (nginx -t output and tracebacks keep their lines). */
const clean = (s: string) => s.replace(/(?![\n\t])\p{Cc}/gu, "");

type Row = typeof schema.nodeLogEntry.$inferInsert;

/**
 * Stores a ReportNodeLogs batch of node: entries the console cannot read are
 * left out, secrets removed again, and the drops the node counted become
 * one "dropped" entry. A batch at or below the node's cursor is acknowledged
 * without storing it again. Returns the entries stored.
 */
export async function ingestNodeLogs(
  app: AppContext,
  node: { id: string },
  req: ReportNodeLogsRequest,
  now = Date.now(),
): Promise<number> {
  const sequence = req.batchSequence;
  if (sequence < 1n || sequence > MAX_SEQUENCE || req.entries.length > NODE_LOG_LIMITS.batch)
    throw new ConnectError("invalid node log batch", Code.InvalidArgument);
  const { days } = await nodeLogRetentionSetting.read(app.db);
  const oldest = now - days * DAY;
  const receivedAt = new Date(now);
  const rows: Row[] = [];
  req.entries.forEach((e, idx) => {
    const level = LEVELS[e.level];
    const source = SOURCES[e.source];
    if (!level || !source) return;
    // Info entries are the whitelisted events only.
    if (level === "info" && !EVENTS.has(e.event)) return;
    let time = e.time ? timestampDate(e.time).getTime() : Number.NaN;
    if (!Number.isFinite(time) || time > now + MAX_AHEAD) time = now;
    if (time < oldest) return;
    const fields: Record<string, string> = {};
    for (const [key, value] of Object.entries(e.fields)) {
      if (!FIELD_KEY.test(key) || Object.keys(fields).length >= NODE_LOG_LIMITS.fields) continue;
      fields[key] = redactNodeLogField(key, clean(value)).slice(0, NODE_LOG_LIMITS.fieldValue);
    }
    rows.push({
      nodeId: node.id,
      sequence,
      idx,
      time: new Date(time),
      receivedAt,
      kind: "entry",
      level,
      source,
      component: FIELD_KEY.test(e.component) ? e.component : "",
      message: redactNodeLogText(clean(e.message)).slice(0, NODE_LOG_LIMITS.message),
      fields,
      repeated: Math.min(e.repeated, 2 ** 31 - 1),
      truncated: e.truncated,
      event: level === "info" ? e.event : "",
    });
  });
  if (req.droppedRateLimited || req.droppedOverflow)
    rows.push({
      nodeId: node.id,
      sequence,
      idx: req.entries.length,
      time: receivedAt,
      receivedAt,
      kind: "dropped",
      level: "warn",
      source: "agent",
      droppedRateLimited: Math.min(req.droppedRateLimited, 2 ** 31 - 1),
      droppedOverflow: Math.min(req.droppedOverflow, 2 ** 31 - 1),
    });
  return app.db.transaction(async (tx) => {
    if (!(await tryLockNodeLogEntries(tx, node.id)))
      throw new ConnectError("node log batch already in progress", Code.ResourceExhausted);
    const cursor = schema.nodeLogEntryCursor;
    await tx.insert(cursor).values({ nodeId: node.id }).onConflictDoNothing();
    const [current] = await tx
      .select()
      .from(cursor)
      .where(eq(cursor.nodeId, node.id))
      .for("update");
    if (!current) throw new Error("missing node log cursor");
    if (sequence <= current.sequence) return 0;
    if (rows.length) await tx.insert(schema.nodeLogEntry).values(rows).onConflictDoNothing();
    await tx.update(cursor).set({ sequence }).where(eq(cursor.nodeId, node.id));
    return rows.filter((r) => r.kind === "entry").length;
  });
}

/** The cursor of a node's ReportNodeLogs batches (an empty sequence-zero request). */
export async function nodeLogCursor(db: Executor, nodeId: string): Promise<bigint> {
  const [row] = await db
    .select({ sequence: schema.nodeLogEntryCursor.sequence })
    .from(schema.nodeLogEntryCursor)
    .where(eq(schema.nodeLogEntryCursor.nodeId, nodeId));
  return row?.sequence ?? 0n;
}

const MIN_LEVEL: Record<NodeLogLevel, NodeLogLevel[]> = {
  info: ["info", "warn", "error"],
  warn: ["warn", "error"],
  error: ["error"],
};

type Cursor = { time: string; sequence: string; idx: number };
const encodeCursor = (c: Cursor) => Buffer.from(JSON.stringify(c)).toString("base64url");
function decodeCursor(raw: string): Cursor {
  try {
    const c = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (
      typeof c.time === "string" &&
      Number.isFinite(Date.parse(c.time)) &&
      typeof c.sequence === "string" &&
      /^\d{1,19}$/.test(c.sequence) &&
      Number.isInteger(c.idx)
    )
      return c as Cursor;
  } catch {}
  return fail("NODE_LOG_CURSOR_INVALID", "invalid cursor");
}

/** A node's log, newest first, a page at a time; demo: client addresses reduced. */
export async function listNodeLogs(
  db: Database,
  input: NodeLogQuery,
  demo = false,
): Promise<NodeLogPage> {
  const [node] = await db
    .select({ id: schema.node.id, supportedFeatures: schema.node.supportedFeatures })
    .from(schema.node)
    .where(eq(schema.node.id, input.id));
  if (!node) return fail("NODE_NOT_FOUND", "node not found");
  const t = schema.nodeLogEntry;
  const conditions = [eq(t.nodeId, node.id)];
  if (input.minLevel) conditions.push(inArray(t.level, MIN_LEVEL[input.minLevel]));
  if (input.source) conditions.push(eq(t.source, input.source));
  if (input.from) conditions.push(gte(t.time, new Date(input.from)));
  if (input.to) conditions.push(lte(t.time, new Date(input.to)));
  if (input.q) {
    const pattern = `%${input.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    conditions.push(sql`${t.message} ilike ${pattern}`);
  }
  if (input.cursor) {
    const c = decodeCursor(input.cursor);
    conditions.push(
      sql`(${t.time}, ${t.sequence}, ${t.idx}) < (${new Date(c.time)}, ${BigInt(c.sequence)}, ${c.idx})`,
    );
  }
  const rows = await db
    .select()
    .from(t)
    .where(and(...conditions))
    .orderBy(desc(t.time), desc(t.sequence), desc(t.idx))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page.at(-1);
  return {
    entries: page.map((r) => toEntry(r, demo)),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor({
            time: last.time.toISOString(),
            sequence: last.sequence.toString(),
            idx: last.idx,
          })
        : null,
    supported: nodeSupportsFeature(node.supportedFeatures, NODE_LOGS_FEATURE),
  };
}

function toEntry(r: typeof schema.nodeLogEntry.$inferSelect, demo: boolean): NodeLogEntry {
  const fields = { ...r.fields };
  if (demo && fields.client) fields.client = demoAddress(fields.client);
  return {
    id: `${r.sequence}-${r.idx}`,
    time: r.time.toISOString(),
    receivedAt: r.receivedAt.toISOString(),
    kind: r.kind === "dropped" ? "dropped" : "entry",
    level: r.level as NodeLogLevel,
    source: r.source as NodeLogSource,
    component: r.component,
    message: r.message,
    fields,
    repeated: r.repeated,
    truncated: r.truncated,
    event: r.event,
    dropped:
      r.kind === "dropped"
        ? { rateLimited: r.droppedRateLimited, overflow: r.droppedOverflow }
        : null,
  };
}

/**
 * Deletes node logs older than the retention, then each node's oldest
 * entries beyond its limit (in batches). Returns the entries deleted.
 */
export async function pruneNodeLogs(db: Database, now = new Date()): Promise<number> {
  const { days, perNode } = await nodeLogRetentionSetting.read(db);
  const t = schema.nodeLogEntry;
  let removed = await deleteInBatches(db, t, lt(t.time, new Date(now.getTime() - days * DAY)));
  const over = await db
    .select({ nodeId: t.nodeId })
    .from(t)
    .groupBy(t.nodeId)
    .having(sql`count(*) > ${perNode}`);
  for (const { nodeId } of over) {
    const [edge] = await db
      .select({ time: t.time, sequence: t.sequence, idx: t.idx })
      .from(t)
      .where(eq(t.nodeId, nodeId))
      .orderBy(desc(t.time), desc(t.sequence), desc(t.idx))
      .offset(perNode - 1)
      .limit(1);
    if (!edge) continue;
    // Everything older than the node's perNode-th newest entry.
    removed += await deleteInBatches(
      db,
      t,
      and(
        eq(t.nodeId, nodeId),
        sql`(${t.time}, ${t.sequence}, ${t.idx}) < (${edge.time}, ${edge.sequence}, ${edge.idx})`,
      ),
    );
  }
  return removed;
}
