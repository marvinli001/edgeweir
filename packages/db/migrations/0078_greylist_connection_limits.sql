DROP INDEX "ip_ban_site_manual_uq";--> statement-breakpoint
DROP INDEX "ip_ban_platform_uq";--> statement-breakpoint
ALTER TABLE "ip_ban" ADD COLUMN "action" text DEFAULT 'block' NOT NULL;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD COLUMN "challenge" text;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD COLUMN "rate_limit_requests" integer;--> statement-breakpoint
ALTER TABLE "ip_ban" ADD COLUMN "rate_limit_window_seconds" integer;--> statement-breakpoint
ALTER TABLE "cluster" ADD COLUMN "connection_limits" jsonb;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_site_grey_uq" ON "ip_ban" USING btree ("site_id","cidr") WHERE "ip_ban"."scope" = 'site' and "ip_ban"."action" <> 'block' and "ip_ban"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_platform_grey_uq" ON "ip_ban" USING btree ("cidr") WHERE "ip_ban"."scope" = 'platform' and "ip_ban"."action" <> 'block' and "ip_ban"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_site_manual_uq" ON "ip_ban" USING btree ("site_id","cidr") WHERE "ip_ban"."scope" = 'site' and "ip_ban"."source" = 'manual' and "ip_ban"."action" = 'block' and "ip_ban"."removed_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_platform_uq" ON "ip_ban" USING btree ("cidr") WHERE "ip_ban"."scope" = 'platform' and "ip_ban"."action" = 'block' and "ip_ban"."removed_at" is null;