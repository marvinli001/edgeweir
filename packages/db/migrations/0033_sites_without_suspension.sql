-- Suspension was the platform's switch over a tenant's site; one operator only
-- needs `enabled`. Suspended sites stay dark as disabled sites.
UPDATE "site" SET "enabled" = false WHERE "suspended";--> statement-breakpoint
UPDATE "service_account" SET "scopes" = array_remove("scopes", 'sites:suspend');--> statement-breakpoint
ALTER TABLE "site" DROP COLUMN "suspended";--> statement-breakpoint
ALTER TABLE "site" DROP COLUMN "suspend_reason";--> statement-breakpoint
ALTER TABLE "site" DROP COLUMN "suspend_note";--> statement-breakpoint
ALTER TABLE "site" DROP COLUMN "suspended_at";
