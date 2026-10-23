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

/**
 * The saved states of each rule (ADR-0054): one row per save that created,
 * changed or deleted it, numbered per rule. Rows outlive the rule (no foreign
 * key on rule_id) so deleted rules can be restored; they go with their site.
 * `rule` holds the rule as saved (name, phase, expression, enabled, action);
 * a deletion keeps the last state. `source`: ui, api, restore, copy or
 * initial (the rules that existed when versions began).
 */
export const edgeRuleVersion = pgTable(
  "edge_rule_version",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ruleId: uuid("rule_id").notNull(),
    siteId: uuid("site_id").references(() => site.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** created, updated or deleted. */
    change: text("change").notNull(),
    source: text("source").notNull(),
    /** The version a restore brought back. */
    restoredFrom: integer("restored_from"),
    rule: jsonb("rule").$type<Record<string, unknown>>().notNull(),
    actorType: text("actor_type").notNull().default(""),
    actorId: text("actor_id").notNull().default(""),
    actorName: text("actor_name").notNull().default(""),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex("edge_rule_version_rule_uq").on(t.ruleId, t.version),
    index("edge_rule_version_site_idx").on(t.siteId, t.createdAt),
  ],
);

export const ipList = pgTable(
  "ip_list",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    kind: text("kind").notNull().default("collection"),
    entries: text("entries").array().notNull().default(sql`'{}'::text[]`),
  },
  (t) => [uniqueIndex("ip_list_name_uq").on(t.name)],
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
