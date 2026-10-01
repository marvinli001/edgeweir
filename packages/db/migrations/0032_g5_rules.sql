CREATE TABLE "bulk_redirect" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"site_id" uuid NOT NULL,
	"source" text NOT NULL,
	"target" text NOT NULL,
	"status_code" integer DEFAULT 301 NOT NULL,
	"preserve_query" boolean DEFAULT false NOT NULL,
	"position" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "list_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cache_rule" ADD COLUMN "browser_ttl_seconds" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin" ADD COLUMN "group_name" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "bulk_redirect" ADD CONSTRAINT "bulk_redirect_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "bulk_redirect_site_source_uq" ON "bulk_redirect" USING btree ("site_id","source");--> statement-breakpoint
-- Cache rules become expressions (ADR-0028): the structured condition of every existing rule is
-- rewritten as exactly what cacheConditionExpression (@edgeweir/rule-engine) builds from it, with
-- strings quoted by to_json (the JSON escaping the parser reads), and the lists are cleared.
UPDATE "cache_rule" SET
	"expression" = coalesce(nullif(concat_ws(' and ',
		CASE
			WHEN cardinality("path_prefixes") = 0 THEN NULL
			WHEN cardinality("path_prefixes") = 1 THEN
				'starts_with(http.request.uri.path, ' || to_json("path_prefixes"[1])::text || ')'
			ELSE '(' || (
				SELECT string_agg('starts_with(http.request.uri.path, ' || to_json(p.v)::text || ')', ' or ' ORDER BY p.i)
				FROM unnest("path_prefixes") WITH ORDINALITY AS p(v, i)
			) || ')'
		END,
		CASE WHEN cardinality("paths") = 0 THEN NULL ELSE
			'http.request.uri.path in {' || (
				SELECT string_agg(to_json(p.v)::text, ' ' ORDER BY p.i)
				FROM unnest("paths") WITH ORDINALITY AS p(v, i)
			) || '}'
		END,
		CASE WHEN cardinality("extensions") = 0 THEN NULL ELSE
			'http.request.uri.path.extension in {' || (
				SELECT string_agg(to_json(e.v)::text, ' ' ORDER BY e.i)
				FROM unnest("extensions") WITH ORDINALITY AS e(v, i)
			) || '}'
		END
	), ''), 'true'),
	"path_prefixes" = '{}',
	"paths" = '{}',
	"extensions" = '{}'
WHERE "expression" = '';
