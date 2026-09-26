CREATE TABLE "dns_managed_name" (
	"provider_id" uuid NOT NULL,
	"name" text NOT NULL,
	"type" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	CONSTRAINT "dns_managed_name_provider_id_name_type_pk" PRIMARY KEY("provider_id","name","type")
);
--> statement-breakpoint
CREATE TABLE "dns_revision" (
	"revision" bigserial PRIMARY KEY NOT NULL,
	"provider_id" uuid,
	"policy" jsonb NOT NULL,
	"records" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"reason" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"last_error" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "dns_state" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"policy" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"desired_revision" bigint,
	"applied_revision" bigint
);
--> statement-breakpoint
CREATE TABLE "platform_dns_provider" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"provider" text NOT NULL,
	"zone" text NOT NULL,
	"credential_envelope" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_managed_name" ADD CONSTRAINT "dns_managed_name_provider_id_platform_dns_provider_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."platform_dns_provider"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "dns_revision_created_idx" ON "dns_revision" USING btree ("created_at");
--> statement-breakpoint
INSERT INTO dns_state (id,policy) VALUES (1,'{}'::jsonb);
