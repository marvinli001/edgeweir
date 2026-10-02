import {
  USAGE_WINDOW_SECONDS,
  type UsageRecord,
  type UsageSettings,
  usageSettings,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq, gt, gte, lt, lte, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import { lockUsage, lockUsageWatermark } from "../lib/locks";
import { deleteInBatches } from "../lib/retention";
import { type Actor, recordAudit } from "./audit";
import type { Executor } from "./revisions";
import { findSite } from "./sites";

const WINDOW_MS = USAGE_WINDOW_SECONDS * 1000;
const SETTINGS_KEY = "usage_settings";
const WATERMARK_KEY = "usage_watermark";
export const USAGE_DEFAULTS: UsageSettings = { retentionDays: 100, offlineThresholdMinutes: 60 };
/** A node's watermark may run ahead of the console clock by at most this much. */
const CLOCK_SKEW_MS = 60_000;

type UsageRow = typeof schema.siteUsage.$inferSelect;

const floorWindow = (ms: number) => Math.floor(ms / WINDOW_MS) * WINDOW_MS;

function toRecord(row: UsageRow): UsageRecord {
  const start = row.windowStart.getTime();
  return {
    id: `${row.siteId}.${start / 1000}`,
    siteId: row.siteId,
    windowStart: row.windowStart.toISOString(),
    windowEnd: new Date(start + WINDOW_MS).toISOString(),
    requests: row.requests,
    bytesSent: row.bytesSent,
    bytesReceived: row.bytesReceived,
    revision: row.revision,
    seq: row.seq.toString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getUsageSettings(db: Executor): Promise<UsageSettings> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, SETTINGS_KEY));
  const parsed = usageSettings.safeParse({ ...USAGE_DEFAULTS, ...(row?.value ?? {}) });
  return parsed.success ? parsed.data : USAGE_DEFAULTS;
}

export async function setUsageSettings(db: Database, input: UsageSettings, actor: Actor) {
  return db.transaction(async (tx) => {
    const before = await getUsageSettings(tx);
    await tx
      .insert(schema.systemSetting)
      .values({ key: SETTINGS_KEY, value: input })
      .onConflictDoUpdate({ target: schema.systemSetting.key, set: { value: input } });
    await recordAudit(tx, actor, {
      action: "system.usage_update",
      targetType: "system_setting",
      targetId: SETTINGS_KEY,
      metadata: { from: before, to: input },
    });
    return input;
  });
}

/** The stored completeness watermark (it only moves forward), or null. */
export async function usageCompleteUntil(db: Executor): Promise<Date | null> {
  const [row] = await db
    .select()
    .from(schema.systemSetting)
    .where(eq(schema.systemSetting.key, WATERMARK_KEY));
  const value = row?.value.completeUntil;
  return typeof value === "string" ? new Date(value) : null;
}

/**
 * Records a node's statistics watermark (ReportStatsV2.complete_until):
 * whole minutes, never ahead of the console clock by more than a minute,
 * and never backwards.
 */
export async function recordStatsWatermark(
  db: Executor,
  nodeId: string,
  completeUntil: Date,
  now = Date.now(),
) {
  const minute = Math.floor(completeUntil.getTime() / 60_000) * 60_000;
  const bounded = new Date(Math.min(minute, Math.floor((now + CLOCK_SKEW_MS) / 60_000) * 60_000));
  const cursor = schema.nodeStatsCursor;
  await db
    .insert(cursor)
    .values({ nodeId, completeUntil: bounded })
    .onConflictDoUpdate({
      target: cursor.nodeId,
      set: {
        completeUntil: sql`greatest(coalesce(${cursor.completeUntil}, ${bounded.toISOString()}::timestamptz), ${bounded.toISOString()}::timestamptz)`,
      },
    });
}

/**
 * Computes one window of a site from node_minute_stats of every node. A
 * window whose values change gets revision + 1 and a new seq; an unchanged
 * recomputation touches nothing. Returns whether the row changed. Call with
 * the usage lock held.
 */
async function computeUsageWindow(tx: Executor, siteId: string, bucket: Date): Promise<boolean> {
  const start = bucket.toISOString();
  const end = new Date(bucket.getTime() + WINDOW_MS).toISOString();
  const result = await tx.execute<{ seq: string }>(sql`
    insert into site_usage (window_start, site_id, requests, bytes_sent, bytes_received, revision, seq, updated_at)
    select ${start}::timestamptz, s.id,
      coalesce(sum(m.requests), 0), coalesce(sum(m.bytes_sent), 0), coalesce(sum(m.bytes_received), 0),
      1, nextval('site_usage_seq'), now()
    from site s left join node_minute_stats m
      on m.site_id = s.id and m.minute >= ${start}::timestamptz and m.minute < ${end}::timestamptz
    where s.id = ${siteId}::uuid
    group by s.id
    on conflict (window_start, site_id) do update set
      requests = excluded.requests,
      bytes_sent = excluded.bytes_sent,
      bytes_received = excluded.bytes_received,
      revision = site_usage.revision + 1,
      seq = excluded.seq,
      updated_at = excluded.updated_at
    where (site_usage.requests, site_usage.bytes_sent, site_usage.bytes_received)
      is distinct from (excluded.requests, excluded.bytes_sent, excluded.bytes_received)
    returning seq
  `);
  return result.rows.length > 0;
}

/**
 * Recomputes the usage windows marked dirty by ingestion (closed windows
 * only). A window's markers (one per node) are read before it is computed
 * and cleared only if no ingestion wrote them since: data that arrives while
 * the window is computed leaves its marker for the next run. `onComputed`
 * runs between computing and clearing (for tests).
 */
export async function rollupUsage(
  db: Database,
  now = new Date(),
  limit = 500,
  onComputed?: (tx: Executor) => Promise<void>,
): Promise<number> {
  return db.transaction(async (tx) => {
    await lockUsage(tx);
    const dirty = schema.statsRollupDirty;
    const closedBefore = new Date(floorWindow(now.getTime()));
    const keys = await tx
      .selectDistinct({ bucket: dirty.bucket, siteId: dirty.siteId })
      .from(dirty)
      .where(and(eq(dirty.granularity, "usage"), lt(dirty.bucket, closedBefore)))
      .orderBy(dirty.bucket, dirty.siteId)
      .limit(limit);
    let changed = 0;
    for (const key of keys) {
      const marker = and(
        eq(dirty.granularity, "usage"),
        eq(dirty.bucket, key.bucket),
        eq(dirty.siteId, key.siteId),
      );
      const markers = await tx
        .select({ nodeId: dirty.nodeId, generation: dirty.generation })
        .from(dirty)
        .where(marker);
      if (await computeUsageWindow(tx, key.siteId, key.bucket)) changed++;
      await onComputed?.(tx);
      for (const read of markers)
        await tx
          .delete(dirty)
          .where(and(marker, eq(dirty.nodeId, read.nodeId), eq(dirty.generation, read.generation)));
    }
    return changed;
  });
}

/**
 * Computes every usage window of a site that is still marked dirty, open
 * ones included, before the site and its statistics are deleted (usage
 * outlives the site). Call with the statistics lock held exclusively, so
 * that no ingestion is in flight. Returns how many windows changed.
 */
export async function flushSiteUsage(tx: Executor, siteId: string): Promise<number> {
  await lockUsage(tx);
  const dirty = schema.statsRollupDirty;
  const buckets = await tx
    .selectDistinct({ bucket: dirty.bucket })
    .from(dirty)
    .where(and(eq(dirty.granularity, "usage"), eq(dirty.siteId, siteId)))
    .orderBy(dirty.bucket);
  let changed = 0;
  for (const { bucket } of buckets) if (await computeUsageWindow(tx, siteId, bucket)) changed++;
  return changed;
}

/**
 * The completeness watermark: the earliest statistics watermark among nodes
 * that are active and were seen within the offline threshold (a node that
 * never reported one counts from its enrollment; none counts as older than
 * the threshold), capped by windows still waiting to be computed, rounded
 * down to a window. Stored, it only moves
 * forward: data that arrives later for an earlier window is a revision.
 */
export async function advanceUsageWatermark(db: Database, now = new Date()): Promise<Date | null> {
  return db.transaction(async (tx) => {
    await lockUsageWatermark(tx);
    const { offlineThresholdMinutes } = await getUsageSettings(tx);
    const seenSince = new Date(now.getTime() - offlineThresholdMinutes * 60_000);
    const nodes = await tx
      .select({
        enrolledAt: schema.node.enrolledAt,
        createdAt: schema.node.createdAt,
        completeUntil: schema.nodeStatsCursor.completeUntil,
      })
      .from(schema.node)
      .leftJoin(schema.nodeStatsCursor, eq(schema.nodeStatsCursor.nodeId, schema.node.id))
      .where(and(eq(schema.node.status, "active"), gte(schema.node.lastSeenAt, seenSince)));
    let candidate = now.getTime();
    // A node holds the watermark back by at most the offline threshold, like
    // a node that went offline: what it reports later is a revision.
    const oldest = now.getTime() - offlineThresholdMinutes * 60_000;
    for (const n of nodes)
      candidate = Math.min(
        candidate,
        Math.max((n.completeUntil ?? n.enrolledAt ?? n.createdAt).getTime(), oldest),
      );
    const [pending] = await tx
      .select({ bucket: sql<Date | null>`min(${schema.statsRollupDirty.bucket})` })
      .from(schema.statsRollupDirty)
      .where(eq(schema.statsRollupDirty.granularity, "usage"));
    if (pending?.bucket) candidate = Math.min(candidate, new Date(pending.bucket).getTime());
    const computed = floorWindow(candidate);
    const stored = await usageCompleteUntil(tx);
    if (stored && stored.getTime() >= computed) return stored;
    const next = new Date(computed);
    await tx
      .insert(schema.systemSetting)
      .values({ key: WATERMARK_KEY, value: { completeUntil: next.toISOString() } })
      .onConflictDoUpdate({
        target: schema.systemSetting.key,
        set: { value: { completeUntil: next.toISOString() } },
      });
    return next;
  });
}

/** Deletes usage older than the retention period. */
export async function pruneUsage(db: Database, now = new Date()): Promise<number> {
  const { retentionDays } = await getUsageSettings(db);
  const cutoff = new Date(floorWindow(now.getTime()) - retentionDays * 86_400_000);
  return deleteInBatches(db, schema.siteUsage, lt(schema.siteUsage.windowStart, cutoff));
}

/** Worker: recompute dirty windows, advance the watermark, apply retention. */
export async function maintainUsage(db: Database, now = new Date()) {
  let changed = 0;
  // Several passes drain a backlog (e.g. after an outage) without one huge transaction.
  for (let pass = 0; pass < 20; pass++) {
    const before = changed;
    changed += await rollupUsage(db, now);
    const [left] = await db
      .select({ n: sql<number>`count(*)`.mapWith(Number) })
      .from(schema.statsRollupDirty)
      .where(
        and(
          eq(schema.statsRollupDirty.granularity, "usage"),
          lt(schema.statsRollupDirty.bucket, new Date(floorWindow(now.getTime()))),
        ),
      );
    if (!left?.n || changed === before) break;
  }
  await advanceUsageWatermark(db, now);
  await pruneUsage(db, now);
  return changed;
}

function parseAligned(value: string): Date {
  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() % WINDOW_MS !== 0)
    fail("USAGE_RANGE_INVALID", "from and to must be multiples of 5 minutes (UTC)");
  return date;
}

function encodeCursor(row: UsageRow) {
  return Buffer.from(`${row.windowStart.toISOString()}|${row.siteId}`).toString("base64url");
}

function decodeCursor(cursor: string): { windowStart: Date; siteId: string } {
  const [time, siteId] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
  const windowStart = new Date(time ?? "");
  if (
    Number.isNaN(windowStart.getTime()) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(siteId ?? "")
  )
    fail("USAGE_CURSOR_INVALID", "invalid cursor");
  return { windowStart, siteId: siteId as string };
}

/** Usage in [from, to), ordered by window then site, one page at a time. */
export async function listUsage(
  db: Database,
  input: {
    from: string;
    to: string;
    siteId?: string;
    cursor?: string;
    limit: number;
  },
) {
  const from = parseAligned(input.from);
  const to = parseAligned(input.to);
  if (to.getTime() <= from.getTime()) fail("USAGE_RANGE_INVALID", "to must be after from");
  if (input.siteId)
    await findSite(db, input.siteId).catch((error) => {
      // Usage outlives deleted sites: a site id without a row still filters.
      if ((error as { code?: string }).code !== "SITE_NOT_FOUND") throw error;
    });
  const u = schema.siteUsage;
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await db
    .select()
    .from(u)
    .where(
      and(
        gte(u.windowStart, from),
        lt(u.windowStart, to),
        input.siteId ? eq(u.siteId, input.siteId) : undefined,
        // A row comparison: one range of the primary key (window_start, site_id).
        after
          ? sql`(${u.windowStart}, ${u.siteId}) > (${after.windowStart.toISOString()}::timestamptz, ${after.siteId}::uuid)`
          : undefined,
      ),
    )
    .orderBy(asc(u.windowStart), asc(u.siteId))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const completeUntil = await usageCompleteUntil(db);
  return {
    items: page.map(toRecord),
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
    completeUntil: completeUntil?.toISOString() ?? null,
  };
}

/** Records created or revised after `afterSeq`, in seq order. */
export async function usageChanges(db: Database, input: { afterSeq: string; limit: number }) {
  const afterSeq = BigInt(input.afterSeq);
  if (afterSeq > 9223372036854775807n) fail("USAGE_CURSOR_INVALID", "afterSeq is out of range");
  const u = schema.siteUsage;
  const rows = await db
    .select()
    .from(u)
    .where(gt(u.seq, afterSeq))
    .orderBy(asc(u.seq))
    .limit(input.limit);
  const completeUntil = await usageCompleteUntil(db);
  const last = rows[rows.length - 1];
  return {
    items: rows.map(toRecord),
    lastSeq: last ? last.seq.toString() : input.afterSeq,
    completeUntil: completeUntil?.toISOString() ?? null,
  };
}

/** For tests and diagnostics: the rows of a window range. */
export async function usageRows(db: Executor, siteId: string, from: Date, to: Date) {
  return db
    .select()
    .from(schema.siteUsage)
    .where(
      and(
        eq(schema.siteUsage.siteId, siteId),
        gte(schema.siteUsage.windowStart, from),
        lte(schema.siteUsage.windowStart, to),
      ),
    )
    .orderBy(asc(schema.siteUsage.windowStart));
}
