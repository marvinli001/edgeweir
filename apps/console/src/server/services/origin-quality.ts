import {
  type AnalyticsRange,
  nodeSupportsFeature,
  ORIGIN_HEADER_TIME_BOUNDS_MS,
  ORIGIN_HEADER_TIME_BUCKETS,
  ORIGIN_STATS_FEATURE,
  type OriginQuality,
  type OriginQualityItem,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq, sql } from "drizzle-orm";
import { bucketOf, RANGES, rangeWindow, sourceFor } from "./analytics";
import { findSite } from "./sites";

/** One origin's counters (origin_stats fields) summed over some rows. */
interface Counters {
  n: number;
  cf: number;
  to: number;
  tls: number;
  inv: number;
  e5: number;
  ms: number;
  h: number[];
}

const empty = (): Counters => ({
  n: 0,
  cf: 0,
  to: 0,
  tls: 0,
  inv: 0,
  e5: 0,
  ms: 0,
  h: Array.from({ length: ORIGIN_HEADER_TIME_BUCKETS }, () => 0),
});

function add(c: Counters, field: string, value: number) {
  if (field.startsWith("h")) {
    const i = Number(field.slice(1));
    if (Number.isInteger(i) && i >= 0 && i < c.h.length) c.h[i] = (c.h[i] ?? 0) + value;
  } else if (field in c && field !== "h") {
    c[field as Exclude<keyof Counters, "h">] += value;
  }
}

const errorsOf = (c: Counters) => c.cf + c.to + c.tls + c.inv + c.e5;

/**
 * The q-quantile (0–1) of the header times in the buckets, interpolated
 * linearly inside its bucket (the first bucket starts at 0 ms; the last,
 * above the largest bound, answers that bound); null without answers.
 */
export function headerTimeQuantile(buckets: number[], q: number): number | null {
  const total = buckets.reduce((a, b) => a + b, 0);
  if (total <= 0) return null;
  const rank = q * total;
  let before = 0;
  for (let i = 0; i < buckets.length; i++) {
    const n = buckets[i] ?? 0;
    if (n > 0 && before + n >= rank) {
      const lower = i === 0 ? 0 : (ORIGIN_HEADER_TIME_BOUNDS_MS[i - 1] ?? 0);
      const upper = ORIGIN_HEADER_TIME_BOUNDS_MS[i];
      if (upper === undefined) return lower;
      return Math.round((lower + ((upper - lower) * (rank - before)) / n) * 10) / 10;
    }
    before += n;
  }
  return ORIGIN_HEADER_TIME_BOUNDS_MS[ORIGIN_HEADER_TIME_BOUNDS_MS.length - 1] ?? null;
}

/**
 * Fetches from each of a site's current origins over a range (origin_stats,
 * ADR-0052): totals with the error rate and header time percentiles, and
 * per bucket the attempts, errors and p95. Origins deleted since are left
 * out; `unsupportedNodes` counts the active nodes of the site's cluster
 * without origin-stats-v1.
 */
export async function originQuality(
  db: Database,
  query: { id: string; range: AnalyticsRange },
  now = Date.now(),
): Promise<OriginQuality> {
  const site = await findSite(db, query.id);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const { bucketSeconds } = RANGES[query.range];
  const origins = await db
    .select({
      id: schema.origin.id,
      address: schema.origin.address,
      port: schema.origin.port,
      scheme: schema.origin.scheme,
      group: schema.origin.groupName,
      backup: schema.origin.backup,
    })
    .from(schema.origin)
    .innerJoin(schema.originPool, eq(schema.originPool.id, schema.origin.poolId))
    .where(eq(schema.originPool.siteId, site.id))
    .orderBy(asc(schema.origin.createdAt), asc(schema.origin.id));
  const result = await db.execute<{ bucket: string | number; key: string; value: string | number }>(
    sql`select ${bucketOf(bucketSeconds, stats)} as bucket, entry.key as key, sum(entry.value::numeric)::bigint as value
      from ${stats} cross join lateral jsonb_each_text(${stats.originStats}) as entry(key, value)
      where ${and(
        eq(stats.siteId, site.id),
        sql`${stats.minute} >= ${window.from.toISOString()}::timestamptz`,
        sql`${stats.minute} < ${window.end.toISOString()}::timestamptz`,
      )}
      group by 1, 2`,
  );
  const bucketMs = bucketSeconds * 1000;
  const times: number[] = [];
  for (let t = window.from.getTime(); t < window.end.getTime(); t += bucketMs) times.push(t);
  const index = new Map(times.map((t, i) => [t, i]));
  const known = new Set(origins.map((o) => o.id));
  const totals = new Map<string, Counters>();
  const perBucket = new Map<string, Counters[]>();
  for (const row of result.rows) {
    const at = row.key.lastIndexOf(":");
    const id = row.key.slice(0, at);
    const i = index.get(Number(row.bucket) * 1000);
    if (!known.has(id) || i === undefined) continue;
    const field = row.key.slice(at + 1);
    const value = Number(row.value);
    const total = totals.get(id) ?? empty();
    totals.set(id, total);
    add(total, field, value);
    const series = perBucket.get(id) ?? times.map(empty);
    perBucket.set(id, series);
    const bucket = series[i];
    if (bucket) add(bucket, field, value);
  }
  const items: OriginQualityItem[] = origins.map((o) => {
    const c = totals.get(o.id) ?? empty();
    const series = perBucket.get(o.id) ?? times.map(empty);
    const answered = c.h.reduce((a, b) => a + b, 0);
    const errors = errorsOf(c);
    return {
      originId: o.id,
      address: o.address,
      port: o.port,
      scheme: o.scheme === "https" ? "https" : "http",
      group: o.group,
      backup: o.backup,
      requests: c.n,
      failures: { connect: c.cf, timeout: c.to, tls: c.tls, invalid: c.inv, server: c.e5 },
      errors,
      errorRate: c.n > 0 ? Math.min(1, errors / c.n) : 0,
      answered,
      meanMs: answered > 0 ? Math.round((c.ms / answered) * 10) / 10 : null,
      p50Ms: headerTimeQuantile(c.h, 0.5),
      p95Ms: headerTimeQuantile(c.h, 0.95),
      p99Ms: headerTimeQuantile(c.h, 0.99),
      series: {
        requests: series.map((b) => b.n),
        errors: series.map(errorsOf),
        p95Ms: series.map((b) => headerTimeQuantile(b.h, 0.95)),
      },
    };
  });
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")));
  return {
    range: query.range,
    bucketSeconds,
    from: window.from.toISOString(),
    to: window.end.toISOString(),
    times: times.map((t) => new Date(t).toISOString()),
    items,
    unsupportedNodes: nodes.filter(
      (node) => !nodeSupportsFeature(node.features, ORIGIN_STATS_FEATURE),
    ).length,
  };
}
