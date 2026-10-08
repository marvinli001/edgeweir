CREATE TABLE "site_certificate" (
	"site_id" uuid NOT NULL,
	"certificate_id" uuid NOT NULL,
	"position" integer NOT NULL,
	CONSTRAINT "site_certificate_site_id_certificate_id_pk" PRIMARY KEY("site_id","certificate_id")
);
--> statement-breakpoint
CREATE TABLE "session_ticket_key" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"cluster_id" uuid NOT NULL,
	"role" text NOT NULL,
	"secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "certificate" ADD COLUMN "acme_account_id" uuid;--> statement-breakpoint
ALTER TABLE "site_certificate" ADD CONSTRAINT "site_certificate_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_certificate" ADD CONSTRAINT "site_certificate_certificate_id_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificate"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session_ticket_key" ADD CONSTRAINT "session_ticket_key_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "site_certificate_position_uq" ON "site_certificate" USING btree ("site_id","position");--> statement-breakpoint
CREATE INDEX "site_certificate_certificate_idx" ON "site_certificate" USING btree ("certificate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_ticket_key_cluster_role_uq" ON "session_ticket_key" USING btree ("cluster_id","role");--> statement-breakpoint
ALTER TABLE "certificate" ADD CONSTRAINT "certificate_acme_account_id_acme_account_id_fk" FOREIGN KEY ("acme_account_id") REFERENCES "public"."acme_account"("id") ON DELETE set null ON UPDATE no action;