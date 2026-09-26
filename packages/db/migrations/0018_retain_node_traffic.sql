ALTER TABLE "node_day_stats" DROP CONSTRAINT "node_day_stats_node_id_node_id_fk";
--> statement-breakpoint
ALTER TABLE "node_hour_stats" DROP CONSTRAINT "node_hour_stats_node_id_node_id_fk";
--> statement-breakpoint
ALTER TABLE "stats_rollup_dirty" DROP CONSTRAINT "stats_rollup_dirty_node_id_node_id_fk";
--> statement-breakpoint
ALTER TABLE "node_minute_stats" DROP CONSTRAINT "node_minute_stats_node_id_node_id_fk";
