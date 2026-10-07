CREATE TABLE "site_secret" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"secret_envelope" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "cache_set_cookie" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster" ADD COLUMN "cache_max_size_gb" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster" ADD COLUMN "cache_inactive_days" integer DEFAULT 7 NOT NULL;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "cache_max_size_gb" integer;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "cache_usage" jsonb;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "tries" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "status_retry" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "hide_x_cache" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "purge_method" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "maintenance" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "maintenance_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "charset" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "request_body_limit" bigint DEFAULT 104857600 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_error_page" ADD COLUMN "redirect_url" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_error_page" ADD COLUMN "response_status" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_secret" ADD CONSTRAINT "site_secret_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_secret_site_kind_uq" ON "site_secret" USING btree ("site_id","kind");