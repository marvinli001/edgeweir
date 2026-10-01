import type { AnalyticsRange, TrafficPoint, TrafficTotals } from "@edgeweir/contract";
import { formatBitRate, formatBytes, formatCompact, formatPercent, m } from "@/lib/i18n";

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

const MINUTE_MS = 60_000;

/** Minutes since the epoch on the viewer's wall clock, so boundaries fall on local hours and days. */
function localMinutes(time: number): number {
  return Math.floor((time - new Date(time).getTimezoneOffset() * MINUTE_MS) / MINUTE_MS);
}

/** Bar widths that read as clock units, in minutes. */
const GROUP_MINUTES = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1_440];

/**
 * Merges adjacent buckets into groups aligned to the viewer's clock, so a bar chart keeps at most
 * about `max` bars (hourly bars for a day of 10-minute buckets). Each group is labeled by the start
 * of its span; the first one may be partial.
 */
export function groupBuckets(times: string[], series: number[][], bucketSeconds: number, max = 32) {
  const bucketMinutes = bucketSeconds / 60;
  const spanMinutes =
    GROUP_MINUTES.find(
      (span) => span % bucketMinutes === 0 && (times.length * bucketMinutes) / span <= max,
    ) ?? times.length * bucketMinutes;
  const groups: { time: string; values: number[] }[] = [];
  let key: number | null = null;
  times.forEach((time, index) => {
    const next = Math.floor(localMinutes(new Date(time).getTime()) / spanMinutes);
    if (next !== key) {
      key = next;
      // Start of the span on the wall clock, back in UTC.
      const start = next * spanMinutes * MINUTE_MS;
      const offset = new Date(start).getTimezoneOffset() * MINUTE_MS;
      groups.push({ time: new Date(start + offset).toISOString(), values: series.map(() => 0) });
    }
    const values = groups.at(-1)?.values;
    if (!values) return;
    for (let i = 0; i < series.length; i++) {
      values[i] = (values[i] ?? 0) + (series[i]?.[index] ?? 0);
    }
  });
  return groups;
}

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
