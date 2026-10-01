ALTER TABLE "node" ADD COLUMN "previous_cert_serial" text;--> statement-breakpoint
ALTER TABLE "node_upgrade_delivery" ADD COLUMN "deadline_at" timestamp with time zone;--> statement-breakpoint
-- Deliveries already released keep the deadline they had: 30 minutes after the upgrade was created.
UPDATE "node_upgrade_delivery" AS "d" SET "deadline_at" = "u"."created_at" + interval '30 minutes' FROM "node_upgrade" AS "u" WHERE "d"."upgrade_id" = "u"."id" AND "d"."state" IN ('pending', 'running');
