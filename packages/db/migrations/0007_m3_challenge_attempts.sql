ALTER TABLE "acme_challenge" ADD COLUMN "operation_started_at" timestamp with time zone NOT NULL DEFAULT now();
--> statement-breakpoint
ALTER TABLE "acme_challenge" ALTER COLUMN "operation_started_at" DROP DEFAULT;
