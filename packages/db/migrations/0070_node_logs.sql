CREATE TABLE "node_log_entry" (
	"node_id" uuid NOT NULL,
	"sequence" bigint NOT NULL,
	"idx" integer NOT NULL,
	"time" timestamp with time zone NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"kind" text DEFAULT 'entry' NOT NULL,
	"level" text NOT NULL,
	"source" text NOT NULL,
	"component" text DEFAULT '' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"fields" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"repeated" integer DEFAULT 0 NOT NULL,
	"truncated" boolean DEFAULT false NOT NULL,
	"event" text DEFAULT '' NOT NULL,
	"dropped_rate_limited" integer DEFAULT 0 NOT NULL,
	"dropped_overflow" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "node_log_entry_node_id_sequence_idx_pk" PRIMARY KEY("node_id","sequence","idx")
);
--> statement-breakpoint
CREATE TABLE "node_log_entry_cursor" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node_log_entry" ADD CONSTRAINT "node_log_entry_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_log_entry_cursor" ADD CONSTRAINT "node_log_entry_cursor_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "node_log_entry_node_time_idx" ON "node_log_entry" USING btree ("node_id","time","sequence","idx");--> statement-breakpoint
CREATE INDEX "node_log_entry_time_idx" ON "node_log_entry" USING btree ("time");