-- One operator, one account: the console has no organizations, members,
-- invitations or other accounts any more. Data of every organization stays
-- and belongs to the operator.

-- The earliest platform administrator who is not disabled keeps the console.
CREATE TEMP TABLE "operator" ON COMMIT DROP AS
  SELECT "id" FROM "user"
  ORDER BY coalesce("role", '') ~ '(^|,)\s*admin\s*($|,)' DESC, coalesce("banned", false), "created_at", "id"
  LIMIT 1;--> statement-breakpoint
UPDATE "user" SET "role" = 'admin', "banned" = false, "ban_reason" = NULL, "ban_expires" = NULL
  WHERE "id" IN (SELECT "id" FROM "operator");--> statement-breakpoint
-- Alert subscriptions of the other accounts move to the operator: one per site
-- and channel, with every kind any of them had.
INSERT INTO "alert_subscription" ("user_id", "organization_id", "site_id", "channel_id", "kinds", "enabled")
  SELECT o."id", min(s."organization_id"), s."site_id", s."channel_id",
    ARRAY(
      SELECT DISTINCT k FROM "alert_subscription" x, unnest(x."kinds") AS k
      WHERE x."site_id" = s."site_id" AND x."channel_id" = s."channel_id" ORDER BY k
    ),
    bool_or(s."enabled")
  FROM "alert_subscription" s CROSS JOIN "operator" o
  GROUP BY o."id", s."site_id", s."channel_id"
  ON CONFLICT ("user_id", "site_id", "channel_id")
    DO UPDATE SET "kinds" = excluded."kinds", "enabled" = excluded."enabled";--> statement-breakpoint
DELETE FROM "apikey" WHERE "reference_id" NOT IN (SELECT "id" FROM "operator");--> statement-breakpoint
DELETE FROM "user" WHERE "id" NOT IN (SELECT "id" FROM "operator");--> statement-breakpoint

-- IP lists share one namespace. Lists of organizations had no effect of their
-- own at the edge (only platform allow and block lists apply everywhere), so
-- they stay collections. Platform lists keep their names; an organization
-- list whose name is taken gets a suffix, and the rules of that
-- organization's sites that use it follow the new name.
UPDATE "ip_list" SET "kind" = 'collection' WHERE "organization_id" IS NOT NULL;--> statement-breakpoint
CREATE TEMP TABLE "ip_list_rename" ON COMMIT DROP AS
  SELECT "id", "organization_id", "name" AS "old_name",
    left("name", 57) || '_' || left(md5("id"::text), 6) AS "new_name"
  FROM (
    SELECT *, row_number() OVER (PARTITION BY "name" ORDER BY "organization_id" NULLS FIRST, "id") AS "rank"
    FROM "ip_list"
  ) AS "ranked"
  WHERE "rank" > 1;--> statement-breakpoint
UPDATE "ip_list" l SET "name" = r."new_name" FROM "ip_list_rename" r WHERE l."id" = r."id";--> statement-breakpoint
DO $$
DECLARE
  renamed record;
BEGIN
  FOR renamed IN SELECT * FROM "ip_list_rename" LOOP
    UPDATE "edge_rule" e
      SET "expression" = regexp_replace(
        e."expression", '\$' || renamed."old_name" || '(?![A-Za-z0-9_])', '$' || renamed."new_name", 'g'
      )
      FROM "site" s
      WHERE e."site_id" = s."id"
        AND s."organization_id" = renamed."organization_id"
        AND renamed."id" = ANY(e."list_ids");
  END LOOP;
END $$;--> statement-breakpoint

UPDATE "service_account" SET "scopes" = ARRAY(
  SELECT scope FROM unnest("scopes") AS scope
  WHERE scope NOT IN ('organizations:read', 'organizations:write', 'members:read', 'invitations:write')
);--> statement-breakpoint
-- Whether tenants may turn on OWASP CRS.
DELETE FROM "system_setting" WHERE "key" = 'waf_settings';--> statement-breakpoint

ALTER TABLE "alert_subscription" DROP CONSTRAINT "alert_subscription_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "ip_ban" DROP CONSTRAINT "ip_ban_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "certificate" DROP CONSTRAINT "certificate_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "dns_credential" DROP CONSTRAINT "dns_credential_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "cache_task" DROP CONSTRAINT "cache_task_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "site" DROP CONSTRAINT "site_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "security_event" DROP CONSTRAINT "security_event_organization_id_organization_id_fk";--> statement-breakpoint
ALTER TABLE "ip_list" DROP CONSTRAINT "ip_list_organization_id_organization_id_fk";--> statement-breakpoint
DROP INDEX "site_usage_org_idx";--> statement-breakpoint
DROP INDEX "ip_ban_org_idx";--> statement-breakpoint
DROP INDEX "certificate_org_idx";--> statement-breakpoint
DROP INDEX "audit_log_org_idx";--> statement-breakpoint
DROP INDEX "cache_task_org_idx";--> statement-breakpoint
DROP INDEX "site_org_idx";--> statement-breakpoint
DROP INDEX "ip_list_org_name_uq";--> statement-breakpoint
DROP INDEX "ip_list_platform_name_uq";--> statement-breakpoint
ALTER TABLE "alert_channel" DROP COLUMN "available_to_tenants";--> statement-breakpoint
ALTER TABLE "alert_subscription" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "site_usage" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "session" DROP COLUMN "active_organization_id";--> statement-breakpoint
ALTER TABLE "ip_ban" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "certificate" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "dns_credential" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "audit_log" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "cache_task" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "site" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "security_event" DROP COLUMN "organization_id";--> statement-breakpoint
ALTER TABLE "ip_list" DROP COLUMN "organization_id";--> statement-breakpoint
DROP TABLE "invitation";--> statement-breakpoint
DROP TABLE "member";--> statement-breakpoint
DROP TABLE "organization_settings";--> statement-breakpoint
DROP TABLE "organization";--> statement-breakpoint
CREATE INDEX "ip_ban_created_idx" ON "ip_ban" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "cache_task_created_idx" ON "cache_task" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ip_list_name_uq" ON "ip_list" USING btree ("name");
