import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Credentials are write-only API values, encrypted with a row-bound envelope. */
export const dnsCredential = pgTable("dns_credential", {
  id: uuid("id").primaryKey().defaultRandom(),
  organizationId: text("organization_id")
    .notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  zone: text("zone").notNull(),
  credentialEnvelope: text("credential_envelope").notNull(),
  createdAt: now(),
});

export const certificate = pgTable(
  "certificate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    names: text("names").array().notNull().default(sql`'{}'::text[]`),
    source: text("source").notNull(),
    status: text("status").notNull().default("pending"),
    chainPem: text("chain_pem").notNull().default(""),
    privateKeyEnvelope: text("private_key_envelope").notNull().default(""),
    fingerprint: text("fingerprint").notNull().default(""),
    notBefore: timestamp("not_before", { withTimezone: true }),
    notAfter: timestamp("not_after", { withTimezone: true }),
    autoRenew: boolean("auto_renew").notNull().default(false),
    renewAt: timestamp("renew_at", { withTimezone: true }),
    /** Public CA/challenge settings, with no credential values. */
    acme: jsonb("acme").$type<Record<string, string>>().notNull().default({}),
    accountEnvelope: text("account_envelope").notNull().default(""),
    lastError: text("last_error").notNull().default(""),
    operationStartedAt: timestamp("operation_started_at", { withTimezone: true }),
    createdAt: now(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("certificate_org_idx").on(t.organizationId)],
);

export const acmeChallenge = pgTable("acme_challenge", {
  id: uuid("id").primaryKey().defaultRandom(),
  certificateId: uuid("certificate_id")
    .notNull()
    .references(() => certificate.id, { onDelete: "cascade" }),
  domain: text("domain").notNull(),
  token: text("token").notNull(),
  keyAuthorization: text("key_authorization").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  operationStartedAt: timestamp("operation_started_at", { withTimezone: true }).notNull(),
});

/** Persist before DNS creation; retain until exact TXT cleanup succeeds. */
export const dnsChallengeLease = pgTable(
  "dns_challenge_lease",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    certificateId: uuid("certificate_id")
      .notNull()
      .references(() => certificate.id, { onDelete: "restrict" }),
    credentialId: uuid("credential_id")
      .notNull()
      .references(() => dnsCredential.id, { onDelete: "restrict" }),
    operationStartedAt: timestamp("operation_started_at", { withTimezone: true }).notNull(),
    token: text("token").notNull(),
    record: jsonb("record")
      .$type<{ name: string; type: string; data: string; ttl: number }>()
      .notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("dns_challenge_attempt_uq").on(t.certificateId, t.operationStartedAt, t.token),
  ],
);
