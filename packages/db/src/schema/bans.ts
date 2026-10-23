import { sql } from "drizzle-orm";
import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { cluster, node, site } from "./core";

/**
 * Order of ban changes. Every write takes the same transaction-level advisory
 * lock before `nextval`, so changes commit in sequence order and a reader that
 * continues after a sequence never skips a change that commits later.
 */
export const ipBanSeq = pgSequence("ip_ban_seq");

/** What made a node ban an address automatically (or a rule: ruleId). */
export interface BanTrigger {
  metric: string;
  observed: number;
  threshold: number;
  windowSeconds: number;
  /** The rule of a ban a rule made (source rule). */
  ruleId?: string;
}

/** Who created a manual ban, as it was when the ban was made. */
export interface BanCreator {
  type: string;
  id: string;
  name: string;
}

/**
 * Dynamic IP bans and greylist entries. They reach the nodes through
 * GetBans, outside NodeConfig revisions. A row is active until `expires_at`
 * or until it is removed (`removed_at`); expired and removed rows are
 * deleted an hour after expiry. A row whose action is not `block` is a
 * greylist entry (manual only): its addresses are challenged or
 * rate-limited instead of refused, never dropped by the kernel, and only
 * nodes that ask for greylist entries get it.
 */
export const ipBan = pgTable(
  "ip_ban",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** platform | site */
    scope: text("scope").notNull(),
    siteId: uuid("site_id").references(() => site.id, { onDelete: "cascade" }),
    /**
     * Cluster of the site; null for platform bans (every cluster), except a
     * scan ban stored lifted for the reporting node's cluster.
     */
    clusterId: uuid("cluster_id").references(() => cluster.id, { onDelete: "cascade" }),
    /** Canonical CIDR: host bits zero, IPv6 lowercase and compressed. */
    cidr: text("cidr").notNull(),
    /**
     * abuse | attack | scanner | spam | other (manual); cc_ip_rate | unknown_host_scan |
     * challenge_failures (auto); waf_rule | rate_limit (rule)
     */
    reason: text("reason").notNull(),
    /** manual | auto | rule */
    source: text("source").notNull(),
    /** Node that created an automatic ban. */
    nodeId: uuid("node_id").references(() => node.id, { onDelete: "set null" }),
    trigger: jsonb("trigger").$type<BanTrigger>(),
    createdBy: jsonb("created_by").$type<BanCreator>(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Set when the ban was lifted before it expired. */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    /** From ip_ban_seq; a new value on every change of the row. */
    seq: bigint("seq", { mode: "bigint" }).notNull(),
    /** Sent to the nodes of the cluster (automatic bans only when sharing is on). */
    distributed: boolean("distributed").notNull().default(true),
    /** block (a ban) | challenge | rate_limit (greylist entries). */
    action: text("action").notNull().default("block"),
    /** challenge: cookie302 | js | pow | captcha. */
    challenge: text("challenge"),
    /** rate_limit: requests per window per client (IPv4 address, IPv6 /64). */
    rateLimitRequests: integer("rate_limit_requests"),
    rateLimitWindowSeconds: integer("rate_limit_window_seconds"),
  },
  (t) => [
    uniqueIndex("ip_ban_seq_uq").on(t.seq),
    index("ip_ban_cluster_seq_idx").on(t.clusterId, t.seq),
    index("ip_ban_created_idx").on(t.createdAt),
    index("ip_ban_site_idx").on(t.siteId),
    index("ip_ban_expires_idx").on(t.expiresAt),
    // One ban per (scope, site, CIDR) and source; lifted bans leave the index.
    uniqueIndex("ip_ban_site_manual_uq")
      .on(t.siteId, t.cidr)
      .where(
        sql`${t.scope} = 'site' and ${t.source} = 'manual' and ${t.action} = 'block' and ${t.removedAt} is null`,
      ),
    uniqueIndex("ip_ban_platform_uq")
      .on(t.cidr)
      .where(sql`${t.scope} = 'platform' and ${t.action} = 'block' and ${t.removedAt} is null`),
    // One greylist entry per (scope, site, CIDR), next to a ban of the same CIDR.
    uniqueIndex("ip_ban_site_grey_uq")
      .on(t.siteId, t.cidr)
      .where(sql`${t.scope} = 'site' and ${t.action} <> 'block' and ${t.removedAt} is null`),
    uniqueIndex("ip_ban_platform_grey_uq")
      .on(t.cidr)
      .where(sql`${t.scope} = 'platform' and ${t.action} <> 'block' and ${t.removedAt} is null`),
    // Automatic and rule bans per reporting node and source (platform ones: ip_ban_platform_uq).
    uniqueIndex("ip_ban_auto_uq")
      .on(t.nodeId, t.siteId, t.cidr, t.source)
      .where(sql`${t.source} in ('auto', 'rule') and ${t.removedAt} is null`),
  ],
);
