CREATE TABLE "node_upgrade" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"cluster_name" text NOT NULL,
	"group_name" text NOT NULL,
	"version" text NOT NULL,
	"state" text DEFAULT 'canary' NOT NULL,
	"artifacts" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_upgrade_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"upgrade_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"node_name" text NOT NULL,
	"arch" text NOT NULL,
	"phase" text NOT NULL,
	"state" text NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"error_code" text DEFAULT '' NOT NULL,
	"lease_until" timestamp with time zone,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "node_upgrade" ADD CONSTRAINT "node_upgrade_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_upgrade_delivery" ADD CONSTRAINT "node_upgrade_delivery_upgrade_id_node_upgrade_id_fk" FOREIGN KEY ("upgrade_id") REFERENCES "public"."node_upgrade"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_upgrade_created_idx" ON "node_upgrade" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "node_upgrade_delivery_job_idx" ON "node_upgrade_delivery" USING btree ("upgrade_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_upgrade_delivery_active_uq" ON "node_upgrade_delivery" USING btree ("node_id") WHERE "node_upgrade_delivery"."state" in ('held', 'pending', 'running');