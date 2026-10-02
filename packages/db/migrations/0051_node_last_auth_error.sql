ALTER TABLE "node" ADD COLUMN "last_auth_error" text;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "last_auth_error_at" timestamp with time zone;