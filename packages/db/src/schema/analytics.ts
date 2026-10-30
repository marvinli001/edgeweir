import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { node, site } from "./core";
import { statsDimensionColumns } from "./stats-dims";

/** A permanent high-water mark: retrying a batch never increments counters again. */
export const nodeStatsCursor = pgTable("node_stats_cursor", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => node.id, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "bigint" }).notNull().default(sql`0`),
  /** The node's statistics watermark (ReportStatsV2.complete_until); only moves forward. */
  completeUntil: timestamp("complete_until", { withTimezone: true }),
});

/** Global, gap-tolerant order in which usage rows were created or revised. */
export const siteUsageSeq = pgSequence("site_usage_seq");

/**
 * Recomputable usage per site and UTC 5-minute window [window_start, +5 min),
 * summed over every node from node_minute_stats. Counters are exact decimal
 * integers. A recomputation that changes a value increments `revision` and
 * takes a new `seq`. Not tied to the site row: usage outlives deleted sites.
 */
export const siteUsage = pgTable(
  "site_usage",
  {
    windowStart: timestamp("window_start", { withTimezone: true }).notNull(),
    siteId: uuid("site_id").notNull(),
    requests: numeric("requests", { precision: 38, scale: 0 }).notNull().default("0"),
    bytesSent: numeric("bytes_sent", { precision: 38, scale: 0 }).notNull().default("0"),
    bytesReceived: numeric("bytes_received", { precision: 38, scale: 0 }).notNull().default("0"),
    revision: integer("revision").notNull().default(1),
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.windowStart, t.siteId] }),
    uniqueIndex("site_usage_seq_uq").on(t.seq),
    // A site's windows of a period (usage protection).
    index("site_usage_site_window_idx").on(t.siteId, t.windowStart),
  ],
);

/**
 * A site's usage protection (ADR-0049): its settings, then the state the
 * worker keeps for the current period. The guard only lifts the action it
 * applied itself (held_action); the operator turning the site on or
 * maintenance off pauses it until the period ends.
 */
export const siteUsageGuard = pgTable("site_usage_guard", {
  siteId: uuid("site_id")
    .primaryKey()
    .references(() => site.id, { onDelete: "cascade" }),
  /** day or month */
  period: text("period").notNull(),
  /** IANA time zone the period starts at midnight in. */
  timeZone: text("time_zone").notNull(),
  /** Bytes sent per period; null: no limit. */
  bytesLimit: numeric("bytes_limit", { precision: 38, scale: 0 }),
  requestsLimit: numeric("requests_limit", { precision: 38, scale: 0 }),
  /** Bits per second over the last 5 complete minutes. */
  bandwidthBps: bigint("bandwidth_bps", { mode: "number" }),
  /** Warning threshold in percent; null: no warning. */
  warnPercent: integer("warn_percent"),
  /** alert, maintenance or disable */
  action: text("action").notNull(),
  /** auto or manual */
  recovery: text("recovery").notNull(),
  bandwidthHoldMinutes: integer("bandwidth_hold_minutes").notNull().default(30),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  /** The period the state below belongs to. */
  periodStart: timestamp("period_start", { withTimezone: true }),
  periodEnd: timestamp("period_end", { withTimezone: true }),
  /** Metrics at or over the warning threshold / the limit in this period (the alerts held). */
  warnMetrics: text("warn_metrics").array().notNull().default(sql`'{}'::text[]`),
  limitMetrics: text("limit_metrics").array().notNull().default(sql`'{}'::text[]`),
  /** The highest bandwidth seen in this period, and when it was last over the limit. */
  bandwidthPeakBps: bigint("bandwidth_peak_bps", { mode: "number" }).notNull().default(0),
  bandwidthBreachedAt: timestamp("bandwidth_breached_at", { withTimezone: true }),
  /** maintenance or disable: applied by the guard and still in force. */
  heldAction: text("held_action"),
  heldMetric: text("held_metric"),
  heldSince: timestamp("held_since", { withTimezone: true }),
  /** Restored by the operator: no action before this time (the period's end). */
  pausedUntil: timestamp("paused_until", { withTimezone: true }),
  /** Error code of the last action that could not be published; empty when none. */
  lastError: text("last_error").notNull().default(""),
  evaluatedAt: timestamp("evaluated_at", { withTimezone: true }),
});
const trafficColumns = () => ({
  minute: timestamp("minute", { withTimezone: true }).notNull(),
  nodeId: uuid("node_id").notNull(),
  siteId: uuid("site_id")
    .notNull()
    .references(() => site.id, { onDelete: "cascade" }),
  requests: bigint("requests", { mode: "number" }).notNull().default(0),
  bytesSent: bigint("bytes_sent", { mode: "number" }).notNull().default(0),
  bytesReceived: bigint("bytes_received", { mode: "number" }).notNull().default(0),
  cacheHits: bigint("cache_hits", { mode: "number" }).notNull().default(0),
  cacheMisses: bigint("cache_misses", { mode: "number" }).notNull().default(0),
  statusCodes: jsonb("status_codes").$type<Record<string, number>>().notNull().default({}),
  topUrls: jsonb("top_urls").$type<Record<string, number>>().notNull().default({}),
  topIps: jsonb("top_ips").$type<Record<string, number>>().notNull().default({}),
  wafRules: jsonb("waf_rules").$type<Record<string, number>>().notNull().default({}),
  loggedRules: jsonb("logged_rules").$type<Record<string, number>>().notNull().default({}),
  authFailures: bigint("auth_failures", { mode: "number" }).notNull().default(0),
  ...statsDimensionColumns(),
  imageBytesSaved: bigint("image_bytes_saved", { mode: "number" }).notNull().default(0),
  markdownResponses: bigint("markdown_responses", { mode: "number" }).notNull().default(0),
});
const rollup = <T extends string>(name: T) =>
  pgTable(name, trafficColumns(), (t) => [
    primaryKey({ columns: [t.minute, t.nodeId, t.siteId] }),
    index(`${name}_site_idx`).on(t.siteId, t.minute),
  ]);
export const nodeHourStats = rollup("node_hour_stats");
export const nodeDayStats = rollup("node_day_stats");
/**
 * Durable invalidation queue; ingestion and marker writes commit together.
 * Every write to a marker takes a new generation, and a rollup clears only
 * the generation it read: data written while it aggregates leaves the
 * marker in place.
 */
export const statsRollupDirty = pgTable(
  "stats_rollup_dirty",
  {
    granularity: text("granularity").notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    nodeId: uuid("node_id").notNull(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    generation: integer("generation").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.granularity, t.bucket, t.nodeId, t.siteId] })],
);
/** SQL migration defines a non-overlapping union of ready rollups and pending minute data. */
export const trafficHourStats = pgView("traffic_hour_stats", trafficColumns()).existing();

/** Names of client networks (AS number → name), from nodes' statistics (stats-dims-v1). */
export const asnName = pgTable("asn_name", {
  asn: bigint("asn", { mode: "number" }).primaryKey(),
  name: text("name").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
