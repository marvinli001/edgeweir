import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { site } from "./core";

const bytea = customType<{ data: Uint8Array; driverData: Buffer | Uint8Array }>({
  dataType: () => "bytea",
  toDriver: (value) => Buffer.from(value.buffer, value.byteOffset, value.byteLength),
  fromDriver: (value) => new Uint8Array(value),
});

/** An Ed25519 publisher key the operator trusts (docs/reference/extensions.md). */
export const extensionKey = pgTable("extension_key", {
  /** RFC 7638 JWK thumbprint. */
  kid: text("kid").primaryKey(),
  publisher: text("publisher").notNull(),
  /** Base64url public key (JWK "x"). */
  x: text("x").notNull(),
  label: text("label").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** An installed extension and its operator settings. */
export const extension = pgTable("extension", {
  id: text("id").primaryKey(),
  activeVersion: text("active_version").notNull(),
  enabled: boolean("enabled").notNull().default(false),
  /** open | closed */
  failureMode: text("failure_mode").notNull().default("open"),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  /**
   * Manifest `secret: true` (version 1.1): JSON envelope (purpose
   * "extension.secret_envelope", bound to the id) of the current secret's 32
   * bytes followed by the previous one's (none before the first rotation).
   * Generated when such a version becomes active; never plaintext.
   */
  secretEnvelope: text("secret_envelope"),
  /** Version of the secret (Extension.secret_version); 0 while there is none. */
  secretVersion: integer("secret_version").notNull().default(0),
  /** Hooks run in install order (then id). */
  installedAt: timestamp("installed_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .$onUpdate(() => new Date())
    .notNull(),
});

/** A verified package version of an extension; the package bytes stay for rollbacks. */
export const extensionVersion = pgTable(
  "extension_version",
  {
    extensionId: text("extension_id")
      .notNull()
      .references(() => extension.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    package: bytea("package").notNull(),
    signature: text("signature").notNull(),
    /** Signing key; removing the key is refused while a version references it. */
    kid: text("kid").notNull(),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
    uploadedAt: timestamp("uploaded_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.extensionId, t.version] }),
    uniqueIndex("extension_version_sha256_idx").on(t.sha256),
  ],
);

/** An extension turned on for one site, with the site's configuration. */
export const siteExtension = pgTable(
  "site_extension",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    extensionId: text("extension_id")
      .notNull()
      .references(() => extension.id, { onDelete: "cascade" }),
    enabled: boolean("enabled").notNull().default(false),
    config: jsonb("config").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.extensionId] })],
);

/**
 * An opaque per-site data item of an extension whose manifest declares
 * `data` (version 1.1), uploaded through the console API; nodes fetch it by
 * digest (GetExtensionData).
 */
export const siteExtensionData = pgTable(
  "site_extension_data",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    extensionId: text("extension_id")
      .notNull()
      .references(() => extension.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** Lowercase hex SHA-256 of the content. */
    sha256: text("sha256").notNull(),
    size: integer("size").notNull(),
    content: bytea("content").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.extensionId, t.name] })],
);
