CREATE TABLE "node_address_state" (
	"node_id" uuid NOT NULL,
	"address" text NOT NULL,
	"down" boolean DEFAULT false NOT NULL,
	"failing_since" timestamp with time zone,
	"answering_since" timestamp with time zone,
	"changed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "node_address_state_node_id_address_pk" PRIMARY KEY("node_id","address")
);
--> statement-breakpoint
CREATE TABLE "probe" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"region_id" uuid NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"hostname" text DEFAULT '' NOT NULL,
	"agent_version" text DEFAULT '' NOT NULL,
	"os" text DEFAULT '' NOT NULL,
	"arch" text DEFAULT '' NOT NULL,
	"cert_serial" text,
	"cert_fingerprint" text,
	"cert_not_after" timestamp with time zone,
	"previous_cert_serial" text,
	"enrolled_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "probe_result" (
	"prober_kind" text NOT NULL,
	"prober_id" uuid NOT NULL,
	"region_id" uuid,
	"node_id" uuid NOT NULL,
	"address" text NOT NULL,
	"port" integer NOT NULL,
	"method" text NOT NULL,
	"sent" integer NOT NULL,
	"lost" integer NOT NULL,
	"rtt_ms" integer DEFAULT 0 NOT NULL,
	"error" text DEFAULT '' NOT NULL,
	"checked_at" timestamp with time zone NOT NULL,
	CONSTRAINT "probe_result_prober_id_node_id_address_port_pk" PRIMARY KEY("prober_id","node_id","address","port")
);
--> statement-breakpoint
CREATE TABLE "probe_token" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"token_hash" text NOT NULL,
	"token_prefix" text NOT NULL,
	"name" text NOT NULL,
	"region_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"used_at" timestamp with time zone,
	"used_by_probe_id" uuid,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "probe_token_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "scheduling_rule" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"line_name" text,
	"name" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"match" text DEFAULT 'all' NOT NULL,
	"conditions" jsonb NOT NULL,
	"action" text NOT NULL,
	"hold_seconds" integer DEFAULT 300 NOT NULL,
	"recover_seconds" integer DEFAULT 300 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduling_state" (
	"rule_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"condition_since" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"active_since" timestamp with time zone,
	"clear_since" timestamp with time zone,
	"evaluated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "scheduling_state_rule_id_node_id_pk" PRIMARY KEY("rule_id","node_id")
);
--> statement-breakpoint
DROP INDEX "node_ip_node_address_uq";--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "metrics" jsonb;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "probe_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "node_ip" ADD COLUMN "source" text DEFAULT 'reported' NOT NULL;--> statement-breakpoint
ALTER TABLE "node_ip" ADD COLUMN "level" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "dns_revision" ADD COLUMN "reason_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_address_state" ADD CONSTRAINT "node_address_state_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe" ADD CONSTRAINT "probe_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_result" ADD CONSTRAINT "probe_result_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_token" ADD CONSTRAINT "probe_token_region_id_region_id_fk" FOREIGN KEY ("region_id") REFERENCES "public"."region"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_token" ADD CONSTRAINT "probe_token_used_by_probe_id_probe_id_fk" FOREIGN KEY ("used_by_probe_id") REFERENCES "public"."probe"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "probe_token" ADD CONSTRAINT "probe_token_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_rule" ADD CONSTRAINT "scheduling_rule_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_state" ADD CONSTRAINT "scheduling_state_rule_id_scheduling_rule_id_fk" FOREIGN KEY ("rule_id") REFERENCES "public"."scheduling_rule"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scheduling_state" ADD CONSTRAINT "scheduling_state_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "probe_result_node_idx" ON "probe_result" USING btree ("node_id","checked_at");--> statement-breakpoint
CREATE INDEX "scheduling_rule_cluster_idx" ON "scheduling_rule" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "scheduling_state_node_idx" ON "scheduling_state" USING btree ("node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "node_ip_node_source_address_uq" ON "node_ip" USING btree ("node_id","source","address");