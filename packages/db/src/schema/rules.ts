import { sql } from "drizzle-orm";
import {
  boolean,
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
import { site } from "./core";

export const edgeRule = pgTable(
  "edge_rule",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id").references(() => site.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    phase: text("phase").notNull(),
    expression: text("expression").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    priority: integer("priority").notNull(),
    action: jsonb("action").$type<Record<string, unknown>>().notNull(),
    listIds: uuid("list_ids").array().notNull().default(sql`'{}'::uuid[]`),
  },
  (t) => [index("edge_rule_site_idx").on(t.siteId)],
);

export const ipList = pgTable(
  "ip_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").references(() => organization.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("collection"),
    entries: text("entries").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [
    uniqueIndex("ip_list_org_name_uq").on(t.organizationId, t.name),
    uniqueIndex("ip_list_platform_name_uq").on(t.name).where(sql`${t.organizationId} is null`),
  ],
);

/**
 * A site's exact-match redirect table (contract bulkRedirects), at most 5000
 * entries in the order they were saved; sources unique per site.
 */
export const bulkRedirect = pgTable(
  "bulk_redirect",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    /** "/path" or "host/path". */
    source: text("source").notNull(),
    target: text("target").notNull(),
    statusCode: integer("status_code").notNull().default(301),
    preserveQuery: boolean("preserve_query").notNull().default(false),
    position: integer("position").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex("bulk_redirect_site_source_uq").on(t.siteId, t.source)],
);
