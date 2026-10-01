CREATE TABLE "cluster_port_pool" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"protocol" text NOT NULL,
	"port_from" integer NOT NULL,
	"port_to" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "l4_app" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"port" integer NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"accept_proxy_protocol" boolean DEFAULT false NOT NULL,
	"proxy_protocol_version" integer DEFAULT 0 NOT NULL,
	"max_fails" integer DEFAULT 3 NOT NULL,
	"fail_timeout_seconds" integer DEFAULT 30 NOT NULL,
	"connect_timeout_ms" integer DEFAULT 5000 NOT NULL,
	"idle_timeout_seconds" integer DEFAULT 600 NOT NULL,
	"allow_list_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"block_list_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"max_connections" integer DEFAULT 0 NOT NULL,
	"new_connections_per_second" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "l4_minute_stats" (
	"minute" timestamp with time zone NOT NULL,
	"node_id" uuid NOT NULL,
	"app_id" uuid NOT NULL,
	"connections" bigint DEFAULT 0 NOT NULL,
	"refused" bigint DEFAULT 0 NOT NULL,
	"peak_concurrent" bigint DEFAULT 0 NOT NULL,
	"bytes_received" bigint DEFAULT 0 NOT NULL,
	"bytes_sent" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "l4_minute_stats_minute_node_id_app_id_pk" PRIMARY KEY("minute","node_id","app_id")
);
--> statement-breakpoint
CREATE TABLE "l4_origin" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"app_id" uuid NOT NULL,
	"address" text NOT NULL,
	"port" integer NOT NULL,
	"weight" integer DEFAULT 1 NOT NULL,
	"backup" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cluster_port_pool" ADD CONSTRAINT "cluster_port_pool_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l4_app" ADD CONSTRAINT "l4_app_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l4_minute_stats" ADD CONSTRAINT "l4_minute_stats_app_id_l4_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."l4_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "l4_origin" ADD CONSTRAINT "l4_origin_app_id_l4_app_id_fk" FOREIGN KEY ("app_id") REFERENCES "public"."l4_app"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cluster_port_pool_cluster_idx" ON "cluster_port_pool" USING btree ("cluster_id");--> statement-breakpoint
CREATE UNIQUE INDEX "l4_app_cluster_protocol_port_uq" ON "l4_app" USING btree ("cluster_id","protocol","port");--> statement-breakpoint
CREATE INDEX "l4_minute_stats_app_idx" ON "l4_minute_stats" USING btree ("app_id","minute");--> statement-breakpoint
CREATE INDEX "l4_origin_app_idx" ON "l4_origin" USING btree ("app_id");