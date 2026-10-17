CREATE TABLE "site_auto_mitigation" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"threshold" text NOT NULL,
	"duration_minutes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"active_since" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"trigger_level" text,
	"paused" boolean DEFAULT false NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"evaluated_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "site_auto_mitigation" ADD CONSTRAINT "site_auto_mitigation_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;