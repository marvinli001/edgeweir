CREATE TABLE "site_usage_guard" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"period" text NOT NULL,
	"time_zone" text NOT NULL,
	"bytes_limit" numeric(38, 0),
	"requests_limit" numeric(38, 0),
	"bandwidth_bps" bigint,
	"warn_percent" integer,
	"action" text NOT NULL,
	"recovery" text NOT NULL,
	"bandwidth_hold_minutes" integer DEFAULT 30 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"period_start" timestamp with time zone,
	"period_end" timestamp with time zone,
	"warn_metrics" text[] DEFAULT '{}'::text[] NOT NULL,
	"limit_metrics" text[] DEFAULT '{}'::text[] NOT NULL,
	"bandwidth_peak_bps" bigint DEFAULT 0 NOT NULL,
	"bandwidth_breached_at" timestamp with time zone,
	"held_action" text,
	"held_metric" text,
	"held_since" timestamp with time zone,
	"paused_until" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"evaluated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_usage_guard" ADD CONSTRAINT "site_usage_guard_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_usage_site_window_idx" ON "site_usage" USING btree ("site_id","window_start");