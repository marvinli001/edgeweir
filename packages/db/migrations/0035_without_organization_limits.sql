-- Technical limits were set per organization; one operator owns every resource.
UPDATE "service_account" SET "scopes" = array_remove(array_remove("scopes", 'limits:read'), 'limits:write');--> statement-breakpoint
DROP TABLE "organization_limit" CASCADE;
