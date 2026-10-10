import {
  BLOCK_REASONS,
  BROWSERS,
  DEVICES,
  MAX_STATS_COUNTRIES,
  MAX_STATS_TOP,
  OPERATING_SYSTEMS,
  STATS_HTTP_VERSIONS,
  STATS_TLS_VERSIONS,
} from "@edgeweir/contract";
import { type SQL, sql } from "drizzle-orm";
import type { AnyPgTable } from "drizzle-orm/pg-core";
import { addTrafficCounter } from "./stats-counter";

/**
 * Statistics dimensions of a minute (MinuteStats 14-24, stats-dims-v1,
 * ADR-0041 §7) as nodes report them; ingestion keeps only valid keys and
 * bounded maps.
 */
export interface ReportedDimensions {
  countries?: { country: string; requests: number; bytesSent: number }[];
  asns?: { asn: number; name: string; requests: number }[];
  referers?: Record<string, number>;
  browsers?: Record<string, number>;
  oses?: Record<string, number>;
  devices?: Record<string, number>;
  httpVersions?: Record<string, number>;
  tlsVersions?: Record<string, number>;
  blockReasons?: Record<string, number>;
  challengesIssued?: number;
  challengesPassed?: number;
}

/** The dimension columns of node_minute_stats / node_hour_stats / node_day_stats. */
export interface DimensionBucket {
  country_requests: Record<string, number>;
  country_bytes: Record<string, number>;
  asns: Record<string, number>;
  referers: Record<string, number>;
  browsers: Record<string, number>;
  oses: Record<string, number>;
  devices: Record<string, number>;
  http_versions: Record<string, number>;
  tls_versions: Record<string, number>;
  block_reasons: Record<string, number>;
  challenges_issued: number;
  challenges_passed: number;
}

/** Map columns and how many keys a bucket keeps (null: the key list bounds them). */
export const DIMENSION_MAPS = [
  // Bounded by the key space (two letters or ""): one report keeps the heaviest
  // MAX_STATS_COUNTRIES by requests, with their bytes.
  ["country_requests", null],
  ["country_bytes", null],
  ["asns", MAX_STATS_TOP],
  ["referers", MAX_STATS_TOP],
  ["browsers", null],
  ["oses", null],
  ["devices", null],
  ["http_versions", null],
  ["tls_versions", null],
  ["block_reasons", null],
] as const satisfies readonly (readonly [keyof DimensionBucket, number | null])[];
export const DIMENSION_COUNTERS = ["challenges_issued", "challenges_passed"] as const;
export const DIMENSION_COLUMNS = [
  ...DIMENSION_MAPS.map(([column]) => column),
  ...DIMENSION_COUNTERS,
] as const;

const KEYS: Record<string, ReadonlySet<string>> = {
  browsers: new Set(BROWSERS),
  oses: new Set(OPERATING_SYSTEMS),
  devices: new Set(DEVICES),
  http_versions: new Set(STATS_HTTP_VERSIONS),
  tls_versions: new Set(STATS_TLS_VERSIONS),
  block_reasons: new Set(BLOCK_REASONS),
};
const COUNTRY_RE = /^(?:[A-Z]{2})?$/;
/** Referring hosts as nodes report them: lowercase labels of letters, digits, "-" and "_". */
const HOST_RE =
  /^(?=.{1,253}$)(?:[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?\.)*[a-z0-9_](?:[a-z0-9_-]{0,61}[a-z0-9_])?$/;
const isCount = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;
/** Names nodes report for a network: control characters dropped, at most 128 characters. */
export const cleanAsName = (name: string) =>
  name
    .replace(/\p{Cc}/gu, "")
    .trim()
    .slice(0, 128);

/** Heaviest `limit` entries (ties by key), all when limit is null. */
function bounded(values: Record<string, number>, limit: number | null) {
  const entries = Object.entries(values).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  return Object.fromEntries(limit === null ? entries : entries.slice(0, limit));
}
function add(target: Record<string, number>, key: string, n: number) {
  target[key] = addTrafficCounter(target[key] ?? 0, n);
}

/** A node's dimensions as stored, with invalid keys and counts dropped. */
export function cleanDimensions(input: ReportedDimensions | undefined): DimensionBucket {
  const d = input ?? {};
  const out: DimensionBucket = {
    country_requests: Object.create(null),
    country_bytes: Object.create(null),
    asns: Object.create(null),
    referers: Object.create(null),
    browsers: Object.create(null),
    oses: Object.create(null),
    devices: Object.create(null),
    http_versions: Object.create(null),
    tls_versions: Object.create(null),
    block_reasons: Object.create(null),
    challenges_issued:
      Number.isSafeInteger(d.challengesIssued) && (d.challengesIssued ?? 0) > 0
        ? (d.challengesIssued as number)
        : 0,
    challenges_passed:
      Number.isSafeInteger(d.challengesPassed) && (d.challengesPassed ?? 0) > 0
        ? (d.challengesPassed as number)
        : 0,
  };
  for (const c of d.countries ?? []) {
    if (!COUNTRY_RE.test(c.country) || !isCount(c.requests)) continue;
    add(out.country_requests, c.country, c.requests);
    if (isCount(c.bytesSent)) add(out.country_bytes, c.country, c.bytesSent);
  }
  for (const a of d.asns ?? []) {
    if (!Number.isInteger(a.asn) || a.asn < 1 || a.asn > 4294967295 || !isCount(a.requests))
      continue;
    add(out.asns, String(a.asn), a.requests);
  }
  for (const [host, n] of Object.entries(d.referers ?? {}))
    if (HOST_RE.test(host) && isCount(n)) add(out.referers, host, n);
  const keyed = [
    ["browsers", d.browsers],
    ["oses", d.oses],
    ["devices", d.devices],
    ["http_versions", d.httpVersions],
    ["tls_versions", d.tlsVersions],
    ["block_reasons", d.blockReasons],
  ] as const;
  for (const [column, values] of keyed)
    for (const [key, n] of Object.entries(values ?? {}))
      if (KEYS[column]?.has(key) && isCount(n)) add(out[column], key, n);
  for (const [column, limit] of DIMENSION_MAPS) out[column] = bounded(out[column], limit);
  out.country_requests = bounded(out.country_requests, MAX_STATS_COUNTRIES);
  out.country_bytes = Object.fromEntries(
    Object.entries(out.country_bytes).filter(([country]) => country in out.country_requests),
  );
  return out;
}

/** Adds b's dimensions to a's (two buckets of one minute and site in a report). */
export function mergeDimensions(a: DimensionBucket, b: DimensionBucket): DimensionBucket {
  const out = { ...a };
  for (const [column, limit] of DIMENSION_MAPS) {
    const values: Record<string, number> = Object.assign(Object.create(null), a[column]);
    for (const [key, n] of Object.entries(b[column])) add(values, key, n);
    out[column] = bounded(values, limit);
  }
  for (const column of DIMENSION_COUNTERS) out[column] = addTrafficCounter(a[column], b[column]);
  return out;
}

/** Networks' names from a report, for asn_name (the last name per network wins). */
export function reportedAsNames(reported: (ReportedDimensions | undefined)[]) {
  const names = new Map<number, string>();
  for (const d of reported)
    for (const a of d?.asns ?? []) {
      const name = cleanAsName(a.name ?? "");
      if (Number.isInteger(a.asn) && a.asn >= 1 && a.asn <= 4294967295 && name)
        names.set(a.asn, name);
    }
  return [...names].map(([asn, name]) => ({ asn, name }));
}

const SATURATE = "9007199254740991::numeric";

/** Ingestion's `on conflict ... do update` assignments: maps summed key by key, counters saturated. */
export function dimensionUpsert(table: string): SQL {
  const maps = DIMENSION_MAPS.map(
    ([c, limit]) =>
      `${c} = (select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (
        select k, least(${SATURATE}, coalesce((${table}.${c} ->> k)::numeric,0)+coalesce((excluded.${c} ->> k)::numeric,0)) as n
        from jsonb_object_keys(${table}.${c} || excluded.${c}) as k order by n desc,k${limit === null ? "" : ` limit ${limit}`}) q)`,
  );
  const counters = DIMENSION_COUNTERS.map(
    (c) => `${c} = least(${SATURATE}, ${table}.${c}::numeric + excluded.${c})`,
  );
  // Column and table names are constants of this module.
  return sql.raw([...maps, ...counters].join(",\n"));
}

/** A rollup's aggregates of the dimension columns over `source` rows matching `where`. */
export function dimensionRollup(source: AnyPgTable, where: SQL): SQL {
  const parts = DIMENSION_MAPS.map(
    ([c, limit]) =>
      sql`(select coalesce(jsonb_object_agg(k,n),'{}'::jsonb) from (select entry.key as k,least(${sql.raw(SATURATE)},sum(entry.value::numeric)) as n from ${source},lateral jsonb_each_text(${sql.raw(c)}) entry where ${where} group by entry.key order by n desc,k${sql.raw(limit === null ? "" : ` limit ${limit}`)}) ${sql.raw(`d_${c}`)})`,
  );
  const counters = DIMENSION_COUNTERS.map(
    (c) => sql`least(${sql.raw(SATURATE)},coalesce(sum(${sql.raw(c)}),0))`,
  );
  return sql.join([...parts, ...counters], sql`,`);
}
