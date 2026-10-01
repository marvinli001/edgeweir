import {
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
import { user } from "./auth";
import { cluster, node, region } from "./core";

/**
 * A regional probe (`edgeweir-node probe`): it measures the scheduling
 * addresses of the nodes from its region over mutual TLS with a certificate
 * of the node CA (CN=<probe id>, O=Edgeweir Probe). Deleting or disabling a
 * probe stops its certificate from being accepted.
 */
export const probe = pgTable("probe", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** Probes are refused while their region still exists (REGION_IN_USE on region delete). */
  regionId: uuid("region_id")
    .notNull()
    .references(() => region.id, { onDelete: "restrict" }),
  enabled: boolean("enabled").notNull().default(true),
  hostname: text("hostname").notNull().default(""),
  agentVersion: text("agent_version").notNull().default(""),
  os: text("os").notNull().default(""),
  arch: text("arch").notNull().default(""),
  certSerial: text("cert_serial"),
  certFingerprint: text("cert_fingerprint"),
  certNotAfter: timestamp("cert_not_after", { withTimezone: true }),
  /** The certificate a renewal replaced, accepted until the probe uses the new one. */
  previousCertSerial: text("previous_cert_serial"),
  enrolledAt: timestamp("enrolled_at", { withTimezone: true }),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Single-use probe enrollment tokens (`ewp_…`); only the SHA-256 is stored. */
export const probeToken = pgTable("probe_token", {
  id: uuid("id").primaryKey().defaultRandom(),
  tokenHash: text("token_hash").notNull().unique(),
  tokenPrefix: text("token_prefix").notNull(),
  name: text("name").notNull(),
  regionId: uuid("region_id")
    .notNull()
    .references(() => region.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  usedByProbeId: uuid("used_by_probe_id").references(() => probe.id, { onDelete: "set null" }),
  createdByUserId: text("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The latest result of one prober (a probe, or a node that also probes) for
 * one scheduling address and listener port of a node.
 */
export const probeResult = pgTable(
  "probe_result",
  {
    /** probe | node */
    proberKind: text("prober_kind").notNull(),
    /** Probe id or node id (no foreign key: two tables); removed with the prober. */
    proberId: uuid("prober_id").notNull(),
    /** The prober's region when it reported (a node's comes from its node group). */
    regionId: uuid("region_id"),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    port: integer("port").notNull(),
    /** tcp | http | https */
    method: text("method").notNull(),
    sent: integer("sent").notNull(),
    lost: integer("lost").notNull(),
    rttMs: integer("rtt_ms").notNull().default(0),
    error: text("error").notNull().default(""),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.proberId, t.nodeId, t.address, t.port] }),
    index("probe_result_node_idx").on(t.nodeId, t.checkedAt),
  ],
);

/**
 * Probe-driven reachability of a node's scheduling address, with hysteresis:
 * `failingSince` while the probers see it fail, `down` once that lasted
 * ipDownSeconds, `answeringSince` while a down address answers again.
 */
export const nodeAddressState = pgTable(
  "node_address_state",
  {
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    address: text("address").notNull(),
    down: boolean("down").notNull().default(false),
    failingSince: timestamp("failing_since", { withTimezone: true }),
    answeringSince: timestamp("answering_since", { withTimezone: true }),
    changedAt: timestamp("changed_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.nodeId, t.address] })],
);

/** A scheduling condition as stored (contract `schedulingCondition`). */
export interface SchedulingConditionData {
  metric: string;
  aggregate: string;
  comparator: string;
  threshold: number;
  durationSeconds: number;
  regionId: string | null;
}

/**
 * A cluster's scheduling rule: structured conditions on node and probe
 * metrics combined with and / or, and a DNS action with hold and recovery.
 */
export const schedulingRule = pgTable(
  "scheduling_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    /** A line of the cluster's DNS binding; null applies to every line. */
    lineName: text("line_name"),
    name: text("name").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    /** all | any */
    match: text("match").notNull().default("all"),
    conditions: jsonb("conditions").$type<SchedulingConditionData[]>().notNull(),
    /** remove_node | backup_group | backup_ip */
    action: text("action").notNull(),
    holdSeconds: integer("hold_seconds").notNull().default(300),
    recoverSeconds: integer("recover_seconds").notNull().default(300),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [index("scheduling_rule_cluster_idx").on(t.clusterId)],
);

/**
 * Where a rule stands for one node: since when each condition's comparison
 * holds (ISO time or null, by condition index), when the action started and
 * since when the conditions are clear again (recovering).
 */
export const schedulingState = pgTable(
  "scheduling_state",
  {
    ruleId: uuid("rule_id")
      .notNull()
      .references(() => schedulingRule.id, { onDelete: "cascade" }),
    nodeId: uuid("node_id")
      .notNull()
      .references(() => node.id, { onDelete: "cascade" }),
    /** idle | pending | active | recovering */
    state: text("state").notNull().default("idle"),
    conditionSince: jsonb("condition_since").$type<(string | null)[]>().notNull().default([]),
    activeSince: timestamp("active_since", { withTimezone: true }),
    clearSince: timestamp("clear_since", { withTimezone: true }),
    evaluatedAt: timestamp("evaluated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.ruleId, t.nodeId] }),
    index("scheduling_state_node_idx").on(t.nodeId),
  ],
);
