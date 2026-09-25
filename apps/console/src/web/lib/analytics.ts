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
  },
  {
    id: "data-transfer",
    title: m.analytics_data_transfer,
    size: "lg",
    total: (t) => t.bytesSent,
    point: (p) => p.bytesSent,
    format: formatBytes,
    better: "up",
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
  },
  {
    id: "peak-bandwidth",
    title: m.analytics_peak_bandwidth,
    size: "sm",
    total: (t) => t.peakBytesPerSecond,
    point: (p, bucketSeconds) => p.bytesSent / bucketSeconds,
    format: formatBitRate,
    better: "up",
  },
  {
    id: "4xx-rate",
    title: m.analytics_4xx_rate,
    size: "sm",
    total: (t) => ratio(t.status4xx, t.requests),
    point: (p) => ratio(p.status4xx, p.requests),
    format: formatPercent,
    better: "down",
  },
  {
    id: "5xx-rate",
    title: m.analytics_5xx_rate,
    size: "sm",
    total: (t) => ratio(t.status5xx, t.requests),
    point: (p) => ratio(p.status5xx, p.requests),
    format: formatPercent,
    better: "down",
  },
];

export const STATUS_CLASSES = [
  { key: "status2xx", label: "2xx", color: "var(--status-2xx)" },
  { key: "status3xx", label: "3xx", color: "var(--status-3xx)" },
  { key: "status4xx", label: "4xx", color: "var(--status-4xx)" },
  { key: "status5xx", label: "5xx", color: "var(--status-5xx)" },
] as const satisfies readonly { key: keyof TrafficTotals; label: string; color: string }[];
