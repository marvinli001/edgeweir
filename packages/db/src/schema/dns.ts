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
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { dnsCredential } from "./certificates";
import { cluster } from "./core";

export interface DnsRecordData {
  name: string;
  type: "A" | "AAAA" | "CNAME" | "TXT";
  data: string;
  ttl: number;
}
export interface DnsLineData {
  name: string;
  nodeGroupId: string;
  overrides: { nodeId: string; addresses: string[] }[];
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
    reason: text("reason").notNull(),
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
 * Records the console wrote into an organization's own zone (ownership TXT,
 * CNAME to the site target). Only these are ever changed or deleted.
 */
export const dnsOwnedRecord = pgTable(
  "dns_owned_record",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => dnsCredential.id, { onDelete: "restrict" }),
    /** The site the record serves; null once the site is gone (cleanup pending). */
    siteId: uuid("site_id"),
    /** The host name the record serves (site domain or registrable domain). */
    domain: text("domain").notNull(),
    /** Relative to the credential's zone ("@" for the apex). */
    name: text("name").notNull(),
    type: text("type").notNull(),
    data: text("data").notNull(),
    /** ownership (TXT proof) or target (CNAME to the site target). */
    purpose: text("purpose").notNull(),
    /** pending, written, conflict, failed, deleting. */
    status: text("status").notNull().default("pending"),
    /** Records of other owners found at the name (conflict). */
    conflicts: jsonb("conflicts").$type<{ type: string; data: string }[]>().notNull().default([]),
    /** A member confirmed replacing the conflicting records. */
    confirmed: boolean("confirmed").notNull().default(false),
    /**
     * The console created the record. An identical record that was already
     * there is adopted (tracked) but never deleted by the console.
     */
    created: boolean("created").notNull().default(false),
    lastError: text("last_error").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dns_owned_record_name_uq").on(t.credentialId, t.name, t.type, t.purpose),
    index("dns_owned_record_org_idx").on(t.organizationId),
    index("dns_owned_record_site_idx").on(t.siteId),
  ],
);
/**
 * Short leases that serialize DNS work across console processes without
 * holding a database connection: one per binding (`binding:<cluster id>`)
 * and per organization credential (`credential:<id>`).
 */
export const dnsLease = pgTable("dns_lease", {
  key: text("key").primaryKey(),
  holder: uuid("holder").notNull(),
  until: timestamp("until", { withTimezone: true }).notNull(),
});
