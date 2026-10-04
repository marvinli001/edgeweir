ALTER TABLE "origin_pool" ADD COLUMN "protocol" text DEFAULT 'http1' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "grpc" boolean DEFAULT false NOT NULL;