-- Keep existing traffic values representable by the public API before resuming rollups.
UPDATE node_minute_stats
SET requests = least(9007199254740991, greatest(0, requests)),
    bytes_sent = least(9007199254740991, greatest(0, bytes_sent)),
    bytes_received = least(9007199254740991, greatest(0, bytes_received)),
    cache_hits = least(9007199254740991, greatest(0, cache_hits)),
    cache_misses = least(9007199254740991, greatest(0, cache_misses)),
    status_codes = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(status_codes)),
    top_urls = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(top_urls)),
    top_ips = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(top_ips))
WHERE requests > 9007199254740991 or requests < 0
   OR bytes_sent > 9007199254740991 or bytes_sent < 0
   OR bytes_received > 9007199254740991 or bytes_received < 0
   OR cache_hits > 9007199254740991 or cache_hits < 0
   OR cache_misses > 9007199254740991 or cache_misses < 0
   OR exists (select 1 from jsonb_each_text(status_codes) where value::numeric > 9007199254740991 or value::numeric < 0)
   OR exists (select 1 from jsonb_each_text(top_urls) where value::numeric > 9007199254740991 or value::numeric < 0)
   OR exists (select 1 from jsonb_each_text(top_ips) where value::numeric > 9007199254740991 or value::numeric < 0);
--> statement-breakpoint
UPDATE node_hour_stats
SET requests = least(9007199254740991, greatest(0, requests)),
    bytes_sent = least(9007199254740991, greatest(0, bytes_sent)),
    bytes_received = least(9007199254740991, greatest(0, bytes_received)),
    cache_hits = least(9007199254740991, greatest(0, cache_hits)),
    cache_misses = least(9007199254740991, greatest(0, cache_misses)),
    status_codes = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(status_codes)),
    top_urls = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(top_urls)),
    top_ips = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(top_ips))
WHERE requests > 9007199254740991 or requests < 0
   OR bytes_sent > 9007199254740991 or bytes_sent < 0
   OR bytes_received > 9007199254740991 or bytes_received < 0
   OR cache_hits > 9007199254740991 or cache_hits < 0
   OR cache_misses > 9007199254740991 or cache_misses < 0
   OR exists (select 1 from jsonb_each_text(status_codes) where value::numeric > 9007199254740991 or value::numeric < 0)
   OR exists (select 1 from jsonb_each_text(top_urls) where value::numeric > 9007199254740991 or value::numeric < 0)
   OR exists (select 1 from jsonb_each_text(top_ips) where value::numeric > 9007199254740991 or value::numeric < 0);
--> statement-breakpoint
UPDATE node_day_stats
SET requests = least(9007199254740991, greatest(0, requests)),
    bytes_sent = least(9007199254740991, greatest(0, bytes_sent)),
    bytes_received = least(9007199254740991, greatest(0, bytes_received)),
    cache_hits = least(9007199254740991, greatest(0, cache_hits)),
    cache_misses = least(9007199254740991, greatest(0, cache_misses)),
    status_codes = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(status_codes)),
    top_urls = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(top_urls)),
    top_ips = (select coalesce(jsonb_object_agg(key, least(9007199254740991::numeric, greatest(0, value::numeric))), '{}'::jsonb) from jsonb_each_text(top_ips))
WHERE requests > 9007199254740991 or requests < 0
   OR bytes_sent > 9007199254740991 or bytes_sent < 0
   OR bytes_received > 9007199254740991 or bytes_received < 0
   OR cache_hits > 9007199254740991 or cache_hits < 0
   OR cache_misses > 9007199254740991 or cache_misses < 0
   OR exists (select 1 from jsonb_each_text(status_codes) where value::numeric > 9007199254740991 or value::numeric < 0)
   OR exists (select 1 from jsonb_each_text(top_urls) where value::numeric > 9007199254740991 or value::numeric < 0)
   OR exists (select 1 from jsonb_each_text(top_ips) where value::numeric > 9007199254740991 or value::numeric < 0);
