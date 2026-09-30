CREATE TABLE "idempotency_key" (
	"principal" text NOT NULL,
	"key" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"body_hash" text NOT NULL,
	"state" text DEFAULT 'in_progress' NOT NULL,
	"response_status" integer,
	"response_headers" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"response_body" text DEFAULT '' NOT NULL,
	"locked_until" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_key_principal_key_pk" PRIMARY KEY("principal","key")
);
--> statement-breakpoint
CREATE TABLE "service_account" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"scopes" text[] DEFAULT '{}'::text[] NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_account_name_unique" UNIQUE("name")
);
--> statement-breakpoint
CREATE TABLE "service_account_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service_account_id" uuid NOT NULL,
	"name" text DEFAULT '' NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_account_key_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "invitation" ALTER COLUMN "inviter_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "invitation" ADD COLUMN "inviter_service_account_id" uuid;--> statement-breakpoint
ALTER TABLE "service_account" ADD CONSTRAINT "service_account_created_by_user_id_user_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_account_key" ADD CONSTRAINT "service_account_key_service_account_id_service_account_id_fk" FOREIGN KEY ("service_account_id") REFERENCES "public"."service_account"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "idempotency_key_expires_idx" ON "idempotency_key" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "service_account_key_account_idx" ON "service_account_key" USING btree ("service_account_id");