import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { site } from "./core";
export const alertChannel = pgTable("alert_channel", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  kind: text("kind").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  platform: boolean("platform").notNull().default(false),
  locale: text("locale").notNull().default("zh-CN"),
  configEnvelope: text("config_envelope").notNull(),
  lastError: text("last_error").notNull().default(""),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
/** One per account and channel: the alert kinds it sends for a set of sites, or all sites. */
export const alertSubscription = pgTable(
  "alert_subscription",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => alertChannel.id, { onDelete: "cascade" }),
    /** Every site, present and future; alert_subscription_site is then empty. */
    allSites: boolean("all_sites").notNull().default(false),
    kinds: text("kinds").array().notNull(),
    enabled: boolean("enabled").notNull().default(true),
  },
  (t) => [uniqueIndex("alert_subscription_user_channel_uq").on(t.userId, t.channelId)],
);
/** The sites of a subscription that does not cover all sites. */
export const alertSubscriptionSite = pgTable(
  "alert_subscription_site",
  {
    subscriptionId: uuid("subscription_id")
      .notNull()
      .references(() => alertSubscription.id, { onDelete: "cascade" }),
    siteId: uuid("site_id")
      .notNull()
      .references(() => site.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.subscriptionId, t.siteId] }),
    index("alert_subscription_site_site_idx").on(t.siteId),
  ],
);
export const alertState = pgTable("alert_state", {
  key: text("key").primaryKey(),
  /** Null for platform alerts (clusters, DNS). */
  siteId: uuid("site_id").references(() => site.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  resourceId: text("resource_id").notNull(),
  active: boolean("active").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const alertEvent = pgTable(
  "alert_event",
  {
    ordinal: bigserial("ordinal", { mode: "number" }).notNull(),
    id: uuid("id").primaryKey().defaultRandom(),
    /** Null for platform alerts, which go to platform channels only. */
    siteId: uuid("site_id").references(() => site.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    resourceId: text("resource_id").notNull(),
    status: text("status").notNull(),
    payload: jsonb("payload").$type<{ siteName: string; domain: string }>().notNull(),
    occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("alert_event_site_time_idx").on(t.siteId, t.occurredAt),
    // The sweep's latest events of the last day, the event list and the retention.
    index("alert_event_time_idx").on(t.occurredAt, t.ordinal),
  ],
);
export const alertDelivery = pgTable(
  "alert_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    eventId: uuid("event_id")
      .notNull()
      .references(() => alertEvent.id, { onDelete: "cascade" }),
    channelId: uuid("channel_id")
      .notNull()
      .references(() => alertChannel.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }).notNull().defaultNow(),
    lastError: text("last_error").notNull().default(""),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (t) => [uniqueIndex("alert_delivery_event_channel_uq").on(t.eventId, t.channelId)],
);
