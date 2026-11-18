CREATE TABLE "site_api_endpoint" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"method" text NOT NULL,
	"template" text NOT NULL,
	"path" text NOT NULL,
	"source" text NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"sampled_requests" bigint DEFAULT 0 NOT NULL,
	"violations" bigint DEFAULT 0 NOT NULL,
	"first_seen" timestamp with time zone NOT NULL,
	"last_seen" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "api_security" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "api_security" jsonb;--> statement-breakpoint
ALTER TABLE "site_api_endpoint" ADD CONSTRAINT "site_api_endpoint_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_api_endpoint_template_uq" ON "site_api_endpoint" USING btree ("site_id","method","template");--> statement-breakpoint
CREATE INDEX "site_api_endpoint_last_seen_idx" ON "site_api_endpoint" USING btree ("last_seen");