CREATE TABLE "dns_binding" (
	"cluster_id" uuid PRIMARY KEY NOT NULL,
	"mode" text DEFAULT 'off' NOT NULL,
	"provider_id" uuid,
	"domain" text DEFAULT '' NOT NULL,
	"ttl" integer DEFAULT 600 NOT NULL,
	"lines" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"all_label" text DEFAULT 'all' NOT NULL,
	"line_aliases" boolean DEFAULT false NOT NULL,
	"desired_revision" bigint,
	"applied_revision" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE TABLE "dns_lease" (
	"key" text PRIMARY KEY NOT NULL,
	"holder" uuid NOT NULL,
	"until" timestamp with time zone NOT NULL
);--> statement-breakpoint
ALTER TABLE "dns_revision" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "dns_managed_name" ADD COLUMN "cluster_id" uuid;--> statement-breakpoint
ALTER TABLE "dns_binding" ADD CONSTRAINT "dns_binding_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_binding" ADD CONSTRAINT "dns_binding_provider_id_platform_dns_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_dns_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
-- Data: the platform-wide DNS policy becomes one binding per cluster. Every
-- cluster keeps the former CNAME suffix as its domain, so existing site
-- targets (<site id>.<suffix>) keep their names; clusters that share it get
-- distinct labels for their all-lines record (all, all-2, ...), clusters with
-- sites first. An enabled policy keeps the per-site line targets
-- (<line>.<site id>.<suffix>) as aliases.
WITH p AS (
	SELECT
		coalesce((policy->>'enabled')::boolean, false) AS enabled,
		(SELECT id FROM "platform_dns_provider" WHERE id::text = policy->>'providerId') AS provider_id,
		coalesce(policy->>'cnameSuffix', '') AS domain,
		coalesce((policy->>'ttl')::int, 600) AS ttl,
		CASE WHEN jsonb_typeof(policy->'lines') = 'array' THEN policy->'lines' ELSE '[]'::jsonb END AS lines
	FROM "dns_state" WHERE id = 1
), c AS (
	SELECT cl.id, row_number() OVER (
		ORDER BY EXISTS (SELECT 1 FROM "site" s WHERE s.cluster_id = cl.id) DESC, cl.created_at, cl.id
	) AS n
	FROM "cluster" cl
)
INSERT INTO "dns_binding" ("cluster_id", "mode", "provider_id", "domain", "ttl", "lines", "all_label", "line_aliases")
SELECT
	c.id,
	CASE WHEN p.enabled AND p.provider_id IS NOT NULL AND p.domain <> '' THEN 'auto' ELSE 'off' END,
	p.provider_id,
	p.domain,
	p.ttl,
	coalesce((
		SELECT jsonb_agg(e.line ORDER BY e.ord)
		FROM jsonb_array_elements(p.lines) WITH ORDINALITY AS e(line, ord)
		JOIN "node_group" g ON g.id::text = e.line->>'nodeGroupId'
		WHERE g.cluster_id = c.id
	), '[]'::jsonb),
	CASE
		WHEN c.n = 1 THEN 'all'
		WHEN EXISTS (SELECT 1 FROM jsonb_array_elements(p.lines) l WHERE l->>'name' = 'all-' || c.n)
			THEN 'all-' || c.n || '-' || substr(c.id::text, 1, 8)
		ELSE 'all-' || c.n
	END,
	p.enabled
FROM c CROSS JOIN p
WHERE p.domain <> '';--> statement-breakpoint
-- Managed names belong to the binding of the site they name; names of
-- deleted sites to the first cluster using that account, then to the first
-- cluster. The owning binding's reconciliation removes what it no longer plans.
UPDATE "dns_managed_name" m SET "cluster_id" = s.cluster_id
FROM "site" s
WHERE m.cluster_id IS NULL
	AND s.id::text = substring(m.name from '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})');--> statement-breakpoint
UPDATE "dns_managed_name" m SET "cluster_id" = (
	SELECT b.cluster_id FROM "dns_binding" b JOIN "cluster" c ON c.id = b.cluster_id
	WHERE b.provider_id = m.provider_id ORDER BY c.created_at, c.id LIMIT 1
) WHERE m.cluster_id IS NULL;--> statement-breakpoint
UPDATE "dns_managed_name" SET "cluster_id" = (SELECT id FROM "cluster" ORDER BY created_at, id LIMIT 1)
WHERE "cluster_id" IS NULL;--> statement-breakpoint
DELETE FROM "dns_managed_name" WHERE "cluster_id" IS NULL;--> statement-breakpoint
ALTER TABLE "dns_managed_name" ALTER COLUMN "cluster_id" SET NOT NULL;--> statement-breakpoint
-- Revisions of the platform-wide policy stay as history (cluster_id null).
UPDATE "dns_revision" SET "status" = 'superseded' WHERE "status" IN ('pending', 'blocked');--> statement-breakpoint
INSERT INTO "alert_event" ("site_id", "kind", "resource_id", "status", "payload")
SELECT NULL, "kind", "resource_id", 'resolved', '{"siteName":"DNS","domain":""}'::jsonb
FROM "alert_state" WHERE "key" = 'dns_mass_removal_blocked/platform/dns' AND "active";--> statement-breakpoint
UPDATE "alert_state" SET "active" = false, "updated_at" = now()
WHERE "key" = 'dns_mass_removal_blocked/platform/dns' AND "active";--> statement-breakpoint
ALTER TABLE "dns_state" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "dns_state" CASCADE;--> statement-breakpoint
ALTER TABLE "dns_managed_name" ADD CONSTRAINT "dns_managed_name_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_revision" ADD CONSTRAINT "dns_revision_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_managed_name_cluster_idx" ON "dns_managed_name" USING btree ("cluster_id");--> statement-breakpoint
CREATE INDEX "dns_revision_cluster_idx" ON "dns_revision" USING btree ("cluster_id","revision");
