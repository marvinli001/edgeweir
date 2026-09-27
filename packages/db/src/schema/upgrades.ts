import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { cluster } from "./core";
export const nodeUpgrade = pgTable(
  "node_upgrade",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clusterId: uuid("cluster_id")
      .notNull()
      .references(() => cluster.id, { onDelete: "cascade" }),
    clusterName: text("cluster_name").notNull(),
    groupName: text("group_name").notNull(),
    version: text("version").notNull(),
    state: text("state").notNull().default("canary"),
    artifacts: jsonb("artifacts")
      .$type<
        {
          arch: "amd64" | "arm64";
          archiveUrl: string;
          sha256: string;
          checksumsUrl: string;
          signatureUrl: string;
        }[]
      >()
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("node_upgrade_created_idx").on(t.createdAt)],
);
export const nodeUpgradeDelivery = pgTable(
  "node_upgrade_delivery",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    upgradeId: uuid("upgrade_id")
      .notNull()
      .references(() => nodeUpgrade.id, { onDelete: "cascade" }),
    // Keep the history after a node is removed. Delivery still requires an active enrolled node.
    nodeId: uuid("node_id").notNull(),
    nodeName: text("node_name").notNull(),
    arch: text("arch").notNull(),
    phase: text("phase").notNull(),
    state: text("state").notNull(),
    message: text("message").notNull().default(""),
    errorCode: text("error_code").notNull().default(""),
    healthySince: timestamp("healthy_since", { withTimezone: true }),
    leaseUntil: timestamp("lease_until", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("node_upgrade_delivery_job_idx").on(t.upgradeId),
    uniqueIndex("node_upgrade_delivery_active_uq")
      .on(t.nodeId)
      .where(sql`${t.state} in ('held', 'pending', 'running')`),
  ],
);
