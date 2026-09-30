import {
  boolean,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { cluster, node, site } from "./core";

/**
 * A site's CC policy as saved (contract `siteCcPolicy`). With `followTemplate`
 * the thresholds come from the platform template (system setting
 * `cc_template`); the saved values are kept for switching back.
 */
export interface StoredCcPolicy {
  enabled: boolean;
  followTemplate: boolean;
  maxLevel: string;
  highPowInsteadOfCaptcha: boolean;
  windowSeconds: number;
  siteQps: number;
  urlQps: number;
  ipQps: number;
  ipBanSeconds: number;
  originErrorPercent: number;
  originErrorMinRequests: number;
  escalateAfterSeconds: number;
  cooldownSeconds: number;
}

/** Challenges and CC mitigation of a site; no row means the defaults (everything off). */
export const siteProtection = pgTable("site_protection", {
  siteId: uuid("site_id")
    .primaryKey()
    .references(() => site.id, { onDelete: "cascade" }),
  /** Challenge every GET/HEAD request without a valid pass. */
  underAttack: boolean("under_attack").notNull().default(false),
  /** cookie302 | js | pow | captcha */
  underAttackChallenge: text("under_attack_challenge").notNull().default("js"),
  /** Lifetime of a pass, 300 to 86400 seconds. */
  passTtlSeconds: integer("pass_ttl_seconds").notNull().default(1800),
  /** Leading zero bits of the proof of work (8 to 24). */
  powDifficulty: integer("pow_difficulty").notNull().default(16),
  /** Proof of work that replaces the image captcha (8 to 26, at least pow_difficulty). */
  powHighDifficulty: integer("pow_high_difficulty").notNull().default(20),
  /** Null until the CC policy is first saved (then it is off). */
  cc: jsonb("cc").$type<StoredCcPolicy>(),
  /** Record the JA4 fingerprint in sampled access logs. */
  logJa4: boolean("log_ja4").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/**
 * HMAC keys of challenge passes, three per cluster once a cluster uses
 * challenges: next, current and previous. Nodes sign with current and accept
 * all three; the daily rotation shifts the roles and creates a new next. The
 * secret (32 random bytes) is envelope-encrypted with purpose
 * "challenge_key.secret" bound to the row id; it is generated when a node
 * first fetches the key (GetChallengeKeys), so null means not generated yet.
 */
export const challengeKey = pgTable(
  "challenge_key",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    /** next | current | previous */
    role: text("role").notNull(),
    /** JSON envelope of the secret. Never plaintext. */
    secret: text("secret"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("challenge_key_cluster_role_uq").on(t.clusterId, t.role)],
);

/** One of the heaviest addresses or paths of a CC window (approximate). */
export interface TopCount {
  value: string;
  count: number;
}

/**
 * CC mitigation decisions reported by nodes (ReportSecurityEvents): site and
 * path level changes and automatic bans. Deleted after the retention period
 * of the system setting `protection_settings`.
 */
export const securityEvent = pgTable(
  "security_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    nodeId: uuid("node_id").references(() => node.id, { onDelete: "set null" }),
    /** The node's own event id; retries carry the same one. */
    nodeEventId: text("node_event_id").notNull(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
    /** site_level | path_level | ip_banned */
    kind: text("kind").notNull(),
    /** normal | cookie302 | js | pow | captcha (after and before the change) */
    level: text("level").notNull().default(""),
    previousLevel: text("previous_level").notNull().default(""),
    path: text("path").notNull().default(""),
    address: text("address").notNull().default(""),
    /** site_qps | url_qps | ip_qps | origin_error_rate | cooldown */
    metric: text("metric").notNull().default(""),
    observed: doublePrecision("observed").notNull().default(0),
    threshold: doublePrecision("threshold").notNull().default(0),
    topIps: jsonb("top_ips").$type<TopCount[]>().notNull().default([]),
    topPaths: jsonb("top_paths").$type<TopCount[]>().notNull().default([]),
  },
  (t) => [
    uniqueIndex("security_event_node_event_uq").on(t.nodeId, t.nodeEventId),
    index("security_event_site_time_idx").on(t.siteId, t.occurredAt),
    index("security_event_time_idx").on(t.occurredAt),
  ],
);
