/**
 * System area: alerts, the audit log, system settings (general, probes, service accounts) and the
 * operator's AccessKeys. Follows world.ts: fra-edge-03 offline for ~47 min, sin-edge-02 lagging
 * under high CPU, one failing origin of shop.example.com and the burst on it ~9.5 hours ago.
 * Id kinds 40–49 (see `id()`).
 */
import type {
  AlertEventKind,
  AlertKind,
  AuditLogEntry,
  Probe,
  ProbeResultDto,
  ServiceAccount,
} from "@edgeweir/contract";
import type { Fixtures } from "./define";
import {
  ago,
  ahead,
  clusters,
  DAY,
  HOUR,
  id,
  MINUTE,
  NOW,
  nodeGroups,
  nodes,
  noise,
  regions,
  sites,
} from "./world";

const iso = (time: number) => new Date(time).toISOString();
const round1 = (value: number) => Math.round(value * 10) / 10;

const siteNamed = (name: string) => {
  const site = sites.find((s) => s.name === name);
  if (!site) throw new Error(`[lab] no site ${name}`);
  return site;
};
const nodeNamed = (name: string) => {
  const node = nodes.find((n) => n.name === name);
  if (!node) throw new Error(`[lab] no node ${name}`);
  return node;
};
const clusterNamed = (name: string) => {
  const cluster = clusters.find((c) => c.name === name);
  if (!cluster) throw new Error(`[lab] no cluster ${name}`);
  return cluster;
};

const NODE_CHANNEL_URL = "https://node.example.net:8443";
const CONSOLE_VERSION = "20261006-afad833";
const CA_SHA256 = Array.from({ length: 32 }, (_, i) =>
  Math.floor(noise(4_000 + i) * 256)
    .toString(16)
    .padStart(2, "0"),
).join("");

// ---------------------------------------------------------------------------------------------
// Alerts

const channels = [
  {
    id: id(40, 1),
    name: "Ops webhook",
    kind: "webhook",
    enabled: true,
    platform: true,
    locale: "en" as const,
    lastError: "",
  },
  {
    id: id(40, 2),
    name: "On-call mailbox",
    kind: "email",
    enabled: true,
    platform: false,
    locale: "zh-CN" as const,
    lastError: "",
  },
  {
    id: id(40, 3),
    name: "Ops group",
    kind: "telegram",
    enabled: true,
    platform: true,
    locale: "zh-CN" as const,
    lastError: "alert_send_failed",
  },
  {
    id: id(40, 4),
    name: "Night shift",
    kind: "dingtalk",
    enabled: true,
    platform: false,
    locale: "zh-CN" as const,
    lastError: "",
  },
  {
    id: id(40, 5),
    name: "Team room",
    kind: "wecom",
    enabled: false,
    platform: false,
    locale: "zh-CN" as const,
    lastError: "",
  },
];

const ALL_KINDS: AlertKind[] = [
  "node_offline",
  "certificate_expiring",
  "origin_unavailable",
  "high_5xx",
  "cc_mitigation",
];

const siteRefs = (...names: string[]) => names.map((name) => ({ id: siteNamed(name).id, name }));

/** One per channel; "Night shift" has none, so a new subscription can be added. */
const subscriptions = [
  {
    id: id(42, 1),
    channelId: id(40, 1),
    channelName: "Ops webhook",
    kinds: ["node_offline", "origin_unavailable", "high_5xx", "cc_mitigation"] as AlertKind[],
    enabled: true,
    allSites: false,
    sites: siteRefs("shop.example.com", "api.example.com", "example.com"),
  },
  {
    id: id(42, 2),
    channelId: id(40, 2),
    channelName: "On-call mailbox",
    kinds: ALL_KINDS,
    enabled: true,
    allSites: true,
    sites: [],
  },
  {
    id: id(42, 3),
    channelId: id(40, 3),
    channelName: "Ops group",
    kinds: ["certificate_expiring", "origin_unavailable"] as AlertKind[],
    enabled: true,
    allSites: false,
    sites: siteRefs(
      "example.com",
      "shop.example.com",
      "static.example.net",
      "app.example.net",
      "media.example.net",
      "docs.example.org",
      "cdn.example.org",
      "download.example.com",
    ),
  },
  {
    id: id(42, 4),
    channelId: id(40, 5),
    channelName: "Team room",
    kinds: ["high_5xx"] as AlertKind[],
    enabled: false,
    allSites: false,
    sites: siteRefs("blog.example.org", "docs.example.org"),
  },
];

interface AlertEvent {
  id: string;
  siteId: string | null;
  kind: AlertEventKind;
  status: "firing" | "resolved";
  occurredAt: string;
  siteName: string;
}

interface EventSeed {
  kind: AlertEventKind;
  /** A site name; node and platform alerts have none. */
  site?: string;
  /** Node, cluster or "rule · node" of an alert without a site. */
  name?: string;
  firing: number;
  resolved?: number;
}

const eventSeeds: EventSeed[] = [
  // The second origin of shop.example.com fails on a Singapore node (world.ts originHealthOf).
  { kind: "origin_unavailable", site: "shop.example.com", firing: 3 * MINUTE },
  // sin-edge-02 runs hot (87 % CPU) and still applies its revision.
  { kind: "scheduling_action", name: "CPU over 85% · sin-edge-02", firing: 18 * MINUTE },
  // fra-edge-03 stopped reporting 47 minutes ago.
  { kind: "node_offline", name: "fra-edge-03", firing: 45 * MINUTE },
  { kind: "scheduling_action", name: "Probe loss · fra-edge-03", firing: 46 * MINUTE },
  { kind: "certificate_expiring", site: "blog.example.org", firing: 5.2 * HOUR },
  // The burst on shop.example.com, answered with 403 / 429.
  {
    kind: "cc_mitigation",
    site: "shop.example.com",
    firing: 9.5 * HOUR + 18 * MINUTE,
    resolved: 9.5 * HOUR - 24 * MINUTE,
  },
  {
    kind: "high_5xx",
    site: "api.example.com",
    firing: 26 * HOUR + 12 * MINUTE,
    resolved: 25 * HOUR + 50 * MINUTE,
  },
  {
    kind: "origin_unavailable",
    site: "media.example.net",
    firing: 2 * DAY + 3 * HOUR,
    resolved: 2 * DAY + 2.6 * HOUR,
  },
  {
    kind: "config_rollout_failed",
    name: "apac-edge",
    firing: 3 * DAY + 5 * HOUR,
    resolved: 3 * DAY + 4.5 * HOUR,
  },
  {
    kind: "dns_mass_removal_blocked",
    name: "eu-edge",
    firing: 4 * DAY + 2 * HOUR,
    resolved: 4 * DAY + 1.4 * HOUR,
  },
  {
    kind: "node_offline",
    name: "iad-edge-02",
    firing: 5 * DAY + 1 * HOUR,
    resolved: 5 * DAY + 20 * MINUTE,
  },
  {
    kind: "config_rule_invalid",
    name: "Block old API clients",
    firing: 6 * DAY + 4 * HOUR,
    resolved: 6 * DAY + 3.8 * HOUR,
  },
  {
    kind: "certificate_expiring",
    site: "cdn.example.org",
    firing: 4 * DAY + 6 * HOUR,
    resolved: 1 * DAY + 10 * MINUTE,
  },
];

const events: AlertEvent[] = (() => {
  const out: AlertEvent[] = [];
  let n = 0;
  for (const seed of eventSeeds) {
    const siteId = seed.site ? siteNamed(seed.site).id : null;
    const siteName = seed.site ?? seed.name ?? "";
    const base = { siteId, kind: seed.kind, siteName };
    out.push({ ...base, id: id(41, ++n), status: "firing", occurredAt: ago(seed.firing) });
    if (seed.resolved !== undefined)
      out.push({ ...base, id: id(41, ++n), status: "resolved", occurredAt: ago(seed.resolved) });
  }
  return out.sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));
})();

/** A site's alerts and the offline alerts of the nodes that serve it. */
function eventsOf(siteId: string | undefined): AlertEvent[] {
  if (!siteId) return events;
  const site = sites.find((s) => s.id === siteId);
  if (!site) return [];
  const serving = new Set(nodes.filter((n) => n.clusterId === site.clusterId).map((n) => n.name));
  return events.filter(
    (e) => e.siteId === siteId || (e.kind === "node_offline" && serving.has(e.siteName)),
  );
}

// ---------------------------------------------------------------------------------------------
// Probes

const PROBE_PORTS = [
  { port: 80, method: "http" },
  { port: 443, method: "https" },
] as const;
const ATTEMPTS = 3;

/** Median round trip between regions, in ms. */
const RTT: Record<string, number> = {
  "ap-tokyo|ap-tokyo": 1.3,
  "ap-tokyo|ap-singapore": 69,
  "ap-tokyo|eu-frankfurt": 226,
  "ap-tokyo|us-virginia": 148,
  "ap-singapore|ap-singapore": 1.1,
  "ap-singapore|eu-frankfurt": 158,
  "ap-singapore|us-virginia": 214,
  "eu-frankfurt|eu-frankfurt": 0.9,
  "eu-frankfurt|us-virginia": 88,
  "us-virginia|us-virginia": 1.2,
};
const rttBetween = (a: string, b: string) => RTT[`${a}|${b}`] ?? RTT[`${b}|${a}`] ?? 120;

const regionCodeOf = (node: (typeof nodes)[number]) =>
  nodeGroups.find((g) => g.id === node.nodeGroupId)?.regionCode ?? "";

const regionByCode = (code: string) => {
  const region = regions.find((r) => r.code === code);
  if (!region) throw new Error(`[lab] no region ${code}`);
  return region;
};

interface ProbeSeed {
  name: string;
  region: string;
  /** offline: last seen hours ago; pending: a token was created, nothing enrolled yet. */
  state?: "offline" | "pending";
  arch?: string;
  created: number;
}

const probeSeeds: ProbeSeed[] = [
  { name: "probe-tyo-01", region: "ap-tokyo", created: 200 * DAY },
  { name: "probe-sin-01", region: "ap-singapore", arch: "arm64", created: 8 * DAY },
  { name: "probe-fra-01", region: "eu-frankfurt", created: 150 * DAY },
  { name: "probe-iad-01", region: "us-virginia", created: 140 * DAY },
  { name: "probe-iad-02", region: "us-virginia", state: "offline", created: 64 * DAY },
  { name: "probe-tyo-02", region: "ap-tokyo", state: "pending", created: 21 * MINUTE },
];

const PROBE_OFFLINE_FOR = 3.2 * HOUR;

interface Prober {
  kind: "probe" | "node";
  id: string;
  name: string;
  regionCode: string;
  regionId: string | null;
  regionName: string | null;
  ownNodeId: string | null;
  /** Time of its latest round. */
  checkedAt: number;
}

const probers: Prober[] = [
  ...probeSeeds.flatMap((seed, index): Prober[] => {
    if (seed.state === "pending") return [];
    const region = regionByCode(seed.region);
    return [
      {
        kind: "probe",
        id: id(47, index + 1),
        name: seed.name,
        regionCode: region.code,
        regionId: region.id,
        regionName: region.name,
        ownNodeId: null,
        checkedAt:
          seed.state === "offline"
            ? NOW - PROBE_OFFLINE_FOR
            : NOW - 2_000 - noise(470 + index) * 6_000,
      },
    ];
  }),
  ...nodes
    .filter((n) => n.probeEnabled)
    .map((node, index): Prober => {
      const group = nodeGroups.find((g) => g.id === node.nodeGroupId);
      return {
        kind: "node",
        id: node.id,
        name: node.name,
        regionCode: group?.regionCode ?? "",
        regionId: group?.regionId ?? null,
        regionName: group?.regionName ?? null,
        ownNodeId: node.id,
        checkedAt: node.online
          ? NOW - 2_500 - noise(480 + index) * 6_000
          : Date.parse(node.lastSeenAt ?? ago(47 * MINUTE)),
      };
    }),
];

/** The latest result per target of a prober: every active node × address × listener port. */
function resultsOf(prober: Prober, seed: number): ProbeResultDto[] {
  const out: ProbeResultDto[] = [];
  nodes.forEach((node, ni) => {
    if (node.id === prober.ownNodeId || node.status !== "active") return;
    const down = !node.online && prober.checkedAt > Date.parse(node.lastSeenAt ?? iso(NOW));
    const busy = (node.metrics?.cpuPercent ?? 0) > 80;
    const base = rttBetween(prober.regionCode, regionCodeOf(node));
    node.ipAddresses.forEach((address, ai) => {
      PROBE_PORTS.forEach(({ port, method }, pi) => {
        const key = seed * 997 + ni * 31 + ai * 7 + pi;
        const lost = down
          ? ATTEMPTS
          : busy && noise(key + 5) > 0.55
            ? 1
            : noise(key + 9) > 0.985
              ? 1
              : 0;
        const rtt =
          base * (ai === 1 ? 1.04 : 1) +
          (pi === 1 ? base * 0.12 + 1.5 : 0) +
          (busy ? 8 + noise(key + 3) * 14 : 0) +
          (noise(key) - 0.5) * base * 0.06;
        out.push({
          proberKind: prober.kind,
          proberId: prober.id,
          proberName: prober.name,
          regionId: prober.regionId,
          regionName: prober.regionName,
          nodeId: node.id,
          nodeName: node.name,
          address,
          port,
          method,
          sent: ATTEMPTS,
          lost,
          lossPercent: round1((lost / ATTEMPTS) * 100),
          rttMs: lost === ATTEMPTS ? 0 : Math.max(1, Math.round(rtt)),
          error: lost === 0 ? "" : down && ai === 1 ? "unreachable" : "timeout",
          checkedAt: iso(prober.checkedAt - (ni * 4 + ai * 2 + pi) * 35),
        });
      });
    });
  });
  return out;
}

const probeResults: ProbeResultDto[] = probers.flatMap((p, index) => resultsOf(p, index + 1));

const PROBE_TARGETS = nodes.filter((n) => n.status === "active").length * 2 * PROBE_PORTS.length;

function lastRoundOf(probeId: string): Probe["lastRound"] {
  const rows = probeResults.filter((r) => r.proberId === probeId);
  const prober = probers.find((p) => p.id === probeId);
  if (!rows.length || !prober) return null;
  const sent = rows.reduce((sum, r) => sum + r.sent, 0);
  const lost = rows.reduce((sum, r) => sum + r.lost, 0);
  const answering = rows.filter((r) => r.lost < r.sent);
  return {
    checkedAt: iso(prober.checkedAt),
    results: rows.length,
    failed: rows.filter((r) => r.lost === r.sent).length,
    lossPercent: round1((lost / sent) * 100),
    avgRttMs: answering.length
      ? round1(answering.reduce((sum, r) => sum + r.rttMs, 0) / answering.length)
      : null,
  };
}

const probes: Probe[] = probeSeeds.map((seed, index) => {
  const region = regionByCode(seed.region);
  const probeId = id(47, index + 1);
  const pending = seed.state === "pending";
  const offline = seed.state === "offline";
  return {
    id: probeId,
    name: seed.name,
    regionId: region.id,
    regionName: region.name,
    regionCode: region.code,
    enabled: true,
    online: !pending && !offline,
    lastSeenAt: pending ? null : offline ? ago(PROBE_OFFLINE_FOR) : ago(1_500 + index * 900),
    enrolledAt: pending ? null : ago(seed.created - 4 * MINUTE),
    hostname: pending ? "" : `${seed.name}.probe.example.net`,
    agentVersion: pending ? "" : offline ? "0.2.0" : "0.2.1",
    os: pending ? "" : "linux",
    arch: pending ? "" : (seed.arch ?? "amd64"),
    certNotAfter: pending ? null : ahead((38 + index * 9) * DAY),
    targets: PROBE_TARGETS,
    lastRound: pending ? null : lastRoundOf(probeId),
    createdAt: ago(seed.created),
  };
});

// ---------------------------------------------------------------------------------------------
// Service accounts and AccessKeys

const serviceAccounts: ServiceAccount[] = [
  {
    id: id(44, 1),
    name: "deploy-bot",
    scopes: ["sites:read", "sites:write"],
    enabled: true,
    keys: [
      {
        id: id(45, 1),
        name: "ci",
        prefix: "ews_7kQp2fXa",
        createdAt: ago(60 * DAY),
        lastUsedAt: ago(1 * HOUR + 10 * MINUTE),
        revokedAt: null,
      },
      {
        id: id(45, 2),
        name: "ci-2025",
        prefix: "ews_Rb40mTzc",
        createdAt: ago(190 * DAY),
        lastUsedAt: ago(61 * DAY),
        revokedAt: ago(60 * DAY),
      },
    ],
    createdAt: ago(190 * DAY),
    updatedAt: ago(60 * DAY),
  },
  {
    id: id(44, 2),
    name: "usage-export",
    scopes: ["sites:read", "usage:read"],
    enabled: true,
    keys: [
      {
        id: id(45, 3),
        name: "billing",
        prefix: "ews_c9LwE3uN",
        createdAt: ago(27 * DAY),
        lastUsedAt: ago(4 * MINUTE),
        revokedAt: null,
      },
    ],
    createdAt: ago(27 * DAY),
    updatedAt: ago(27 * DAY),
  },
  {
    id: id(44, 3),
    name: "inventory",
    scopes: ["clusters:read", "system:read"],
    enabled: true,
    keys: [
      {
        id: id(45, 4),
        name: "primary",
        prefix: "ews_Hn5vY8sd",
        createdAt: ago(98 * DAY),
        lastUsedAt: ago(6 * HOUR),
        revokedAt: null,
      },
      {
        id: id(45, 5),
        name: "standby",
        prefix: "ews_p2GxK6qe",
        createdAt: ago(98 * DAY),
        lastUsedAt: null,
        revokedAt: null,
      },
    ],
    createdAt: ago(98 * DAY),
    updatedAt: ago(41 * DAY),
  },
  {
    id: id(44, 4),
    name: "status-board",
    scopes: ["sites:read"],
    enabled: false,
    keys: [],
    createdAt: ago(130 * DAY),
    updatedAt: ago(33 * DAY),
  },
];

/** The operator's AccessKeys, newest first. */
const accessKeys = [
  {
    id: id(46, 4),
    name: "backup-script",
    prefix: "ewk_Tq3m",
    scope: "read" as const,
    enabled: true,
    createdAt: ago(3 * DAY),
    lastUsedAt: null,
  },
  {
    id: id(46, 3),
    name: "ci-deploy",
    prefix: "ewk_8hVc",
    scope: "write" as const,
    enabled: true,
    createdAt: ago(90 * DAY),
    lastUsedAt: ago(2.4 * HOUR),
  },
  {
    id: id(46, 2),
    name: "status-dashboard",
    prefix: "ewk_Lp2x",
    scope: "read" as const,
    enabled: true,
    createdAt: ago(150 * DAY),
    lastUsedAt: ago(40_000),
  },
  {
    id: id(46, 1),
    name: "old-laptop",
    prefix: "ewk_Zr9a",
    scope: "write" as const,
    enabled: false,
    createdAt: ago(200 * DAY),
    lastUsedAt: ago(75 * DAY),
  },
];

// ---------------------------------------------------------------------------------------------
// Audit log

interface Actor {
  type: string;
  id: string;
  name: string;
  ip: string;
  userAgent: string;
}

const DESKTOP =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15";
const PHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1";

const OPERATOR: Actor = {
  type: "user",
  id: "lab-operator",
  name: "Operator",
  ip: "192.0.2.10",
  userAgent: DESKTOP,
};
const OPERATOR_PHONE: Actor = { ...OPERATOR, ip: "198.51.100.23", userAgent: PHONE };
const API_KEY: Actor = {
  type: "api_key",
  id: "lab-operator",
  name: "Operator",
  ip: "198.51.100.200",
  userAgent: "ci-deploy/1.4",
};
const DEPLOY_BOT: Actor = {
  type: "service_account",
  id: id(44, 1),
  name: "deploy-bot",
  ip: "203.0.113.60",
  userAgent: "deploy-bot/2.1",
};
const SYSTEM: Actor = { type: "system", id: "", name: "system", ip: "", userAgent: "" };
const ANONYMOUS: Actor = {
  type: "user",
  id: "",
  name: "",
  ip: "203.0.113.200",
  userAgent: "python-requests/2.32.3",
};
const nodeActor = (name: string): Actor => {
  const node = nodeNamed(name);
  return { type: "node", id: node.id, name, ip: node.ipAddresses[0] ?? "", userAgent: "" };
};
const probeActor = (index: number): Actor => {
  const seed = probeSeeds[index - 1];
  return { type: "probe", id: id(47, index), name: seed?.name ?? "", ip: "", userAgent: "" };
};

interface Target {
  type: string;
  id: string;
  name: string;
}

const siteT = (name: string): Target => ({ type: "site", id: siteNamed(name).id, name });
const clusterT = (name: string): Target => ({ type: "cluster", id: clusterNamed(name).id, name });
const nodeT = (name: string): Target => ({ type: "node", id: nodeNamed(name).id, name });
const userT: Target = { type: "user", id: "lab-operator", name: "Operator" };
const settingT = (key: string): Target => ({ type: "system_setting", id: key, name: "" });
const other = (type: string, n: number, name: string): Target => ({ type, id: id(48, n), name });

const revisionOf = (site: string) => clusters.find((c) => c.id === siteNamed(site).clusterId);

interface AuditSeed {
  at: number;
  actor: Actor;
  action: string;
  target?: Target;
  metadata?: Record<string, unknown>;
}

const siteUpdate = (
  at: number,
  actor: Actor,
  site: string,
  changed: string[],
  back = 0,
): AuditSeed => ({
  at,
  actor,
  action: "site.update",
  target: siteT(site),
  metadata: { changed, revision: (revisionOf(site)?.latestRevision?.revision ?? 100) - back },
});

const purge = (at: number, actor: Actor, n: number, site: string, urls: string[]): AuditSeed => ({
  at,
  actor,
  action: "cache.purge",
  target: other("cache_task", n, urls.length === 1 ? (urls[0] ?? "") : `${urls.length} × url`),
  metadata: {
    type: "url",
    targets: urls,
    count: urls.length,
    sites: [site],
    nodes: nodes.filter((n) => n.clusterId === siteNamed(site).clusterId && n.online).length,
    skippedNodes: nodes.filter((n) => n.clusterId === siteNamed(site).clusterId && !n.online)
      .length,
  },
});

/** What happened recently, newest first; older routine entries follow below. */
const storySeeds: AuditSeed[] = [
  siteUpdate(4 * MINUTE, OPERATOR, "shop.example.com", ["origins"]),
  siteUpdate(6 * MINUTE, OPERATOR, "media.example.net", ["cacheRules"], 1),
  purge(9 * MINUTE, OPERATOR, 1, "media.example.net", [
    "https://media.example.net/hls/live/index.m3u8",
  ]),
  {
    at: 14 * MINUTE,
    actor: OPERATOR,
    action: "auth.sign_in",
    target: userT,
    metadata: { method: "passkey" },
  },
  {
    at: 18 * MINUTE,
    actor: SYSTEM,
    action: "scheduling.activate",
    target: other("scheduling_rule", 2, "CPU over 85%"),
    metadata: {
      clusterId: clusterNamed("apac-edge").id,
      nodeId: nodeNamed("sin-edge-02").id,
      nodeName: "sin-edge-02",
      action: "backup_ip",
    },
  },
  {
    at: 21 * MINUTE,
    actor: OPERATOR,
    action: "probe.token_create",
    target: { type: "probe", id: id(47, 6), name: "probe-tyo-02" },
    metadata: { regionId: regionByCode("ap-tokyo").id, ttlMinutes: 1440 },
  },
  {
    at: 46 * MINUTE,
    actor: SYSTEM,
    action: "scheduling.activate",
    target: other("scheduling_rule", 1, "Probe loss"),
    metadata: {
      clusterId: clusterNamed("eu-edge").id,
      nodeId: nodeNamed("fra-edge-03").id,
      nodeName: "fra-edge-03",
      action: "remove_node",
    },
  },
  siteUpdate(52 * MINUTE, OPERATOR, "docs.example.org", ["domains"]),
  siteUpdate(2.4 * HOUR, API_KEY, "api.example.com", ["originSettings"]),
  purge(2.4 * HOUR + 2 * MINUTE, API_KEY, 2, "api.example.com", [
    "https://api.example.com/v2/catalog",
    "https://api.example.com/v2/catalog/featured",
    "https://api.example.com/v2/prices",
  ]),
  {
    at: 8.9 * HOUR,
    actor: OPERATOR_PHONE,
    action: "site.protection_update",
    target: siteT("shop.example.com"),
    metadata: { underAttack: false, revision: 180 },
  },
  {
    at: 9.2 * HOUR,
    actor: OPERATOR_PHONE,
    action: "ban.create",
    target: other("ban", 3, "203.0.113.77"),
    metadata: { site: "shop.example.com", ttlSeconds: 86_400, reason: "burst" },
  },
  {
    at: 9.25 * HOUR,
    actor: OPERATOR_PHONE,
    action: "ban.create",
    target: other("ban", 4, "198.51.100.199"),
    metadata: { site: "shop.example.com", ttlSeconds: 86_400, reason: "burst" },
  },
  {
    at: 9.4 * HOUR,
    actor: OPERATOR_PHONE,
    action: "site.protection_update",
    target: siteT("shop.example.com"),
    metadata: { underAttack: true, revision: 178 },
  },
  {
    at: 9.45 * HOUR,
    actor: OPERATOR_PHONE,
    action: "auth.sign_in",
    target: userT,
    metadata: { method: "totp" },
  },
  siteUpdate(13 * HOUR, OPERATOR, "auth.example.net", ["originSettings"], 3),
  {
    at: 20 * HOUR,
    actor: ANONYMOUS,
    action: "auth.sign_in_failed",
    target: { type: "user", id: "", name: "admin@example.com" },
    metadata: { method: "password", code: "INVALID_EMAIL_OR_PASSWORD", email: "admin@example.com" },
  },
  {
    at: 20 * HOUR + 40_000,
    actor: ANONYMOUS,
    action: "auth.sign_in_failed",
    target: { type: "user", id: "", name: "admin@example.com" },
    metadata: { method: "password", code: "INVALID_EMAIL_OR_PASSWORD", email: "admin@example.com" },
  },
  {
    at: 1 * DAY + 10 * MINUTE,
    actor: SYSTEM,
    action: "certificate.issued",
    target: other("certificate", 5, "cdn.example.org"),
    metadata: { fingerprint: `sha256:${CA_SHA256.slice(8, 40)}`, ari: true },
  },
  siteUpdate(26 * HOUR, OPERATOR, "example.com", ["cacheRules", "cacheSettings"], 2),
  {
    at: 26.5 * HOUR,
    actor: OPERATOR,
    action: "alert.policy_update",
    target: settingT("alert_policy"),
    metadata: { nodeOfflineSeconds: 120, certificateHours: 168, errorRatio: 0.1 },
  },
  {
    at: 27 * HOUR,
    actor: nodeActor("iad-edge-01"),
    action: "node.upgrade_result",
    target: other("node_upgrade", 6, "0.2.1"),
    metadata: { success: true },
  },
  {
    at: 2 * DAY,
    actor: OPERATOR,
    action: "node.upgrade_create",
    target: other("node_upgrade", 6, "0.2.1"),
    metadata: { version: "0.2.1", nodes: nodes.length },
  },
  {
    at: 2 * DAY + 3 * HOUR,
    actor: OPERATOR,
    action: "cluster.rollout_promote",
    target: clusterT("apac-edge"),
    metadata: { revision: 171 },
  },
  {
    at: 3 * DAY,
    actor: OPERATOR,
    action: "api_key.create",
    target: { type: "api_key", id: id(46, 4), name: "backup-script" },
    metadata: { scope: "read", prefix: "ewk_Tq3m" },
  },
  {
    at: 3 * DAY + 2 * HOUR,
    actor: OPERATOR,
    action: "alert.channel_test",
    target: { type: "alert_channel", id: id(40, 3), name: "Ops group" },
  },
  {
    at: 3 * DAY + 2.1 * HOUR,
    actor: OPERATOR,
    action: "alert.channel_create",
    target: { type: "alert_channel", id: id(40, 4), name: "Night shift" },
    metadata: { kind: "dingtalk", platform: false },
  },
  {
    at: 3 * DAY + 4.4 * HOUR,
    actor: OPERATOR,
    action: "cluster.rollback",
    target: clusterT("apac-edge"),
    metadata: { toRevision: 168, revision: 169, created: true },
  },
  {
    at: 4 * DAY + 1.5 * HOUR,
    actor: OPERATOR,
    action: "dns.force_publish",
    target: clusterT("eu-edge"),
    metadata: { removed: 2 },
  },
  {
    at: 5 * DAY + 1.1 * HOUR,
    actor: OPERATOR,
    action: "node.disable",
    target: nodeT("iad-edge-02"),
  },
  {
    at: 5 * DAY + 15 * MINUTE,
    actor: OPERATOR,
    action: "node.enable",
    target: nodeT("iad-edge-02"),
  },
  {
    at: 6 * DAY + 3.7 * HOUR,
    actor: OPERATOR,
    action: "platform.rules_update",
    target: { type: "platform", id: "", name: "" },
    metadata: { count: 6 },
  },
  {
    at: 8 * DAY,
    actor: probeActor(2),
    action: "probe.enroll",
    target: { type: "probe", id: id(47, 2), name: "probe-sin-01" },
    metadata: { regionId: regionByCode("ap-singapore").id },
  },
  {
    at: 12 * DAY,
    actor: DEPLOY_BOT,
    action: "site.disable",
    target: siteT("download.example.com"),
    metadata: { revision: 131 },
  },
  {
    at: 12 * DAY - 25 * MINUTE,
    actor: DEPLOY_BOT,
    action: "site.enable",
    target: siteT("download.example.com"),
    metadata: { revision: 132 },
  },
  {
    at: 14 * DAY,
    actor: OPERATOR,
    action: "ip_list.update",
    target: other("ip_list", 7, "office"),
    metadata: { entries: 4, kind: "allow" },
  },
  {
    at: 19 * DAY,
    actor: DEPLOY_BOT,
    action: "site.disable",
    target: siteT("legacy.example.org"),
    metadata: { revision: 120 },
  },
  {
    at: 21 * DAY,
    actor: OPERATOR,
    action: "cluster.rollout_policy_update",
    target: clusterT("apac-edge"),
    metadata: { enabled: true, windowSeconds: 600, autoPromote: true },
  },
  {
    at: 24 * DAY,
    actor: OPERATOR,
    action: "system.release_source_update",
    target: settingT("release_source"),
    metadata: { from: { url: "" }, to: { url: "https://releases.example.net/edgeweir-node" } },
  },
  {
    at: 27 * DAY,
    actor: OPERATOR,
    action: "service_account.create",
    target: { type: "service_account", id: id(44, 2), name: "usage-export" },
    metadata: { scopes: ["sites:read", "usage:read"] },
  },
  {
    at: 27 * DAY - 2 * MINUTE,
    actor: OPERATOR,
    action: "service_account.key_create",
    target: { type: "service_account", id: id(44, 2), name: "usage-export" },
    metadata: { keyId: id(45, 3), name: "billing", prefix: "ews_c9LwE3uN" },
  },
  {
    at: 29 * DAY,
    actor: OPERATOR,
    action: "account.passkey_add",
    target: userT,
    metadata: { passkeyId: "lab-passkey-2", name: "Security key" },
  },
];

/** Routine changes over the last two months between the story's entries. */
const routineSeeds: AuditSeed[] = Array.from({ length: 110 }, (_, i): AuditSeed => {
  const at = 1.2 * HOUR + (i + noise(900 + i)) * ((58 * DAY) / 110);
  const pick = noise(1_000 + i);
  const site = sites[Math.floor(noise(1_100 + i) * (sites.length - 1))]?.name ?? "example.com";
  if (pick < 0.55)
    return siteUpdate(
      at,
      OPERATOR,
      site,
      [
        (["origins", "cacheRules", "domains", "originSettings", "cacheSettings"] as const)[
          Math.floor(noise(1_200 + i) * 5)
        ] ?? "origins",
      ],
      3 + Math.floor(at / (6 * HOUR)),
    );
  if (pick < 0.7)
    return purge(at, pick < 0.62 ? OPERATOR : API_KEY, 100 + i, site, [`https://${site}/`]);
  if (pick < 0.84)
    return {
      at,
      actor: OPERATOR,
      action: "auth.sign_in",
      target: userT,
      metadata: { method: pick < 0.8 ? "passkey" : "totp" },
    };
  if (pick < 0.92)
    return {
      at,
      actor: SYSTEM,
      action: "certificate.issued",
      target: other("certificate", 300 + i, site),
      metadata: { fingerprint: `sha256:${(i * 2_654_435_761).toString(16).slice(-12)}`, ari: true },
    };
  if (pick < 0.97)
    return {
      at,
      actor: OPERATOR,
      action: "site.rules_update",
      target: siteT(site),
      metadata: { count: 2 + Math.floor(noise(1_300 + i) * 6) },
    };
  return {
    at,
    actor: OPERATOR,
    action: "site.waf_update",
    target: siteT(site),
    metadata: { paranoiaLevel: 1 },
  };
});

const auditLog: AuditLogEntry[] = (() => {
  const seeds = [...storySeeds, ...routineSeeds].sort((a, b) => a.at - b.at);
  const first = 18_400;
  return seeds.map((seed, index) => ({
    id: first + seeds.length - index,
    occurredAt: ago(seed.at),
    actorType: seed.actor.type,
    actorId: seed.actor.id,
    actorName: seed.actor.name,
    ip: seed.actor.ip,
    userAgent: seed.actor.userAgent,
    action: seed.action,
    targetType: seed.target?.type ?? "",
    targetId: seed.target?.id ?? "",
    targetName: seed.target?.name ?? "",
    metadata: seed.metadata ?? {},
  }));
})();

const distinct = (values: string[]) => [...new Set(values.filter(Boolean))].sort();

// ---------------------------------------------------------------------------------------------

export const systemFixtures: Fixtures = {
  alerts: {
    channels: () => channels,
    subscriptions: () => subscriptions,
    events: (input) => eventsOf(input.siteId),
    policy: () => ({
      nodeOfflineSeconds: 120,
      certificateHours: 168,
      errorRatio: 0.1,
      minimumRequests: 200,
      windowMinutes: 5,
    }),
    smtp: () => ({
      host: "smtp.example.net",
      port: 465,
      secure: true,
      from: "alerts@example.com",
      username: "alerts@example.com",
      ca: "",
      caFile: false,
    }),
  },
  auditLogs: {
    list: (input) => {
      const from = input.from ? Date.parse(input.from) : -Infinity;
      const to = input.to ? Date.parse(input.to) : Infinity;
      const matching = auditLog.filter((entry) => {
        const at = Date.parse(entry.occurredAt);
        return (
          (!input.action || entry.action === input.action) &&
          (!input.targetType || entry.targetType === input.targetType) &&
          at >= from &&
          at <= to
        );
      });
      const limit = Number(input.limit ?? 50);
      const offset = Number(input.offset ?? 0);
      return { items: matching.slice(offset, offset + limit), total: matching.length };
    },
    facets: () => ({
      actions: distinct(auditLog.map((e) => e.action)),
      targetTypes: distinct(auditLog.map((e) => e.targetType)),
    }),
  },
  settings: {
    get: () => ({
      version: CONSOLE_VERSION,
      consoleUrl: "https://console.example.net",
      nodeApiUrl: NODE_CHANNEL_URL,
      nodeCaSha256: CA_SHA256,
      analyticsMode: "lite",
      setupCompletedAt: ago(210 * DAY),
    }),
    nodeChannel: () => ({ url: "", effectiveUrl: NODE_CHANNEL_URL, source: "environment" }),
    nodeChannelCheck: () => ({ url: NODE_CHANNEL_URL, result: "ok", checkedAt: ago(12_000) }),
    originAllowList: () => ({ cidrs: ["10.40.0.0/16", "fd00:40::/48"] }),
    releaseSource: () => ({
      url: "https://releases.example.net/edgeweir-node",
      effectiveUrl: "https://releases.example.net/edgeweir-node",
      source: "setting",
    }),
    usage: () => ({ retentionDays: 90, offlineThresholdMinutes: 30 }),
    probes: () => ({
      intervalSeconds: 10,
      timeoutMs: 2000,
      attempts: ATTEMPTS,
      lossPercent: 50,
      ipDownSeconds: 30,
      ipUpSeconds: 120,
    }),
    errorPages: () => ({
      unknownHost: [
        "<!doctype html>",
        '<html lang="en">',
        "<title>{{status}} · Unknown host</title>",
        "<h1>{{host}} is not served here</h1>",
        "<p>Request {{request_id}}</p>",
        "</html>",
      ].join("\n"),
      siteDisabled: "",
    }),
  },
  probes: {
    list: () => probes,
    results: (input) =>
      probeResults.filter(
        (r) =>
          (!input.probeId || r.proberId === input.probeId) &&
          (!input.nodeId || r.nodeId === input.nodeId),
      ),
  },
  serviceAccounts: {
    list: () => serviceAccounts,
  },
  accessKeys: {
    list: () => accessKeys,
  },
};
