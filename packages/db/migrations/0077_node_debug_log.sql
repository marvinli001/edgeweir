CREATE TABLE "node_debug_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"node_id" uuid NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"since" timestamp with time zone,
	"until" timestamp with time zone,
	"components" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deadline_at" timestamp with time zone NOT NULL,
	"lease_until" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"error_code" text DEFAULT '' NOT NULL,
	"error_params" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"entries" jsonb,
	"entry_count" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"buffer_since" timestamp with time zone,
	"overwritten" bigint DEFAULT 0 NOT NULL,
	"supervisor_missing" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_debug_log" ADD CONSTRAINT "node_debug_log_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_debug_log_node_idx" ON "node_debug_log" USING btree ("node_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "node_debug_log_open_uq" ON "node_debug_log" USING btree ("node_id") WHERE "node_debug_log"."state" in ('pending', 'running');