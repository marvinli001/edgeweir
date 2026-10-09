ALTER TABLE "site" ADD COLUMN "access_control" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "block_list_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "allow_list_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "access_control_updated_at" timestamp with time zone;