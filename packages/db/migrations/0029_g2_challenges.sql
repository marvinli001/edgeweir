CREATE TABLE "challenge_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"role" text NOT NULL,
	"secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "security_event" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid,
	"node_event_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text NOT NULL,
	"level" text DEFAULT '' NOT NULL,
	"previous_level" text DEFAULT '' NOT NULL,
	"path" text DEFAULT '' NOT NULL,
	"address" text DEFAULT '' NOT NULL,
	"metric" text DEFAULT '' NOT NULL,
	"observed" double precision DEFAULT 0 NOT NULL,
	"threshold" double precision DEFAULT 0 NOT NULL,
	"top_ips" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"top_paths" jsonb DEFAULT '[]'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "site_protection" (
	"site_id" uuid PRIMARY KEY NOT NULL,
	"under_attack" boolean DEFAULT false NOT NULL,
	"under_attack_challenge" text DEFAULT 'js' NOT NULL,
	"pass_ttl_seconds" integer DEFAULT 1800 NOT NULL,
	"pow_difficulty" integer DEFAULT 16 NOT NULL,
	"pow_high_difficulty" integer DEFAULT 20 NOT NULL,
	"cc" jsonb,
	"log_ja4" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "security_state" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "ja4" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "challenge_key" ADD CONSTRAINT "challenge_key_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "security_event" ADD CONSTRAINT "security_event_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_protection" ADD CONSTRAINT "site_protection_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "challenge_key_cluster_role_uq" ON "challenge_key" USING btree ("cluster_id","role");--> statement-breakpoint
CREATE UNIQUE INDEX "security_event_node_event_uq" ON "security_event" USING btree ("node_id","node_event_id");--> statement-breakpoint
CREATE INDEX "security_event_site_time_idx" ON "security_event" USING btree ("site_id","occurred_at");--> statement-breakpoint
CREATE INDEX "security_event_time_idx" ON "security_event" USING btree ("occurred_at");