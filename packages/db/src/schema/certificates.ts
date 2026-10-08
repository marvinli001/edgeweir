import { sql } from "drizzle-orm";
import {
  type AnyPgColumn,
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

const now = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** Credentials are write-only API values, encrypted with a row-bound envelope. */
export const dnsCredential = pgTable("dns_credential", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  provider: text("provider").notNull(),
  zone: text("zone").notNull(),
  credentialEnvelope: text("credential_envelope").notNull(),
  createdAt: now(),
});

export const certificate = pgTable("certificate", {
  id: uuid("id").primaryKey().defaultRandom(),
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
  /** The request's EAB key (`{ eabKid, eabHmacKey }`); the account is in acme_account. */
  accountEnvelope: text("account_envelope").notNull().default(""),
  /** The ACME account the certificate was last issued with or stored for. */
  acmeAccountId: uuid("acme_account_id").references((): AnyPgColumn => acmeAccount.id, {
    onDelete: "set null",
  }),
  lastError: text("last_error").notNull().default(""),
  operationStartedAt: timestamp("operation_started_at", { withTimezone: true }),
  /** When to ask the CA for its suggested renewal window again (ARI, RFC 9773). */
  renewalInfoAt: timestamp("renewal_info_at", { withTimezone: true }),
  createdAt: now(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * ACME accounts, one per directory, EAB key id and contact email, shared by
 * every certificate requested with them: CAs limit new accounts (Let's
 * Encrypt: 10 per IP address in 3 hours).
 */
export const acmeAccount = pgTable(
  "acme_account",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    directoryUrl: text("directory_url").notNull(),
    eabKid: text("eab_kid").notNull().default(""),
    email: text("email").notNull(),
    /** The account key and registration, sealed. */
    accountEnvelope: text("account_envelope").notNull(),
    createdAt: now(),
  },
  (t) => [uniqueIndex("acme_account_uq").on(t.directoryUrl, t.eabKid, t.email)],
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
    /**
     * When the record may be cleaned up; after a failed cleanup, when to try
     * again (backing off with `attempts`).
     */
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Failed cleanups so far. */
    attempts: integer("attempts").notNull().default(0),
  },
  (t) => [
    uniqueIndex("dns_challenge_attempt_uq").on(t.certificateId, t.operationStartedAt, t.token),
  ],
);
