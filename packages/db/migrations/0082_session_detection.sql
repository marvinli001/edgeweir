ALTER TABLE "node_day_stats" ADD COLUMN "bot_scores" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_hour_stats" ADD COLUMN "bot_scores" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "node_minute_stats" ADD COLUMN "bot_scores" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "session_detection" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "bot_score" integer DEFAULT 0 NOT NULL;