CREATE TABLE "site_waf" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"paranoia_level" integer DEFAULT 1 NOT NULL,
	"anomaly_threshold" integer DEFAULT 5 NOT NULL,
	"excluded_rule_ids" integer[] DEFAULT '{}' NOT NULL,
	"request_body_limit" integer DEFAULT 131072 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_day_stats" ADD COLUMN "waf_rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD COLUMN "waf_rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "waf_rules" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "waf_rule_ids" bigint[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "waf_blocked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_waf" ADD CONSTRAINT "site_waf_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- traffic_hour_stats (0010) gains waf_rules as its last column.
CREATE OR REPLACE VIEW traffic_hour_stats AS
SELECT m.minute, m.node_id, m.site_id, m.requests, m.bytes_sent, m.bytes_received,
       m.cache_hits, m.cache_misses, m.status_codes, m.top_urls, m.top_ips, m.waf_rules
FROM node_minute_stats m
WHERE NOT EXISTS (
  SELECT 1 FROM node_hour_stats h
  WHERE h.minute = date_trunc('hour',m.minute,'UTC') AND h.node_id = m.node_id AND h.site_id = m.site_id
    AND NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
      AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id)
)
UNION ALL
SELECT h.minute, h.node_id, h.site_id, h.requests, h.bytes_sent, h.bytes_received,
       h.cache_hits, h.cache_misses, h.status_codes, h.top_urls, h.top_ips, h.waf_rules
FROM node_hour_stats h
WHERE NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
  AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id);
