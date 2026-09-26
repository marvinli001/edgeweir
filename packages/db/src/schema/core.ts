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
import { certificate } from "./certificates";

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

/** Platform-wide region dictionary (e.g. "cn-east"), used by node groups and later scheduling. */
export const region = pgTable("region", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Stable lowercase code, unique across the platform. */
  code: text("code").notNull().unique(),
  createdAt: createdAt(),
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
    regionId: uuid("region_id").references(() => region.id, { onDelete: "set null" }),
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
    supportedFeatures: text("supported_features").array().notNull().default(sql`'{}'::text[]`),
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
    /** Cache key policy (contract `cacheKeyPolicy`); `{}` means the defaults. */
    cacheKey: jsonb("cache_key").$type<Record<string, unknown>>().notNull().default({}),
    /** Fetch and cache cacheable responses in slices (Range requests). */
    rangeSlice: boolean("range_slice").notNull().default(false),
    /** Proxy WebSocket upgrades to the origin. */
    websocket: boolean("websocket").notNull().default(true),
    certificateId: uuid("certificate_id").references(() => certificate.id, {
      onDelete: "restrict",
    }),
    tlsSettings: jsonb("tls_settings").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("site_org_idx").on(t.organizationId), index("site_cluster_idx").on(t.clusterId)],
);

/** Sites a user starred; they lead the site list on the console home. */
export const siteStar = pgTable(
  "site_star",
  {
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.userId, t.siteId] }), index("site_star_site_idx").on(t.siteId)],
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
    verified: boolean("verified").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("site_domain_name_uq").on(t.name, t.wildcard).where(sql`${t.verified} = true`),
    uniqueIndex("site_domain_site_name_uq").on(t.siteId, t.name, t.wildcard),
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
    /** Verify certificates of HTTPS origins. */
    tlsVerify: boolean("tls_verify").notNull().default(true),
    /** Passive health check: consecutive failures that mark an origin down. */
    maxFails: integer("max_fails").notNull().default(3),
    /** Passive health check: seconds before a down origin is tried again. */
    recoverySeconds: integer("recovery_seconds").notNull().default(30),
    connectTimeoutMs: integer("connect_timeout_ms").notNull().default(10_000),
    sendTimeoutMs: integer("send_timeout_ms").notNull().default(60_000),
    readTimeoutMs: integer("read_timeout_ms").notNull().default(60_000),
    /** Reuse upstream connections (keep-alive pool). */
    keepalive: boolean("keepalive").notNull().default(true),
    keepaliveIdleSeconds: integer("keepalive_idle_seconds").notNull().default(60),
    keepaliveMaxRequests: integer("keepalive_max_requests").notNull().default(1000),
    createdAt: createdAt(),
  },
  (t) => [index("origin_pool_site_idx").on(t.siteId)],
);

/**
 * Access keys of S3-compatible origins. The secret is envelope-encrypted with
 * the master key and only leaves the console over the mTLS node channel.
 */
export const originCredential = pgTable(
  "origin_credential",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    accessKeyId: text("access_key_id").notNull(),
    /** JSON envelope of the secret access key. Never plaintext. */
    secretEnvelope: text("secret_envelope").notNull(),
    /** Bumped when the secret changes; part of the compiled configuration. */
    version: integer("version").notNull().default(1),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("origin_credential_site_key_uq").on(t.siteId, t.accessKeyId)],
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
    /** Set for S3-compatible origins: requests are signed with this credential. */
    credentialId: uuid("credential_id").references(() => originCredential.id, {
      onDelete: "set null",
    }),
    s3Region: text("s3_region").notNull().default(""),
    /** Path-style bucket; empty for virtual-hosted endpoints. */
    s3Bucket: text("s3_bucket").notNull().default(""),
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
    /** Exact URI paths. */
    paths: text("paths").array().notNull().default(sql`'{}'::text[]`),
    /** Response status codes; empty matches any cacheable status. */
    statusCodes: integer("status_codes").array().notNull().default(sql`'{}'::integer[]`),
    minSizeBytes: bigint("min_size_bytes", { mode: "number" }).notNull().default(0),
    maxSizeBytes: bigint("max_size_bytes", { mode: "number" }).notNull().default(0),
    expression: text("expression").notNull().default(""),
    /** cache | bypass */
    action: text("action").notNull().default("cache"),
    edgeTtlSeconds: integer("edge_ttl_seconds").notNull().default(3600),
    /** override | respect */
    originCacheControl: text("origin_cache_control").notNull().default("override"),
    staleWhileRevalidateSeconds: integer("stale_while_revalidate_seconds").notNull().default(0),
    staleIfErrorSeconds: integer("stale_if_error_seconds").notNull().default(0),
    /** Cache responses to requests with an Authorization header (RFC 9111 section 3.5). */
    cacheAuthorized: boolean("cache_authorized").notNull().default(false),
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
    /** English rendering of the reason, kept for API readers; the UI localizes reason_code. */
    reason: text("reason").notNull().default(""),
    /** Stable reason code (e.g. "site_updated"); empty for revisions published before it existed. */
    reasonCode: text("reason_code").notNull().default(""),
    reasonParams: jsonb("reason_params")
      .$type<Record<string, string | number>>()
      .notNull()
      .default({}),
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
    topUrls: jsonb("top_urls").$type<Record<string, number>>().notNull().default({}),
    topIps: jsonb("top_ips").$type<Record<string, number>>().notNull().default({}),
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
    /** Display name of the actor at the time of the action. */
    actorName: text("actor_name").notNull().default(""),
    organizationId: text("organization_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull().default(""),
    targetId: text("target_id").notNull().default(""),
    /** Display name of the target at the time of the action (survives deletion). */
    targetName: text("target_name").notNull().default(""),
    ip: text("ip").notNull().default(""),
    userAgent: text("user_agent").notNull().default(""),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    index("audit_log_occurred_idx").on(t.occurredAt),
    index("audit_log_org_idx").on(t.organizationId, t.occurredAt),
    index("audit_log_action_idx").on(t.action, t.occurredAt),
  ],
);

/** Per-organization policy that better-auth's organization table does not model. */
export const organizationSettings = pgTable("organization_settings", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** Cluster that sites created by the organization's members land on. */
  defaultClusterId: uuid("default_cluster_id").references(() => cluster.id, {
    onDelete: "set null",
  }),
  /** Members must enable two-factor authentication before using the console. */
  requireTwoFactor: boolean("require_two_factor").notNull().default(false),
  updatedAt: updatedAt(),
});

/**
 * Node certificates revoked when a node is deleted. The node channel refuses
 * any client certificate whose serial is listed here.
 */
export const nodeCertificateRevocation = pgTable("node_certificate_revocation", {
  serial: text("serial").primaryKey(),
  /** Not a foreign key: the node row is gone by the time the entry matters. */
  nodeId: uuid("node_id").notNull(),
  fingerprintSha256: text("fingerprint_sha256").notNull().default(""),
  reason: text("reason").notNull().default(""),
  revokedAt: timestamp("revoked_at", { withTimezone: true }).defaultNow().notNull(),
});

/** Platform-wide key/value settings (setup token state, later SMTP, GeoIP ...). */
export const systemSetting = pgTable("system_setting", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<Record<string, unknown>>().notNull().default({}),
  updatedAt: updatedAt(),
});

/** Latest passive health state reported by each node for origins it saw failing. */
export const originHealth = pgTable(
  "origin_health",
  {
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    originId: uuid("origin_id")
      .notNull()
      .references(() => origin.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    healthy: boolean("healthy").notNull(),
    consecutiveFailures: integer("consecutive_failures").notNull().default(0),
    /** Text of the last failure as the node wrote it (fallback for unknown codes). */
    lastError: text("last_error").notNull().default(""),
    /** Stable code of the last failure (e.g. "timeout"); empty for older nodes. */
    lastErrorCode: text("last_error_code").notNull().default(""),
    lastErrorParams: jsonb("last_error_params")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    lastFailureAt: timestamp("last_failure_at", { withTimezone: true }),
    downUntil: timestamp("down_until", { withTimezone: true }),
    reportedAt: timestamp("reported_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.nodeId, t.originId] }),
    index("origin_health_site_idx").on(t.siteId),
  ],
);

/**
 * A cache purge or prefetch requested in the console. It is delivered to
 * every node of the affected clusters as a typed node task.
 */
export const cacheTask = pgTable(
  "cache_task",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null when the targets span several organizations (platform administrators). */
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    /** url | prefix | site | prefetch */
    type: text("type").notNull(),
    /** What the user asked for: URLs, prefixes or site names, for display. */
    targets: text("targets").array().notNull().default(sql`'{}'::text[]`),
    siteIds: uuid("site_ids").array().notNull().default(sql`'{}'::uuid[]`),
    /** Resolved node payload: [{ siteId, clusterId, type, host, path, query, url }]. */
    payload: jsonb("payload").$type<Record<string, string>[]>().notNull().default([]),
    createdByUserId: text("created_by_user_id").references(() => user.id, {
      onDelete: "set null",
    }),
    createdByName: text("created_by_name").notNull().default(""),
    /** user | recovery (a whole-site purge for purges a node missed) */
    source: text("source").notNull().default("user"),
    createdAt: createdAt(),
    /** Set once every node reported a result (or the task expired). */
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("cache_task_org_idx").on(t.organizationId, t.createdAt)],
);

/** Delivery and result of a cache task on one node. */
export const cacheTaskNode = pgTable(
  "cache_task_node",
  {
    taskId: uuid("task_id")
      .notNull()
      .references(() => cacheTask.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    clusterId: uuid("cluster_id").notNull(),
    /** Node name when the task was created (survives renames in the list). */
    nodeName: text("node_name").notNull().default(""),
    /** pending | running | succeeded | failed | skipped (node disabled) */
    state: text("state").notNull().default("pending"),
    /** Text of the outcome (from the node, or the console's English fallback). */
    message: text("message").notNull().default(""),
    /** Stable code of a failed or skipped outcome (e.g. "prefetch_failed", "task_expired"). */
    errorCode: text("error_code").notNull().default(""),
    errorParams: jsonb("error_params").$type<Record<string, string>>().notNull().default({}),
    succeeded: integer("succeeded").notNull().default(0),
    failed: integer("failed").notNull().default(0),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    /** When a missed purge (expired or skipped) was made up with a whole-site purge. */
    recoveredAt: timestamp("recovered_at", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.taskId, t.nodeId] }),
    index("cache_task_node_node_idx").on(t.nodeId, t.state),
  ],
);
