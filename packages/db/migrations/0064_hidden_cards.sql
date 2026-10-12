CREATE TABLE "hidden_cards" (
	"user_id" text PRIMARY KEY NOT NULL,
	"overview" text[] DEFAULT '{}'::text[] NOT NULL,
	"site" text[] DEFAULT '{}'::text[] NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "hidden_cards" ADD CONSTRAINT "hidden_cards_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;