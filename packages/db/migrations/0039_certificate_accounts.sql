CREATE TABLE "acme_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"directory_url" text NOT NULL,
	"eab_kid" text DEFAULT '' NOT NULL,
	"email" text NOT NULL,
	"account_envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate" ADD COLUMN "renewal_info_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "acme_account_uq" ON "acme_account" USING btree ("directory_url","eab_kid","email");