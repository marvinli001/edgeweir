CREATE TABLE "site_ai_crawl" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"crawlers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"operators" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"impersonators" text,
	"challenge" text,
	"block_status" integer,
	"block_body" text,
	"robots_managed" boolean DEFAULT false NOT NULL,
	"signal_search" text DEFAULT 'unset' NOT NULL,
	"signal_ai_input" text DEFAULT 'unset' NOT NULL,
	"signal_ai_train" text DEFAULT 'unset' NOT NULL,
	"pay_per_crawl" boolean DEFAULT false NOT NULL,
	"price_micros" integer DEFAULT 10000 NOT NULL,
	"dynamic_pricing" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_day_stats" ADD COLUMN "crawler_stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_day_stats" ADD COLUMN "crawler_paths" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD COLUMN "crawler_stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD COLUMN "crawler_paths" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "crawler_stats" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "crawler_paths" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "crawler" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "crawler_verification" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "crawler_charged_micros" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_ai_crawl" ADD CONSTRAINT "site_ai_crawl_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- traffic_hour_stats (0010, 0030, 0048, 0058, 0061, 0063, 0073) gains the AI crawler counters and paths (ADR-0070) as its last columns.
CREATE OR REPLACE VIEW traffic_hour_stats AS
SELECT m.minute, m.node_id, m.site_id, m.requests, m.bytes_sent, m.bytes_received,
       m.cache_hits, m.cache_misses, m.status_codes, m.top_urls, m.top_ips, m.waf_rules, m.logged_rules,
       m.auth_failures, m.country_requests, m.country_bytes, m.asns, m.referers, m.browsers, m.oses,
       m.devices, m.http_versions, m.tls_versions, m.block_reasons, m.challenges_issued, m.challenges_passed,
       m.image_bytes_saved, m.origin_stats, m.crawler_stats, m.crawler_paths
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
       h.auth_failures, h.country_requests, h.country_bytes, h.asns, h.referers, h.browsers, h.oses,
       h.devices, h.http_versions, h.tls_versions, h.block_reasons, h.challenges_issued, h.challenges_passed,
       h.image_bytes_saved, h.origin_stats, h.crawler_stats, h.crawler_paths
FROM node_hour_stats h
WHERE NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
  AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id);
