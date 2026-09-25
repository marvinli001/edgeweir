CREATE TABLE "site_star" (
	"user_id" text NOT NULL,
	"site_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "site_star_user_id_site_id_pk" PRIMARY KEY("user_id","site_id")
);
--> statement-breakpoint
ALTER TABLE "site_star" ADD CONSTRAINT "site_star_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "site_star" ADD CONSTRAINT "site_star_site_id_site_id_fk" FOREIGN KEY ("site_id") REFERENCES "public"."site"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "site_star_site_idx" ON "site_star" USING btree ("site_id");