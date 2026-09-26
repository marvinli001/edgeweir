CREATE TABLE "node_day_stats" (
	"minute" timestamp with time zone NOT NULL,
	"node_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"bytes_sent" bigint DEFAULT 0 NOT NULL,
	"bytes_received" bigint DEFAULT 0 NOT NULL,
	"cache_hits" bigint DEFAULT 0 NOT NULL,
	"cache_misses" bigint DEFAULT 0 NOT NULL,
	"status_codes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_urls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_ips" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "node_day_stats_minute_node_id_site_id_pk" PRIMARY KEY("minute","node_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "node_hour_stats" (
	"minute" timestamp with time zone NOT NULL,
	"node_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"requests" bigint DEFAULT 0 NOT NULL,
	"bytes_sent" bigint DEFAULT 0 NOT NULL,
	"bytes_received" bigint DEFAULT 0 NOT NULL,
	"cache_hits" bigint DEFAULT 0 NOT NULL,
	"cache_misses" bigint DEFAULT 0 NOT NULL,
	"status_codes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_urls" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"top_ips" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "node_hour_stats_minute_node_id_site_id_pk" PRIMARY KEY("minute","node_id","site_id")
);
--> statement-breakpoint
CREATE TABLE "node_stats_cursor" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stats_rollup_dirty" (
	"granularity" text NOT NULL,
	"bucket" timestamp with time zone NOT NULL,
	"node_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "stats_rollup_dirty_granularity_bucket_node_id_site_id_pk" PRIMARY KEY("granularity","bucket","node_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "top_urls" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "top_ips" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_day_stats" ADD CONSTRAINT "node_day_stats_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_day_stats" ADD CONSTRAINT "node_day_stats_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD CONSTRAINT "node_hour_stats_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD CONSTRAINT "node_hour_stats_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_stats_cursor" ADD CONSTRAINT "node_stats_cursor_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_rollup_dirty" ADD CONSTRAINT "stats_rollup_dirty_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stats_rollup_dirty" ADD CONSTRAINT "stats_rollup_dirty_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_day_stats_site_idx" ON "node_day_stats" USING btree ("site_id","minute");--> statement-breakpoint
CREATE INDEX "node_hour_stats_site_idx" ON "node_hour_stats" USING btree ("site_id","minute");--> statement-breakpoint
-- Backfill existing traffic before applying retention.
INSERT INTO stats_rollup_dirty (granularity, bucket, node_id, site_id)
SELECT DISTINCT 'hour', date_trunc('hour',minute,'UTC'), node_id, site_id FROM node_minute_stats
ON CONFLICT DO NOTHING;
--> statement-breakpoint
CREATE VIEW traffic_hour_stats AS
SELECT m.minute, m.node_id, m.site_id, m.requests, m.bytes_sent, m.bytes_received,
       m.cache_hits, m.cache_misses, m.status_codes, m.top_urls, m.top_ips
FROM node_minute_stats m
WHERE NOT EXISTS (
  SELECT 1 FROM node_hour_stats h
  WHERE h.minute = date_trunc('hour',m.minute,'UTC') AND h.node_id = m.node_id AND h.site_id = m.site_id
    AND NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
      AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id)
)
UNION ALL
SELECT h.minute, h.node_id, h.site_id, h.requests, h.bytes_sent, h.bytes_received,
       h.cache_hits, h.cache_misses, h.status_codes, h.top_urls, h.top_ips
FROM node_hour_stats h
WHERE NOT EXISTS (SELECT 1 FROM stats_rollup_dirty d WHERE d.granularity = 'hour'
  AND d.bucket = h.minute AND d.node_id = h.node_id AND d.site_id = h.site_id);
