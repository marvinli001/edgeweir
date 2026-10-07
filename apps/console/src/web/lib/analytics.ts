import type { AnalyticsRange, TrafficPoint, TrafficTotals } from "@edgeweir/contract";
import { formatBitRate, formatBytes, formatCompact, formatPercent, m } from "@/lib/i18n";
import { localMinutes } from "@/lib/time-buckets";

export const ANALYTICS_RANGES = [
  "1h",
  "6h",
  "24h",
  "7d",
  "30d",
] as const satisfies readonly AnalyticsRange[];

export const DEFAULT_RANGE: AnalyticsRange = "24h";

export function rangeLabel(range: AnalyticsRange): string {
  return {
    "1h": m.analytics_range_1h,
    "6h": m.analytics_range_6h,
    "24h": m.analytics_range_24h,
    "7d": m.analytics_range_7d,
    "30d": m.analytics_range_30d,
  }[range]();
}

/** part / whole as 0–100, or null when there is nothing to divide. */
export function ratio(part: number, whole: number): number | null {
  return whole > 0 ? (part / whole) * 100 : null;
}

/** Relative change from the previous period, or null when there is nothing to compare with. */
export function relativeChange(current: number | null, previous: number | null): number | null {
  if (current === null || previous === null || previous === 0) return null;
  return (current - previous) / previous;
}

export interface Metric {
  /** `metric-<id>` is the card's test id. */
  id: string;
  title: () => string;
  size: "lg" | "sm";
  total: (totals: TrafficTotals) => number | null;
  point: (point: TrafficPoint, bucketSeconds: number) => number | null;
  format: (value: number) => string;
  /** Which way the change indicator counts as good. */
  better: "up" | "down";
  /** Fixed value axis (ratios); otherwise it starts at zero and fits the data. */
  domain?: [number, number];
  /** What the metric's dialog breaks it down by, in tab order. */
  details: DetailSource[];
}

/**
 * A breakdown the metric dialog can show. `entities` becomes one view per available dimension
 * (sites unless the page is one site, and nodes).
 */
export type DetailSource =
  | { kind: "entities"; metric: "requests" | "bytesSent"; perSecond?: boolean }
  | { kind: "status"; statusClass?: 4 | 5 }
  | { kind: "cache" };

export type DetailView =
  | { kind: "entities"; by: "site" | "node"; metric: "requests" | "bytesSent"; perSecond?: boolean }
  | { kind: "status"; statusClass?: 4 | 5 }
  | { kind: "cache" }
  /** The metric's own series, when nothing else applies. */
  | { kind: "trend" };

export function detailViews(
  sources: DetailSource[],
  available: { site: boolean; node: boolean },
): DetailView[] {
  const views = sources.flatMap((source): DetailView[] =>
    source.kind === "entities"
      ? (["site", "node"] as const).filter((by) => available[by]).map((by) => ({ ...source, by }))
      : [source],
  );
  return views.length > 0 ? views : [{ kind: "trend" }];
}

export function detailViewId(view: DetailView): string {
  return view.kind === "entities" ? view.by : view.kind;
}

/** Categorical slots for breakdown series, in assignment order; the remainder is gray. */
export const SERIES_COLORS = [
  "var(--series-1)",
  "var(--series-2)",
  "var(--series-3)",
  "var(--series-4)",
  "var(--series-5)",
] as const;
export const OTHER_COLOR = "var(--series-other)";

/** Axis tick spacing per range, in minutes of the viewer's clock. */
const TICK_MINUTES: Record<AnalyticsRange, number> = {
  "1h": 10,
  "6h": 60,
  "24h": 240,
  "7d": 1_440,
  "30d": 7_200,
};

/** The first point after each clock boundary (every 10 minutes … every 5 days). */
export function timeTicks(times: string[], range: AnalyticsRange): string[] {
  const step = TICK_MINUTES[range];
  const ticks: string[] = [];
  let previous: number | null = null;
  for (const time of times) {
    const key = Math.floor(localMinutes(new Date(time).getTime()) / step);
    if (previous !== null && key !== previous) ticks.push(time);
    previous = key;
  }
  return ticks;
}

/** Whether a range's axis reads in dates rather than times of day. */
export function spansDays(range: AnalyticsRange): boolean {
  return range === "7d" || range === "30d";
}

export const METRICS: Metric[] = [
  {
    id: "requests",
    title: m.analytics_requests,
    size: "lg",
    total: (t) => t.requests,
    point: (p) => p.requests,
    format: formatCompact,
    better: "up",
    details: [{ kind: "entities", metric: "requests" }, { kind: "status" }],
  },
  {
    id: "data-transfer",
    title: m.analytics_data_transfer,
    size: "lg",
    total: (t) => t.bytesSent,
    point: (p) => p.bytesSent,
    format: formatBytes,
    better: "up",
    details: [{ kind: "entities", metric: "bytesSent" }],
  },
  {
    id: "hit-ratio",
    title: m.analytics_hit_ratio,
    size: "sm",
    total: (t) => ratio(t.cacheHits, t.cacheHits + t.cacheMisses),
    point: (p) => ratio(p.cacheHits, p.cacheHits + p.cacheMisses),
    format: formatPercent,
    better: "up",
    domain: [0, 100],
    details: [{ kind: "cache" }],
  },
  {
    id: "peak-bandwidth",
    title: m.analytics_peak_bandwidth,
    size: "sm",
    total: (t) => t.peakBytesPerSecond,
    point: (p, bucketSeconds) => p.bytesSent / bucketSeconds,
    format: formatBitRate,
    better: "up",
    details: [{ kind: "entities", metric: "bytesSent", perSecond: true }],
  },
  {
    id: "4xx-rate",
    title: m.analytics_4xx_rate,
    size: "sm",
    total: (t) => ratio(t.status4xx, t.requests),
    point: (p) => ratio(p.status4xx, p.requests),
    format: formatPercent,
    better: "down",
    details: [{ kind: "status", statusClass: 4 }],
  },
  {
    id: "5xx-rate",
    title: m.analytics_5xx_rate,
    size: "sm",
    total: (t) => ratio(t.status5xx, t.requests),
    point: (p) => ratio(p.status5xx, p.requests),
    format: formatPercent,
    better: "down",
    details: [{ kind: "status", statusClass: 5 }],
  },
];

export const STATUS_CLASSES = [
  { key: "status2xx", label: "2xx", color: "var(--status-2xx)" },
  { key: "status3xx", label: "3xx", color: "var(--status-3xx)" },
  { key: "status4xx", label: "4xx", color: "var(--status-4xx)" },
  { key: "status5xx", label: "5xx", color: "var(--status-5xx)" },
] as const satisfies readonly { key: keyof TrafficTotals; label: string; color: string }[];
