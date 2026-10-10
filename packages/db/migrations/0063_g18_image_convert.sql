ALTER TABLE "node_day_stats" ADD COLUMN "image_bytes_saved" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD COLUMN "image_bytes_saved" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "image_bytes_saved" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "image_convert" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
-- traffic_hour_stats (0010, 0030, 0048, 0058, 0061) gains the bytes WebP / AVIF variants saved (ADR-0043) as its last column.
CREATE OR REPLACE VIEW traffic_hour_stats AS
SELECT m.minute, m.node_id, m.site_id, m.requests, m.bytes_sent, m.bytes_received,
       m.cache_hits, m.cache_misses, m.status_codes, m.top_urls, m.top_ips, m.waf_rules, m.logged_rules,
       m.auth_failures, m.country_requests, m.country_bytes, m.asns, m.referers, m.browsers, m.oses,
       m.devices, m.http_versions, m.tls_versions, m.block_reasons, m.challenges_issued, m.challenges_passed,
       m.image_bytes_saved
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
       h.image_bytes_saved
FROM node_hour_stats h
WHERE NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
  AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id);
