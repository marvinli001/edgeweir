ALTER TABLE "node" ADD COLUMN "clock_offset_ms" integer;--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "clock_measured_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dns_binding" ADD COLUMN "failing_since" timestamp with time zone;