import { sql } from "drizzle-orm";
import { pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { organization } from "./auth";
/** A pending request reserves no routing rights. Verified roots belong to one organization. */
export const domainOwnership = pgTable(
  "domain_ownership",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    domain: text("domain").notNull(),
    token: text("token").notNull(),
    method: text("method").notNull().default("dns"),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("domain_ownership_org_uq").on(t.organizationId, t.domain),
    uniqueIndex("domain_ownership_verified_uq")
      .on(t.domain)
      .where(sql`${t.verifiedAt} is not null`),
  ],
);
