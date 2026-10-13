ALTER TABLE "site" ADD COLUMN "auth_identity_headers" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
-- The identity headers of the rules stored now, disabled ones included, in
-- the rules' order (those of rules deleted before cannot be known).
UPDATE "site" SET "auth_identity_headers" = "names"."headers"
FROM (
	SELECT "site_id", array_agg("name" ORDER BY "first", "name") AS "headers"
	FROM (
		SELECT "site_id", "name", min("ord") AS "first"
		FROM (
			SELECT "site_id", 'x-auth-user' AS "name", "position" * 100 AS "ord"
			FROM "site_auth_rule"
			WHERE "kind" = 'basic' AND "settings"->>'userHeader' = 'true'
			UNION ALL
			SELECT "r"."site_id", lower("h"."value"), "r"."position" * 100 + "h"."ordinality"
			FROM "site_auth_rule" AS "r",
				jsonb_array_elements_text(CASE WHEN jsonb_typeof("r"."settings"->'responseHeaders') = 'array' THEN "r"."settings"->'responseHeaders' ELSE '[]'::jsonb END) WITH ORDINALITY AS "h"("value", "ordinality")
			WHERE "r"."kind" = 'forward'
		) AS "all_names"
		GROUP BY "site_id", "name"
	) AS "unique_names"
	GROUP BY "site_id"
) AS "names"
WHERE "site"."id" = "names"."site_id";
