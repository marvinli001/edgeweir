import { pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { site } from "./core";

/**
 * A site's error page for one status (403, 429, 502, 503, 504): an HTML
 * template of at most 64 KiB that replaces the nodes' built-in page. Whether
 * it also replaces origin responses is site.intercept_origin_errors.
 */
export const siteErrorPage = pgTable(
  "site_error_page",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    status: smallint("status").notNull(),
    template: text("template").notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.status] })],
);
