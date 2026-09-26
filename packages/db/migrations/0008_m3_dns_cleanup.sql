CREATE TABLE "dns_challenge_lease" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"certificate_id" uuid NOT NULL,
	"credential_id" uuid NOT NULL,
	"operation_started_at" timestamp with time zone NOT NULL,
	"token" text NOT NULL,
	"record" jsonb NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "dns_challenge_lease" ADD CONSTRAINT "dns_challenge_lease_certificate_id_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_challenge_lease" ADD CONSTRAINT "dns_challenge_lease_credential_id_dns_credential_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."dns_credential"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "dns_challenge_attempt_uq" ON "dns_challenge_lease" USING btree ("certificate_id","operation_started_at","token");