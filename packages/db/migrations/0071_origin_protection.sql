CREATE TABLE "origin_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"hostnames" text[] NOT NULL,
	"key_type" text NOT NULL,
	"source" text NOT NULL,
	"certificate_pem" text NOT NULL,
	"serial" text NOT NULL,
	"fingerprint" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "origin_certificate_serial_unique" UNIQUE("serial")
);
--> statement-breakpoint
CREATE TABLE "origin_client_certificate" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"chain_pem" text NOT NULL,
	"private_key_envelope" text NOT NULL,
	"fingerprint" text NOT NULL,
	"serial" text NOT NULL,
	"not_before" timestamp with time zone NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "tls_trust" text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_pool" ADD COLUMN "client_certificate" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pki_authority" ADD COLUMN "crl_pem" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "origin_client_certificate" ADD CONSTRAINT "origin_client_certificate_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "origin_client_certificate_cluster_idx" ON "origin_client_certificate" USING btree ("cluster_id","not_after");