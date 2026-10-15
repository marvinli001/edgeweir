import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
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
    /** ADR-0041 §1 (empty or 0 from older nodes). */
    userAgent: text("user_agent").notNull().default(""),
    referer: text("referer").notNull().default(""),
    httpVersion: text("http_version").notNull().default(""),
    scheme: text("scheme").notNull().default(""),
    country: text("country").notNull().default(""),
    asn: bigint("asn", { mode: "number" }).notNull().default(0),
    asName: text("as_name").notNull().default(""),
    upstreamAddr: text("upstream_addr").notNull().default(""),
    upstreamStatus: integer("upstream_status").notNull().default(0),
    upstreamMs: integer("upstream_ms").notNull().default(0),
    requestBytes: bigint("request_bytes", { mode: "number" }).notNull().default(0),
    contentType: text("content_type").notNull().default(""),
    tlsVersion: text("tls_version").notNull().default(""),
    blockReason: text("block_reason").notNull().default(""),
    blockRuleId: text("block_rule_id").notNull().default(""),
    /** Optional fields, only while the site records them (access-logs-v2). */
    query: text("query").notNull().default(""),
    headers: jsonb("headers").$type<Record<string, string>>().notNull().default({}),
    peerIp: text("peer_ip").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.time, t.id] }),
    index("access_log_site_time_idx").on(t.siteId, t.time),
  ],
);
/** Node logs (ADR-0050): the last ReportNodeLogs batch stored per node. */
export const nodeLogEntryCursor = pgTable("node_log_entry_cursor", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => node.id, { onDelete: "cascade" }),
  sequence: bigint("sequence", { mode: "bigint" }).notNull().default(sql`0`),
});
/**
 * A node's warnings, errors and events (ADR-0050), kept for the
 * node_log_retention setting. kind "dropped" records how many entries the
 * node dropped before a batch (message and fields empty).
 */
export const nodeLogEntry = pgTable(
  "node_log_entry",
  {
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    sequence: bigint("sequence", { mode: "bigint" }).notNull(),
    idx: integer("idx").notNull(),
    /** When it happened on the node (within a day before and 5 minutes after it arrived). */
    time: timestamp("time", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
    kind: text("kind").notNull().default("entry"),
    level: text("level").notNull(),
    source: text("source").notNull(),
    component: text("component").notNull().default(""),
    message: text("message").notNull().default(""),
    fields: jsonb("fields").$type<Record<string, string>>().notNull().default({}),
    repeated: integer("repeated").notNull().default(0),
    truncated: boolean("truncated").notNull().default(false),
    event: text("event").notNull().default(""),
    droppedRateLimited: integer("dropped_rate_limited").notNull().default(0),
    droppedOverflow: integer("dropped_overflow").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.sequence, t.idx] }),
    index("node_log_entry_node_time_idx").on(t.nodeId, t.time, t.sequence, t.idx),
    index("node_log_entry_time_idx").on(t.time),
  ],
);
