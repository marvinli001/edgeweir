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
    organizationId: text("organization_id").notNull(),
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
    index("site_usage_org_idx").on(t.organizationId, t.windowStart),
  ],
);
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
});
const rollup = <T extends string>(name: T) =>
  pgTable(name, trafficColumns(), (t) => [
    primaryKey({ columns: [t.minute, t.nodeId, t.siteId] }),
    index(`${name}_site_idx`).on(t.siteId, t.minute),
  ]);
export const nodeHourStats = rollup("node_hour_stats");
export const nodeDayStats = rollup("node_day_stats");
/** Durable invalidation queue; ingestion and marker writes commit together. */
export const statsRollupDirty = pgTable(
  "stats_rollup_dirty",
  {
    granularity: text("granularity").notNull(),
    bucket: timestamp("bucket", { withTimezone: true }).notNull(),
    nodeId: uuid("node_id").notNull(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.granularity, t.bucket, t.nodeId, t.siteId] })],
);
/** SQL migration defines a non-overlapping union of ready rollups and pending minute data. */
export const trafficHourStats = pgView("traffic_hour_stats", trafficColumns()).existing();
