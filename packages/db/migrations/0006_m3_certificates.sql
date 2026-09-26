CREATE TABLE "acme_challenge" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certificate_id" uuid NOT NULL,
	"domain" text NOT NULL,
	"token" text NOT NULL,
	"key_authorization" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"names" text[] DEFAULT '{}'::text[] NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"chain_pem" text DEFAULT '' NOT NULL,
	"private_key_envelope" text DEFAULT '' NOT NULL,
	"fingerprint" text DEFAULT '' NOT NULL,
	"not_before" timestamp with time zone,
	"not_after" timestamp with time zone,
	"auto_renew" boolean DEFAULT false NOT NULL,
	"renew_at" timestamp with time zone,
	"acme" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"account_envelope" text DEFAULT '' NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"operation_started_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_credential" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"zone" text NOT NULL,
	"credential_envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "supported_features" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "tls_settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "acme_challenge" ADD CONSTRAINT "acme_challenge_certificate_id_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificate"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_credential" ADD CONSTRAINT "dns_credential_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "certificate_org_idx" ON "certificate" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "site" ADD CONSTRAINT "site_certificate_id_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificate"("id") ON DELETE restrict ON UPDATE no action;