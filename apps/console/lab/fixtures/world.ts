/**
 * A small production platform: 3 clusters, 4 regions, 10 nodes (one lagging behind, one
 * offline), 12 sites. Names are reserved documentation domains (RFC 2606) and addresses come
 * from the documentation ranges (RFC 5737, RFC 3849).
 */
import {
  type AttentionItem,
  type ClientIpSettings,
  type Cluster,
  type ClusterListenPorts,
  DEFAULT_REQUEST_BODY_LIMIT,
  type Node,
  type NodeGroup,
  type OriginHealth,
  type Region,
  type Revision,
  type Site,
  type SiteDelivery,
} from "@edgeweir/contract";
import { cacheConditionExpression, RULES_BODY_LIMIT } from "@edgeweir/rule-engine";

export const NOW = Date.now();
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/**
 * Days access logs are kept, per storage (settings.logRetention; the lab keeps what is saved
 * until reload). The console stores logs in PostgreSQL (analyticsMode "lite").
 */
export const logRetention = { postgresDays: 14, clickhouseDays: 30 };

export const ago = (ms: number) => new Date(NOW - ms).toISOString();
export const ahead = (ms: number) => new Date(NOW + ms).toISOString();

/** A stable v4-shaped UUID per kind and number. */
export const id = (kind: number, n: number) =>
  `00000000-0000-4000-8${kind.toString(16).padStart(3, "0")}-${n.toString(16).padStart(12, "0")}`;

/** Deterministic noise in [0, 1) for a key. */
export function noise(key: number): number {
  let t = (key + 0x6d2b79f5) | 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// ---------------------------------------------------------------------------------------------
// Regions, clusters, node groups

export const regions: Region[] = [
  { id: id(1, 1), name: "Tokyo", code: "ap-tokyo", nodeGroupCount: 1, createdAt: ago(210 * DAY) },
  {
    id: id(1, 2),
    name: "Singapore",
    code: "ap-singapore",
    nodeGroupCount: 1,
    createdAt: ago(180 * DAY),
  },
  {
    id: id(1, 3),
    name: "Frankfurt",
    code: "eu-frankfurt",
    nodeGroupCount: 1,
    createdAt: ago(160 * DAY),
  },
  {
    id: id(1, 4),
    name: "Virginia",
    code: "us-virginia",
    nodeGroupCount: 1,
    createdAt: ago(150 * DAY),
  },
];

const regionOf = (code: string) => regions.find((r) => r.code === code) as Region;

interface ClusterSeed {
  id: string;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  /** The cache zone of every node. */
  cache: Cluster["cache"];
  /** Listener ports besides 80 and 443. */
  listen: { http: number[]; https: number[] };
  /** How the HTTP(S) listeners find the client address. */
  clientIp: ClientIpSettings;
}

const DIRECT: ClientIpSettings = {
  mode: "direct",
  trustedCidrs: [],
  header: "",
  dropForwardedFor: false,
};

const clusterSeeds: ClusterSeed[] = [
  {
    id: id(2, 1),
    name: "apac-edge",
    description: "Tokyo + Singapore",
    revision: 184,
    createdAt: ago(210 * DAY),
    cache: { maxSizeGb: 400, inactiveDays: 7 },
    // The shop's admin answers on 8443; a staging hostname on 8080.
    listen: { http: [8080], https: [8443] },
    // Visitors reach the nodes directly; origins see only the node as X-Forwarded-For.
    clientIp: { ...DIRECT, dropForwardedFor: true },
  },
  {
    id: id(2, 2),
    name: "eu-edge",
    description: "Frankfurt",
    revision: 97,
    createdAt: ago(160 * DAY),
    cache: { maxSizeGb: 200, inactiveDays: 7 },
    listen: { http: [], https: [] },
    // Behind the data center's layer-4 balancer, which speaks PROXY protocol.
    clientIp: { ...DIRECT, mode: "proxy_protocol" },
  },
  {
    id: id(2, 3),
    name: "na-edge",
    description: "Virginia",
    revision: 142,
    createdAt: ago(150 * DAY),
    // The download mirror keeps large files around longer.
    cache: { maxSizeGb: 1000, inactiveDays: 14 },
    listen: { http: [], https: [8443] },
    // Behind a cloud load balancer that appends the client to X-Forwarded-For.
    clientIp: {
      mode: "header",
      trustedCidrs: ["192.0.2.224/27", "2001:db8:c:ff00::/56"],
      header: "x-forwarded-for",
      dropForwardedFor: false,
    },
  },
];

const [APAC, EU, NA] = clusterSeeds as [ClusterSeed, ClusterSeed, ClusterSeed];

function group(
  n: number,
  cluster: ClusterSeed,
  name: string,
  region: string,
  flags: { isDefault?: boolean; isCanary?: boolean } = {},
): NodeGroup {
  const r = regionOf(region);
  return {
    id: id(3, n),
    clusterId: cluster.id,
    name,
    isDefault: flags.isDefault ?? false,
    isCanary: flags.isCanary ?? false,
    regionId: r.id,
    regionName: r.name,
    regionCode: r.code,
    nodeCount: 0,
    createdAt: cluster.createdAt,
  };
}

export const nodeGroups: NodeGroup[] = [
  group(1, APAC, "tokyo", "ap-tokyo", { isDefault: true }),
  group(2, APAC, "singapore", "ap-singapore", { isCanary: true }),
  group(3, EU, "frankfurt", "eu-frankfurt", { isDefault: true }),
  group(4, NA, "virginia", "us-virginia", { isDefault: true }),
];

// ---------------------------------------------------------------------------------------------
// Nodes

type NodeHealth = "ok" | "behind" | "offline";

interface NodeSeed {
  name: string;
  group: number;
  v4: string;
  v6: string;
  cpu: number;
  egressMbps: number;
  health?: NodeHealth;
  /** The node's own cache zone size (GB), instead of its cluster's. */
  cacheGb?: number;
}

const nodeSeeds: NodeSeed[] = [
  {
    name: "tyo-edge-01",
    group: 1,
    v4: "203.0.113.11",
    v6: "2001:db8:a::11",
    cpu: 34,
    egressMbps: 412,
  },
  {
    name: "tyo-edge-02",
    group: 1,
    v4: "203.0.113.12",
    v6: "2001:db8:a::12",
    cpu: 29,
    egressMbps: 377,
  },
  {
    name: "sin-edge-01",
    group: 2,
    v4: "203.0.113.21",
    v6: "2001:db8:a::21",
    cpu: 41,
    egressMbps: 298,
    // The canary has a smaller disk.
    cacheGb: 160,
  },
  {
    name: "sin-edge-02",
    group: 2,
    v4: "203.0.113.22",
    v6: "2001:db8:a::22",
    cpu: 87,
    egressMbps: 264,
    health: "behind",
  },
  {
    name: "fra-edge-01",
    group: 3,
    v4: "198.51.100.31",
    v6: "2001:db8:b::31",
    cpu: 22,
    egressMbps: 236,
  },
  {
    name: "fra-edge-02",
    group: 3,
    v4: "198.51.100.32",
    v6: "2001:db8:b::32",
    cpu: 26,
    egressMbps: 251,
  },
  {
    name: "fra-edge-03",
    group: 3,
    v4: "198.51.100.33",
    v6: "2001:db8:b::33",
    cpu: 0,
    egressMbps: 0,
    health: "offline",
  },
  {
    name: "iad-edge-01",
    group: 4,
    v4: "192.0.2.41",
    v6: "2001:db8:c::41",
    cpu: 38,
    egressMbps: 344,
  },
  {
    name: "iad-edge-02",
    group: 4,
    v4: "192.0.2.42",
    v6: "2001:db8:c::42",
    cpu: 31,
    egressMbps: 318,
  },
  {
    name: "iad-edge-03",
    group: 4,
    v4: "192.0.2.43",
    v6: "2001:db8:c::43",
    cpu: 27,
    egressMbps: 289,
    // The newest node came with twice the disk.
    cacheGb: 2000,
  },
];

const FEATURES = [
  "tls-v1",
  "tls-pending-domains-v1",
  "http01-v1",
  "http3-v1",
  "metrics-v1",
  "access-logs-v1",
  "bans-v1",
  "kernel-ban-v1",
  "active-health-v1",
  "session-affinity-v1",
  "challenge-v1",
  "ja4-v1",
  "origin-http2-v1",
  "brotli-v1",
  "zstd-v1",
  "modsecurity-v1",
  "error-pages-v1",
  "purge-tag-v1",
  "prefetch-v2",
  "probe-health-v1",
  "rule-log-v1",
  "stats-sequence-v1",
  "self-upgrade-v1",
  "rules-v1",
  "rules-v2",
  "rules-v3",
  "l4-v1",
  "l4-v2",
  "cache-zone-v1",
  "edge-ports-v1",
  "client-ip-v1",
  "site-content-v1",
  "geoip-country-v1",
  "geoip-subdivision-v1",
  "geoip-city-v1",
  "geoip-asn-v1",
];

export const nodes: Node[] = nodeSeeds.map((seed, index) => {
  const g = nodeGroups.find((candidate) => candidate.id === id(3, seed.group)) as NodeGroup;
  const cluster = clusterSeeds.find((c) => c.id === g.clusterId) as ClusterSeed;
  const region = regions.find((r) => r.id === g.regionId) as Region;
  g.nodeCount++;
  const health = seed.health ?? "ok";
  const online = health !== "offline";
  const lastSeen = online ? ago(4_000 + index * 1_300) : ago(47 * MINUTE);
  const applied = health === "behind" ? cluster.revision - 2 : cluster.revision;
  const memoryTotal = 16 * 1024 ** 3;
  const cacheBytes = (seed.cacheGb ?? cluster.cache.maxSizeGb) * 1024 ** 3;
  // The newest node (its own, larger disk) is still filling up.
  const cacheFilled = (seed.cacheGb ?? 0) > 1000 ? 0.18 : 0.62 + noise(index * 13) * 0.3;
  return {
    id: id(4, index + 1),
    name: seed.name,
    clusterId: cluster.id,
    clusterName: cluster.name,
    nodeGroupId: g.id,
    nodeGroupName: g.name,
    regionName: region.name,
    hostname: `${seed.name}.edge.example.net`,
    status: "active",
    online,
    lastSeenAt: lastSeen,
    enrolledAt: ago((120 - index * 7) * DAY),
    agentVersion: "0.2.1",
    supportedFeatures: FEATURES,
    upgradeRequired: false,
    engine: "openresty",
    engineVersion: "1.27.1.2",
    os: "linux",
    arch: index % 3 === 2 ? "arm64" : "amd64",
    ipAddresses: [seed.v4, seed.v6],
    certFingerprint: `sha256:${(index * 7919).toString(16).padStart(8, "0")}c0ffee`,
    certNotAfter: ahead((60 + index) * DAY),
    appliedRevision: applied,
    appliedContentHash: `${applied.toString(16)}a9f3e1`,
    targetRevision: cluster.revision,
    applyState: health === "behind" ? "applying" : "applied",
    applyMessage: "",
    dataPlaneHealthy: online,
    banStatus: {
      appliedSequence: String(9_812 + index),
      entries: 120 + index * 13,
      capacity: 65_536,
      unappliedIds: [],
      unapplied: 0,
      kernelEntries: 40 + index,
      autoEvicted: "0",
      reportedAt: lastSeen,
    },
    probeEnabled: index % 3 === 0,
    metrics: online
      ? {
          cpuPercent: seed.cpu,
          load1: (seed.cpu / 100) * 8,
          load5: (seed.cpu / 100) * 7.2,
          load15: (seed.cpu / 100) * 6.5,
          memoryUsedBytes: Math.round(memoryTotal * (0.38 + seed.cpu / 300)),
          memoryTotalBytes: memoryTotal,
          egressBps: seed.egressMbps * 1_000_000,
          activeConnections: Math.round(seed.egressMbps * 31),
          reportedAt: lastSeen,
        }
      : null,
    schedulingAddresses: [
      { address: seed.v4, level: 0, source: "reported", reachable: online },
      { address: seed.v6, level: 0, source: "reported", reachable: online },
    ],
    schedulingLevel: 0,
    remoteAddress: seed.v4,
    dnsIssue: null,
    authError: null,
    cache: {
      maxSizeGb: seed.cacheGb ?? null,
      // As last measured, with the heartbeat.
      usage: {
        usedBytes: Math.round(cacheBytes * cacheFilled),
        maxBytes: cacheBytes,
        measuredAt: lastSeen,
      },
    },
  };
});

export const nodeCity: Record<string, string> = {
  "ap-tokyo": "Tokyo",
  "ap-singapore": "Singapore",
  "eu-frankfurt": "Frankfurt",
  "us-virginia": "Virginia",
};

// ---------------------------------------------------------------------------------------------
// Revisions

const SITE_REASONS = ["site_updated", "site_purged", "site_protection_updated", "site_waf_updated"];

export function revisionsOf(clusterId: string, count = 12): Revision[] {
  const cluster = clusterSeeds.find((c) => c.id === clusterId);
  if (!cluster) return [];
  const own = sites.filter((s) => s.clusterId === clusterId);
  const out: Revision[] = [];
  let at = NOW - (cluster === APAC ? 4 * MINUTE : cluster === EU ? 52 * MINUTE : 2.4 * HOUR);
  for (let i = 0; i < count; i++) {
    const revision = cluster.revision - i;
    const site = own[(revision * 7) % own.length];
    const pick = Math.floor(noise(revision * 31 + i) * 10);
    const reasonCode =
      pick === 0
        ? "rules_updated"
        : pick === 1
          ? "certificate_updated"
          : (SITE_REASONS[pick % SITE_REASONS.length] as string);
    out.push({
      clusterId,
      revision,
      contentHash: `${(revision * 2654435761).toString(16).slice(-10)}`,
      siteCount: own.filter((s) => s.enabled).length,
      reason: reasonCode,
      reasonCode,
      reasonParams: reasonCode === "rules_updated" ? {} : { site: site?.name ?? "" },
      createdAt: new Date(at).toISOString(),
    });
    at -= (35 + noise(revision) * 280) * MINUTE;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Sites

interface SiteSeed {
  name: string;
  domains: string[];
  cluster: ClusterSeed;
  /** Share of the platform's requests. */
  share: number;
  /** Bytes per response. */
  avgBytes: number;
  hitRatio: number;
  enabled?: boolean;
  delivery?: SiteDelivery["state"];
  updated: number;
  created: number;
}

const siteSeeds: SiteSeed[] = [
  {
    name: "example.com",
    domains: ["example.com", "www.example.com"],
    cluster: APAC,
    share: 0.21,
    avgBytes: 38_000,
    hitRatio: 0.93,
    updated: 26 * HOUR,
    created: 205 * DAY,
  },
  {
    name: "shop.example.com",
    domains: ["shop.example.com", "m.shop.example.com"],
    cluster: APAC,
    share: 0.17,
    avgBytes: 52_000,
    hitRatio: 0.81,
    updated: 4 * MINUTE,
    created: 190 * DAY,
  },
  {
    name: "api.example.com",
    domains: ["api.example.com"],
    cluster: NA,
    share: 0.14,
    avgBytes: 4_800,
    hitRatio: 0.32,
    updated: 2.4 * HOUR,
    created: 148 * DAY,
  },
  {
    name: "static.example.net",
    domains: ["static.example.net", "img.example.net"],
    cluster: APAC,
    share: 0.12,
    avgBytes: 96_000,
    hitRatio: 0.97,
    updated: 3 * DAY,
    created: 176 * DAY,
  },
  {
    name: "app.example.net",
    domains: ["app.example.net"],
    cluster: NA,
    share: 0.09,
    avgBytes: 22_000,
    hitRatio: 0.74,
    updated: 9 * HOUR,
    created: 120 * DAY,
  },
  {
    name: "media.example.net",
    domains: ["media.example.net", "video.example.net"],
    cluster: APAC,
    share: 0.08,
    avgBytes: 410_000,
    hitRatio: 0.95,
    delivery: "partial",
    updated: 6 * MINUTE,
    created: 98 * DAY,
  },
  {
    name: "docs.example.org",
    domains: ["docs.example.org"],
    cluster: EU,
    share: 0.06,
    avgBytes: 31_000,
    hitRatio: 0.9,
    updated: 52 * MINUTE,
    created: 140 * DAY,
  },
  {
    name: "cdn.example.org",
    domains: ["cdn.example.org", "assets.example.org"],
    cluster: EU,
    share: 0.05,
    avgBytes: 74_000,
    hitRatio: 0.96,
    updated: 5 * DAY,
    created: 155 * DAY,
  },
  {
    name: "auth.example.net",
    domains: ["auth.example.net"],
    cluster: EU,
    share: 0.03,
    avgBytes: 6_200,
    hitRatio: 0.12,
    updated: 13 * HOUR,
    created: 88 * DAY,
  },
  {
    name: "download.example.com",
    domains: ["download.example.com", "mirror.example.com"],
    cluster: NA,
    share: 0.03,
    avgBytes: 2_400_000,
    hitRatio: 0.88,
    updated: 2 * DAY,
    created: 61 * DAY,
  },
  {
    name: "blog.example.org",
    domains: ["blog.example.org"],
    cluster: EU,
    share: 0.02,
    avgBytes: 27_000,
    hitRatio: 0.91,
    updated: 8 * DAY,
    created: 44 * DAY,
  },
  {
    name: "legacy.example.org",
    domains: ["legacy.example.org"],
    cluster: NA,
    share: 0,
    avgBytes: 18_000,
    hitRatio: 0.6,
    enabled: false,
    updated: 19 * DAY,
    created: 260 * DAY,
  },
];

function deliveryOf(seed: SiteSeed): SiteDelivery {
  const live = nodes.filter((n) => n.clusterId === seed.cluster.id && n.online);
  const state = seed.enabled === false ? "disabled" : (seed.delivery ?? "live");
  const behind = state === "partial" ? 1 : 0;
  return {
    state,
    totalNodes: live.length,
    servingNodes: state === "disabled" ? 0 : live.length,
    currentNodes: state === "disabled" ? 0 : live.length - behind,
    canary: null,
  };
}

const DEFAULT_ORIGIN_SETTINGS: Site["originSettings"] = {
  policy: "weighted_random",
  tlsVerify: true,
  maxFails: 3,
  recoverySeconds: 30,
  connectTimeoutMs: 10_000,
  sendTimeoutMs: 60_000,
  readTimeoutMs: 60_000,
  keepalive: true,
  keepaliveIdleSeconds: 60,
  keepaliveMaxRequests: 1000,
  websocket: true,
  protocol: "http1",
  grpc: false,
  activeHealthCheck: {
    enabled: false,
    path: "/",
    method: "GET",
    expectedStatusMin: 200,
    expectedStatusMax: 399,
    host: "",
    intervalSeconds: 30,
    timeoutSeconds: 5,
    healthyThreshold: 2,
    unhealthyThreshold: 3,
  },
  sessionAffinity: { enabled: false, ttlSeconds: 3600 },
  tries: 3,
  statusRetry: true,
};

type OriginSeed = Partial<Site["origins"][number]> & { address: string };

function origins(siteIndex: number, list: OriginSeed[]): Site["origins"] {
  return list.map((o, i) => ({
    id: id(6, siteIndex * 100 + i + 1),
    port: o.scheme === "http" ? 80 : 443,
    scheme: "https",
    weight: 1,
    backup: false,
    hostHeader: "",
    sni: "",
    group: "",
    s3: null,
    ...o,
  }));
}

const ORIGINS: Record<string, OriginSeed[]> = {
  "shop.example.com": [
    { address: "198.51.100.10", weight: 60 },
    { address: "198.51.100.11", weight: 40 },
    { address: "203.0.113.50", backup: true },
    { address: "origin-media.example.com", group: "media", weight: 1 },
  ],
  "api.example.com": [
    { address: "192.0.2.80", weight: 50 },
    { address: "192.0.2.81", weight: 50 },
  ],
};

/**
 * A cache rule: the builder's lists (stored as their expression, lists sorted the way the
 * server returns them) or an expression of another shape (lists empty).
 */
type CacheRuleSeed = Partial<Omit<Site["cacheRules"][number], "id" | "priority">>;

const DAY_S = 86_400;

function cacheRules(siteIndex: number, list: CacheRuleSeed[]): Site["cacheRules"] {
  return list.map((seed, i) => {
    const lists = {
      pathPrefixes: seed.pathPrefixes ?? [],
      paths: [...(seed.paths ?? [])].sort(),
      extensions: [...(seed.extensions ?? [])].sort(),
    };
    return {
      id: id(12, siteIndex * 100 + i + 1),
      priority: (i + 1) * 10,
      statusCodes: [],
      minSizeBytes: 0,
      maxSizeBytes: 0,
      action: "cache",
      edgeTtlSeconds: 3600,
      originCacheControl: "respect",
      staleWhileRevalidateSeconds: 0,
      staleIfErrorSeconds: 0,
      cacheAuthorized: false,
      browserTtlSeconds: 0,
      cacheSetCookie: false,
      ...seed,
      ...lists,
      expression: seed.expression ?? cacheConditionExpression(lists),
    };
  });
}

const ASSETS = ["css", "js", "woff2", "svg", "webp", "avif", "png", "jpg", "ico"];

const CACHE_RULES: Record<string, CacheRuleSeed[]> = {
  "example.com": [
    {
      extensions: ASSETS,
      edgeTtlSeconds: 30 * DAY_S,
      originCacheControl: "override",
      browserTtlSeconds: 7 * DAY_S,
    },
    { paths: ["/", "/index.html"], edgeTtlSeconds: 600, staleWhileRevalidateSeconds: 300 },
  ],
  "shop.example.com": [
    {
      extensions: ASSETS,
      edgeTtlSeconds: 30 * DAY_S,
      originCacheControl: "override",
      staleIfErrorSeconds: DAY_S,
      browserTtlSeconds: 7 * DAY_S,
    },
    {
      pathPrefixes: ["/images/", "/media/"],
      edgeTtlSeconds: 7 * DAY_S,
      staleWhileRevalidateSeconds: 3600,
      staleIfErrorSeconds: DAY_S,
    },
    {
      expression:
        'starts_with(http.request.uri.path, "/api/v2/products") and http.request.method in {"GET" "HEAD"}',
      statusCodes: [200],
      edgeTtlSeconds: 60,
      originCacheControl: "override",
      staleWhileRevalidateSeconds: 300,
      staleIfErrorSeconds: 3600,
    },
    {
      paths: ["/", "/robots.txt", "/sitemap.xml"],
      statusCodes: [200, 301],
      edgeTtlSeconds: 300,
      staleWhileRevalidateSeconds: 120,
    },
    {
      pathPrefixes: ["/collections/", "/products/"],
      statusCodes: [200],
      edgeTtlSeconds: 900,
      staleWhileRevalidateSeconds: 600,
      staleIfErrorSeconds: 6 * 3600,
      browserTtlSeconds: 60,
      // The origin sets a recently-viewed cookie on every product page.
      cacheSetCookie: true,
    },
    {
      pathPrefixes: ["/account/", "/checkout", "/api/v2/cart"],
      action: "bypass",
      edgeTtlSeconds: 0,
    },
    {
      expression: 'http.request.cookies["preview"] eq "1" or http.request.uri.args["draft"] ne ""',
      action: "bypass",
      edgeTtlSeconds: 0,
    },
    {
      extensions: ["mp4", "zip"],
      minSizeBytes: 8 * 1024 * 1024,
      edgeTtlSeconds: 30 * DAY_S,
      originCacheControl: "override",
    },
  ],
  "api.example.com": [
    {
      expression:
        'http.request.method eq "GET" and starts_with(http.request.uri.path, "/v1/catalog")',
      statusCodes: [200],
      edgeTtlSeconds: 30,
      staleWhileRevalidateSeconds: 60,
    },
    { pathPrefixes: ["/v1/"], action: "bypass", edgeTtlSeconds: 0 },
  ],
  "static.example.net": [
    {
      pathPrefixes: ["/"],
      edgeTtlSeconds: 365 * DAY_S,
      originCacheControl: "override",
      browserTtlSeconds: 30 * DAY_S,
    },
  ],
  "media.example.net": [
    {
      extensions: ["m3u8"],
      edgeTtlSeconds: 2,
      originCacheControl: "override",
      staleWhileRevalidateSeconds: 2,
    },
    {
      extensions: ["m4s", "mp4", "ts"],
      edgeTtlSeconds: 30 * DAY_S,
      originCacheControl: "override",
    },
  ],
  "docs.example.org": [{ pathPrefixes: ["/"], edgeTtlSeconds: 3600, staleIfErrorSeconds: DAY_S }],
};

/** shop.example.com varies its cache by the parameters it reads, currency and device. */
const CACHE_SETTINGS: Record<string, Partial<Site["cacheSettings"]>> = {
  "example.com": {
    cacheKey: {
      query: "exclude",
      queryParams: ["fbclid", "gclid", "utm_*"],
      sortQuery: true,
      headers: [],
      cookies: [],
      deviceType: false,
      includeHost: true,
    },
  },
  "shop.example.com": {
    cacheKey: {
      query: "include",
      queryParams: ["page", "q", "sort", "variant"],
      sortQuery: true,
      headers: ["accept-language"],
      cookies: ["currency"],
      deviceType: true,
      includeHost: true,
    },
    keepCacheTag: true,
    // The storefront's CMS purges a product page with PURGE when it is edited.
    purgeMethod: { enabled: true, keySet: true },
  },
  "static.example.net": {
    cacheKey: {
      query: "ignore",
      queryParams: [],
      sortQuery: false,
      headers: [],
      cookies: [],
      deviceType: false,
      includeHost: false,
    },
    xCache: false,
  },
};

const DEFAULT_CONTENT_SETTINGS: Site["contentSettings"] = {
  charset: { name: "off", force: false, uppercase: false },
  requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
  rulesBodyLimit: RULES_BODY_LIMIT.default,
};

const CONTENT_SETTINGS: Record<string, Site["contentSettings"]> = {
  // Product photo uploads from the admin stay under 20 MiB; text answers in UTF-8.
  "shop.example.com": {
    charset: { name: "utf-8", force: false, uppercase: false },
    requestBodyLimit: 20 * 1024 * 1024,
    // Login and checkout forms are small; rules read up to 128 KiB of them.
    rulesBodyLimit: 128 * 1024,
  },
  "api.example.com": { ...DEFAULT_CONTENT_SETTINGS, requestBodyLimit: 10 * 1024 * 1024 },
  // The old CMS sends pages without a charset.
  "legacy.example.org": {
    charset: { name: "gb18030", force: true, uppercase: true },
    requestBodyLimit: DEFAULT_REQUEST_BODY_LIMIT,
    rulesBodyLimit: RULES_BODY_LIMIT.default,
  },
};

/** The shop's admin answers on 8443 as well. */
const SITE_PORTS: Record<string, Site["ports"]> = {
  "shop.example.com": { http: [80], https: [443, 8443] },
};

/** Tags of the fixture sites (the operator's own grouping, ADR-0042). */
export const tagSeeds = [
  { id: id(60, 1), name: "production" },
  { id: id(60, 2), name: "staging" },
  { id: id(60, 3), name: "static" },
  { id: id(60, 4), name: "api" },
  { id: id(60, 5), name: "legacy" },
  { id: id(60, 6), name: "retired" },
];
const tagOf = (name: string) => tagSeeds.find((tag) => tag.name === name) ?? { id: "", name };
const SITE_TAGS: Record<string, string[]> = {
  "example.com": ["production"],
  "shop.example.com": ["production"],
  "api.example.com": ["production", "api"],
  "static.example.net": ["production", "static"],
  "app.example.net": ["staging"],
  "media.example.net": ["production", "static"],
  "cdn.example.org": ["static"],
  "auth.example.net": ["production", "api"],
  "download.example.com": ["static"],
  "legacy.example.org": ["legacy"],
};

export const sites: Site[] = siteSeeds.map((seed, index) => {
  const originList =
    ORIGINS[seed.name] ??
    (index % 2 === 0
      ? [{ address: `198.51.100.${100 + index}` }, { address: `198.51.100.${120 + index}` }]
      : [{ address: `203.0.113.${100 + index}` }]);
  const settings: Site["originSettings"] =
    seed.name === "shop.example.com"
      ? {
          ...DEFAULT_ORIGIN_SETTINGS,
          activeHealthCheck: {
            ...DEFAULT_ORIGIN_SETTINGS.activeHealthCheck,
            enabled: true,
            path: "/healthz",
          },
          sessionAffinity: { enabled: true, ttlSeconds: 3600 },
        }
      : seed.name === "api.example.com"
        ? {
            ...DEFAULT_ORIGIN_SETTINGS,
            protocol: "http2",
            grpc: true,
            policy: "round_robin",
            // Writes are not retried on another origin after a 5xx.
            tries: 2,
            statusRetry: false,
          }
        : DEFAULT_ORIGIN_SETTINGS;
  return {
    id: id(5, index + 1),
    name: seed.name,
    enabled: seed.enabled ?? true,
    clusterId: seed.cluster.id,
    clusterName: seed.cluster.name,
    domains: seed.domains,
    // Sites from before CNAME prefixes keep their id; newer ones have 8 random characters.
    cnamePrefix:
      index % 3 === 0 ? id(5, index + 1) : `s${(index * 7919).toString(36).padStart(7, "x")}`,
    tags: (SITE_TAGS[seed.name] ?? []).map(tagOf),
    origins: origins(index + 1, originList),
    cacheRules: cacheRules(index + 1, CACHE_RULES[seed.name] ?? []),
    originSettings: settings,
    cacheSettings: {
      cacheKey: {
        query: "all",
        queryParams: [],
        sortQuery: false,
        headers: [],
        cookies: [],
        deviceType: false,
        includeHost: true,
      },
      rangeSlice: seed.avgBytes > 400_000,
      keepCacheTag: false,
      xCache: true,
      purgeMethod: { enabled: false, keySet: false },
      ...CACHE_SETTINGS[seed.name],
    },
    contentSettings: CONTENT_SETTINGS[seed.name] ?? DEFAULT_CONTENT_SETTINGS,
    cacheGeneration: 3 + index,
    ports: SITE_PORTS[seed.name] ?? { http: [80], https: [443] },
    delivery: deliveryOf(seed),
    createdAt: ago(seed.created),
    updatedAt: ago(seed.updated),
  };
});

export const siteSeedOf = (siteId: string) =>
  siteSeeds[sites.findIndex((s) => s.id === siteId)] as SiteSeed | undefined;

export const siteShare = (siteId: string) => siteSeedOf(siteId)?.share ?? 0;
export const siteHitRatio = (siteId: string) => siteSeedOf(siteId)?.hitRatio ?? 0.85;
export const siteAvgBytes = (siteId: string) => siteSeedOf(siteId)?.avgBytes ?? 40_000;

export const starredIds = new Set([sites[0]?.id, sites[1]?.id, sites[2]?.id] as string[]);

export const clusters: Cluster[] = clusterSeeds.map((seed) => {
  const own = nodes.filter((n) => n.clusterId === seed.id);
  const live = own.filter((n) => n.online && n.status === "active");
  return {
    id: seed.id,
    name: seed.name,
    description: seed.description,
    nodeCount: own.length,
    onlineNodeCount: own.filter((n) => n.online).length,
    liveNodeCount: live.length,
    appliedNodeCount: live.filter((n) => n.appliedRevision === seed.revision).length,
    siteCount: sites.filter((s) => s.clusterId === seed.id).length,
    latestRevision: revisionsOf(seed.id, 1)[0] ?? null,
    clientIpMode: seed.clientIp.mode,
    cache: seed.cache,
    createdAt: seed.createdAt,
  };
});

const clusterSeedOf = (clusterId: string) => clusterSeeds.find((c) => c.id === clusterId);

/** Active nodes of a cluster without a node feature. */
export const nodesWithout = (clusterId: string, feature: string) =>
  nodes
    .filter(
      (n) =>
        n.clusterId === clusterId &&
        n.status === "active" &&
        !n.supportedFeatures.includes(feature),
    )
    .map((n) => ({ id: n.id, name: n.name }));

/** A cluster's extra listener ports (clusters.listenPorts). */
export function listenPortsOf(clusterId: string): ClusterListenPorts {
  const listen = clusterSeedOf(clusterId)?.listen ?? { http: [], https: [] };
  return {
    clusterId,
    httpPorts: listen.http,
    httpsPorts: listen.https,
    nodesWithout: nodesWithout(clusterId, "edge-ports-v1"),
  };
}

/** A cluster's client address setting (clusters.clientIp). */
export function clientIpOf(clusterId: string) {
  return {
    clusterId,
    settings: clusterSeedOf(clusterId)?.clientIp ?? DIRECT,
    nodesWithout: nodesWithout(clusterId, "client-ip-v1"),
  };
}

export const attention: AttentionItem[] = [
  {
    // The offline node's removal is held back by the mass removal protection (fixtures/infra.ts).
    kind: "dns_blocked",
    clusterId: EU.id,
    clusterName: EU.name,
    revision: 186,
    at: ago(46 * MINUTE),
    count: 0,
    version: "",
  },
  {
    kind: "nodes_unhealthy",
    clusterId: EU.id,
    clusterName: EU.name,
    revision: null,
    at: null,
    count: 1,
    version: "",
  },
  {
    kind: "nodes_lagging",
    clusterId: APAC.id,
    clusterName: APAC.name,
    revision: APAC.revision,
    at: null,
    count: 1,
    version: "",
  },
];

/** One origin of shop.example.com fails its checks on a Singapore node; the backup stands by. */
export function originHealthOf(siteId: string): OriginHealth[] {
  const site = sites.find((s) => s.id === siteId);
  if (!site) return [];
  const live = nodes.filter((n) => n.clusterId === site.clusterId && n.online);
  return site.origins.map((origin, index) => {
    const failing = site.name === "shop.example.com" && index === 1;
    const failingNode = live[live.length - 1];
    const entries = live.flatMap((node) =>
      (["passive", "active"] as const)
        .filter((source) => source === "passive" || site.originSettings.activeHealthCheck.enabled)
        .map((source) => {
          const down = failing && node === failingNode;
          return {
            nodeId: node.id,
            nodeName: node.name,
            source,
            healthy: !down,
            consecutiveFailures: down ? 4 : 0,
            lastError: down ? "connect() timed out" : "",
            lastErrorCode: down ? "timeout" : "",
            lastErrorParams: {},
            lastFailureAt: down ? ago(3 * MINUTE) : null,
            downUntil: down && source === "passive" ? ahead(27_000) : null,
            reportedAt: ago(6_000),
          };
        }),
    );
    return {
      originId: origin.id,
      downNodes: failing ? 1 : 0,
      onlineNodes: live.length,
      lastError: failing ? "connect() timed out" : "",
      lastErrorCode: failing ? "timeout" : "",
      lastErrorParams: {},
      lastFailureAt: failing ? ago(3 * MINUTE) : null,
      nodes: entries,
    };
  });
}
