CREATE TABLE "site_error_page" (
	"site_id" uuid NOT NULL,
	"status" smallint NOT NULL,
	"template" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_error_page_site_id_status_pk" PRIMARY KEY("site_id","status")
);
--> statement-breakpoint
-- Rows from before G4 are passive checks; the column has to exist before the key covers it.
ALTER TABLE "origin_health" ADD COLUMN "source" text DEFAULT 'passive' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_health" DROP CONSTRAINT "origin_health_node_id_origin_id_pk";--> statement-breakpoint
ALTER TABLE "origin_health" ADD CONSTRAINT "origin_health_node_id_origin_id_source_pk" PRIMARY KEY("node_id","origin_id","source");--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "active_health_check" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "session_affinity" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "keep_cache_tag" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "intercept_origin_errors" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "error_pages_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "request_id" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_error_page" ADD CONSTRAINT "site_error_page_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;