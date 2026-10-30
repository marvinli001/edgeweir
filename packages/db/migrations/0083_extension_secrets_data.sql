CREATE TABLE "site_extension_data" (
	"site_id" uuid NOT NULL,
	"extension_id" text NOT NULL,
	"name" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"content" "bytea" NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_extension_data_site_id_extension_id_name_pk" PRIMARY KEY("site_id","extension_id","name")
);
--> statement-breakpoint
ALTER TABLE "extension" ADD COLUMN "secret_envelope" text;--> statement-breakpoint
ALTER TABLE "extension" ADD COLUMN "secret_version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "site_extension_data" ADD CONSTRAINT "site_extension_data_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_extension_data" ADD CONSTRAINT "site_extension_data_extension_id_extension_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extension"("id") ON DELETE cascade ON UPDATE no action;