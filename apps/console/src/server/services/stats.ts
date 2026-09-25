import { schema } from "@edgeweir/db";
import { sql } from "drizzle-orm";
import type { Executor } from "./revisions";

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
        status_codes: { ...s.statusCodes },
      });
      continue;
    }
    b.requests += s.requests;
    b.bytes_sent += s.bytesSent;
    b.bytes_received += s.bytesReceived;
    b.cache_hits += s.cacheHits;
    b.cache_misses += s.cacheMisses;
    for (const [code, n] of Object.entries(s.statusCodes)) {
      b.status_codes[code] = (b.status_codes[code] ?? 0) + n;
    }
  }
  if (buckets.size === 0) return 0;

  const t = schema.nodeMinuteStats;
  const result = await db.execute<{ site_id: string }>(sql`
    insert into ${t} (minute, node_id, site_id, requests, bytes_sent, bytes_received, cache_hits, cache_misses, status_codes)
    select b.minute, ${node.id}::uuid, b.site_id, b.requests, b.bytes_sent, b.bytes_received,
           b.cache_hits, b.cache_misses, coalesce(b.status_codes, '{}'::jsonb)
    from jsonb_to_recordset(${JSON.stringify([...buckets.values()])}::jsonb) as b(
      minute timestamptz, site_id uuid, requests bigint, bytes_sent bigint, bytes_received bigint,
      cache_hits bigint, cache_misses bigint, status_codes jsonb)
    join ${schema.site} on ${schema.site.id} = b.site_id and ${schema.site.clusterId} = ${node.clusterId}::uuid
    on conflict (minute, node_id, site_id) do update set
      requests = ${t}.requests + excluded.requests,
      bytes_sent = ${t}.bytes_sent + excluded.bytes_sent,
      bytes_received = ${t}.bytes_received + excluded.bytes_received,
      cache_hits = ${t}.cache_hits + excluded.cache_hits,
      cache_misses = ${t}.cache_misses + excluded.cache_misses,
      -- Sum per-status counters key by key.
      status_codes = (
        select coalesce(jsonb_object_agg(k, coalesce((${t}.status_codes ->> k)::bigint, 0)
          + coalesce((excluded.status_codes ->> k)::bigint, 0)), '{}'::jsonb)
        from jsonb_object_keys(${t}.status_codes || excluded.status_codes) as k
      )
    returning site_id
  `);
  const stored = new Set(result.rows.map((r) => r.site_id));
  let accepted = 0;
  for (const [siteId, n] of perSite) if (stored.has(siteId)) accepted += n;
  return accepted;
}
