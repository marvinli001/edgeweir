import type {
  AnalyticsRange,
  Traffic,
  TrafficBreakdown,
  TrafficBreakdownInput,
  TrafficTopItem,
  TrafficTotals,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, desc, eq, gte, inArray, lt, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import type { SiteScope } from "./sites";

/** Window length and point width of each range (60–168 points). */
export const RANGES: Record<AnalyticsRange, { seconds: number; bucketSeconds: number }> = {
  "1h": { seconds: 3_600, bucketSeconds: 60 },
  "6h": { seconds: 21_600, bucketSeconds: 300 },
  "24h": { seconds: 86_400, bucketSeconds: 600 },
  "7d": { seconds: 604_800, bucketSeconds: 3_600 },
  "30d": { seconds: 2_592_000, bucketSeconds: 21_600 },
};

/**
 * The current window ends with the bucket that contains `now` (still filling up); the previous
 * window is the same length right before it. Buckets are aligned to the Unix epoch.
 */
export function rangeWindow(range: AnalyticsRange, now = Date.now()) {
  const { seconds, bucketSeconds } = RANGES[range];
  const bucketMs = bucketSeconds * 1000;
  const last = Math.floor(now / bucketMs) * bucketMs;
  const from = last - (seconds / bucketSeconds - 1) * bucketMs;
  return {
    bucketSeconds,
    from: new Date(from),
    end: new Date(last + bucketMs),
    previousFrom: new Date(from - seconds * 1000),
  };
}

const stats = schema.nodeMinuteStats;

const sum = (expression: SQLWrapper) =>
  sql<number>`coalesce(sum(${expression}), 0)::bigint`.mapWith(Number);

/** Responses of one status class ("2" → 2xx) in a row's per-code counters. */
const statusClass = (digit: 2 | 3 | 4 | 5) =>
  sum(
    sql`(select sum(value::bigint) from jsonb_each_text(${stats.statusCodes}) where key like ${sql.raw(`'${digit}%'`)})`,
  );

const counters = {
  requests: sum(stats.requests),
  bytesSent: sum(stats.bytesSent),
  bytesReceived: sum(stats.bytesReceived),
  cacheHits: sum(stats.cacheHits),
  cacheMisses: sum(stats.cacheMisses),
  status2xx: statusClass(2),
  status3xx: statusClass(3),
  status4xx: statusClass(4),
  status5xx: statusClass(5),
};

type Counters = { [K in keyof typeof counters]: number };

const zero = (): Counters => ({
  requests: 0,
  bytesSent: 0,
  bytesReceived: 0,
  cacheHits: 0,
  cacheMisses: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0,
});

function totalsOf(points: Counters[], bucketSeconds: number): TrafficTotals {
  const totals = { ...zero(), peakBytesPerSecond: 0 };
  for (const point of points) {
    for (const key of Object.keys(counters) as (keyof Counters)[]) totals[key] += point[key];
    totals.peakBytesPerSecond = Math.max(
      totals.peakBytesPerSecond,
      point.bytesSent / bucketSeconds,
    );
  }
  return totals;
}

/** Epoch seconds of the bucket a row's minute falls in. */
function bucketOf(bucketSeconds: number) {
  // A fixed literal from RANGES, so the expression renders the same in SELECT and GROUP BY.
  return sql<number>`extract(epoch from date_bin(${sql.raw(`'${bucketSeconds} seconds'`)}::interval, ${stats.minute}, timestamptz 'epoch'))::bigint`;
}

/** Rows of the caller's scope: every site for platform admins, else the organization's. */
function scopeFilter(scope: SiteScope) {
  return scope.all ? undefined : eq(schema.site.organizationId, scope.organizationId);
}

/**
 * Bucketed traffic of the scope (or one site) over a range, plus totals of the range and of the
 * period before it. Buckets without statistics are filled with zeros.
 */
export async function trafficSeries(
  db: Database,
  scope: SiteScope,
  query: { range: AnalyticsRange; siteId?: string },
  now = Date.now(),
): Promise<Traffic> {
  const window = rangeWindow(query.range, now);
  const { bucketSeconds } = window;
  const bucket = bucketOf(bucketSeconds);
  const rows = await db
    .select({ bucket: bucket.mapWith(Number), ...counters })
    .from(stats)
    .innerJoin(schema.site, eq(schema.site.id, stats.siteId))
    .where(
      and(
        gte(stats.minute, window.previousFrom),
        lt(stats.minute, window.end),
        scopeFilter(scope),
        query.siteId ? eq(stats.siteId, query.siteId) : undefined,
      ),
    )
    .groupBy(sql`1`)
    .orderBy(sql`1`);

  const byBucket = new Map(rows.map(({ bucket, ...rest }) => [bucket * 1000, rest]));
  const bucketMs = bucketSeconds * 1000;
  const series = (start: Date, end: Date) => {
    const points: (Counters & { time: number })[] = [];
    for (let t = start.getTime(); t < end.getTime(); t += bucketMs) {
      points.push({ time: t, ...(byBucket.get(t) ?? zero()) });
    }
    return points;
  };
  const current = series(window.from, window.end);
  const previous = series(window.previousFrom, window.from);
  return {
    range: query.range,
    bucketSeconds,
    from: window.from.toISOString(),
    to: new Date(Math.min(now, window.end.getTime())).toISOString(),
    points: current.map((p) => ({ ...p, time: new Date(p.time).toISOString() })),
    totals: totalsOf(current, bucketSeconds),
    previous: totalsOf(previous, bucketSeconds),
  };
}

const topColumns = {
  requests: counters.requests,
  bytesSent: counters.bytesSent,
  cacheHits: counters.cacheHits,
  cacheMisses: counters.cacheMisses,
};

/** Sites of the scope with the most requests over the range. */
export async function topSites(
  db: Database,
  scope: SiteScope,
  query: { range: AnalyticsRange; limit: number },
  now = Date.now(),
): Promise<TrafficTopItem[]> {
  const window = rangeWindow(query.range, now);
  return db
    .select({
      id: schema.site.id,
      name: schema.site.name,
      parentId: schema.organization.id,
      parentName: schema.organization.name,
      ...topColumns,
    })
    .from(stats)
    .innerJoin(schema.site, eq(schema.site.id, stats.siteId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.site.organizationId))
    .where(and(gte(stats.minute, window.from), lt(stats.minute, window.end), scopeFilter(scope)))
    .groupBy(schema.site.id, schema.organization.id)
    .orderBy(desc(topColumns.requests), schema.site.name)
    .limit(query.limit);
}

/** Nodes with the most requests over the range (platform-wide). */
export async function topNodes(
  db: Database,
  query: { range: AnalyticsRange; limit: number },
  now = Date.now(),
): Promise<TrafficTopItem[]> {
  const window = rangeWindow(query.range, now);
  return db
    .select({
      id: schema.node.id,
      name: schema.node.name,
      parentId: schema.cluster.id,
      parentName: schema.cluster.name,
      ...topColumns,
    })
    .from(stats)
    .innerJoin(schema.node, eq(schema.node.id, stats.nodeId))
    .innerJoin(schema.cluster, eq(schema.cluster.id, schema.node.clusterId))
    .where(and(gte(stats.minute, window.from), lt(stats.minute, window.end)))
    .groupBy(schema.node.id, schema.cluster.id)
    .orderBy(desc(topColumns.requests), schema.node.name)
    .limit(query.limit);
}

/**
 * The sites, nodes or status codes with the most requests (or bytes sent) over a range, each with
 * its per-bucket series, plus the metric over everything the breakdown covers.
 */
export async function trafficBreakdown(
  db: Database,
  scope: SiteScope,
  query: Omit<TrafficBreakdownInput, "range" | "metric" | "limit"> &
    Required<Pick<TrafficBreakdownInput, "range" | "metric" | "limit">>,
  now = Date.now(),
): Promise<TrafficBreakdown> {
  const window = rangeWindow(query.range, now);
  const bucketMs = window.bucketSeconds * 1000;
  const times: number[] = [];
  for (let t = window.from.getTime(); t < window.end.getTime(); t += bucketMs) times.push(t);
  const index = new Map(times.map((t, i) => [t, i]));
  const where = and(
    gte(stats.minute, window.from),
    lt(stats.minute, window.end),
    scopeFilter(scope),
    query.siteId ? eq(stats.siteId, query.siteId) : undefined,
  );
  const result = await (query.by === "status"
    ? statusBreakdown(db, where, window.bucketSeconds, query.statusClass)
    : entityBreakdown(db, where, window.bucketSeconds, query.by, query.metric, query.limit));

  const seriesOf = (rows: { bucket: number; value: number }[]) => {
    const series = times.map(() => 0);
    for (const row of rows) {
      const i = index.get(row.bucket * 1000);
      if (i !== undefined) series[i] = (series[i] ?? 0) + row.value;
    }
    return series;
  };
  const totalSeries = seriesOf(result.totals);
  return {
    range: query.range,
    bucketSeconds: window.bucketSeconds,
    from: window.from.toISOString(),
    to: new Date(Math.min(now, window.end.getTime())).toISOString(),
    times: times.map((t) => new Date(t).toISOString()),
    items: result.items.slice(0, query.limit).map((item) => ({
      ...item,
      series: seriesOf(result.points.filter((p) => p.id === item.id)),
    })),
    total: totalSeries.reduce((a, b) => a + b, 0),
    totalSeries,
  };
}

interface BreakdownRows {
  /** Ranked, largest first. */
  items: {
    id: string;
    name: string;
    parentId: string | null;
    parentName: string | null;
    total: number;
  }[];
  points: { bucket: number; id: string; value: number }[];
  totals: { bucket: number; value: number }[];
}

/** Sites or nodes: rank over the range, then fetch the leaders' buckets and the scope's. */
async function entityBreakdown(
  db: Database,
  where: SQL | undefined,
  bucketSeconds: number,
  by: "site" | "node",
  metric: "requests" | "bytesSent",
  limit: number,
): Promise<BreakdownRows> {
  const value = sum(metric === "requests" ? stats.requests : stats.bytesSent);
  const bucket = bucketOf(bucketSeconds).mapWith(Number);
  const key = by === "site" ? stats.siteId : stats.nodeId;
  const items =
    by === "site"
      ? await db
          .select({
            id: schema.site.id,
            name: schema.site.name,
            parentId: schema.organization.id,
            parentName: schema.organization.name,
            total: value,
          })
          .from(stats)
          .innerJoin(schema.site, eq(schema.site.id, stats.siteId))
          .innerJoin(schema.organization, eq(schema.organization.id, schema.site.organizationId))
          .where(where)
          .groupBy(schema.site.id, schema.organization.id)
          .having(sql`${value} > 0`)
          .orderBy(desc(value), schema.site.name)
          .limit(limit)
      : await db
          .select({
            id: schema.node.id,
            name: schema.node.name,
            parentId: schema.cluster.id,
            parentName: schema.cluster.name,
            total: value,
          })
          .from(stats)
          .innerJoin(schema.site, eq(schema.site.id, stats.siteId))
          .innerJoin(schema.node, eq(schema.node.id, stats.nodeId))
          .innerJoin(schema.cluster, eq(schema.cluster.id, schema.node.clusterId))
          .where(where)
          .groupBy(schema.node.id, schema.cluster.id)
          .having(sql`${value} > 0`)
          .orderBy(desc(value), schema.node.name)
          .limit(limit);
  const [points, totals] = await Promise.all([
    items.length === 0
      ? []
      : db
          .select({ bucket, id: key, value })
          .from(stats)
          .innerJoin(schema.site, eq(schema.site.id, stats.siteId))
          .where(
            and(
              where,
              inArray(
                key,
                items.map((i) => i.id),
              ),
            ),
          )
          .groupBy(sql`1`, sql`2`),
    db
      .select({ bucket, value })
      .from(stats)
      .innerJoin(schema.site, eq(schema.site.id, stats.siteId))
      .where(where)
      .groupBy(sql`1`),
  ]);
  return { items, points, totals };
}

/** Status codes: one pass over each row's per-code counters, ranked here. */
async function statusBreakdown(
  db: Database,
  where: SQL | undefined,
  bucketSeconds: number,
  statusClass: number | undefined,
): Promise<BreakdownRows> {
  const classFilter =
    statusClass === undefined ? sql`` : sql` and code.key like ${`${statusClass}%`}`;
  const result = await db.execute<{
    bucket: string | number;
    code: string;
    value: string | number;
  }>(
    sql`select ${bucketOf(bucketSeconds)} as bucket, code.key as code, sum(code.value::bigint)::bigint as value
      from ${stats}
      inner join ${schema.site} on ${schema.site.id} = ${stats.siteId}
      cross join lateral jsonb_each_text(${stats.statusCodes}) as code(key, value)
      where ${where ?? sql`true`}${classFilter}
      group by 1, 2`,
  );
  const points = result.rows.map((row) => ({
    bucket: Number(row.bucket),
    id: row.code,
    value: Number(row.value),
  }));
  const byCode = new Map<string, number>();
  const byBucket = new Map<number, number>();
  for (const p of points) {
    byCode.set(p.id, (byCode.get(p.id) ?? 0) + p.value);
    byBucket.set(p.bucket, (byBucket.get(p.bucket) ?? 0) + p.value);
  }
  const items = [...byCode]
    .filter(([, total]) => total > 0)
    .map(([code, total]) => ({ id: code, name: code, parentId: null, parentName: null, total }))
    .sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  const totals = [...byBucket].map(([bucket, value]) => ({ bucket, value }));
  return { items, points, totals };
}
