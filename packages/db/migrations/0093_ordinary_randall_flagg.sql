ALTER TABLE "site_usage" DROP CONSTRAINT "site_usage_window_start_site_id_pk";--> statement-breakpoint
ALTER TABLE "site_usage" ADD COLUMN "resource_kind" text DEFAULT 'site' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_usage" ADD CONSTRAINT "site_usage_window_start_site_id_resource_kind_pk" PRIMARY KEY("window_start","site_id","resource_kind");--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "traffic_limit" jsonb;
--> statement-breakpoint
INSERT INTO site_usage(window_start,site_id,resource_kind,requests,bytes_sent,bytes_received,revision,seq,updated_at)
SELECT date_bin(interval '5 minutes',minute,timestamptz 'epoch'),app_id,'l4',sum(connections),sum(bytes_sent),sum(bytes_received),1,nextval('site_usage_seq'),now()
FROM l4_minute_stats GROUP BY 1,app_id ON CONFLICT DO NOTHING;
