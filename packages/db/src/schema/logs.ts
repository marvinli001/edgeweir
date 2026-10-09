import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { node, site } from "./core";
export const nodeLogCursor = pgTable("node_log_cursor", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => node.id, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "bigint" }).notNull().default(sql`0`),
});
// The SQL migration adds RANGE(time) partitioning; daily partitions are maintained by the worker.
export const accessLog = pgTable(
  "access_log",
  {
    time: timestamp("time", { withTimezone: true }).notNull(),
    id: text("id").notNull(),
    nodeId: uuid("node_id").notNull(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    clientIp: text("client_ip").notNull(),
    method: text("method").notNull(),
    host: text("host").notNull(),
    path: text("path").notNull(),
    status: integer("status").notNull(),
    bytesSent: bigint("bytes_sent", { mode: "number" }).notNull(),
    durationMs: integer("duration_ms").notNull(),
    cacheStatus: text("cache_status").notNull(),
    sampleRate: integer("sample_rate").notNull(),
    /** JA4 TLS client fingerprint; empty unless the site records it. */
    ja4: text("ja4").notNull().default(""),
    /** OWASP CRS rules the request matched (at most 16, ascending). */
    wafRuleIds: bigint("waf_rule_ids", { mode: "number" }).array().notNull().default(sql`'{}'`),
    /** CRS blocked the request. */
    wafBlocked: boolean("waf_blocked").notNull().default(false),
    /** The request id the node answered with (X-Request-Id); empty for older nodes. */
    requestId: text("request_id").notNull().default(""),
    /** Log rules that wrote this line whatever the sample rate (waf-v2, at most 8). */
    ruleIds: text("rule_ids").array().notNull().default(sql`'{}'`),
  },
  (t) => [
    primaryKey({ columns: [t.time, t.id] }),
    index("access_log_site_time_idx").on(t.siteId, t.time),
  ],
);
