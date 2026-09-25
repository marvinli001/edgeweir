import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  customType,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";

const bytea = customType<{ data: Uint8Array; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value),
});

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();
const updatedAt = () =>
  timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull();

/** A cluster is a set of edge nodes that share one NodeConfig revision stream. */
export const cluster = pgTable("cluster", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Node groups partition a cluster, e.g. canary nodes that receive revisions first. */
export const nodeGroup = pgTable(
  "node_group",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    isCanary: boolean("is_canary").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("node_group_cluster_name_uq").on(t.clusterId, t.name)],
);

export const node = pgTable(
  "node",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "restrict" }),
    nodeGroupId: uuid("node_group_id").references(() => nodeGroup.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    hostname: text("hostname").notNull().default(""),
    /** active | disabled */
    status: text("status").notNull().default("active"),
    agentVersion: text("agent_version").notNull().default(""),
    engine: text("engine").notNull().default(""),
    engineVersion: text("engine_version").notNull().default(""),
    os: text("os").notNull().default(""),
    arch: text("arch").notNull().default(""),
    certSerial: text("cert_serial"),
    certFingerprint: text("cert_fingerprint"),
    certNotAfter: timestamp("cert_not_after", { withTimezone: true }),
    enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("node_cluster_idx").on(t.clusterId)],
);

export const nodeIp = pgTable(
  "node_ip",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    /** reported (by the agent) | public | private */
    kind: text("kind").notNull().default("reported"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("node_ip_node_address_uq").on(t.nodeId, t.address)],
);

/** Single-use node enrollment tokens. Only the SHA-256 of the token is stored. */
export const enrollmentToken = pgTable(
  "enrollment_token",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    nodeGroupId: uuid("node_group_id").references(() => nodeGroup.id, { onDelete: "set null" }),
    tokenHash: text("token_hash").notNull().unique(),
    tokenPrefix: text("token_prefix").notNull(),
    nodeName: text("node_name").notNull().default(""),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    usedByNodeId: uuid("used_by_node_id").references(() => node.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("enrollment_token_cluster_idx").on(t.clusterId)],
);

export const site = pgTable(
  "site",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** Bumped to purge every cached object of the site. */
    cacheGeneration: bigint("cache_generation", { mode: "number" }).notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("site_org_idx").on(t.organizationId), index("site_cluster_idx").on(t.clusterId)],
);

export const siteDomain = pgTable(
  "site_domain",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    /** Lowercase host name; for wildcards the suffix without "*." */
    name: text("name").notNull(),
    wildcard: boolean("wildcard").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_domain_name_uq").on(t.name, t.wildcard),
    index("site_domain_site_idx").on(t.siteId),
  ],
);

export const originPool = pgTable(
  "origin_pool",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    name: text("name").notNull().default("default"),
    /** weighted_random | round_robin | consistent_hash */
    policy: text("policy").notNull().default("weighted_random"),
    createdAt: createdAt(),
  },
  (t) => [index("origin_pool_site_idx").on(t.siteId)],
);

export const origin = pgTable(
  "origin",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    poolId: uuid("pool_id")
      .notNull()
      .references(() => originPool.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    port: integer("port").notNull(),
    /** http | https */
    scheme: text("scheme").notNull().default("http"),
    weight: integer("weight").notNull().default(1),
    backup: boolean("backup").notNull().default(false),
    hostHeader: text("host_header").notNull().default(""),
    sni: text("sni").notNull().default(""),
    createdAt: createdAt(),
  },
  (t) => [index("origin_pool_idx").on(t.poolId)],
);

export const cacheRule = pgTable(
  "cache_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    priority: integer("priority").notNull().default(100),
    pathPrefixes: text("path_prefixes").array().notNull().default(sql`'{}'::text[]`),
    extensions: text("extensions").array().notNull().default(sql`'{}'::text[]`),
    expression: text("expression").notNull().default(""),
    /** cache | bypass */
    action: text("action").notNull().default("cache"),
    edgeTtlSeconds: integer("edge_ttl_seconds").notNull().default(3600),
    /** override | respect */
    originCacheControl: text("origin_cache_control").notNull().default("override"),
    createdAt: createdAt(),
  },
  (t) => [index("cache_rule_site_idx").on(t.siteId)],
);

/** Every published NodeConfig of a cluster. Revisions are immutable. */
export const configRevision = pgTable(
  "config_revision",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    revision: bigint("revision", { mode: "number" }).notNull(),
    contentHash: text("content_hash").notNull(),
    /** Binary NodeConfig protobuf. */
    ir: bytea("ir").notNull(),
    siteCount: integer("site_count").notNull().default(0),
    reason: text("reason").notNull().default(""),
    createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("config_revision_cluster_revision_uq").on(t.clusterId, t.revision)],
);

/** Latest apply receipt / heartbeat of each node. */
export const nodeConfigStatus = pgTable("node_config_status", {
  nodeId: uuid("node_id")
    .primaryKey()
    .references(() => node.id, { onDelete: "cascade" }),
  appliedRevision: bigint("applied_revision", { mode: "number" }).notNull().default(0),
  appliedContentHash: text("applied_content_hash").notNull().default(""),
  /** applying | applied | failed */
  state: text("state").notNull().default("applying"),
  message: text("message").notNull().default(""),
  dataPlaneHealthy: boolean("data_plane_healthy").notNull().default(false),
  appliedAt: timestamp("applied_at", { withTimezone: true }),
  reportedAt: timestamp("reported_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Pre-aggregated per-minute traffic ("lite" analytics mode). */
export const nodeMinuteStats = pgTable(
  "node_minute_stats",
  {
    minute: timestamp("minute", { withTimezone: true }).notNull(),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    requests: bigint("requests", { mode: "number" }).notNull().default(0),
    bytesSent: bigint("bytes_sent", { mode: "number" }).notNull().default(0),
    bytesReceived: bigint("bytes_received", { mode: "number" }).notNull().default(0),
    cacheHits: bigint("cache_hits", { mode: "number" }).notNull().default(0),
    cacheMisses: bigint("cache_misses", { mode: "number" }).notNull().default(0),
    statusCodes: jsonb("status_codes").$type<Record<string, number>>().notNull().default({}),
  },
  (t) => [
    primaryKey({ columns: [t.minute, t.nodeId, t.siteId] }),
    index("node_minute_stats_site_idx").on(t.siteId, t.minute),
  ],
);

/** Internal certificate authorities (e.g. the node-channel CA). Keys are envelope-encrypted. */
export const pkiAuthority = pgTable("pki_authority", {
  id: text("id").primaryKey(),
  certificatePem: text("certificate_pem").notNull(),
  fingerprintSha256: text("fingerprint_sha256").notNull(),
  /** JSON envelope produced by the server's master-key crypto. Never plaintext. */
  privateKeyEnvelope: text("private_key_envelope").notNull(),
  notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  createdAt: createdAt(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).defaultNow().notNull(),
    /** user | api_key | node | system */
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull().default(""),
    organizationId: text("organization_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull().default(""),
    targetId: text("target_id").notNull().default(""),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_log_occurred_idx").on(t.occurredAt),
    index("audit_log_org_idx").on(t.organizationId, t.occurredAt),
  ],
);
