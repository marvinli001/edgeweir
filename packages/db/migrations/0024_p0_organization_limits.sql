CREATE TABLE "organization_limit" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"max_sites" integer,
	"max_domains" integer,
	"max_certificates" integer,
	"max_ip_list_entries" integer,
	"max_purge_tasks_per_minute" integer,
	"max_purge_urls_per_hour" integer,
	"max_members" integer,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "organization_limit" ADD CONSTRAINT "organization_limit_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;