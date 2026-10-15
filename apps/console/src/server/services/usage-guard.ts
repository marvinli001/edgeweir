import {
  USAGE_GUARD_BANDWIDTH_MINUTES,
  USAGE_WINDOW_SECONDS,
  type UsageGuard,
  type UsageGuardInput,
  type UsageGuardMetric,
  type UsageGuardPeriod,
  type UsageGuardSettings,
  usageGuardAction,
  usageGuardMetric,
  usageGuardPeriod,
  usageGuardRecovery,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, sql } from "drizzle-orm";
import type { AppContext } from "../lib/context";
import { fail } from "../lib/errors";
import { readMaintenance } from "../lib/site-content";
import { assertUpdatedAt } from "../lib/updated-at";
import { type Actor, recordAudit, systemActor } from "./audit";
import { type Executor, publishRevision, type Tx } from "./revisions";

type GuardRow = typeof schema.siteUsageGuard.$inferSelect;
type SiteRow = typeof schema.site.$inferSelect;
type HeldAction = "maintenance" | "disable";

const MINUTE = 60_000;
const WINDOW_MS = USAGE_WINDOW_SECONDS * 1000;
const METRICS = usageGuardMetric.options;

// ---------------------------------------------------------------- periods

const formatters = new Map<string, Intl.DateTimeFormat>();

/** The calendar date at `ms` in `timeZone`. */
function localDate(ms: number, timeZone: string) {
  let format = formatters.get(timeZone);
  if (!format) {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      calendar: "gregory",
      numberingSystem: "latn",
      year: "numeric",
      month: "numeric",
      day: "numeric",
    });
    formatters.set(timeZone, format);
  }
  const part = (parts: Intl.DateTimeFormatPart[], type: string) =>
    Number(parts.find((p) => p.type === type)?.value);
  const parts = format.formatToParts(ms);
  return { year: part(parts, "year"), month: part(parts, "month"), day: part(parts, "day") };
}

type CalendarDate = ReturnType<typeof localDate>;
const dateKey = (d: CalendarDate) => d.year * 10_000 + d.month * 100 + d.day;

/**
 * The first whole minute whose date in `timeZone` is `date`: local midnight,
 * or the end of a transition that skips it. Offsets lie between -12 and +14
 * hours, so the day starts within 15 hours before to 13 hours after
 * midnight UTC of the same date; found by bisection over minutes.
 */
function startOfDay(date: CalendarDate, timeZone: string): number {
  const target = dateKey(date);
  const midnight = Date.UTC(date.year, date.month - 1, date.day);
  let before = (midnight - 15 * 3_600_000) / MINUTE;
  let after = (midnight + 13 * 3_600_000) / MINUTE;
  while (after - before > 1) {
    const middle = Math.floor((before + after) / 2);
    if (dateKey(localDate(middle * MINUTE, timeZone)) >= target) after = middle;
    else before = middle;
  }
  return after * MINUTE;
}

const utcDate = (ms: number): CalendarDate => {
  const d = new Date(ms);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

/**
 * The calendar day or month containing `now` in `timeZone`, as UTC instants
 * [start, end). Current offsets are multiples of 15 minutes, so both are
 * multiples of the 5-minute usage window; a day with a daylight saving
 * transition is 23 or 25 hours long.
 */
export function periodBounds(period: UsageGuardPeriod, timeZone: string, now: number) {
  const today = localDate(now, timeZone);
  const first: CalendarDate = period === "day" ? today : { ...today, day: 1 };
  const next =
    period === "day"
      ? utcDate(Date.UTC(today.year, today.month - 1, today.day + 1))
      : utcDate(Date.UTC(today.year, today.month, 1));
  return {
    start: new Date(startOfDay(first, timeZone)),
    end: new Date(startOfDay(next, timeZone)),
  };
}

// ---------------------------------------------------------------- usage

const floorWindow = (ms: number) => Math.floor(ms / WINDOW_MS) * WINDOW_MS;

/**
 * Bytes sent and requests of a site in [start, now]: the computed 5-minute
 * windows of site_usage, and node_minute_stats from the first window that is
 * still open or waiting to be recomputed (so the latest minutes count before
 * their window closes, and a window with late data is not counted stale).
 */
export async function periodUsage(db: Executor, siteId: string, start: Date, end: Date, now: Date) {
  const [dirty] = await db
    .select({ bucket: sql<string | null>`min(${schema.statsRollupDirty.bucket})` })
    .from(schema.statsRollupDirty)
    .where(
      and(
        eq(schema.statsRollupDirty.granularity, "usage"),
        eq(schema.statsRollupDirty.siteId, siteId),
      ),
    );
  const open = floorWindow(now.getTime());
  const pending = dirty?.bucket ? new Date(dirty.bucket).getTime() : open;
  const tail = new Date(Math.max(start.getTime(), Math.min(open, pending)));
  const closed = await db.execute<{ bytes: string; requests: string }>(sql`
    select coalesce(sum(bytes_sent), 0)::text as bytes, coalesce(sum(requests), 0)::text as requests
    from site_usage where site_id = ${siteId}::uuid
      and window_start >= ${start.toISOString()}::timestamptz and window_start < ${tail.toISOString()}::timestamptz`);
  const recent = await db.execute<{ bytes: string; requests: string }>(sql`
    select coalesce(sum(bytes_sent), 0)::text as bytes, coalesce(sum(requests), 0)::text as requests
    from node_minute_stats where site_id = ${siteId}::uuid
      and minute >= ${tail.toISOString()}::timestamptz and minute < ${end.toISOString()}::timestamptz`);
  const value = (rows: { bytes: string; requests: string }[], key: "bytes" | "requests") =>
    BigInt(rows[0]?.[key] ?? "0");
  return {
    bytes: value(closed.rows, "bytes") + value(recent.rows, "bytes"),
    requests: value(closed.rows, "requests") + value(recent.rows, "requests"),
  };
}

/**
 * A site's bandwidth: bytes sent by every node in the last 5 complete
 * minutes, ending a minute before the current one (nodes report the minute
 * that just ended within a minute), in bits per second.
 */
export async function currentBandwidth(db: Executor, siteId: string, now: Date) {
  const minute = Math.floor(now.getTime() / MINUTE) * MINUTE;
  const to = new Date(minute - MINUTE);
  const from = new Date(to.getTime() - USAGE_GUARD_BANDWIDTH_MINUTES * MINUTE);
  const result = await db.execute<{ bytes: string }>(sql`
    select coalesce(sum(bytes_sent), 0)::text as bytes from node_minute_stats
    where site_id = ${siteId}::uuid
      and minute >= ${from.toISOString()}::timestamptz and minute < ${to.toISOString()}::timestamptz`);
  return (Number(result.rows[0]?.bytes ?? 0) * 8) / (USAGE_GUARD_BANDWIDTH_MINUTES * 60);
}

// ---------------------------------------------------------------- assessment

export interface Measured {
  period: { start: Date; end: Date };
  bytes: bigint;
  requests: bigint;
  bandwidthBps: number;
}

/** `used` is at least `percent` % of `limit`. */
const reached = (used: bigint, limit: bigint, percent: number) =>
  used * 100n >= limit * BigInt(percent);

/**
 * The guard's state for this evaluation (pure): the metrics at or over the
 * warning threshold and the limit in the current period, the bandwidth peak
 * of the period and the last time bandwidth was over its limit, and the
 * first metric that calls for the action (bytes and requests while over in
 * the period; bandwidth while over, then for the hold time with auto
 * recovery, or for the rest of the period with manual recovery).
 */
export function assessGuard(row: GuardRow, measured: Measured, now: Date) {
  const samePeriod = row.periodStart?.getTime() === measured.period.start.getTime();
  const bandwidth = Math.round(measured.bandwidthBps);
  const peak = Math.max(samePeriod ? row.bandwidthPeakBps : 0, bandwidth);
  const breachedAt =
    row.bandwidthBps !== null && bandwidth >= row.bandwidthBps ? now : row.bandwidthBreachedAt;
  const warn: UsageGuardMetric[] = [];
  const limit: UsageGuardMetric[] = [];
  const check = (metric: UsageGuardMetric, used: bigint, max: bigint | null) => {
    if (max === null) return;
    if (row.warnPercent !== null && reached(used, max, row.warnPercent)) warn.push(metric);
    if (reached(used, max, 100)) limit.push(metric);
  };
  check("bytes", measured.bytes, row.bytesLimit === null ? null : BigInt(row.bytesLimit));
  check(
    "requests",
    measured.requests,
    row.requestsLimit === null ? null : BigInt(row.requestsLimit),
  );
  check("bandwidth", BigInt(peak), row.bandwidthBps === null ? null : BigInt(row.bandwidthBps));
  const holding =
    row.recovery === "manual" ||
    (breachedAt !== null &&
      now.getTime() - breachedAt.getTime() < row.bandwidthHoldMinutes * MINUTE);
  const exceeded =
    METRICS.find((metric) => limit.includes(metric) && (metric !== "bandwidth" || holding)) ?? null;
  return { warn, limit, peak, breachedAt, exceeded };
}

/** The site is in the state the action puts it in. */
function siteIn(site: SiteRow, action: HeldAction) {
  return action === "disable" ? !site.enabled : readMaintenance(site.maintenance).enabled;
}

// ---------------------------------------------------------------- actions

interface ActionContext {
  actor: Actor;
  audit: "site.usage_guard_apply" | "site.usage_guard_release" | "site.usage_guard_restore";
  metadata: Record<string, unknown>;
}

/** Puts the site in (`on`) or out of the action's state, publishes its cluster and audits it. */
async function setActionState(
  tx: Tx,
  site: SiteRow,
  action: HeldAction,
  on: boolean,
  ctx: ActionContext,
) {
  const now = new Date();
  if (action === "disable") {
    await tx
      .update(schema.site)
      .set({ enabled: !on, updatedAt: now })
      .where(eq(schema.site.id, site.id));
  } else {
    await tx
      .update(schema.site)
      .set({
        maintenance: { ...readMaintenance(site.maintenance), enabled: on },
        maintenanceUpdatedAt: new Date(
          Math.max(now.getTime(), (site.maintenanceUpdatedAt?.getTime() ?? 0) + 1),
        ),
      })
      .where(eq(schema.site.id, site.id));
  }
  const { row } = await publishRevision(tx, {
    clusterId: site.clusterId,
    reason: {
      code: on ? "usage_limit_reached" : "usage_limit_released",
      params: { site: site.name },
    },
    actor: ctx.actor,
  });
  await recordAudit(tx, ctx.actor, {
    action: ctx.audit,
    targetType: "site",
    targetId: site.id,
    targetName: site.name,
    metadata: { ...ctx.metadata, action, revision: row.revision },
  });
}

/** An error's API code, for last_error. */
const errorCode = (error: unknown) => {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)
    ? code
    : "INTERNAL_SERVER_ERROR";
};

const limitsOf = (row: GuardRow) => ({
  bytes: row.bytesLimit,
  requests: row.requestsLimit,
  bandwidthBps: row.bandwidthBps,
});

/**
 * Evaluates a site's usage protection (the worker, every minute): records
 * the period's state and alerts, lets go of an action the operator undid
 * (paused until the period ends), lifts an action that is no longer called
 * for or no longer configured, and applies the action at 100% unless
 * paused or the site is already in that state (left alone then, and never
 * lifted). An action that cannot be published leaves last_error and is
 * retried at the next evaluation. Returns whether the held alerts changed.
 */
export async function evaluateUsageGuard(
  db: Database,
  siteId: string,
  now = new Date(),
  log?: AppContext["log"],
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [site] = await tx
      .select()
      .from(schema.site)
      .where(eq(schema.site.id, siteId))
      .for("update");
    const [row] = site
      ? await tx
          .select()
          .from(schema.siteUsageGuard)
          .where(eq(schema.siteUsageGuard.siteId, siteId))
          .for("update")
      : [];
    if (!site || !row) return false;
    const settings = toSettings(row);
    const period = periodBounds(settings.period, settings.timeZone, now.getTime());
    const usage = await periodUsage(tx, siteId, period.start, period.end, now);
    const bandwidthBps = await currentBandwidth(tx, siteId, now);
    const measured = { period, ...usage, bandwidthBps };
    const state = assessGuard(row, measured, now);
    const samePeriod = row.periodStart?.getTime() === period.start.getTime();
    let held = row.heldAction as HeldAction | null;
    let heldMetric = row.heldMetric;
    let heldSince = row.heldSince;
    let pausedUntil = row.pausedUntil && row.pausedUntil > now ? row.pausedUntil : null;
    let lastError = row.lastError;
    const metadata = (metric: string | null) => ({
      metric,
      period: { start: period.start.toISOString(), end: period.end.toISOString() },
      usage: {
        bytes: usage.bytes.toString(),
        requests: usage.requests.toString(),
        bandwidthBps: Math.round(bandwidthBps),
      },
      limits: limitsOf(row),
    });
    // The operator turned the site on or maintenance off themselves.
    if (held && !siteIn(site, held)) {
      held = null;
      heldMetric = null;
      heldSince = null;
      pausedUntil = period.end;
    }
    let current: SiteRow = site;
    const attempt = async (change: (sp: Tx) => Promise<void>) => {
      try {
        await tx.transaction(change);
        const [fresh] = await tx.select().from(schema.site).where(eq(schema.site.id, siteId));
        if (fresh) current = fresh;
        lastError = "";
        return true;
      } catch (error) {
        lastError = errorCode(error);
        log?.warn("usage protection action failed", { siteId, error: lastError });
        return false;
      }
    };
    const lift =
      held && (row.action !== held || (row.recovery === "auto" && state.exceeded === null));
    if (held && lift) {
      const action = held;
      const lifted = await attempt((sp) =>
        setActionState(sp, current, action, false, {
          actor: systemActor,
          audit: "site.usage_guard_release",
          metadata: metadata(heldMetric),
        }),
      );
      if (lifted) {
        held = null;
        heldMetric = null;
        heldSince = null;
      }
    }
    const wanted = row.action === "alert" ? null : (row.action as HeldAction);
    if (
      !held &&
      wanted &&
      state.exceeded &&
      !pausedUntil &&
      current.enabled &&
      !siteIn(current, wanted)
    ) {
      const metric = state.exceeded;
      const applied = await attempt((sp) =>
        setActionState(sp, current, wanted, true, {
          actor: systemActor,
          audit: "site.usage_guard_apply",
          metadata: metadata(metric),
        }),
      );
      if (applied) {
        held = wanted;
        heldMetric = metric;
        heldSince = now;
      }
    }
    if (!held && !(wanted && state.exceeded && !pausedUntil)) lastError = "";
    await tx
      .update(schema.siteUsageGuard)
      .set({
        periodStart: period.start,
        periodEnd: period.end,
        warnMetrics: state.warn,
        limitMetrics: state.limit,
        bandwidthPeakBps: state.peak,
        bandwidthBreachedAt: state.breachedAt,
        heldAction: held,
        heldMetric,
        heldSince,
        pausedUntil,
        lastError,
        evaluatedAt: now,
      })
      .where(eq(schema.siteUsageGuard.siteId, siteId));
    const same = (a: string[], b: string[]) =>
      a.length === b.length && a.every((m) => b.includes(m));
    return (
      !samePeriod || !same(row.warnMetrics, state.warn) || !same(row.limitMetrics, state.limit)
    );
  });
}

/**
 * Worker: evaluates every site's usage protection after the usage windows
 * were recomputed. One site's failure does not stop the others. Returns
 * whether an alert the guards hold changed (the caller sweeps alerts then).
 */
export async function enforceUsageGuards(app: AppContext, now = new Date()): Promise<boolean> {
  const rows = await app.db
    .select({ siteId: schema.siteUsageGuard.siteId })
    .from(schema.siteUsageGuard);
  let changed = false;
  for (const { siteId } of rows) {
    try {
      if (await evaluateUsageGuard(app.db, siteId, now, app.log)) changed = true;
    } catch (error) {
      app.log.warn("usage protection evaluation failed", {
        siteId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return changed;
}

/**
 * After the operator turned a site on or its maintenance off: a guard that
 * held that action lets go and is paused until its period ends. Call with
 * the site row locked, after the change.
 */
export async function noteOperatorRestore(tx: Tx, site: SiteRow, now = new Date()) {
  const [row] = await tx
    .select()
    .from(schema.siteUsageGuard)
    .where(eq(schema.siteUsageGuard.siteId, site.id))
    .for("update");
  if (!row?.heldAction || siteIn(site, row.heldAction as HeldAction)) return;
  const settings = toSettings(row);
  await tx
    .update(schema.siteUsageGuard)
    .set({
      heldAction: null,
      heldMetric: null,
      heldSince: null,
      pausedUntil: periodBounds(settings.period, settings.timeZone, now.getTime()).end,
      lastError: "",
    })
    .where(eq(schema.siteUsageGuard.siteId, site.id));
}

// ---------------------------------------------------------------- procedures

function toSettings(row: GuardRow): UsageGuardSettings {
  return {
    period: usageGuardPeriod.parse(row.period),
    timeZone: row.timeZone,
    bytesLimit: row.bytesLimit,
    requestsLimit: row.requestsLimit,
    bandwidthBps: row.bandwidthBps,
    warnPercent: row.warnPercent,
    action: usageGuardAction.parse(row.action),
    recovery: usageGuardRecovery.parse(row.recovery),
    bandwidthHoldMinutes: row.bandwidthHoldMinutes,
  };
}

async function toDto(
  db: Executor,
  siteId: string,
  row: GuardRow | undefined,
  now = new Date(),
): Promise<UsageGuard> {
  if (!row)
    return {
      siteId,
      settings: null,
      updatedAt: null,
      period: null,
      usage: null,
      held: null,
      pausedUntil: null,
      lastError: "",
    };
  const settings = toSettings(row);
  const period = periodBounds(settings.period, settings.timeZone, now.getTime());
  const usage = await periodUsage(db, siteId, period.start, period.end, now);
  const bandwidthBps = await currentBandwidth(db, siteId, now);
  const samePeriod = row.periodStart?.getTime() === period.start.getTime();
  return {
    siteId,
    settings,
    updatedAt: row.updatedAt.toISOString(),
    period: { start: period.start.toISOString(), end: period.end.toISOString() },
    usage: {
      bytes: usage.bytes.toString(),
      requests: usage.requests.toString(),
      bandwidthBps: Math.round(bandwidthBps),
      bandwidthPeakBps: Math.max(samePeriod ? row.bandwidthPeakBps : 0, Math.round(bandwidthBps)),
    },
    held:
      row.heldAction && row.heldMetric && row.heldSince
        ? {
            action: row.heldAction === "disable" ? "disable" : "maintenance",
            metric: usageGuardMetric.parse(row.heldMetric),
            since: row.heldSince.toISOString(),
          }
        : null,
    pausedUntil: row.pausedUntil && row.pausedUntil > now ? row.pausedUntil.toISOString() : null,
    lastError: row.lastError,
  };
}

/**
 * A site row, locked FOR UPDATE when `lock` (sites.ts's findSite; not
 * imported, because sites.ts calls noteOperatorRestore).
 */
async function findSite(db: Executor, id: string, lock = false) {
  const query = db.select().from(schema.site).where(eq(schema.site.id, id));
  const [row] = await (lock ? query.for("update") : query);
  if (!row) fail("SITE_NOT_FOUND", "site not found");
  return row;
}

const lockGuard = async (tx: Tx, siteId: string) => {
  const [row] = await tx
    .select()
    .from(schema.siteUsageGuard)
    .where(eq(schema.siteUsageGuard.siteId, siteId))
    .for("update");
  return row;
};

export async function getUsageGuard(db: Database, siteId: string): Promise<UsageGuard> {
  await findSite(db, siteId);
  const [row] = await db
    .select()
    .from(schema.siteUsageGuard)
    .where(eq(schema.siteUsageGuard.siteId, siteId));
  return toDto(db, siteId, row);
}

/**
 * Creates or replaces a site's usage protection. Saving re-arms a guard the
 * operator paused; the new settings apply at the next evaluation.
 */
export async function updateUsageGuard(
  db: Database,
  input: UsageGuardInput,
  ctx: { actor: Actor },
): Promise<UsageGuard> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, input.id, true);
    const before = await lockGuard(tx, site.id);
    if (input.expectedUpdatedAt !== undefined) {
      if (!before)
        fail("UPDATED_AT_MISMATCH", "the usage protection changed since it was read", {
          updatedAt: "",
        });
      assertUpdatedAt(before.updatedAt, input.expectedUpdatedAt);
    }
    const settings = {
      period: input.period,
      timeZone: input.timeZone,
      bytesLimit: input.bytesLimit,
      requestsLimit: input.requestsLimit,
      bandwidthBps: input.bandwidthBps,
      warnPercent: input.warnPercent,
      action: input.action,
      recovery: input.recovery,
      bandwidthHoldMinutes: input.bandwidthHoldMinutes,
    };
    const updatedAt = new Date(Math.max(Date.now(), (before?.updatedAt.getTime() ?? 0) + 1));
    const [row] = await tx
      .insert(schema.siteUsageGuard)
      .values({ siteId: site.id, ...settings, updatedAt })
      .onConflictDoUpdate({
        target: schema.siteUsageGuard.siteId,
        set: { ...settings, updatedAt, pausedUntil: null },
      })
      .returning();
    await recordAudit(tx, ctx.actor, {
      action: "site.usage_guard_update",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { from: before ? toSettings(before) : null, to: settings },
    });
    return toDto(tx, site.id, row);
  });
}

/** Removes a site's usage protection, lifting the action it holds. */
export async function deleteUsageGuard(
  db: Database,
  siteId: string,
  ctx: { actor: Actor },
): Promise<UsageGuard> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, siteId, true);
    const row = await lockGuard(tx, site.id);
    if (!row) return toDto(tx, site.id, undefined);
    const held = row.heldAction as HeldAction | null;
    if (held && siteIn(site, held))
      await setActionState(tx, site, held, false, {
        actor: ctx.actor,
        audit: "site.usage_guard_release",
        metadata: { metric: row.heldMetric, deleted: true },
      });
    await tx.delete(schema.siteUsageGuard).where(eq(schema.siteUsageGuard.siteId, site.id));
    await recordAudit(tx, ctx.actor, {
      action: "site.usage_guard_delete",
      targetType: "site",
      targetId: site.id,
      targetName: site.name,
      metadata: { settings: toSettings(row), lifted: held },
    });
    return toDto(tx, site.id, undefined);
  });
}

/**
 * Lifts the action a site's usage protection holds and pauses it until the
 * period ends (its alerts continue). USAGE_GUARD_NOT_HELD when it holds none.
 */
export async function restoreUsageGuard(
  db: Database,
  siteId: string,
  ctx: { actor: Actor },
): Promise<UsageGuard> {
  return db.transaction(async (tx) => {
    const site = await findSite(tx, siteId, true);
    const row = await lockGuard(tx, site.id);
    const held = row?.heldAction as HeldAction | null | undefined;
    if (!row || !held) fail("USAGE_GUARD_NOT_HELD", "the usage protection holds no action");
    const settings = toSettings(row);
    const now = new Date();
    const period = periodBounds(settings.period, settings.timeZone, now.getTime());
    const metadata = { metric: row.heldMetric, pausedUntil: period.end.toISOString() };
    if (siteIn(site, held))
      await setActionState(tx, site, held, false, {
        actor: ctx.actor,
        audit: "site.usage_guard_restore",
        metadata,
      });
    // Already undone (the next evaluation would have noticed): nothing to publish.
    else
      await recordAudit(tx, ctx.actor, {
        action: "site.usage_guard_restore",
        targetType: "site",
        targetId: site.id,
        targetName: site.name,
        metadata: { ...metadata, action: held },
      });
    const [updated] = await tx
      .update(schema.siteUsageGuard)
      .set({
        heldAction: null,
        heldMetric: null,
        heldSince: null,
        pausedUntil: period.end,
        lastError: "",
      })
      .where(eq(schema.siteUsageGuard.siteId, site.id))
      .returning();
    return toDto(tx, site.id, updated, now);
  });
}
