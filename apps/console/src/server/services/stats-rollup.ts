import { type Database, schema } from "@edgeweir/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { lockStats } from "../lib/locks";
import type { Executor } from "./revisions";
import { MAX_LOGGED_RULES, MAX_WAF_RULES } from "./stats";

export const STATS_RETENTION = { minutes: 7, hours: 90, days: 365 } as const;
const DAY = 86400000;
/** How long one maintenance run rolls up before leaving the rest to the next. */
export const ROLLUP_BUDGET_MS = 30_000;
const GRANULARITIES = ["hour", "day"] as const;
type Granularity = (typeof GRANULARITIES)[number];

/**
 * Rolls dirty hours, then dirty days, up in batches of `limit` keys until
 * none is left or the time budget is spent (each granularity gets at least
 * one batch). Returns how many keys were rolled up.
 */
export async function rollupTraffic(
  db: Database,
  now = new Date(),
  limit = 200,
  budgetMs = ROLLUP_BUDGET_MS,
  onAggregated?: (tx: Executor) => Promise<void>,
) {
  const deadline = Date.now() + budgetMs;
  let rolled = 0;
  for (const granularity of GRANULARITIES) {
    for (;;) {
      const batch = await rollupBatch(db, granularity, now, limit, onAggregated);
      rolled += batch.rolled;
      if (batch.keys < limit || Date.now() >= deadline) break;
    }
  }
  return rolled;
}

/**
 * One batch: dirty keys of closed buckets, oldest first, row-locked (keys
 * another run holds are skipped). A day waits until none of its hours is
 * dirty, and such days are not picked at all, so they never fill a batch.
 * Each key's aggregate is replaced and its marker cleared only if no
 * ingestion wrote it since it was read (`onAggregated` runs in between, for
 * tests).
 */
async function rollupBatch(
  db: Database,
  granularity: Granularity,
  now: Date,
  limit: number,
  onAggregated?: (tx: Executor) => Promise<void>,
) {
  const width = granularity === "hour" ? 3600000 : DAY;
  const source = granularity === "hour" ? schema.nodeMinuteStats : schema.nodeHourStats;
  const target = granularity === "hour" ? schema.nodeHourStats : schema.nodeDayStats;
  return db.transaction(async (tx) => {
    // Site deletion removes statistics rows: it waits for running rollups.
    await lockStats(tx, "shared");
    const dirty = schema.statsRollupDirty;
    const keys = await tx
      .select()
      .from(dirty)
      .where(
        and(
          eq(dirty.granularity, granularity),
          lt(dirty.bucket, new Date(Math.floor(now.getTime() / width) * width)),
          granularity === "day"
            ? sql`not exists (select 1 from stats_rollup_dirty h where h.granularity = 'hour' and h.node_id = ${dirty.nodeId} and h.site_id = ${dirty.siteId} and h.bucket >= ${dirty.bucket} and h.bucket < ${dirty.bucket} + interval '1 day')`
            : undefined,
        ),
      )
      .orderBy(dirty.bucket)
      .limit(limit)
      .for("update", { skipLocked: true });
    let rolled = 0;
    for (const key of keys) {
      const end = new Date(key.bucket.getTime() + width);
      const where = sql`${source.nodeId}=${key.nodeId}::uuid and ${source.siteId}=${key.siteId}::uuid and ${source.minute}>=${key.bucket.toISOString()}::timestamptz and ${source.minute}<${end.toISOString()}::timestamptz`;
      await tx.execute(sql`
      insert into ${target} (minute,node_id,site_id,requests,bytes_sent,bytes_received,cache_hits,cache_misses,status_codes,top_urls,top_ips,waf_rules,logged_rules,auth_failures)
      select ${key.bucket.toISOString()}::timestamptz,${key.nodeId}::uuid,${key.siteId}::uuid,
        least(9007199254740991::numeric,coalesce(sum(requests),0)),least(9007199254740991::numeric,coalesce(sum(bytes_sent),0)),least(9007199254740991::numeric,coalesce(sum(bytes_received),0)),least(9007199254740991::numeric,coalesce(sum(cache_hits),0)),least(9007199254740991::numeric,coalesce(sum(cache_misses),0)),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select code.key as k,least(9007199254740991::numeric,sum(code.value::numeric)) as n from ${source},lateral jsonb_each_text(status_codes) code where ${where} group by code.key) codes),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(9007199254740991::numeric,sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(top_urls) entry where ${where} group by entry.key order by n desc,k limit 50) urls),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(9007199254740991::numeric,sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(top_ips) entry where ${where} group by entry.key order by n desc,k limit 50) ips),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(9007199254740991::numeric,sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(waf_rules) entry where ${where} group by entry.key order by n desc,k limit ${MAX_WAF_RULES}) rules),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(9007199254740991::numeric,sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(logged_rules) entry where ${where} group by entry.key order by n desc,k limit ${MAX_LOGGED_RULES}) logged),
        least(9007199254740991::numeric,coalesce(sum(auth_failures),0))
      from ${source} where ${where}
      on conflict(minute,node_id,site_id) do update set requests=excluded.requests,bytes_sent=excluded.bytes_sent,bytes_received=excluded.bytes_received,cache_hits=excluded.cache_hits,cache_misses=excluded.cache_misses,status_codes=excluded.status_codes,top_urls=excluded.top_urls,top_ips=excluded.top_ips,waf_rules=excluded.waf_rules,logged_rules=excluded.logged_rules,auth_failures=excluded.auth_failures
    `);
      if (granularity === "hour")
        await tx
          .insert(dirty)
          .values({
            granularity: "day",
            bucket: new Date(Math.floor(key.bucket.getTime() / DAY) * DAY),
            nodeId: key.nodeId,
            siteId: key.siteId,
          })
          .onConflictDoUpdate({
            target: [dirty.granularity, dirty.bucket, dirty.nodeId, dirty.siteId],
            set: { generation: sql`${dirty.generation} + 1` },
          });
      await onAggregated?.(tx);
      await tx
        .delete(dirty)
        .where(
          and(
            eq(dirty.granularity, granularity),
            eq(dirty.bucket, key.bucket),
            eq(dirty.nodeId, key.nodeId),
            eq(dirty.siteId, key.siteId),
            eq(dirty.generation, key.generation),
          ),
        );
      rolled++;
    }
    return { keys: keys.length, rolled };
  });
}
/** Never delete a source bucket before its durable aggregate is available. */
export async function pruneTraffic(db: Database, now = new Date()) {
  const minuteCutoff = new Date(
    Math.floor(now.getTime() / 3600000) * 3600000 - STATS_RETENTION.minutes * DAY,
  ).toISOString();
  const hourCutoff = new Date(
    Math.floor(now.getTime() / DAY) * DAY - STATS_RETENTION.hours * DAY,
  ).toISOString();
  const dayCutoff = new Date(Math.floor(now.getTime() / DAY) * DAY - STATS_RETENTION.days * DAY);
  return db.transaction(async (tx) => {
    await lockStats(tx, "exclusive");
    await tx.execute(sql`delete from node_minute_stats m where m.minute<${minuteCutoff}::timestamptz
   and exists(select 1 from node_hour_stats h where h.minute=date_trunc('hour',m.minute,'UTC') and h.node_id=m.node_id and h.site_id=m.site_id)
   and not exists(select 1 from stats_rollup_dirty d where d.granularity='hour' and d.bucket=date_trunc('hour',m.minute,'UTC') and d.node_id=m.node_id and d.site_id=m.site_id)
   and not exists(select 1 from stats_rollup_dirty d where d.granularity='usage' and d.site_id=m.site_id and d.bucket=to_timestamp(floor(extract(epoch from m.minute)/300)*300))`);
    await tx.execute(sql`delete from node_hour_stats h where h.minute<${hourCutoff}::timestamptz
   and exists(select 1 from node_day_stats d where d.minute=date_trunc('day',h.minute,'UTC') and d.node_id=h.node_id and d.site_id=h.site_id)
   and not exists(select 1 from stats_rollup_dirty d where d.granularity='day' and d.bucket=date_trunc('day',h.minute,'UTC') and d.node_id=h.node_id and d.site_id=h.site_id)`);
    await tx.delete(schema.nodeDayStats).where(lt(schema.nodeDayStats.minute, dayCutoff));
    // Layer-4 minute statistics are not rolled up: kept as long as minute data.
    await tx
      .delete(schema.l4MinuteStats)
      .where(lt(schema.l4MinuteStats.minute, new Date(minuteCutoff)));
  });
}
export async function maintainTraffic(db: Database, now = new Date()) {
  const rolled = await rollupTraffic(db, now);
  await pruneTraffic(db, now);
  return rolled;
}
