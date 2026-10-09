CREATE TABLE "site_auth_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"position" integer NOT NULL,
	"kind" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"scope" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"secret_envelope" text,
	"secret_version" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_day_stats" ADD COLUMN "auth_failures" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD COLUMN "auth_failures" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "auth_failures" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "auth_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site_auth_rule" ADD CONSTRAINT "site_auth_rule_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_auth_rule_site_position_uq" ON "site_auth_rule" USING btree ("site_id","position");--> statement-breakpoint
-- traffic_hour_stats (0010, 0030, 0048) gains auth_failures as its last column.
CREATE OR REPLACE VIEW traffic_hour_stats AS
SELECT m.minute, m.node_id, m.site_id, m.requests, m.bytes_sent, m.bytes_received,
       m.cache_hits, m.cache_misses, m.status_codes, m.top_urls, m.top_ips, m.waf_rules, m.logged_rules,
       m.auth_failures
FROM node_minute_stats m
WHERE NOT EXISTS (
  SELECT 1 FROM node_hour_stats h
  WHERE h.minute = date_trunc('hour',m.minute,'UTC') AND h.node_id = m.node_id AND h.site_id = m.site_id
    AND NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
      AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id)
)
UNION ALL
SELECT h.minute, h.node_id, h.site_id, h.requests, h.bytes_sent, h.bytes_received,
       h.cache_hits, h.cache_misses, h.status_codes, h.top_urls, h.top_ips, h.waf_rules, h.logged_rules,
       h.auth_failures
FROM node_hour_stats h
WHERE NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
  AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id);
