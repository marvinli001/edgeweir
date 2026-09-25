CREATE TABLE "node_certificate_revocation" (
	"serial" text PRIMARY KEY NOT NULL,
	"node_id" uuid NOT NULL,
	"fingerprint_sha256" text DEFAULT '' NOT NULL,
	"reason" text DEFAULT '' NOT NULL,
	"revoked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" text PRIMARY KEY NOT NULL,
	"default_cluster_id" uuid,
	"require_two_factor" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "region" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "region_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "system_setting" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "target_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config_revision" ADD COLUMN "reason_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "config_revision" ADD COLUMN "reason_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_group" ADD COLUMN "region_id" uuid;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_default_cluster_id_cluster_id_fk" FOREIGN KEY ("default_cluster_id") REFERENCES "public"."cluster"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_group" ADD CONSTRAINT "node_group_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_action_idx" ON "audit_log" USING btree ("action","occurred_at");