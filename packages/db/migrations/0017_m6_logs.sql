CREATE TABLE "access_log" (
	"time" timestamp with time zone NOT NULL,
	"id" text NOT NULL,
	"node_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"client_ip" text NOT NULL,
	"method" text NOT NULL,
	"host" text NOT NULL,
	"path" text NOT NULL,
	"status" integer NOT NULL,
	"bytes_sent" bigint NOT NULL,
	"duration_ms" integer NOT NULL,
	"cache_status" text NOT NULL,
	"sample_rate" integer NOT NULL,
	CONSTRAINT "access_log_time_id_pk" PRIMARY KEY("time","id")
) PARTITION BY RANGE ("time");
--> statement-breakpoint
CREATE TABLE "node_log_cursor" (
	"node_id" uuid PRIMARY KEY NOT NULL,
	"sequence" bigint DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "log_sample_rate" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD CONSTRAINT "access_log_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "node_log_cursor" ADD CONSTRAINT "node_log_cursor_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "access_log_site_time_idx" ON "access_log" USING btree ("site_id","time");