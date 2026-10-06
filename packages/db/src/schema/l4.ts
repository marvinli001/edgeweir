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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { certificate } from "./certificates";
import { cluster } from "./core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

/**
 * Port ranges of a cluster that layer-4 applications may listen on
 * (1024-65535, inclusive). Ranges of a protocol do not overlap; `both`
 * counts for TCP and UDP. Never a port of the cluster's HTTP(S) listeners.
 */
export const clusterPortPool = pgTable(
  "cluster_port_pool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    /** tcp | udp | both */
    protocol: text("protocol").notNull(),
    portFrom: integer("port_from").notNull(),
    portTo: integer("port_to").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("cluster_port_pool_cluster_idx").on(t.clusterId)],
);

/**
 * A layer-4 (TCP / UDP) application: every node of the cluster listens on
 * its port and forwards connections or UDP sessions to its origins
 * (NodeConfig.l4_apps, feature l4-v1). Unique by cluster, protocol and port.
 */
export const l4App = pgTable(
  "l4_app",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** tcp | udp */
    protocol: text("protocol").notNull(),
    port: integer("port").notNull(),
    /** A disabled application is not shipped to nodes and has no DNS record. */
    enabled: boolean("enabled").notNull().default(true),
    /** TCP only: the listener expects a PROXY protocol header. */
    acceptProxyProtocol: boolean("accept_proxy_protocol").notNull().default(false),
    /** TCP only: PROXY protocol version sent to the origins (0 none, 1, 2). */
    proxyProtocolVersion: integer("proxy_protocol_version").notNull().default(0),
    /** Passive health check: consecutive failures and seconds before a retry. */
    maxFails: integer("max_fails").notNull().default(3),
    failTimeoutSeconds: integer("fail_timeout_seconds").notNull().default(30),
    connectTimeoutMs: integer("connect_timeout_ms").notNull().default(5000),
    /** 600 for TCP, 30 for UDP unless set. */
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull().default(600),
    /** ip_list ids; a referenced list cannot be deleted. */
    allowListIds: uuid("allow_list_ids").array().notNull().default(sql`'{}'::uuid[]`),
    blockListIds: uuid("block_list_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Per node; 0 means no limit. */
    maxConnections: integer("max_connections").notNull().default(0),
    newConnectionsPerSecond: integer("new_connections_per_second").notNull().default(0),
    /** The last port of a range port..port_end; null: the single port. */
    portEnd: integer("port_end"),
    /** fixed | same (origins take the port the connection arrived on). */
    originPortMode: text("origin_port_mode").notNull().default("fixed"),
    /** TCP only: TLS terminated with this certificate; null: plain TCP. */
    certificateId: uuid("certificate_id").references(() => certificate.id, {
      onDelete: "restrict",
    }),
    /** 1.2 | 1.3, with a certificate. */
    tlsMinimumVersion: text("tls_minimum_version").notNull().default("1.2"),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [uniqueIndex("l4_app_cluster_protocol_port_uq").on(t.clusterId, t.protocol, t.port)],
);

/** An origin of a layer-4 application, in the order the operator saved them. */
export const l4Origin = pgTable(
  "l4_origin",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    appId: uuid("app_id")
      .notNull()
      .references(() => l4App.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    /** 0 while the application's origin_port_mode is same. */
    port: integer("port").notNull(),
    weight: integer("weight").notNull().default(1),
    /** Used only while every primary origin is down. */
    backup: boolean("backup").notNull().default(false),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("l4_origin_app_idx").on(t.appId)],
);

/**
 * Per-minute counters of a layer-4 application on one node
 * (ReportStatsV2Request.l4_stats), kept as long as site minute statistics.
 */
export const l4MinuteStats = pgTable(
  "l4_minute_stats",
  {
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    nodeId: uuid("node_id").notNull(),
    appId: uuid("app_id")
      .notNull()
      .references(() => l4App.id, { onDelete: "cascade" }),
    connections: bigint("connections", { mode: "number" }).notNull().default(0),
    refused: bigint("refused", { mode: "number" }).notNull().default(0),
    /** Highest concurrency the node saw in the minute. */
    peakConcurrent: bigint("peak_concurrent", { mode: "number" }).notNull().default(0),
    bytesReceived: bigint("bytes_received", { mode: "number" }).notNull().default(0),
    bytesSent: bigint("bytes_sent", { mode: "number" }).notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.minute, t.nodeId, t.appId] }),
    index("l4_minute_stats_app_idx").on(t.appId, t.minute),
  ],
);
