import { isIP } from "node:net";
import { type Database, schema } from "@edgeweir/db";
import { eq, sql } from "drizzle-orm";
import { lockStats } from "../lib/locks";
import type { Executor } from "./revisions";
import { addTrafficCounter } from "./stats-counter";

/** Buckets accepted per ReportStats call; the rest of a larger batch is dropped. */
export const MAX_STATS_PER_REPORT = 5000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One per-minute, per-site bucket as a node reports it. */
export interface ReportedMinuteStats {
  minute: Date;
  siteId: string;
  requests: number;
  bytesSent: number;
  bytesReceived: number;
  cacheHits: number;
  cacheMisses: number;
  statusCodes: Record<string, number>;
  topUrls?: Record<string, number>;
  topIps?: Record<string, number>;
  /** OWASP CRS rule id → matched requests. */
  wafRules?: Record<string, number>;
}

interface Bucket {
  minute: string;
  site_id: string;
  requests: number;
  bytes_sent: number;
  bytes_received: number;
  cache_hits: number;
  cache_misses: number;
  status_codes: Record<string, number>;
  top_urls: Record<string, number>;
  top_ips: Record<string, number>;
  waf_rules: Record<string, number>;
}

/**
 * Adds a node's per-minute counters to node_minute_stats with a single
 * statement per report: buckets that share a minute and site are summed first
 * (an upsert cannot touch the same row twice), the batch travels as one JSON
 * parameter (no per-row parameters, so no protocol limit on the batch size),
 * buckets of sites outside the node's cluster (or unknown) are dropped by the
 * join, and existing rows are incremented. Returns how many of the reported
 * buckets were accepted.
 */
export async function ingestMinuteStats(
  db: Executor,
  node: { id: string; clusterId: string },
  reported: ReportedMinuteStats[],
): Promise<number> {
  const buckets = new Map<string, Bucket>();
  const perSite = new Map<string, number>();
  for (const s of reported.slice(0, MAX_STATS_PER_REPORT)) {
    if (!UUID_RE.test(s.siteId) || Number.isNaN(s.minute.getTime())) continue;
    if (
      ![
        s.requests,
        s.bytesSent,
        s.bytesReceived,
        s.cacheHits,
        s.cacheMisses,
        ...Object.values(s.statusCodes),
      ].every((n) => Number.isSafeInteger(n) && n >= 0)
    )
      continue;
    const siteId = s.siteId.toLowerCase();
    const minute = new Date(s.minute);
    minute.setUTCSeconds(0, 0);
    perSite.set(siteId, (perSite.get(siteId) ?? 0) + 1);
    const key = `${minute.getTime()}|${siteId}`;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, {
        minute: minute.toISOString(),
        site_id: siteId,
        requests: s.requests,
        bytes_sent: s.bytesSent,
        bytes_received: s.bytesReceived,
        cache_hits: s.cacheHits,
        cache_misses: s.cacheMisses,
        status_codes: Object.fromEntries(
          Object.entries(s.statusCodes).filter(([code]) => /^[1-5][0-9]{2}$/.test(code)),
        ),
        top_urls: cleanTop(s.topUrls, "url"),
        top_ips: cleanTop(s.topIps, "ip"),
        waf_rules: cleanTop(s.wafRules, "rule"),
      });
      continue;
    }
    b.requests = addTrafficCounter(b.requests, s.requests);
    b.bytes_sent = addTrafficCounter(b.bytes_sent, s.bytesSent);
    b.bytes_received = addTrafficCounter(b.bytes_received, s.bytesReceived);
    b.cache_hits = addTrafficCounter(b.cache_hits, s.cacheHits);
    b.cache_misses = addTrafficCounter(b.cache_misses, s.cacheMisses);
    b.top_urls = mergeTop(b.top_urls, cleanTop(s.topUrls, "url"));
    b.top_ips = mergeTop(b.top_ips, cleanTop(s.topIps, "ip"));
    b.waf_rules = mergeTop(b.waf_rules, cleanTop(s.wafRules, "rule"));
    for (const [code, n] of Object.entries(s.statusCodes)) {
      if (/^[1-5][0-9]{2}$/.test(code))
        b.status_codes[code] = addTrafficCounter(b.status_codes[code] ?? 0, n);
    }
  }
  if (buckets.size === 0) return 0;

  const t = schema.nodeMinuteStats;
  const result = await db.execute<{ site_id: string }>(sql`
    with stored as (
    insert into ${t} (minute, node_id, site_id, requests, bytes_sent, bytes_received, cache_hits, cache_misses, status_codes, top_urls, top_ips, waf_rules)
    select b.minute, ${node.id}::uuid, b.site_id, b.requests, b.bytes_sent, b.bytes_received,
           b.cache_hits, b.cache_misses, coalesce(b.status_codes, '{}'::jsonb), b.top_urls, b.top_ips, b.waf_rules
    from jsonb_to_recordset(${JSON.stringify([...buckets.values()])}::jsonb) as b(
      minute timestamptz, site_id uuid, requests bigint, bytes_sent bigint, bytes_received bigint,
      cache_hits bigint, cache_misses bigint, status_codes jsonb, top_urls jsonb, top_ips jsonb, waf_rules jsonb)
    join ${schema.site} on ${schema.site.id} = b.site_id and ${schema.site.clusterId} = ${node.clusterId}::uuid
    on conflict (minute, node_id, site_id) do update set
      requests = least(9007199254740991::numeric, ${t}.requests::numeric + excluded.requests),
      bytes_sent = least(9007199254740991::numeric, ${t}.bytes_sent::numeric + excluded.bytes_sent),
      bytes_received = least(9007199254740991::numeric, ${t}.bytes_received::numeric + excluded.bytes_received),
      cache_hits = least(9007199254740991::numeric, ${t}.cache_hits::numeric + excluded.cache_hits),
      cache_misses = least(9007199254740991::numeric, ${t}.cache_misses::numeric + excluded.cache_misses),
      top_urls = (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (
        select k, least(9007199254740991::numeric, coalesce((${t}.top_urls ->> k)::numeric,0)+coalesce((excluded.top_urls ->> k)::numeric,0)) as n
        from jsonb_object_keys(${t}.top_urls || excluded.top_urls) as k order by n desc,k limit 50) q),
      top_ips = (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (
        select k, least(9007199254740991::numeric, coalesce((${t}.top_ips ->> k)::numeric,0)+coalesce((excluded.top_ips ->> k)::numeric,0)) as n
        from jsonb_object_keys(${t}.top_ips || excluded.top_ips) as k order by n desc,k limit 50) q),
      waf_rules = (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (
        select k, least(9007199254740991::numeric, coalesce((${t}.waf_rules ->> k)::numeric,0)+coalesce((excluded.waf_rules ->> k)::numeric,0)) as n
        from jsonb_object_keys(${t}.waf_rules || excluded.waf_rules) as k order by n desc,k limit ${MAX_WAF_RULES}) q),
      -- Sum per-status counters key by key.
      status_codes = (
        select coalesce(jsonb_object_agg(k, least(9007199254740991::numeric, coalesce((${t}.status_codes ->> k)::numeric, 0)
          + coalesce((excluded.status_codes ->> k)::numeric, 0))), '{}'::jsonb)
        from jsonb_object_keys(${t}.status_codes || excluded.status_codes) as k
      )
    returning site_id, minute
    ), dirty as (
      -- A new generation, so that a rollup reading the marker meanwhile leaves it in place.
      insert into stats_rollup_dirty (granularity,bucket,node_id,site_id)
      select distinct 'hour',date_trunc('hour',minute,'UTC'),${node.id}::uuid,site_id from stored
      union
      select distinct 'usage',to_timestamp(floor(extract(epoch from minute)/300)*300),${node.id}::uuid,site_id from stored
      on conflict (granularity,bucket,node_id,site_id) do update set generation = stats_rollup_dirty.generation + 1
    ) select site_id from stored
  `);
  const stored = new Set(result.rows.map((r) => r.site_id));
  let accepted = 0;
  for (const [siteId, n] of perSite) if (stored.has(siteId)) accepted += n;
  return accepted;
}

/** Heavy hitters kept per site, node and minute (URLs and addresses; CRS rules below). */
const MAX_TOP = 50;
/** CRS rules kept per site, node and minute, heaviest first. */
export const MAX_WAF_RULES = 50;
/** A CRS rule id as nodes report it: a uint32 in decimal. */
const isRuleId = (value: string) => /^[1-9][0-9]{0,9}$/.test(value) && Number(value) <= 4294967295;

function cleanTop(
  input: Record<string, number> | undefined,
  kind: "url" | "ip" | "rule",
): Record<string, number> {
  return Object.fromEntries(
    Object.entries(input ?? {})
      .filter(
        ([value, count]) =>
          Number.isSafeInteger(count) &&
          count > 0 &&
          (kind === "ip"
            ? isIP(value) > 0
            : kind === "rule"
              ? isRuleId(value)
              : value.startsWith("/") &&
                value.length <= 2048 &&
                !value.includes("?") &&
                ![...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)),
      )
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, kind === "rule" ? MAX_WAF_RULES : MAX_TOP),
  );
}
function mergeTop(left: Record<string, number>, right: Record<string, number>) {
  const values: Record<string, number> = Object.assign(Object.create(null), left);
  for (const [key, n] of Object.entries(right))
    values[key] = addTrafficCounter(values[key] ?? 0, n);
  return Object.fromEntries(
    Object.entries(values)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, MAX_TOP),
  );
}
/** One per-minute bucket of a layer-4 application as a node reports it (l4-v1). */
export interface ReportedL4MinuteStats {
  minute: Date;
  appId: string;
  connections: number;
  refused: number;
  peakConcurrent: number;
  bytesReceived: number;
  bytesSent: number;
}

/**
 * Adds a node's per-minute layer-4 counters to l4_minute_stats in one
 * statement, like ingestMinuteStats: buckets of a minute and application
 * are combined first, applications outside the node's cluster (or unknown)
 * are dropped by the join, counters are summed and the concurrency peak is
 * the higher one. Returns how many of the reported buckets were accepted.
 */
export async function ingestL4MinuteStats(
  db: Executor,
  node: { id: string; clusterId: string },
  reported: ReportedL4MinuteStats[],
): Promise<number> {
  const buckets = new Map<string, Omit<ReportedL4MinuteStats, "minute"> & { minute: string }>();
  const perApp = new Map<string, number>();
  for (const s of reported.slice(0, MAX_STATS_PER_REPORT)) {
    if (!UUID_RE.test(s.appId) || Number.isNaN(s.minute.getTime())) continue;
    const counters = [s.connections, s.refused, s.peakConcurrent, s.bytesReceived, s.bytesSent];
    if (!counters.every((n) => Number.isSafeInteger(n) && n >= 0)) continue;
    const appId = s.appId.toLowerCase();
    const minute = new Date(s.minute);
    minute.setUTCSeconds(0, 0);
    perApp.set(appId, (perApp.get(appId) ?? 0) + 1);
    const key = `${minute.getTime()}|${appId}`;
    const b = buckets.get(key);
    if (!b) {
      buckets.set(key, { ...s, appId, minute: minute.toISOString() });
      continue;
    }
    b.connections = addTrafficCounter(b.connections, s.connections);
    b.refused = addTrafficCounter(b.refused, s.refused);
    b.peakConcurrent = Math.max(b.peakConcurrent, s.peakConcurrent);
    b.bytesReceived = addTrafficCounter(b.bytesReceived, s.bytesReceived);
    b.bytesSent = addTrafficCounter(b.bytesSent, s.bytesSent);
  }
  if (buckets.size === 0) return 0;
  const t = schema.l4MinuteStats;
  const rows = [...buckets.values()].map((b) => ({
    minute: b.minute,
    app_id: b.appId,
    connections: b.connections,
    refused: b.refused,
    peak_concurrent: b.peakConcurrent,
    bytes_received: b.bytesReceived,
    bytes_sent: b.bytesSent,
  }));
  const result = await db.execute<{ app_id: string }>(sql`
    insert into ${t} (minute, node_id, app_id, connections, refused, peak_concurrent, bytes_received, bytes_sent)
    select b.minute, ${node.id}::uuid, b.app_id, b.connections, b.refused, b.peak_concurrent, b.bytes_received, b.bytes_sent
    from jsonb_to_recordset(${JSON.stringify(rows)}::jsonb) as b(
      minute timestamptz, app_id uuid, connections bigint, refused bigint, peak_concurrent bigint,
      bytes_received bigint, bytes_sent bigint)
    join ${schema.l4App} on ${schema.l4App.id} = b.app_id and ${schema.l4App.clusterId} = ${node.clusterId}::uuid
    on conflict (minute, node_id, app_id) do update set
      connections = least(9007199254740991::numeric, ${t}.connections::numeric + excluded.connections),
      refused = least(9007199254740991::numeric, ${t}.refused::numeric + excluded.refused),
      peak_concurrent = greatest(${t}.peak_concurrent, excluded.peak_concurrent),
      bytes_received = least(9007199254740991::numeric, ${t}.bytes_received::numeric + excluded.bytes_received),
      bytes_sent = least(9007199254740991::numeric, ${t}.bytes_sent::numeric + excluded.bytes_sent)
    returning app_id
  `);
  const stored = new Set(result.rows.map((r) => r.app_id));
  let accepted = 0;
  for (const [appId, n] of perApp) if (stored.has(appId)) accepted += n;
  return accepted;
}

/**
 * Only the authenticated node can advance its cursor; counter and cursor
 * writes are atomic. Site and layer-4 buckets of a batch share its
 * sequence: a retried batch adds neither again.
 */
export async function ingestStatsBatch(
  db: Database,
  node: { id: string; clusterId: string },
  sequence: bigint,
  reported: ReportedMinuteStats[],
  now?: number,
  mirror?: (tx: Executor) => Promise<void>,
  l4: ReportedL4MinuteStats[] = [],
) {
  if (sequence < 1n || sequence > 9223372036854775807n)
    throw new Error("invalid statistics sequence");
  return db.transaction(async (tx) => {
    await lockStats(tx, "shared");
    const clock = now ?? Date.now();
    const cursor = schema.nodeStatsCursor;
    await tx.insert(cursor).values({ nodeId: node.id }).onConflictDoNothing();
    const [current] = await tx
      .select()
      .from(cursor)
      .where(eq(cursor.nodeId, node.id))
      .for("update");
    if (!current) throw new Error("missing statistics cursor");
    if (sequence <= current.sequence) return 0;
    // Older buckets cannot resurrect data already removed by the retention worker.
    const cutoff = Math.floor(clock / 3600000) * 3600000 - 7 * 86400000;
    const inWindow = (s: { minute: Date }) =>
      s.minute.getTime() >= cutoff && s.minute.getTime() <= clock + 300000;
    const accepted =
      (await ingestMinuteStats(tx, node, reported.filter(inWindow))) +
      (await ingestL4MinuteStats(tx, node, l4.filter(inWindow)));
    await mirror?.(tx);
    await tx.update(cursor).set({ sequence }).where(eq(cursor.nodeId, node.id));
    return accepted;
  });
}
