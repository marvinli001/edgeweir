-- Site domain forms (G10): `kind` (exact | wildcard | suffix | regex)
-- replaces the wildcard flag; a domain (name and form) belongs to one site.
DROP INDEX "site_domain_name_uq";--> statement-breakpoint
DROP INDEX "site_domain_site_name_uq";--> statement-breakpoint
ALTER TABLE "site_domain" ADD COLUMN "kind" text DEFAULT 'exact' NOT NULL;--> statement-breakpoint
UPDATE "site_domain" SET "kind" = 'wildcard' WHERE "wildcard";--> statement-breakpoint
ALTER TABLE "site_domain" DROP COLUMN "wildcard";--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_name_uq" ON "site_domain" USING btree ("name","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_site_name_uq" ON "site_domain" USING btree ("site_id","name","kind");--> statement-breakpoint
-- CNAME prefixes: existing sites and layer-4 applications keep their id, so
-- their CNAME names do not change.
ALTER TABLE "site" ADD COLUMN "cname_prefix" text;--> statement-breakpoint
UPDATE "site" SET "cname_prefix" = "id"::text;--> statement-breakpoint
ALTER TABLE "site" ALTER COLUMN "cname_prefix" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "l4_app" ADD COLUMN "cname_prefix" text;--> statement-breakpoint
UPDATE "l4_app" SET "cname_prefix" = "id"::text;--> statement-breakpoint
ALTER TABLE "l4_app" ALTER COLUMN "cname_prefix" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "site_cname_prefix_uq" ON "site" USING btree ("cname_prefix");--> statement-breakpoint
CREATE UNIQUE INDEX "l4_app_cname_prefix_uq" ON "l4_app" USING btree ("cname_prefix");--> statement-breakpoint
CREATE TABLE "cname_retired" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"site_id" uuid,
	"l4_app_id" uuid,
	"prefix" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cname_retired" ADD CONSTRAINT "cname_retired_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cname_retired" ADD CONSTRAINT "cname_retired_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cname_retired" ADD CONSTRAINT "cname_retired_l4_app_id_l4_app_id_fk" FOREIGN KEY ("l4_app_id") REFERENCES "public"."l4_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "cname_retired_prefix_uq" ON "cname_retired" USING btree ("prefix");--> statement-breakpoint
CREATE INDEX "cname_retired_cluster_idx" ON "cname_retired" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "cname_retired_expires_idx" ON "cname_retired" USING btree ("expires_at");--> statement-breakpoint
-- Unknown hosts and node IP access (G10): null keeps the platform's page.
ALTER TABLE "cluster" ADD COLUMN "unknown_hosts" jsonb;--> statement-breakpoint
ALTER TABLE "cluster" ADD COLUMN "default_site_id" uuid;--> statement-breakpoint
ALTER TABLE "cluster" ADD CONSTRAINT "cluster_default_site_id_site_id_fk" FOREIGN KEY ("default_site_id") REFERENCES "public"."site"("id") ON DELETE set null ON UPDATE no action;
