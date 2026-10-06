/**
 * Traffic of the fixture platform: a day/night cycle (quiet before dawn, busiest in the
 * evening), a softer weekend, a little noise and one burst about 9.5 hours ago that mostly hit
 * shop.example.com and was answered with 403 / 429.
 */
import type {
  AnalyticsRange,
  Traffic,
  TrafficBreakdown,
  TrafficBreakdownInput,
  TrafficPoint,
  TrafficTopItem,
  TrafficTotals,
} from "@edgeweir/contract";
import {
  HOUR,
  MINUTE,
  NOW,
  nodes,
  noise,
  siteAvgBytes,
  siteHitRatio,
  siteShare,
  sites,
} from "./world";

export const RANGES: Record<AnalyticsRange, { seconds: number; bucketSeconds: number }> = {
  "1h": { seconds: 3_600, bucketSeconds: 60 },
  "6h": { seconds: 21_600, bucketSeconds: 300 },
  "24h": { seconds: 86_400, bucketSeconds: 600 },
  "7d": { seconds: 604_800, bucketSeconds: 3_600 },
  "30d": { seconds: 2_592_000, bucketSeconds: 21_600 },
};

/** Requests per minute of the whole platform at its daily peak. */
const PEAK_RPM = 38_000;
const SPIKE_AT = NOW - 9.5 * HOUR;
const SPIKE_SIGMA = 12 * MINUTE;
const SHOP = sites.find((s) => s.name === "shop.example.com")?.id;

function daily(time: number): number {
  const date = new Date(time);
  const hour = date.getHours() + date.getMinutes() / 60;
  const wave = 0.5 - 0.5 * Math.cos((2 * Math.PI * (hour - 4.5)) / 24);
  const evening = 0.16 * Math.exp(-((hour - 21) ** 2) / 3.5);
  const weekend = date.getDay() === 0 || date.getDay() === 6 ? 0.82 : 1;
  return (0.24 + 0.66 * wave + evening) * weekend;
}

/** Extra requests per minute of the burst, as a multiple of the daily peak. */
function burst(time: number): number {
  return 2.4 * Math.exp(-((time - SPIKE_AT) ** 2) / (2 * SPIKE_SIGMA ** 2));
}

/** Noise that drifts smoothly over `period` ms, in [0, 1). */
function drift(time: number, period: number, seed: number): number {
  const at = time / period;
  const i = Math.floor(at);
  const f = at - i;
  const ease = f * f * (3 - 2 * f);
  return noise(i * 7 + seed) * (1 - ease) + noise((i + 1) * 7 + seed) * ease;
}

interface Sample {
  requests: number;
  attack: number;
}

/** Requests in the bucket starting at `time` for the whole platform or one site. */
function sample(time: number, bucketSeconds: number, siteId?: string): Sample {
  const minutes = bucketSeconds / 60;
  // Sample within the bucket so short bursts survive long buckets.
  const steps = Math.min(12, Math.max(1, Math.round(minutes / 5)));
  let base = 0;
  let attack = 0;
  for (let i = 0; i < steps; i++) {
    const at = time + ((i + 0.5) / steps) * bucketSeconds * 1000;
    base += daily(at);
    attack += burst(at);
  }
  base /= steps;
  attack /= steps;
  const seed = siteId ? siteId.charCodeAt(siteId.length - 1) * 977 : 0;
  const jitter =
    1 +
    (drift(time, 40 * MINUTE, seed) - 0.5) * 0.14 +
    (noise(Math.floor(time / 60_000) + seed) - 0.5) * 0.035;
  const share = siteId ? siteShare(siteId) : 1;
  const attackShare = siteId ? (siteId === SHOP ? 0.82 : share * 0.2) : 1;
  return {
    requests: Math.round(PEAK_RPM * minutes * base * jitter * share),
    attack: Math.round(PEAK_RPM * minutes * attack * attackShare),
  };
}

function pointAt(time: number, bucketSeconds: number, siteId?: string): TrafficPoint {
  const { requests: normal, attack } = sample(time, bucketSeconds, siteId);
  const requests = normal + attack;
  const seed = siteId ? siteId.charCodeAt(siteId.length - 1) * 31 : 3;
  // Busier hours keep more objects warm; a purge now and then costs a few points.
  const hit = Math.min(
    0.995,
    (siteId ? siteHitRatio(siteId) : 0.88) +
      (drift(time, 3 * HOUR, seed) - 0.5) * 0.06 -
      (attack / Math.max(1, normal)) * 0.05,
  );
  const avgBytes = siteId ? siteAvgBytes(siteId) : 61_000;
  const status3xx = Math.round(normal * 0.052);
  const status5xx = Math.round(normal * (0.0028 + drift(time, 25 * MINUTE, seed + 5) * 0.0024));
  const status4xx =
    Math.round(normal * (0.022 + drift(time, 50 * MINUTE, seed + 9) * 0.012)) +
    Math.round(attack * 0.93);
  const status2xx = Math.max(0, requests - status3xx - status4xx - status5xx);
  // Refused requests are answered by the edge: no cache lookup, a small body.
  const cacheable = normal * 0.94;
  const cacheHits = Math.round(cacheable * hit);
  return {
    time: new Date(time).toISOString(),
    requests,
    bytesSent: Math.round(normal * avgBytes + attack * 1_200),
    bytesReceived: Math.round(requests * 1_350),
    cacheHits,
    cacheMisses: Math.round(cacheable - cacheHits),
    status2xx,
    status3xx,
    status4xx,
    status5xx,
  };
}

function window(range: AnalyticsRange) {
  const { seconds, bucketSeconds } = RANGES[range];
  const bucketMs = bucketSeconds * 1000;
  // The window moves with the clock, so polling sees new buckets as they fill.
  const last = Math.floor(Date.now() / bucketMs) * bucketMs;
  const count = seconds / bucketSeconds;
  const from = last - (count - 1) * bucketMs;
  return { seconds, bucketSeconds, bucketMs, count, from, last };
}

function totalsOf(points: TrafficPoint[], bucketSeconds: number): TrafficTotals {
  const sum = (key: keyof Omit<TrafficPoint, "time">) =>
    points.reduce((total, point) => total + point[key], 0);
  return {
    requests: sum("requests"),
    bytesSent: sum("bytesSent"),
    bytesReceived: sum("bytesReceived"),
    cacheHits: sum("cacheHits"),
    cacheMisses: sum("cacheMisses"),
    status2xx: sum("status2xx"),
    status3xx: sum("status3xx"),
    status4xx: sum("status4xx"),
    status5xx: sum("status5xx"),
    peakBytesPerSecond: Math.max(0, ...points.map((p) => p.bytesSent / bucketSeconds)),
  };
}

export function trafficOf(range: AnalyticsRange, siteId?: string): Traffic {
  const w = window(range);
  const points = Array.from({ length: w.count }, (_, i) =>
    pointAt(w.from + i * w.bucketMs, w.bucketSeconds, siteId),
  );
  const previous = Array.from({ length: w.count }, (_, i) =>
    pointAt(w.from - w.seconds * 1000 + i * w.bucketMs, w.bucketSeconds, siteId),
  );
  return {
    range,
    bucketSeconds: w.bucketSeconds,
    from: new Date(w.from).toISOString(),
    to: new Date(w.last + w.bucketMs).toISOString(),
    points,
    totals: totalsOf(points, w.bucketSeconds),
    previous: totalsOf(previous, w.bucketSeconds),
  };
}

// ---------------------------------------------------------------------------------------------
// Rankings and breakdowns

const liveSites = sites.filter((s) => s.enabled && siteShare(s.id) > 0);
const onlineNodes = nodes.filter((n) => n.online);
const egressTotal = onlineNodes.reduce((t, n) => t + (n.metrics?.egressBps ?? 0), 0);
const nodeShare = (nodeId: string) =>
  (onlineNodes.find((n) => n.id === nodeId)?.metrics?.egressBps ?? 0) / egressTotal;

export function topSitesOf(range: AnalyticsRange, limit: number): TrafficTopItem[] {
  return liveSites
    .map((site) => {
      const t = trafficOf(range, site.id).totals;
      return {
        id: site.id,
        name: site.name,
        parentId: site.clusterId,
        parentName: site.clusterName,
        requests: t.requests,
        bytesSent: t.bytesSent,
        cacheHits: t.cacheHits,
        cacheMisses: t.cacheMisses,
      };
    })
    .sort((a, b) => b.requests - a.requests)
    .slice(0, limit);
}

export function topNodesOf(range: AnalyticsRange, limit: number): TrafficTopItem[] {
  const t = trafficOf(range).totals;
  return onlineNodes
    .map((node) => {
      const share = nodeShare(node.id);
      return {
        id: node.id,
        name: node.name,
        parentId: node.clusterId,
        parentName: node.clusterName,
        requests: Math.round(t.requests * share),
        bytesSent: Math.round(t.bytesSent * share),
        cacheHits: Math.round(t.cacheHits * share),
        cacheMisses: Math.round(t.cacheMisses * share),
      };
    })
    .sort((a, b) => b.requests - a.requests)
    .slice(0, limit);
}

const STATUS_CODES: Record<number, [string, number][]> = {
  2: [
    ["200", 0.9],
    ["206", 0.07],
    ["204", 0.03],
  ],
  3: [
    ["304", 0.71],
    ["301", 0.17],
    ["302", 0.12],
  ],
  4: [
    ["403", 0.41],
    ["404", 0.27],
    ["429", 0.22],
    ["499", 0.1],
  ],
  5: [
    ["502", 0.52],
    ["504", 0.29],
    ["500", 0.19],
  ],
};

const STATUS_KEY = {
  2: "status2xx",
  3: "status3xx",
  4: "status4xx",
  5: "status5xx",
} as const;

export function breakdownOf(input: TrafficBreakdownInput): TrafficBreakdown {
  const range = input.range ?? "24h";
  const traffic = trafficOf(range, input.siteId);
  const metric = input.metric ?? "requests";
  const limit = input.limit ?? 10;
  const times = traffic.points.map((p) => p.time);
  const value = (p: TrafficPoint) => (metric === "bytesSent" ? p.bytesSent : p.requests);
  type Item = TrafficBreakdown["items"][number];
  let items: Item[] = [];
  let totalSeries = traffic.points.map(value);
  if (input.by === "site") {
    items = liveSites.map((site) => {
      const series = trafficOf(range, site.id).points.map(value);
      return {
        id: site.id,
        name: site.name,
        parentId: site.clusterId,
        parentName: site.clusterName,
        total: series.reduce((a, b) => a + b, 0),
        series,
      };
    });
  } else if (input.by === "node") {
    items = onlineNodes.map((node) => {
      const share = nodeShare(node.id);
      const series = totalSeries.map((v, i) =>
        Math.round(v * share * (0.92 + noise(i * 13 + node.name.length) * 0.16)),
      );
      return {
        id: node.id,
        name: node.name,
        parentId: node.clusterId,
        parentName: node.clusterName,
        total: series.reduce((a, b) => a + b, 0),
        series,
      };
    });
  } else {
    const classes = input.statusClass ? [input.statusClass] : [2, 3, 4, 5];
    totalSeries = traffic.points.map((p) =>
      classes.reduce((t, c) => t + p[STATUS_KEY[c as 2 | 3 | 4 | 5]], 0),
    );
    items = classes.flatMap((c) =>
      (STATUS_CODES[c] ?? []).map(([code, weight]) => {
        const series = traffic.points.map((p) =>
          Math.round(p[STATUS_KEY[c as 2 | 3 | 4 | 5]] * weight),
        );
        return {
          id: code,
          name: code,
          parentId: null,
          parentName: null,
          total: series.reduce((a, b) => a + b, 0),
          series,
        };
      }),
    );
  }
  items.sort((a, b) => b.total - a.total);
  return {
    range,
    bucketSeconds: traffic.bucketSeconds,
    from: traffic.from,
    to: traffic.to,
    times,
    items: items.slice(0, limit),
    total: totalSeries.reduce((a, b) => a + b, 0),
    totalSeries,
  };
}

const URLS: [string, number][] = [
  ["/", 1],
  ["/assets/app-3f9c1a.js", 0.82],
  ["/api/v2/products?page=1", 0.61],
  ["/images/hero@2x.webp", 0.54],
  ["/assets/app-3f9c1a.css", 0.49],
  ["/api/v2/cart", 0.37],
  ["/fonts/inter-var.woff2", 0.31],
  ["/sitemap.xml", 0.12],
  ["/favicon.ico", 0.1],
  ["/robots.txt", 0.06],
];

const IPS: [string, number][] = [
  ["203.0.113.77", 1],
  ["198.51.100.204", 0.58],
  ["192.0.2.18", 0.33],
  ["2001:db8:4f::2a", 0.27],
  ["198.51.100.9", 0.21],
  ["203.0.113.140", 0.17],
  ["192.0.2.201", 0.12],
  ["2001:db8:91::7", 0.09],
  ["198.51.100.63", 0.07],
  ["203.0.113.5", 0.05],
];

export function topRequestsOf(
  range: AnalyticsRange,
  by: "url" | "ip",
  limit: number,
  siteId?: string,
) {
  const total = trafficOf(range, siteId).totals.requests;
  const list = by === "url" ? URLS : IPS;
  const head = by === "url" ? 0.19 : 0.034;
  return {
    approximate: true as const,
    items: list
      .slice(0, limit)
      .map(([value, weight]) => ({ value, requests: Math.round(total * head * weight) })),
  };
}
