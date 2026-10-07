ALTER TABLE "cluster" ADD COLUMN "extra_http_ports" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster" ADD COLUMN "extra_https_ports" integer[] DEFAULT '{}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster" ADD COLUMN "client_ip" jsonb;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "http_ports" integer[] DEFAULT '{80}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "site" ADD COLUMN "https_ports" integer[] DEFAULT '{443}'::integer[] NOT NULL;--> statement-breakpoint
ALTER TABLE "l4_app" ADD COLUMN "port_end" integer;--> statement-breakpoint
ALTER TABLE "l4_app" ADD COLUMN "origin_port_mode" text DEFAULT 'fixed' NOT NULL;--> statement-breakpoint
ALTER TABLE "l4_app" ADD COLUMN "certificate_id" uuid;--> statement-breakpoint
ALTER TABLE "l4_app" ADD COLUMN "tls_minimum_version" text DEFAULT '1.2' NOT NULL;--> statement-breakpoint
ALTER TABLE "l4_app" ADD CONSTRAINT "l4_app_certificate_id_certificate_id_fk" FOREIGN KEY ("certificate_id") REFERENCES "public"."certificate"("id") ON DELETE restrict ON UPDATE no action;