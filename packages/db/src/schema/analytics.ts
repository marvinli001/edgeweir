import { sql } from "drizzle-orm";
import {
  bigint,
  index,
  jsonb,
  pgTable,
  pgView,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { node, site } from "./core";

/** A permanent high-water mark: retrying a batch never increments counters again. */
export const nodeStatsCursor = pgTable("node_stats_cursor", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => node.id, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "bigint" }).notNull().default(sql`0`),
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
