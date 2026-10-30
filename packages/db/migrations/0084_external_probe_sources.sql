CREATE TABLE "external_probe_mapping" (
	"source_id" uuid NOT NULL,
	"monitor_id" text NOT NULL,
	"monitor_name" text DEFAULT '' NOT NULL,
	"node_id" uuid NOT NULL,
	"address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "external_probe_mapping_source_id_monitor_id_pk" PRIMARY KEY("source_id","monitor_id")
);
--> statement-breakpoint
CREATE TABLE "external_probe_observation" (
	"source_id" uuid NOT NULL,
	"monitor_id" text NOT NULL,
	"location" text DEFAULT '' NOT NULL,
	"sent" integer NOT NULL,
	"lost" integer NOT NULL,
	"rtt_ms" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	CONSTRAINT "external_probe_observation_source_id_monitor_id_location_pk" PRIMARY KEY("source_id","monitor_id","location")
);
--> statement-breakpoint
CREATE TABLE "external_probe_source" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"credential_envelope" text,
	"webhook_secret_envelope" text,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"poll_interval_seconds" integer DEFAULT 60 NOT NULL,
	"stale_after_seconds" integer DEFAULT 300 NOT NULL,
	"last_poll_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_delivery_at" timestamp with time zone,
	"last_error_at" timestamp with time zone,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster" ADD COLUMN "probe_mode" text;--> statement-breakpoint
ALTER TABLE "external_probe_mapping" ADD CONSTRAINT "external_probe_mapping_source_id_external_probe_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."external_probe_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_probe_mapping" ADD CONSTRAINT "external_probe_mapping_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_probe_observation" ADD CONSTRAINT "external_probe_observation_source_id_external_probe_source_id_fk" FOREIGN KEY ("source_id") REFERENCES "public"."external_probe_source"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "external_probe_mapping_node_idx" ON "external_probe_mapping" USING btree ("node_id");