CREATE TABLE "cluster_rollout" (
	"cluster_id" uuid PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"window_seconds" integer DEFAULT 300 NOT NULL,
	"auto_promote" boolean DEFAULT true NOT NULL,
	"error_ratio_multiplier" real DEFAULT 2 NOT NULL,
	"error_ratio_floor" real DEFAULT 0.05 NOT NULL,
	"min_requests" integer DEFAULT 100 NOT NULL,
	"state" text DEFAULT 'idle' NOT NULL,
	"stable_revision" bigint,
	"candidate_revision" bigint,
	"last_candidate_revision" bigint,
	"window_started_at" timestamp with time zone,
	"canary_node_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alert_event" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "alert_state" ALTER COLUMN "site_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cluster_rollout" ADD CONSTRAINT "cluster_rollout_cluster_id_cluster_id_fk" FOREIGN KEY ("cluster_id") REFERENCES "public"."cluster"("id") ON DELETE cascade ON UPDATE no action;