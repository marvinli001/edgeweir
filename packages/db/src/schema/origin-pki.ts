import { index, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { cluster } from "./core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).defaultNow().notNull();

/**
 * Client certificates the nodes of a cluster present to origins that request
 * one (origin mutual TLS), signed by an origin client CA (`pki_authority`
 * kind `origin-client`). The newest unexpired one is current; earlier ones
 * stay until they expire for nodes still on earlier revisions.
 */
export const originClientCertificate = pgTable(
  "origin_client_certificate",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    /** The `pki_authority` row that signed it (kept after that CA is retired). */
    authorityId: text("authority_id").notNull().default("origin-client"),
    chainPem: text("chain_pem").notNull(),
    /** Envelope with purpose `origin_client_certificate.private_key_envelope`, bound to the row. */
    privateKeyEnvelope: text("private_key_envelope").notNull(),
    fingerprint: text("fingerprint").notNull(),
    serial: text("serial").notNull(),
    notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
    notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("origin_client_certificate_cluster_idx").on(t.clusterId, t.notAfter)],
);

/**
 * Certificates an Origin CA (`pki_authority` kind `origin-ca`) issued for
 * origin servers, which only the edge trusts. Private keys are never stored.
 */
export const originCertificate = pgTable("origin_certificate", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** The `pki_authority` row that signed it (kept after that CA is retired). */
  authorityId: text("authority_id").notNull().default("origin-ca"),
  hostnames: text("hostnames").array().notNull(),
  /** ec256 | ec384 | rsa2048 | rsa3072 | rsa4096 */
  keyType: text("key_type").notNull(),
  /** generated (the console made the key and showed it once) | csr */
  source: text("source").notNull(),
  certificatePem: text("certificate_pem").notNull(),
  /** Lowercase hex, unique for the CA. */
  serial: text("serial").notNull().unique(),
  fingerprint: text("fingerprint").notNull(),
  notBefore: timestamp("not_before", { withTimezone: true }).notNull(),
  notAfter: timestamp("not_after", { withTimezone: true }).notNull(),
  /** Set once; revoked certificates are listed in the CRL until they expire. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdAt: createdAt(),
});
