import {
  bigint,
  bigserial,
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
import { cluster } from "./core";

export interface DnsRecordData {
  name: string;
  type: "A" | "AAAA" | "CNAME" | "TXT";
  data: string;
  ttl: number;
  /** Canonical resolution line; absent on the default line. */
  line?: "default" | "telecom" | "unicom" | "mobile" | "edu" | "overseas";
}
/** A binding line; lines saved before resolution lines lack the last three fields. */
export interface DnsLineData {
  name: string;
  nodeGroupId: string;
  overrides: { nodeId: string; addresses: string[] }[];
  resolutionLine?: "default" | "telecom" | "unicom" | "mobile" | "edu" | "overseas";
  backupNodeGroupIds?: string[];
  minHealthyIps?: number;
}
export const platformDnsProvider = pgTable("platform_dns_provider", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  zone: text("zone").notNull(),
  credentialEnvelope: text("credential_envelope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
/**
 * A cluster's DNS: mode (off / manual / auto), the provider account whose
 * zone holds the records, the cluster domain, TTL, lines (node group → line
 * name) and the target / applied DNS revision. No row means off.
 */
export const dnsBinding = pgTable("dns_binding", {
  clusterId: uuid("cluster_id")
    .primaryKey()
    .references(() => cluster.id, { onDelete: "cascade" }),
  mode: text("mode").notNull().default("off"),
  providerId: uuid("provider_id").references(() => platformDnsProvider.id, {
    onDelete: "restrict",
  }),
  domain: text("domain").notNull().default(""),
  ttl: integer("ttl").notNull().default(600),
  lines: jsonb("lines").$type<DnsLineData[]>().notNull().default([]),
  /** Label of the record with every line's addresses: "all", "all-N" for migrated shared domains. */
  allLabel: text("all_label").notNull().default("all"),
  /** Keep `<line>.<site id>.<domain>` per site (the targets shown before cluster bindings). */
  lineAliases: boolean("line_aliases").notNull().default(false),
  desiredRevision: bigint("desired_revision", { mode: "number" }),
  appliedRevision: bigint("applied_revision", { mode: "number" }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const dnsRevision = pgTable(
  "dns_revision",
  {
    revision: bigserial("revision", { mode: "number" }).primaryKey(),
    /** Null for revisions of the former platform-wide policy. */
    clusterId: uuid("cluster_id").references(() => cluster.id, { onDelete: "cascade" }),
    providerId: uuid("provider_id"),
    policy: jsonb("policy").$type<Record<string, unknown>>().notNull(),
    records: jsonb("records").$type<DnsRecordData[]>().notNull().default([]),
    managedNames: jsonb("managed_names")
      .$type<{ name: string; type: string }[]>()
      .notNull()
      .default([]),
    contentHash: text("content_hash").notNull(),
    /** manual | health | rollback | force | scheduling */
    reason: text("reason").notNull(),
    /** Parameters of the reason (scheduling: rule, ruleId, node, nodeId, action, event). */
    reasonParams: jsonb("reason_params")
      .$type<Record<string, string | number>>()
      .notNull()
      .default({}),
    status: text("status").notNull().default("pending"),
    lastError: text("last_error").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
  },
  (t) => [
    index("dns_revision_created_idx").on(t.createdAt),
    index("dns_revision_cluster_idx").on(t.clusterId, t.revision),
  ],
);
/**
 * Names a binding manages in a provider zone, claimed before touching DNS so
 * partial external writes are repairable. A name belongs to one binding.
 */
export const dnsManagedName = pgTable(
  "dns_managed_name",
  {
    providerId: uuid("provider_id")
      .notNull()
      .references(() => platformDnsProvider.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "restrict" }),
    active: boolean("active").notNull().default(true),
  },
  (t) => [
    primaryKey({ columns: [t.providerId, t.name, t.type] }),
    index("dns_managed_name_cluster_idx").on(t.clusterId),
  ],
);
/**
 * Short leases that serialize DNS work across console processes without
 * holding a database connection: one per binding (`binding:<cluster id>`).
 */
export const dnsLease = pgTable("dns_lease", {
  key: text("key").primaryKey(),
  holder: uuid("holder").notNull(),
  until: timestamp("until", { withTimezone: true }).notNull(),
});
