ALTER TABLE "cache_rule" ADD COLUMN "cache_authorized" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_task" ADD COLUMN "source" text DEFAULT 'user' NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_task_node" ADD COLUMN "error_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_task_node" ADD COLUMN "error_params" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_task_node" ADD COLUMN "recovered_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "origin_health" ADD COLUMN "last_error_code" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_health" ADD COLUMN "last_error_params" jsonb DEFAULT '{}'::jsonb NOT NULL;