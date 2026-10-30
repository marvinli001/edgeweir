ALTER TABLE "node" ADD COLUMN "key_sha256" text;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "machine_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "decommission_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "decommission_task_id" uuid;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "decommission_error" text;--> statement-breakpoint
CREATE UNIQUE INDEX "node_key_sha256_idx" ON "node" USING btree ("key_sha256");