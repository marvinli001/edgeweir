-- node_offline is one alert per node now (alert_state key node_offline/platform/<node>):
-- the per-site states of the previous version are dropped without a resolved event.
DELETE FROM "alert_state" WHERE "kind" = 'node_offline' AND "site_id" IS NOT NULL;
