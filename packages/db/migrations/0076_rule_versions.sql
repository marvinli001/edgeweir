CREATE TABLE "edge_rule_version" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"rule_id" uuid NOT NULL,
	"site_id" uuid,
	"version" integer NOT NULL,
	"change" text NOT NULL,
	"source" text NOT NULL,
	"restored_from" integer,
	"rule" jsonb NOT NULL,
	"actor_type" text DEFAULT '' NOT NULL,
	"actor_id" text DEFAULT '' NOT NULL,
	"actor_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "edge_rule_version" ADD CONSTRAINT "edge_rule_version_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "edge_rule_version_rule_uq" ON "edge_rule_version" USING btree ("rule_id","version");--> statement-breakpoint
CREATE INDEX "edge_rule_version_site_idx" ON "edge_rule_version" USING btree ("site_id","created_at");--> statement-breakpoint
INSERT INTO "edge_rule_version" ("rule_id", "site_id", "version", "change", "source", "rule", "actor_type", "actor_name")
SELECT "id", "site_id", 1, 'created', 'initial',
	jsonb_build_object('name', "name", 'phase', "phase", 'expression', "expression", 'enabled', "enabled", 'action', "action"),
	'system', 'system'
FROM "edge_rule";
