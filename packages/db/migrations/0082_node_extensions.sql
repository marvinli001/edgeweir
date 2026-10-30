CREATE TABLE "extension" (
	"id" text PRIMARY KEY NOT NULL,
	"active_version" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"failure_mode" text DEFAULT 'open' NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_key" (
	"kid" text PRIMARY KEY NOT NULL,
	"publisher" text NOT NULL,
	"x" text NOT NULL,
	"label" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "extension_version" (
	"extension_id" text NOT NULL,
	"version" text NOT NULL,
	"sha256" text NOT NULL,
	"size" integer NOT NULL,
	"package" "bytea" NOT NULL,
	"signature" text NOT NULL,
	"kid" text NOT NULL,
	"manifest" jsonb NOT NULL,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "extension_version_extension_id_version_pk" PRIMARY KEY("extension_id","version")
);
--> statement-breakpoint
CREATE TABLE "site_extension" (
	"site_id" uuid NOT NULL,
	"extension_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_extension_site_id_extension_id_pk" PRIMARY KEY("site_id","extension_id")
);
--> statement-breakpoint
ALTER TABLE "node" ADD COLUMN "extension_status" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "extension_version" ADD CONSTRAINT "extension_version_extension_id_extension_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_extension" ADD CONSTRAINT "site_extension_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_extension" ADD CONSTRAINT "site_extension_extension_id_extension_id_fk" FOREIGN KEY ("extension_id") REFERENCES "public"."extension"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "extension_version_sha256_idx" ON "extension_version" USING btree ("sha256");