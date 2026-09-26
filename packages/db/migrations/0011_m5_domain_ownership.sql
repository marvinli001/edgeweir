CREATE TABLE "domain_ownership" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"method" text DEFAULT 'dns' NOT NULL,
	"verified_at" timestamp with time zone,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "site_domain_name_uq";--> statement-breakpoint
ALTER TABLE "site_domain" ADD COLUMN "verified" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "domain_ownership" ADD CONSTRAINT "domain_ownership_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "domain_ownership_org_uq" ON "domain_ownership" USING btree ("organization_id","domain");--> statement-breakpoint
CREATE UNIQUE INDEX "domain_ownership_verified_uq" ON "domain_ownership" USING btree ("domain") WHERE "domain_ownership"."verified_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_site_name_uq" ON "site_domain" USING btree ("site_id","name","wildcard");--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_name_uq" ON "site_domain" USING btree ("name","wildcard") WHERE "site_domain"."verified" = true;