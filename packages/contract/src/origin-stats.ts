/**
 * Fetches from each origin of a site (proto v1.4.0 MinuteStats.origins,
 * feature origin-stats-v1, ADR-0052): nodes count every attempt to fetch
 * from an origin with its failures by class and the time to the origin's
 * response header, per minute.
 */
import * as z from "zod";
import { analyticsRange, isoDateTime, uuid } from "./schemas";

/** Origins a node reports per site and minute (a site has at most 32). */
export const MAX_STATS_ORIGINS = 64;
/** Upper bounds (ms) of the header time buckets; one more bucket counts everything above. */
export const ORIGIN_HEADER_TIME_BOUNDS_MS = [
  10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000,
] as const;
export const ORIGIN_HEADER_TIME_BUCKETS = ORIGIN_HEADER_TIME_BOUNDS_MS.length + 1;
export const originQualityInput = z.object({
  id: uuid,
  range: analyticsRange.default("24h"),
});

const count = z.number().int();
/** Milliseconds; null without answered attempts. */
const ms = z.number().nullable();

const originQualityItem = z.object({
  originId: uuid,
  address: z.string(),
  port: z.number().int(),
  scheme: z.enum(["http", "https"]),
  group: z.string(),
  backup: z.boolean(),
  /** Attempts sent to the origin (retries count again). */
  requests: count,
  /** Failed attempts by class, and attempts the origin answered with a 5xx. */
  failures: z.object({
    connect: count,
    timeout: count,
    tls: count,
    invalid: count,
    server: count,
  }),
  /** All failures and 5xx answers. */
  errors: count,
  /** errors / requests; 0 without attempts. */
  errorRate: z.number(),
  /** Attempts the origin answered (with a header time). */
  answered: count,
  /** Time to the response header: mean, and percentiles interpolated in the buckets (approximate). */
  meanMs: ms,
  p50Ms: ms,
  p95Ms: ms,
  p99Ms: ms,
  /** Per bucket, aligned with `times`. */
  series: z.object({
    requests: z.array(count),
    errors: z.array(count),
    p95Ms: z.array(ms),
  }),
});

export const originQuality = z.object({
  range: analyticsRange,
  bucketSeconds: count,
  from: isoDateTime,
  to: isoDateTime,
  /** Start of each bucket, oldest first. */
  times: z.array(isoDateTime),
  /** The site's current origins in pool order; origins deleted since are left out. */
  items: z.array(originQualityItem),
  /** Active nodes of the site's cluster without origin-stats-v1: the counts are partial. */
  unsupportedNodes: count,
});

export type OriginQualityItem = z.infer<typeof originQualityItem>;
export type OriginQuality = z.infer<typeof originQuality>;
