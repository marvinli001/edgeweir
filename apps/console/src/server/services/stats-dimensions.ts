import {
  MAX_STATS_COUNTRIES,
  MAX_STATS_TOP,
  nodeSupportsFeature,
  STATS_DIMS_FEATURE,
  type StatsDimensions,
  type StatsDimensionsInput,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { rangeWindow, sourceFor } from "./analytics";
import { findSite } from "./sites";
import { MAX_TRAFFIC_COUNTER } from "./stats-counter";
import { DIMENSION_COUNTERS, DIMENSION_MAPS } from "./stats-dims";

type Counts = Map<string, number>;

/**
 * A site's (or every site's) statistics dimensions over a range: one pass over
 * the minute rows (24 hours and less) or the hourly rollups with the pending
 * minutes (7 and 30 days), summed key by key (saturating), networks and
 * referring hosts trimmed to the heaviest 50.
 */
export async function statsDimensions(
  db: Database,
  input: StatsDimensionsInput,
  now = Date.now(),
): Promise<StatsDimensions> {
  const stats = sourceFor(input.range);
  const window = rangeWindow(input.range, now);
  const where = and(
    sql`${stats.minute} >= ${window.from.toISOString()}::timestamptz`,
    sql`${stats.minute} < ${window.end.toISOString()}::timestamptz`,
    input.siteId ? eq(stats.siteId, input.siteId) : undefined,
  );
  const columns = sql.raw(
    [...DIMENSION_MAPS.map(([c]) => c), ...DIMENSION_COUNTERS].map((c) => `s.${c}`).join(", "),
  );
  // Constant column names; one statement with a branch per dimension.
  const branches = [
    ...DIMENSION_MAPS.map(
      ([c]) =>
        `select '${c}' as d, e.key as k, least(${MAX_TRAFFIC_COUNTER}::numeric, sum(e.value::numeric))::text as n from r cross join lateral jsonb_each_text(r.${c}) e group by e.key`,
    ),
    ...DIMENSION_COUNTERS.map(
      (c) =>
        `select '${c}' as d, '' as k, least(${MAX_TRAFFIC_COUNTER}::numeric, coalesce(sum(r.${c}), 0))::text as n from r`,
    ),
  ].join(" union all ");
  const result = await db.execute<{ d: string; k: string; n: string }>(sql`
    with r as (
      select ${columns} from ${stats} s
      inner join ${schema.site} on ${schema.site.id} = s.site_id
      where ${where ?? sql`true`}
    ) ${sql.raw(branches)}`);
  const maps = new Map<string, Counts>();
  for (const row of result.rows) {
    let m = maps.get(row.d);
    if (!m) maps.set(row.d, (m = new Map()));
    m.set(row.k, Number(row.n));
  }
  const ranked = (column: string, limit?: number) =>
    [...(maps.get(column) ?? new Map<string, number>())]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
      .slice(0, limit);
  const keyed = (column: string) => ranked(column).map(([key, requests]) => ({ key, requests }));
  const bytes = maps.get("country_bytes") ?? new Map<string, number>();
  const asns = ranked("asns", MAX_STATS_TOP).map(([asn, requests]) => ({
    asn: Number(asn),
    requests,
  }));
  const names = asns.length
    ? await db
        .select({ asn: schema.asnName.asn, name: schema.asnName.name })
        .from(schema.asnName)
        .where(
          inArray(
            schema.asnName.asn,
            asns.map((a) => a.asn),
          ),
        )
    : [];
  const nameOf = new Map(names.map((n) => [n.asn, n.name]));
  const site = input.siteId ? await findSite(db, input.siteId) : null;
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(
      and(
        eq(schema.node.status, "active"),
        site ? eq(schema.node.clusterId, site.clusterId) : undefined,
      ),
    );
  return {
    countries: ranked("country_requests", MAX_STATS_COUNTRIES).map(([country, requests]) => ({
      country,
      requests,
      bytesSent: bytes.get(country) ?? 0,
    })),
    asns: asns.map((a) => ({ ...a, name: nameOf.get(a.asn) ?? "" })),
    referers: ranked("referers", MAX_STATS_TOP).map(([host, requests]) => ({ host, requests })),
    browsers: keyed("browsers"),
    oses: keyed("oses"),
    devices: keyed("devices"),
    httpVersions: keyed("http_versions"),
    tlsVersions: keyed("tls_versions"),
    blockReasons: keyed("block_reasons"),
    challenges: {
      issued: maps.get("challenges_issued")?.get("") ?? 0,
      passed: maps.get("challenges_passed")?.get("") ?? 0,
    },
    unsupportedNodes: nodes.filter((n) => !nodeSupportsFeature(n.features, STATS_DIMS_FEATURE))
      .length,
  };
}
