ALTER TABLE "cluster_rollout" ADD COLUMN "policy_updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
-- Existing rows: their last change of any kind stands for the last policy change.
UPDATE "cluster_rollout" SET "policy_updated_at" = "updated_at";
