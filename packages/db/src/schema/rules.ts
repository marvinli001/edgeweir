import { sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
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
