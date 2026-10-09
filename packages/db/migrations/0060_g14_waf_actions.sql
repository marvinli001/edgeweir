DROP INDEX "ip_ban_auto_uq";--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "rules_body_limit" integer DEFAULT 65536 NOT NULL;--> statement-breakpoint
ALTER TABLE "access_log" ADD COLUMN "rule_ids" text[] DEFAULT '{}' NOT NULL;--> statement-breakpoint
ALTER TABLE "site_protection" ADD COLUMN "allow_verified_bots" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_protection" ADD COLUMN "challenge_text" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "site_protection" ADD COLUMN "failure_ban_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "site_protection" ADD COLUMN "failure_threshold" integer DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_protection" ADD COLUMN "failure_ban_seconds" integer DEFAULT 600 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_waf" ADD COLUMN "exclusions" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "ip_ban_auto_uq" ON "ip_ban" USING btree ("node_id","site_id","cidr","source") WHERE "ip_ban"."source" in ('auto', 'rule') and "ip_ban"."removed_at" is null;--> statement-breakpoint
-- The site-wide exclusions become one exclusion without a path (ADR-0040).
UPDATE "site_waf" SET "exclusions" = jsonb_build_array(jsonb_build_object('path', '', 'exact', false, 'ruleIds', to_jsonb("excluded_rule_ids"), 'targets', '[]'::jsonb)) WHERE cardinality("excluded_rule_ids") > 0;--> statement-breakpoint
ALTER TABLE "site_waf" DROP COLUMN "excluded_rule_ids";
