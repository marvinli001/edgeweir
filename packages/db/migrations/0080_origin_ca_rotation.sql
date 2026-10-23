ALTER TABLE "pki_authority" ADD COLUMN "kind" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "pki_authority" ADD COLUMN "status" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "pki_authority" ADD COLUMN "generation" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_certificate" ADD COLUMN "authority_id" text DEFAULT 'origin-ca' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_client_certificate" ADD COLUMN "authority_id" text DEFAULT 'origin-client' NOT NULL;--> statement-breakpoint
-- Every authority so far is the first and only one of its kind, whose id is the kind.
UPDATE "pki_authority" SET "kind" = "id";--> statement-breakpoint
CREATE UNIQUE INDEX "pki_authority_kind_status_idx" ON "pki_authority" USING btree ("kind","status");