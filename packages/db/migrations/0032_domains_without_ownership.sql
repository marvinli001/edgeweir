-- Domains route as soon as they are on a site: one operator owns every site,
-- so there are no ownership claims to prove. Unverified duplicates were
-- pending claims; the verified route (else the oldest claim) keeps the name.
DELETE FROM "site_domain" WHERE "id" IN (
  SELECT "id" FROM (
    SELECT "id", row_number() OVER (
      PARTITION BY "name", "wildcard" ORDER BY "verified" DESC, "created_at", "id"
    ) AS "rank"
    FROM "site_domain"
  ) AS "ranked"
  WHERE "rank" > 1
);--> statement-breakpoint
DROP TABLE "domain_ownership" CASCADE;--> statement-breakpoint
DROP INDEX "site_domain_name_uq";--> statement-breakpoint
ALTER TABLE "site_domain" DROP COLUMN "verified";--> statement-breakpoint
CREATE UNIQUE INDEX "site_domain_name_uq" ON "site_domain" USING btree ("name","wildcard");--> statement-breakpoint
DELETE FROM "system_setting" WHERE "key" IN ('domain_ownership_v1', 'dns_resolvers');
