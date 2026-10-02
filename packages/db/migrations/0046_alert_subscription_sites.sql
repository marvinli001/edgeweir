CREATE TABLE "alert_subscription_site" (
	"subscription_id" uuid NOT NULL,
	"site_id" uuid NOT NULL,
	CONSTRAINT "alert_subscription_site_subscription_id_site_id_pk" PRIMARY KEY("subscription_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "alert_subscription" ADD COLUMN "all_sites" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_subscription_site" ADD CONSTRAINT "alert_subscription_site_subscription_id_alert_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."alert_subscription"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "alert_subscription_site" ADD CONSTRAINT "alert_subscription_site_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alert_subscription_site_site_idx" ON "alert_subscription_site" USING btree ("site_id");--> statement-breakpoint
-- A subscription now covers a set of sites: the rows of one account and
-- channel (one per site so far) fold into one. When any of them is enabled,
-- the folded subscription is enabled and covers the sites and kinds of the
-- enabled rows (paused rows sent nothing); otherwise it stays paused with the
-- sites and kinds of all of them. Kinds are the union, so no alert that was
-- sent stops.
CREATE TEMP TABLE "subscription_fold" ON COMMIT DROP AS
  SELECT s."id", s."site_id", s."kinds", s."enabled",
    first_value(s."id") OVER w AS "keeper",
    bool_or(s."enabled") OVER w AS "any_enabled"
  FROM "alert_subscription" s
  WINDOW w AS (
    PARTITION BY s."user_id", s."channel_id" ORDER BY s."enabled" DESC, s."id"
    ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING
  );--> statement-breakpoint
DELETE FROM "subscription_fold" WHERE "any_enabled" AND NOT "enabled";--> statement-breakpoint
INSERT INTO "alert_subscription_site" ("subscription_id", "site_id")
  SELECT DISTINCT "keeper", "site_id" FROM "subscription_fold";--> statement-breakpoint
UPDATE "alert_subscription" s SET
  "kinds" = ARRAY(
    SELECT DISTINCT k FROM "subscription_fold" f, unnest(f."kinds") AS k
    WHERE f."keeper" = s."id" ORDER BY k
  ),
  "enabled" = EXISTS (SELECT 1 FROM "subscription_fold" f WHERE f."keeper" = s."id" AND f."enabled")
  WHERE s."id" IN (SELECT "keeper" FROM "subscription_fold");--> statement-breakpoint
DELETE FROM "alert_subscription" WHERE "id" NOT IN (SELECT "keeper" FROM "subscription_fold");--> statement-breakpoint
ALTER TABLE "alert_subscription" DROP CONSTRAINT "alert_subscription_site_id_site_id_fk";--> statement-breakpoint
DROP INDEX "alert_subscription_user_site_channel_uq";--> statement-breakpoint
ALTER TABLE "alert_subscription" DROP COLUMN "site_id";--> statement-breakpoint
CREATE UNIQUE INDEX "alert_subscription_user_channel_uq" ON "alert_subscription" USING btree ("user_id","channel_id");
