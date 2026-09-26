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
export interface DnsRecordData {
  name: string;
  type: "A" | "AAAA" | "CNAME";
  data: string;
  ttl: number;
}
export const platformDnsProvider = pgTable("platform_dns_provider", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  zone: text("zone").notNull(),
  credentialEnvelope: text("credential_envelope").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const dnsRevision = pgTable(
  "dns_revision",
  {
    revision: bigserial("revision", { mode: "number" }).primaryKey(),
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
  (t) => [index("dns_revision_created_idx").on(t.createdAt)],
);
export const dnsState = pgTable("dns_state", {
  id: integer("id").primaryKey().default(1),
  policy: jsonb("policy").$type<Record<string, unknown>>().notNull().default({}),
  desiredRevision: bigint("desired_revision", { mode: "number" }),
  appliedRevision: bigint("applied_revision", { mode: "number" }),
});
/** Claim managed names before touching DNS, so partial external writes are repairable. */
export const dnsManagedName = pgTable(
  "dns_managed_name",
  {
    providerId: uuid("provider_id")
      .notNull()
      .references(() => platformDnsProvider.id, { onDelete: "restrict" }),
    name: text("name").notNull(),
    type: text("type").notNull(),
    active: boolean("active").notNull().default(true),
  },
  (t) => [primaryKey({ columns: [t.providerId, t.name, t.type] })],
);
