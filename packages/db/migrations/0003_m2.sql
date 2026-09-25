CREATE TABLE "cache_task" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text,
	"type" text NOT NULL,
	"targets" text[] DEFAULT '{}'::text[] NOT NULL,
	"site_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"payload" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_by_user_id" text,
	"created_by_name" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "cache_task_node" (
	"task_id" uuid NOT NULL,
	"node_id" uuid NOT NULL,
	"cluster_id" uuid NOT NULL,
	"node_name" text DEFAULT '' NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"message" text DEFAULT '' NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"dispatched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "cache_task_node_task_id_node_id_pk" PRIMARY KEY("task_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "origin_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"access_key_id" text NOT NULL,
	"secret_envelope" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "origin_health" (
	"node_id" uuid NOT NULL,
	"origin_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	"healthy" boolean NOT NULL,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"last_failure_at" timestamp with time zone,
	"down_until" timestamp with time zone,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "origin_health_node_id_origin_id_pk" PRIMARY KEY("node_id","origin_id")
);
--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "paths" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "status_codes" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "min_size_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "max_size_bytes" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "stale_while_revalidate_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "stale_if_error_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "credential_id" uuid;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "s3_region" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "s3_bucket" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "tls_verify" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "max_fails" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "recovery_seconds" integer DEFAULT 30 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "connect_timeout_ms" integer DEFAULT 10000 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "send_timeout_ms" integer DEFAULT 60000 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "read_timeout_ms" integer DEFAULT 60000 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "keepalive" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "keepalive_idle_seconds" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "keepalive_max_requests" integer DEFAULT 1000 NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "cache_key" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "range_slice" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "websocket" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_task" ADD CONSTRAINT "cache_task_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_task" ADD CONSTRAINT "cache_task_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_task_node" ADD CONSTRAINT "cache_task_node_task_id_cache_task_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."cache_task"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cache_task_node" ADD CONSTRAINT "cache_task_node_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin_credential" ADD CONSTRAINT "origin_credential_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin_health" ADD CONSTRAINT "origin_health_node_id_node_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."node"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin_health" ADD CONSTRAINT "origin_health_origin_id_origin_id_fk" FOREIGN KEY ("origin_id") REFERENCES "public"."origin"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "origin_health" ADD CONSTRAINT "origin_health_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "cache_task_org_idx" ON "cache_task" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "cache_task_node_node_idx" ON "cache_task_node" USING btree ("node_id","state");--> statement-breakpoint
CREATE UNIQUE INDEX "origin_credential_site_key_uq" ON "origin_credential" USING btree ("site_id","access_key_id");--> statement-breakpoint
CREATE INDEX "origin_health_site_idx" ON "origin_health" USING btree ("site_id");--> statement-breakpoint
ALTER TABLE "origin" ADD CONSTRAINT "origin_credential_id_origin_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."origin_credential"("id") ON DELETE set null ON UPDATE no action;