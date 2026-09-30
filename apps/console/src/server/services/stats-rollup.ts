import { type Database, schema } from "@edgeweir/db";
import { and, eq, lt, sql } from "drizzle-orm";
import { MAX_WAF_RULES } from "./stats";

export const STATS_RETENTION = { minutes: 7, hours: 90, days: 365 } as const;
const DAY = 86400000;
/** Dirty markers and aggregate replacement share a transaction with row locks. */
export async function rollupTraffic(db: Database, now = new Date(), limit = 200) {
  let rolled = 0;
  for (const granularity of ["hour", "day"] as const) {
    const width = granularity === "hour" ? 3600000 : DAY;
    const source = granularity === "hour" ? schema.nodeMinuteStats : schema.nodeHourStats;
    const target = granularity === "hour" ? schema.nodeHourStats : schema.nodeDayStats;
    await db.transaction(async (tx) => {
      const dirty = schema.statsRollupDirty;
      const keys = await tx
        .select()
        .from(dirty)
        .where(
          and(
            eq(dirty.granularity, granularity),
            lt(dirty.bucket, new Date(Math.floor(now.getTime() / width) * width)),
          ),
        )
        .orderBy(dirty.bucket)
        .limit(limit)
        .for("update", { skipLocked: true });
      for (const key of keys) {
        const end = new Date(key.bucket.getTime() + width);
        const where = sql`${source.nodeId}=${key.nodeId}::uuid and ${source.siteId}=${key.siteId}::uuid and ${source.minute}>=${key.bucket.toISOString()}::timestamptz and ${source.minute}<${end.toISOString()}::timestamptz`;
        // A day is ready only after all of its hours are current.
        if (granularity === "day") {
          const blocked = await tx
            .select({ bucket: dirty.bucket })
            .from(dirty)
            .where(
              and(
                eq(dirty.granularity, "hour"),
                eq(dirty.nodeId, key.nodeId),
                eq(dirty.siteId, key.siteId),
                sql`${dirty.bucket}>=${key.bucket.toISOString()}::timestamptz`,
                lt(dirty.bucket, end),
              ),
            )
            .limit(1);
          if (blocked.length) continue;
        }
        await tx.execute(sql`
      insert into ${target} (minute,node_id,site_id,requests,bytes_sent,bytes_received,cache_hits,cache_misses,status_codes,top_urls,top_ips,waf_rules)
      select ${key.bucket.toISOString()}::timestamptz,${key.nodeId}::uuid,${key.siteId}::uuid,
        least(9007199254740991::numeric,coalesce(sum(requests),0)),least(9007199254740991::numeric,coalesce(sum(bytes_sent),0)),least(9007199254740991::numeric,coalesce(sum(bytes_received),0)),least(9007199254740991::numeric,coalesce(sum(cache_hits),0)),least(9007199254740991::numeric,coalesce(sum(cache_misses),0)),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select code.key as k,least(9007199254740991::numeric,sum(code.value::numeric)) as n from ${source},lateral jsonb_each_text(status_codes) code where ${where} group by code.key) codes),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(9007199254740991::numeric,sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(top_urls) entry where ${where} group by entry.key order by n desc,k limit 50) urls),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(9007199254740991::numeric,sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(top_ips) entry where ${where} group by entry.key order by n desc,k limit 50) ips),
        (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(9007199254740991::numeric,sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(waf_rules) entry where ${where} group by entry.key order by n desc,k limit ${MAX_WAF_RULES}) rules)
      from ${source} where ${where}
      on conflict(minute,node_id,site_id) do update set requests=excluded.requests,bytes_sent=excluded.bytes_sent,bytes_received=excluded.bytes_received,cache_hits=excluded.cache_hits,cache_misses=excluded.cache_misses,status_codes=excluded.status_codes,top_urls=excluded.top_urls,top_ips=excluded.top_ips,waf_rules=excluded.waf_rules
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
            .onConflictDoNothing();
        await tx
          .delete(dirty)
          .where(
            and(
              eq(dirty.granularity, granularity),
              eq(dirty.bucket, key.bucket),
              eq(dirty.nodeId, key.nodeId),
              eq(dirty.siteId, key.siteId),
            ),
          );
        rolled++;
      }
    });
  }
  return rolled;
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
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('edgeweir.stats.retention'))`);
    await tx.execute(sql`delete from node_minute_stats m where m.minute<${minuteCutoff}::timestamptz
   and exists(select 1 from node_hour_stats h where h.minute=date_trunc('hour',m.minute,'UTC') and h.node_id=m.node_id and h.site_id=m.site_id)
   and not exists(select 1 from stats_rollup_dirty d where d.granularity='hour' and d.bucket=date_trunc('hour',m.minute,'UTC') and d.node_id=m.node_id and d.site_id=m.site_id)
   and not exists(select 1 from stats_rollup_dirty d where d.granularity='usage' and d.site_id=m.site_id and d.bucket=to_timestamp(floor(extract(epoch from m.minute)/300)*300))`);
    await tx.execute(sql`delete from node_hour_stats h where h.minute<${hourCutoff}::timestamptz
   and exists(select 1 from node_day_stats d where d.minute=date_trunc('day',h.minute,'UTC') and d.node_id=h.node_id and d.site_id=h.site_id)
   and not exists(select 1 from stats_rollup_dirty d where d.granularity='day' and d.bucket=date_trunc('day',h.minute,'UTC') and d.node_id=h.node_id and d.site_id=h.site_id)`);
    await tx.delete(schema.nodeDayStats).where(lt(schema.nodeDayStats.minute, dayCutoff));
  });
}
export async function maintainTraffic(db: Database, now = new Date()) {
  const rolled = await rollupTraffic(db, now);
  await pruneTraffic(db, now);
  return rolled;
}
