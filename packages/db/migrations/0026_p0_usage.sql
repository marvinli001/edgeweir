CREATE SEQUENCE "public"."site_usage_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "site_usage" (
	"window_start" timestamp with time zone NOT NULL,
	"site_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"requests" numeric(38, 0) DEFAULT '0' NOT NULL,
	"bytes_sent" numeric(38, 0) DEFAULT '0' NOT NULL,
	"bytes_received" numeric(38, 0) DEFAULT '0' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"seq" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_usage_window_start_site_id_pk" PRIMARY KEY("window_start","site_id")
);
--> statement-breakpoint
ALTER TABLE "node_stats_cursor" ADD COLUMN "complete_until" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "site_usage_seq_uq" ON "site_usage" USING btree ("seq");--> statement-breakpoint
CREATE INDEX "site_usage_org_idx" ON "site_usage" USING btree ("organization_id","window_start");--> statement-breakpoint
-- Backfill: every window that already has minute statistics is computed once.
INSERT INTO "stats_rollup_dirty" ("granularity", "bucket", "node_id", "site_id")
SELECT DISTINCT 'usage', to_timestamp(floor(extract(epoch FROM "minute") / 300) * 300), "node_id", "site_id"
FROM "node_minute_stats"
ON CONFLICT DO NOTHING;
