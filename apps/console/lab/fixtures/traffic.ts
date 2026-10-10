/**
 * Traffic of the fixture platform: a day/night cycle (quiet before dawn, busiest in the
 * evening), a softer weekend, a little noise and one burst about 9.5 hours ago that mostly hit
 * shop.example.com and was answered with 403 / 429.
 */
import type {
  AnalyticsRange,
  StatsDimensions,
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

// ---------------------------------------------------------------------------------------------
// Statistics dimensions (countries, networks, referrers, clients, protocols, blocks)

/** Client countries of the platform: request weight and bytes per request against the mean. */
const COUNTRY_WEIGHTS: [country: string, weight: number, bytes: number][] = [
  ["JP", 26, 1.1],
  ["US", 18, 1.25],
  ["SG", 10, 0.95],
  ["CN", 9, 0.7],
  ["KR", 7, 1],
  ["DE", 6, 1.15],
  ["TW", 5, 0.9],
  ["AU", 4, 1.05],
  ["GB", 4, 1.1],
  ["HK", 3, 0.9],
  ["IN", 2.5, 0.6],
  ["FR", 2, 1],
  ["NL", 1.5, 1.6],
  ["CA", 1.2, 1.1],
  ["BR", 1, 0.8],
  ["", 0.8, 0.5],
];

/** Where a cluster's audience lives: weight multipliers by country. */
const CLUSTER_AUDIENCE: Record<string, Record<string, number>> = {
  "apac-edge": { JP: 1.4, SG: 1.5, CN: 1.3, KR: 1.2, TW: 1.3, HK: 1.3, AU: 1.2 },
  "eu-edge": { DE: 3, GB: 3, FR: 3, NL: 3 },
  "na-edge": { US: 2.5, CA: 3, BR: 2 },
};

/** Client networks (documentation AS numbers) and the country each serves. */
export const NETWORKS: { asn: number; name: string; country: string; share: number }[] = [
  { asn: 64496, name: "Example Fiber KK", country: "JP", share: 0.6 },
  { asn: 64497, name: "Example Mobile Japan", country: "JP", share: 0.4 },
  { asn: 64498, name: "Example Cable US", country: "US", share: 0.7 },
  { asn: 64499, name: "Example Cloud Hosting", country: "US", share: 0.3 },
  { asn: 64500, name: "Example Telecom SG", country: "SG", share: 1 },
  { asn: 64501, name: "Example Broadband CN", country: "CN", share: 1 },
  { asn: 64502, name: "Example Telecom KR", country: "KR", share: 1 },
  { asn: 64503, name: "Example Netz DE", country: "DE", share: 1 },
  { asn: 64504, name: "Example Telecom TW", country: "TW", share: 1 },
  { asn: 64505, name: "Example Internet AU", country: "AU", share: 1 },
  { asn: 64506, name: "Example Broadband UK", country: "GB", share: 1 },
  { asn: 64507, name: "Example Datacenter NL", country: "NL", share: 1 },
];

const REFERRERS: [host: string, share: number][] = [
  ["search.example", 0.34],
  ["blog.example.org", 0.14],
  ["news.example.net", 0.11],
  ["social.example", 0.09],
  ["mail.example.com", 0.05],
  ["forum.example.org", 0.04],
  ["video.example", 0.03],
  ["partners.example.net", 0.02],
  ["deals.example", 0.015],
  ["wiki.example.org", 0.01],
];

type Shares = Record<string, number>;
const CLIENTS: Record<
  "web" | "api",
  Record<"browsers" | "oses" | "devices" | "http" | "tls", Shares>
> = {
  web: {
    browsers: {
      chrome: 0.44,
      safari: 0.22,
      edge: 0.08,
      firefox: 0.04,
      samsung: 0.025,
      wechat: 0.03,
      qq: 0.01,
      uc: 0.008,
      opera: 0.007,
      yandex: 0.003,
      ie: 0.002,
      crawler: 0.07,
      tool: 0.04,
      other: 0.015,
    },
    oses: {
      windows: 0.29,
      ios: 0.25,
      android: 0.21,
      macos: 0.14,
      linux: 0.05,
      chromeos: 0.01,
      harmonyos: 0.01,
      other: 0.04,
    },
    devices: { desktop: 0.48, mobile: 0.41, tablet: 0.04, crawler: 0.07 },
    http: { "2": 0.63, "3": 0.22, "1.1": 0.145, "1.0": 0.002, other: 0.003 },
    tls: { "1.3": 0.86, "1.2": 0.11, none: 0.03 },
  },
  api: {
    browsers: { tool: 0.52, chrome: 0.2, safari: 0.1, crawler: 0.02, other: 0.16 },
    oses: { linux: 0.45, android: 0.14, ios: 0.12, windows: 0.1, macos: 0.06, other: 0.13 },
    devices: { other: 0.52, mobile: 0.26, desktop: 0.2, crawler: 0.02 },
    http: { "1.1": 0.58, "2": 0.4, "3": 0.02 },
    tls: { "1.3": 0.7, "1.2": 0.29, none: 0.01 },
  },
};

/** Block reasons of refused requests: shop.example.com took the burst, the others see little. */
const BLOCKS: Record<"burst" | "quiet", Shares> = {
  burst: {
    rate_limit: 0.38,
    ip_banned: 0.21,
    crs: 0.14,
    cc: 0.1,
    challenge: 0.09,
    rule: 0.04,
    auth: 0.02,
    referer: 0.015,
    region: 0.005,
  },
  quiet: { referer: 0.4, crs: 0.3, user_agent: 0.2, region: 0.1 },
};

const keyed = (total: number, shares: Shares) =>
  Object.entries(shares)
    .map(([key, share]) => ({ key, requests: Math.round(total * share) }))
    .filter((item) => item.requests > 0)
    .sort((a, b) => b.requests - a.requests);

/** Sites in clusters with a node without stats-dims-v1 (an older release). */
const PARTIAL_SITES = new Set(["download.example.com"]);

export function dimensionsOf(range: AnalyticsRange, siteId?: string): StatsDimensions {
  const site = siteId ? sites.find((s) => s.id === siteId) : undefined;
  const totals = trafficOf(range, siteId).totals;
  const audience = (site && CLUSTER_AUDIENCE[site.clusterName]) ?? {};
  const weights = COUNTRY_WEIGHTS.map(([country, weight, bytes]) => {
    const seed = site ? noise(site.name.length * 31 + country.charCodeAt(0)) : 0.5;
    return { country, weight: weight * (audience[country] ?? 1) * (0.8 + seed * 0.4), bytes };
  });
  const weightSum = weights.reduce((t, c) => t + c.weight, 0);
  const bytesSum = weights.reduce((t, c) => t + c.weight * c.bytes, 0);
  const countries = weights
    .map((c) => ({
      country: c.country,
      requests: Math.round((totals.requests * c.weight) / weightSum),
      bytesSent: Math.round((totals.bytesSent * c.weight * c.bytes) / bytesSum),
    }))
    .sort((a, b) => b.requests - a.requests);
  const byCountry = new Map(countries.map((c) => [c.country, c.requests]));
  const asns = NETWORKS.map((n) => ({
    asn: n.asn,
    name: n.name,
    requests: Math.round((byCountry.get(n.country) ?? 0) * n.share * 0.9),
  }))
    .filter((n) => n.requests > 0)
    .sort((a, b) => b.requests - a.requests);
  const api = site?.name === "api.example.com" || site?.name === "auth.example.net";
  const profile = CLIENTS[api ? "api" : "web"];
  const referers = (api ? [] : REFERRERS)
    .filter(([host]) => host !== site?.name)
    .map(([host, share]) => ({ host, requests: Math.round(totals.requests * 0.22 * share) }));
  const burst = !site || site.id === SHOP;
  const refused = Math.round(totals.status4xx * (burst ? 0.8 : 0.1));
  const blockReasons = keyed(refused, BLOCKS[burst ? "burst" : "quiet"]);
  const issued = burst
    ? Math.round(refused * (BLOCKS.burst.challenge ?? 0) * 1.4 + totals.requests * 0.002)
    : 0;
  return {
    countries,
    asns,
    referers,
    browsers: keyed(totals.requests, profile.browsers),
    oses: keyed(totals.requests, profile.oses),
    devices: keyed(totals.requests, profile.devices),
    httpVersions: keyed(totals.requests, profile.http),
    tlsVersions: keyed(totals.requests, profile.tls),
    blockReasons,
    challenges: { issued, passed: Math.round(issued * 0.41) },
    unsupportedNodes: !site || PARTIAL_SITES.has(site.name) ? 1 : 0,
  };
}
