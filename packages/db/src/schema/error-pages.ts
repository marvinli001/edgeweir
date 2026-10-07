import { integer, pgTable, primaryKey, smallint, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { site } from "./core";

/**
 * A site's error page for one status (400, 401, 403, 404, 405, 410, 429,
 * 500, 502, 503, 504) or class (status 4: 4xx, 5: 5xx): an HTML template of
 * at most 64 KiB that replaces the nodes' built-in page, or a redirect URL.
 * Whether it also replaces origin responses is site.intercept_origin_errors.
 */
export const siteErrorPage = pgTable(
  "site_error_page",
  {
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
    status: smallint("status").notNull(),
    template: text("template").notNull(),
    /** Redirect with 302 to this URL instead (template empty). */
    redirectUrl: text("redirect_url").notNull().default(""),
    /** Send a template page with this status; 0 keeps the response's. */
    responseStatus: integer("response_status").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.siteId, t.status] })],
);
