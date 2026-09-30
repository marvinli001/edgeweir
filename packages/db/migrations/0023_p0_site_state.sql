ALTER TABLE "site" ADD COLUMN "suspended" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "suspend_reason" text;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "suspend_note" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "suspended_at" timestamp with time zone;