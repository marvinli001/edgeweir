CREATE TABLE "edge_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid,
	"name" text NOT NULL,
	"phase" text NOT NULL,
	"expression" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"priority" integer NOT NULL,
	"action" jsonb NOT NULL,
	"list_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ip_list" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"name" text NOT NULL,
	"kind" text DEFAULT 'collection' NOT NULL,
	"entries" text[] DEFAULT '{}'::text[] NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edge_rule" ADD CONSTRAINT "edge_rule_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ip_list" ADD CONSTRAINT "ip_list_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "edge_rule_site_idx" ON "edge_rule" USING btree ("site_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_list_org_name_uq" ON "ip_list" USING btree ("organization_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_list_platform_name_uq" ON "ip_list" USING btree ("name") WHERE "ip_list"."organization_id" is null;