/**
 * Infrastructure: DNS accounts and cluster bindings, scheduling rules, layer-4 applications with
 * their port pools and statistics, node upgrades and the add-node token. Ties to the world:
 * a scheduling rule takes the overloaded sin-edge-02 out of apac-edge's records, fra-edge-03
 * going offline left eu-edge a DNS plan the mass removal protection holds back, na-edge's
 * records are created by hand, and every node finished its upgrade to 0.2.1.
 */
import {
  type ClusterPortPools,
  type DnsLine,
  type DnsProviderId,
  type DnsRecord,
  type DnsResolutionLine,
  type DnsRevision,
  dnsCatalogDto,
  type L4App,
  type L4Protocol,
  type L4Stats,
  type Node,
  type SchedulingPreview,
  type SchedulingRule,
  type UpgradeJob,
} from "@edgeweir/contract";
import { ipLists } from "./access";
import { type Fixtures, notFound } from "./define";
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
  revisionsOf,
  sites,
} from "./world";

const APAC = id(2, 1);
const EU = id(2, 2);
const NA = id(2, 3);

const SECOND = 1_000;

const nodeNamed = (name: string) => nodes.find((n) => n.name === name) as Node;
const clusterName = (clusterId: string) => clusters.find((c) => c.id === clusterId)?.name ?? "";
const groupOf = (node: Node) => nodeGroups.find((g) => g.id === node.nodeGroupId);
const regionId = (code: string) => regions.find((r) => r.code === code)?.id ?? null;

/** IP lists of access.ts by name (their ids belong to that file). */
const listIds = (...names: string[]) =>
  ipLists.filter((list) => names.includes(list.name)).map((list) => list.id);

// ---------------------------------------------------------------------------------------------
// DNS accounts (kind 30)

const providers: { id: string; name: string; provider: DnsProviderId; zone: string }[] = [
  { id: id(30, 1), name: "edge-lines", provider: "tencentcloud", zone: "example.com" },
  { id: id(30, 2), name: "eu-zone", provider: "hetzner", zone: "example.org" },
  { id: id(30, 3), name: "assets", provider: "cloudflare", zone: "example.net" },
  { id: id(30, 4), name: "lab-resolver", provider: "powerdns", zone: "lab.example.net" },
];

/** Mass removal protection: at most 30 % of the address records in one publication. */
const protection = { massRemovalRatio: 0.3 };

// ---------------------------------------------------------------------------------------------
// Layer-4 applications (kinds 33, 34) and port pools

const portPools: Record<string, ClusterPortPools["pools"]> = {
  [APAC]: [
    { protocol: "tcp", from: 20000, to: 20099 },
    { protocol: "udp", from: 30000, to: 30099 },
    { protocol: "both", from: 40000, to: 40019 },
  ],
  [EU]: [{ protocol: "both", from: 20000, to: 20999 }],
  [NA]: [
    { protocol: "tcp", from: 20500, to: 20599 },
    { protocol: "both", from: 25000, to: 25999 },
  ],
};

interface Traffic {
  /** New connections (sessions) per minute at the daily peak. */
  perMinute: number;
  /** Mean connection length, minutes (concurrency = rate × length). */
  minutes: number;
  /** Bytes per connection from clients and to clients. */
  received: number;
  sent: number;
  /** Share refused by the IP lists or the limits. */
  refused: number;
  /** Local hour of the daily peak. */
  peakHour: number;
}

interface AppSeed {
  name: string;
  clusterId: string;
  protocol: L4Protocol;
  port: number;
  enabled?: boolean;
  origins: { address: string; port: number; weight?: number; backup?: boolean }[];
  acceptProxyProtocol?: boolean;
  proxyProtocolVersion?: number;
  idleTimeoutSeconds?: number;
  connectTimeoutMs?: number;
  allow?: string[];
  block?: string[];
  maxConnections?: number;
  newConnectionsPerSecond?: number;
  created: number;
  updated: number;
  traffic: Traffic;
}

const appSeeds: AppSeed[] = [
  {
    name: "game-gateway",
    clusterId: APAC,
    protocol: "tcp",
    port: 20010,
    origins: [
      { address: "198.51.100.60", port: 7777, weight: 3 },
      { address: "198.51.100.61", port: 7777, weight: 3 },
      { address: "203.0.113.70", port: 7777, backup: true },
    ],
    proxyProtocolVersion: 2,
    block: ["anonymizers", "blocklist"],
    maxConnections: 60_000,
    newConnectionsPerSecond: 2_000,
    created: 74 * DAY,
    updated: 3 * HOUR,
    traffic: {
      perMinute: 1_450,
      minutes: 9,
      received: 210_000,
      sent: 1_650_000,
      refused: 0.012,
      peakHour: 21,
    },
  },
  {
    name: "voice-relay",
    clusterId: APAC,
    protocol: "udp",
    port: 30000,
    origins: [
      { address: "198.51.100.62", port: 3478 },
      { address: "198.51.100.63", port: 3478 },
    ],
    maxConnections: 20_000,
    created: 52 * DAY,
    updated: 6 * DAY,
    traffic: {
      perMinute: 520,
      minutes: 4,
      received: 2_300_000,
      sent: 2_400_000,
      refused: 0.002,
      peakHour: 20,
    },
  },
  {
    name: "ssh-bastion",
    clusterId: APAC,
    protocol: "tcp",
    port: 20022,
    origins: [{ address: "203.0.113.80", port: 22 }],
    idleTimeoutSeconds: 3_600,
    allow: ["office_vpn", "monitoring"],
    maxConnections: 200,
    newConnectionsPerSecond: 5,
    created: 160 * DAY,
    updated: 21 * DAY,
    traffic: {
      perMinute: 9,
      minutes: 24,
      received: 420_000,
      sent: 3_800_000,
      refused: 0.38,
      peakHour: 15,
    },
  },
  {
    name: "legacy-ftp",
    clusterId: APAC,
    protocol: "tcp",
    port: 20021,
    enabled: false,
    origins: [{ address: "203.0.113.81", port: 21 }],
    created: 190 * DAY,
    updated: 33 * DAY,
    traffic: { perMinute: 0, minutes: 1, received: 0, sent: 0, refused: 0, peakHour: 12 },
  },
  {
    name: "mqtt-broker",
    clusterId: EU,
    protocol: "tcp",
    port: 20883,
    origins: [
      { address: "198.51.100.90", port: 1883, weight: 2 },
      { address: "2001:db8:b::90", port: 1883, weight: 1 },
    ],
    acceptProxyProtocol: false,
    proxyProtocolVersion: 1,
    idleTimeoutSeconds: 1_800,
    maxConnections: 100_000,
    created: 96 * DAY,
    updated: 2 * DAY,
    traffic: {
      perMinute: 230,
      minutes: 55,
      received: 46_000,
      sent: 28_000,
      refused: 0.004,
      peakHour: 9,
    },
  },
  {
    name: "dns-forwarder",
    clusterId: EU,
    protocol: "udp",
    port: 20053,
    origins: [
      { address: "198.51.100.91", port: 53 },
      { address: "198.51.100.92", port: 53 },
    ],
    idleTimeoutSeconds: 10,
    connectTimeoutMs: 1_000,
    newConnectionsPerSecond: 5_000,
    created: 81 * DAY,
    updated: 12 * DAY,
    traffic: {
      perMinute: 8_800,
      minutes: 0.15,
      received: 84,
      sent: 232,
      refused: 0.006,
      peakHour: 19,
    },
  },
  {
    name: "postgres-replica",
    clusterId: NA,
    protocol: "tcp",
    port: 25432,
    origins: [
      { address: "192.0.2.90", port: 5432 },
      { address: "192.0.2.91", port: 5432, backup: true },
    ],
    acceptProxyProtocol: true,
    idleTimeoutSeconds: 7_200,
    allow: ["office_vpn"],
    maxConnections: 2_000,
    created: 58 * DAY,
    updated: 9 * DAY,
    traffic: {
      perMinute: 4,
      minutes: 110,
      received: 2_100_000,
      sent: 64_000_000,
      refused: 0.05,
      peakHour: 3,
    },
  },
  {
    name: "smtp-relay",
    clusterId: NA,
    protocol: "tcp",
    port: 20587,
    enabled: false,
    origins: [{ address: "192.0.2.95", port: 587 }],
    created: 120 * DAY,
    updated: 15 * DAY,
    traffic: { perMinute: 0, minutes: 1, received: 0, sent: 0, refused: 0, peakHour: 12 },
  },
  {
    name: "syslog-ingest",
    clusterId: NA,
    protocol: "udp",
    port: 25514,
    origins: [
      { address: "192.0.2.96", port: 514 },
      { address: "192.0.2.97", port: 514 },
    ],
    created: 44 * DAY,
    updated: 4 * DAY,
    traffic: {
      perMinute: 48,
      minutes: 1,
      received: 960_000,
      sent: 0,
      refused: 0.001,
      peakHour: 14,
    },
  },
];

const appId = (index: number) => id(33, index + 1);

// ---------------------------------------------------------------------------------------------
// DNS bindings and records

interface BindingSeed {
  clusterId: string;
  mode: "off" | "manual" | "auto";
  providerId: string | null;
  domain: string;
  ttl: number;
  lines: DnsLine[];
  lineAliases: boolean;
  updated: number;
}

const line = (
  name: string,
  group: number,
  resolutionLine: DnsResolutionLine,
  backups: number[] = [],
  minHealthyIps = 1,
): DnsLine => ({
  name,
  nodeGroupId: id(3, group),
  overrides: [],
  resolutionLine,
  backupNodeGroupIds: backups.map((n) => id(3, n)),
  minHealthyIps,
});

const bindingSeeds: BindingSeed[] = [
  {
    clusterId: APAC,
    mode: "auto",
    providerId: id(30, 1),
    domain: "apac.cdn.example.com",
    ttl: 300,
    lines: [line("tyo", 1, "default", [2]), line("sin", 2, "overseas", [1])],
    lineAliases: true,
    updated: 2 * DAY,
  },
  {
    clusterId: EU,
    mode: "auto",
    providerId: id(30, 2),
    domain: "eu.cdn.example.org",
    ttl: 600,
    lines: [line("fra", 3, "default", [], 2)],
    lineAliases: false,
    updated: 3 * DAY,
  },
  {
    clusterId: NA,
    mode: "manual",
    providerId: null,
    domain: "na.cdn.example.com",
    ttl: 600,
    lines: [line("iad", 4, "default")],
    lineAliases: false,
    updated: 12 * DAY,
  },
];

const bindingOf = (clusterId: string) => bindingSeeds.find((b) => b.clusterId === clusterId);
const providerOf = (b: BindingSeed) => providers.find((p) => p.id === b.providerId);
/** Record names are relative to the account's zone, or to the domain without an account. */
const zoneOf = (b: BindingSeed) => providerOf(b)?.zone ?? b.domain;
const relative = (name: string, zone: string) =>
  name === zone ? "@" : name.slice(0, -(zone.length + 1));
const absolute = (name: string, zone: string) => (name === "@" ? zone : `${name}.${zone}`);

/** Sites (disabled ones keep their records) and enabled applications, by id. */
function publishedIds(clusterId: string): string[] {
  const own = sites.filter((s) => s.clusterId === clusterId).map((s) => s.id);
  const apps = appSeeds
    .map((seed, index) => ({ seed, id: appId(index) }))
    .filter(({ seed }) => seed.clusterId === clusterId && seed.enabled !== false)
    .map(({ id: appIdValue }) => appIdValue);
  return [...own, ...apps].sort();
}

/** The binding's records without the nodes in `without` (as the console compiles them). */
function recordsOf(b: BindingSeed, without: readonly string[] = []): DnsRecord[] {
  const zone = zoneOf(b);
  const out: DnsRecord[] = [];
  const add = (name: string, type: DnsRecord["type"], data: string, on?: DnsResolutionLine) =>
    out.push({
      name: relative(name, zone),
      type,
      data,
      ttl: b.ttl,
      ...(on && on !== "default" ? { line: on } : {}),
    });
  const addresses = (name: string, ips: string[], on?: DnsResolutionLine) => {
    for (const ip of ips) add(name, ip.includes(":") ? "AAAA" : "A", ip, on);
  };
  const allName = `all.${b.domain}`;
  const byResolution = new Map<DnsResolutionLine, string[]>();
  for (const l of b.lines) {
    const ips = nodes
      .filter((n) => n.nodeGroupId === l.nodeGroupId && !without.includes(n.name))
      .flatMap((n) => n.ipAddresses);
    addresses(`${l.name}.${b.domain}`, ips);
    byResolution.set(l.resolutionLine, [...(byResolution.get(l.resolutionLine) ?? []), ...ips]);
  }
  addresses(allName, byResolution.get("default") ?? [...byResolution.values()].flat());
  for (const [on, ips] of byResolution) if (on !== "default") addresses(allName, ips, on);
  for (const target of publishedIds(b.clusterId)) {
    add(`${target}.${b.domain}`, "CNAME", allName);
    if (b.lineAliases)
      for (const l of b.lines)
        add(`${l.name}.${target}.${b.domain}`, "CNAME", `${l.name}.${b.domain}`);
  }
  const key = (r: DnsRecord) => `${r.name}|${r.type}|${r.data}|${r.ttl}|${r.line ?? ""}`;
  return out.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0));
}

/** What each binding publishes now: sin-edge-02 is out (CPU overload); eu-edge keeps fra-edge-03. */
const CURRENT_WITHOUT: Record<string, string[]> = { [APAC]: ["sin-edge-02"] };
const currentRecords = (b: BindingSeed) => recordsOf(b, CURRENT_WITHOUT[b.clusterId] ?? []);

// ---------------------------------------------------------------------------------------------
// Scheduling rules (kind 32)

type Condition = SchedulingRule["conditions"][number];

interface RuleNodeState {
  state: "active" | "recovering";
  activeSince: number;
  recoveringSince?: number;
}

interface RuleSeed {
  n: number;
  clusterId: string;
  lineName: string | null;
  name: string;
  enabled?: boolean;
  match: "all" | "any";
  conditions: Condition[];
  action: SchedulingRule["action"];
  holdSeconds: number;
  recoverSeconds: number;
  /** Nodes the action applies to now. */
  inEffect?: Record<string, RuleNodeState>;
  /** How long the comparison has held on nodes it holds on that are not in effect. */
  held?: Record<string, number>;
  created: number;
  updated: number;
}

const condition = (
  metric: Condition["metric"],
  comparator: Condition["comparator"],
  threshold: number,
  durationSeconds: number,
  extra: Partial<Condition> = {},
): Condition => ({
  metric,
  aggregate: "avg",
  comparator,
  threshold,
  durationSeconds,
  regionId: null,
  ...extra,
});

const ruleSeeds: RuleSeed[] = [
  {
    n: 1,
    clusterId: APAC,
    lineName: null,
    name: "CPU overload",
    match: "any",
    conditions: [condition("cpu_percent", "gt", 85, 120), condition("load1", "gt", 6, 300)],
    action: "remove_node",
    holdSeconds: 300,
    recoverSeconds: 600,
    inEffect: { "sin-edge-02": { state: "active", activeSince: 6 * MINUTE } },
    created: 58 * DAY,
    updated: 9 * DAY,
  },
  {
    n: 2,
    clusterId: APAC,
    lineName: "sin",
    name: "Singapore reachability",
    match: "any",
    conditions: [
      condition("probe_loss_percent", "ge", 20, 60, { regionId: regionId("ap-tokyo") }),
      condition("probe_latency_ms", "gt", 180, 120, { regionId: regionId("ap-tokyo") }),
    ],
    action: "backup_group",
    holdSeconds: 300,
    recoverSeconds: 300,
    created: 40 * DAY,
    updated: 40 * DAY,
  },
  {
    n: 3,
    clusterId: APAC,
    lineName: "tyo",
    name: "Egress saturation",
    match: "all",
    conditions: [condition("egress_mbps", "gt", 450, 300, { aggregate: "max" })],
    action: "backup_ip",
    holdSeconds: 600,
    recoverSeconds: 300,
    inEffect: {
      "tyo-edge-01": { state: "recovering", activeSince: 21 * MINUTE, recoveringSince: 3 * MINUTE },
    },
    created: 31 * DAY,
    updated: 31 * DAY,
  },
  {
    n: 4,
    clusterId: APAC,
    lineName: null,
    name: "Connection surge",
    match: "any",
    conditions: [condition("connections", "gt", 12_000, 180)],
    action: "backup_ip",
    holdSeconds: 300,
    recoverSeconds: 300,
    held: { "tyo-edge-01": 95 },
    created: 12 * DAY,
    updated: 12 * DAY,
  },
  {
    n: 5,
    clusterId: APAC,
    lineName: "sin",
    name: "Memory guard",
    enabled: false,
    match: "all",
    conditions: [condition("memory_percent", "gt", 92, 60)],
    action: "remove_node",
    holdSeconds: 300,
    recoverSeconds: 300,
    created: 7 * DAY,
    updated: 2 * DAY,
  },
  {
    n: 6,
    clusterId: EU,
    lineName: null,
    name: "Probe loss",
    match: "all",
    conditions: [condition("probe_loss_percent", "ge", 50, 30)],
    action: "remove_node",
    holdSeconds: 300,
    recoverSeconds: 300,
    inEffect: { "fra-edge-03": { state: "active", activeSince: 46 * MINUTE } },
    created: 140 * DAY,
    updated: 26 * DAY,
  },
  {
    n: 7,
    clusterId: NA,
    lineName: null,
    name: "Memory guard",
    match: "any",
    conditions: [
      condition("memory_percent", "gt", 90, 60),
      condition("load1", "gt", 7, 120, { aggregate: "max" }),
    ],
    action: "remove_node",
    holdSeconds: 300,
    recoverSeconds: 600,
    created: 70 * DAY,
    updated: 70 * DAY,
  },
];

const ruleId = (seed: RuleSeed) => id(32, seed.n);

/** Round trip in ms from probers of a region to a node's region. */
const RTT: Record<string, Record<string, number>> = {
  "ap-tokyo": { "ap-tokyo": 3, "ap-singapore": 69, "eu-frankfurt": 229, "us-virginia": 151 },
  "ap-singapore": { "ap-tokyo": 68, "ap-singapore": 2, "eu-frankfurt": 161, "us-virginia": 214 },
  "eu-frankfurt": { "ap-tokyo": 228, "ap-singapore": 162, "eu-frankfurt": 2, "us-virginia": 88 },
  "us-virginia": { "ap-tokyo": 152, "ap-singapore": 215, "eu-frankfurt": 87, "us-virginia": 3 },
};

const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;

/** The condition's current value on the node; null without data (offline: no metrics). */
function metricValue(node: Node, c: Condition): number | null {
  const metrics = node.metrics;
  const index = nodes.indexOf(node);
  switch (c.metric) {
    case "cpu_percent":
      return metrics ? metrics.cpuPercent : null;
    case "load1":
      return metrics ? round(metrics.load1, 2) : null;
    case "memory_percent":
      return metrics ? round((metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100) : null;
    case "egress_mbps":
      return metrics ? round(metrics.egressBps / 1_000_000) : null;
    case "connections":
      return metrics ? metrics.activeConnections : null;
    case "probe_loss_percent":
      return node.online ? round(noise(index * 17 + 3) * 2.4) : 100;
    case "probe_latency_ms": {
      if (!node.online) return null;
      const own = RTT[groupOf(node)?.regionCode ?? ""] ?? {};
      const from = c.regionId
        ? [regions.find((r) => r.id === c.regionId)?.code ?? ""]
        : Object.keys(own);
      const values = from.map((code) => (own[code] ?? 0) + noise(index * 29 + code.length) * 4);
      const value =
        c.aggregate === "max"
          ? Math.max(...values)
          : c.aggregate === "min"
            ? Math.min(...values)
            : values.reduce((sum, v) => sum + v, 0) / values.length;
      return round(value);
    }
  }
}

const compare = (value: number, c: Condition) =>
  c.comparator === "gt"
    ? value > c.threshold
    : c.comparator === "ge"
      ? value >= c.threshold
      : c.comparator === "lt"
        ? value < c.threshold
        : value <= c.threshold;

/** Nodes a rule looks at: its line's node group, or the whole cluster. */
function ruleNodes(seed: RuleSeed): Node[] {
  const l = bindingOf(seed.clusterId)?.lines.find((candidate) => candidate.name === seed.lineName);
  return nodes.filter(
    (n) => n.clusterId === seed.clusterId && (!l || n.nodeGroupId === l.nodeGroupId),
  );
}

function rule(seed: RuleSeed): SchedulingRule {
  return {
    id: ruleId(seed),
    clusterId: seed.clusterId,
    lineName: seed.lineName,
    name: seed.name,
    enabled: seed.enabled ?? true,
    match: seed.match,
    conditions: seed.conditions,
    action: seed.action,
    holdSeconds: seed.holdSeconds,
    recoverSeconds: seed.recoverSeconds,
    activeNodes: Object.entries(seed.inEffect ?? {}).map(([name, state]) => ({
      nodeId: nodeNamed(name).id,
      nodeName: name,
      since: ago(state.activeSince),
    })),
    createdAt: ago(seed.created),
    updatedAt: ago(seed.updated),
  };
}

type PreviewNode = SchedulingPreview["rules"][number]["nodes"][number];

function previewNode(seed: RuleSeed, node: Node): PreviewNode {
  const enabled = seed.enabled ?? true;
  const effect = enabled ? seed.inEffect?.[node.name] : undefined;
  const conditions = seed.conditions.map((c) => {
    const value = metricValue(node, c);
    const holds = value !== null && compare(value, c);
    const heldSeconds = !holds
      ? 0
      : effect?.state === "active"
        ? Math.round(effect.activeSince / SECOND) + c.durationSeconds
        : (seed.held?.[node.name] ?? 30 + Math.floor(noise(seed.n * 41 + node.name.length) * 90));
    return {
      ...c,
      value,
      holds,
      heldSeconds,
      satisfied: holds && heldSeconds >= c.durationSeconds,
    };
  });
  const matches =
    seed.match === "all"
      ? conditions.every((c) => c.satisfied)
      : conditions.some((c) => c.satisfied);
  const anyHolds = conditions.some((c) => c.holds);
  const recoveringSince =
    effect?.state === "recovering" && effect.recoveringSince !== undefined
      ? effect.recoveringSince
      : null;
  return {
    nodeId: node.id,
    nodeName: node.name,
    state: effect ? effect.state : enabled && anyHolds ? "pending" : "idle",
    conditions,
    matches,
    inEffect: !!effect,
    wouldActivate: enabled && !effect && matches,
    wouldRecover: false,
    activeSince: effect ? ago(effect.activeSince) : null,
    recoveringSince: recoveringSince === null ? null : ago(recoveringSince),
    recoversAt:
      recoveringSince === null
        ? null
        : new Date(NOW - recoveringSince + seed.recoverSeconds * SECOND).toISOString(),
  };
}

// ---------------------------------------------------------------------------------------------
// DNS revisions

interface RevisionSeed {
  revision: number;
  status: DnsRevision["status"];
  reason: string;
  params?: Record<string, string | number>;
  at: number;
  records: number;
  lastError?: string;
}

const schedulingParams = (n: number, node: string, event: "activated" | "recovered") => {
  const seed = ruleSeeds.find((r) => r.n === n) as RuleSeed;
  return {
    rule: seed.name,
    node,
    ruleId: ruleId(seed),
    nodeId: nodeNamed(node).id,
    action: seed.action,
    event,
  };
};

const apacBinding = bindingSeeds[0] as BindingSeed;
const euBinding = bindingSeeds[1] as BindingSeed;
const naBinding = bindingSeeds[2] as BindingSeed;
const count = (b: BindingSeed, without: string[] = []) => recordsOf(b, without).length;

const revisionSeeds: Record<string, RevisionSeed[]> = {
  [APAC]: [
    {
      revision: 214,
      status: "applied",
      reason: "scheduling",
      params: schedulingParams(1, "sin-edge-02", "activated"),
      at: 6 * MINUTE,
      records: count(apacBinding, ["sin-edge-02"]),
    },
    {
      revision: 213,
      status: "applied",
      reason: "scheduling",
      params: schedulingParams(1, "sin-edge-02", "recovered"),
      at: 27 * HOUR,
      records: count(apacBinding),
    },
    {
      revision: 212,
      status: "applied",
      reason: "scheduling",
      params: schedulingParams(1, "sin-edge-02", "activated"),
      at: 27.6 * HOUR,
      records: count(apacBinding, ["sin-edge-02"]),
    },
    {
      revision: 211,
      status: "applied",
      reason: "manual",
      at: 2 * DAY,
      records: count(apacBinding),
    },
    {
      revision: 210,
      status: "failed",
      reason: "manual",
      at: 2 * DAY + 14 * MINUTE,
      records: count(apacBinding),
      lastError: "dns_auth_failed",
    },
    {
      revision: 207,
      status: "applied",
      reason: "health",
      at: 4 * DAY,
      records: count(apacBinding),
    },
  ],
  [EU]: [
    {
      revision: 186,
      status: "blocked",
      reason: "scheduling",
      params: schedulingParams(6, "fra-edge-03", "activated"),
      at: 46 * MINUTE,
      records: count(euBinding, ["fra-edge-03"]),
      lastError: "dns_mass_removal_blocked",
    },
    {
      revision: 185,
      status: "superseded",
      reason: "health",
      at: 47 * MINUTE,
      records: count(euBinding, ["fra-edge-03"]),
      lastError: "dns_mass_removal_blocked",
    },
    {
      revision: 184,
      status: "applied",
      reason: "manual",
      at: 3 * DAY,
      records: count(euBinding),
    },
    {
      revision: 179,
      status: "applied",
      reason: "rollback",
      at: 9 * DAY,
      records: count(euBinding),
    },
  ],
  [NA]: [
    {
      revision: 77,
      status: "applied",
      reason: "manual",
      at: 12 * DAY,
      records: count(naBinding),
    },
    {
      revision: 52,
      status: "applied",
      reason: "manual",
      at: 41 * DAY,
      records: count(naBinding) - 2,
    },
  ],
};

function dnsRevision(seed: RevisionSeed): DnsRevision {
  const applied = seed.status === "applied";
  return {
    revision: seed.revision,
    status: seed.status,
    reason: seed.reason,
    reasonParams: seed.params ?? {},
    recordCount: seed.records,
    createdAt: ago(seed.at),
    appliedAt: applied ? ago(seed.at - 9 * SECOND) : null,
    lastError: seed.lastError ?? "",
    lastErrorParams: {},
  };
}

const revisionsOfBinding = (clusterId: string) => (revisionSeeds[clusterId] ?? []).map(dnsRevision);
/** The revision the binding wants (the newest that is not held back or superseded). */
const desiredRevision = (clusterId: string) =>
  revisionsOfBinding(clusterId).find((r) => r.status === "applied" || r.status === "failed") ??
  null;
const blockedRevision = (clusterId: string) =>
  revisionsOfBinding(clusterId).find((r) => r.status === "blocked") ?? null;

const addressRecord = (r: DnsRecord) => r.type === "A" || r.type === "AAAA";

function bindingDto(b: BindingSeed) {
  return {
    clusterId: b.clusterId,
    mode: b.mode,
    providerId: b.providerId,
    zone: providerOf(b)?.zone ?? "",
    domain: b.domain,
    ttl: b.ttl,
    lines: b.lines,
    lineAliases: b.lineAliases,
    allLabel: "all",
    updatedAt: ago(b.updated),
  };
}

function bindingState(clusterId: string) {
  const b = bindingOf(clusterId);
  if (!b) {
    return {
      binding: {
        clusterId,
        mode: "off" as const,
        providerId: null,
        zone: "",
        domain: "",
        ttl: 600,
        lines: [],
        lineAliases: false,
        allLabel: "all",
        updatedAt: ago(30 * DAY),
      },
      revision: null,
      applied: false,
      records: [],
      blocked: null,
    };
  }
  const revision = desiredRevision(clusterId);
  const records = b.clusterId === EU ? recordsOf(b) : currentRecords(b);
  const blocked = blockedRevision(clusterId);
  // The held-back plan removes fra-edge-03's addresses from every set.
  const previous = records.filter(addressRecord);
  const kept = new Set(
    recordsOf(b, ["fra-edge-03"])
      .filter(addressRecord)
      .map((r) => r.data),
  );
  return {
    binding: bindingDto(b),
    revision,
    applied: revision?.status === "applied",
    records,
    blocked: blocked
      ? {
          ...blocked,
          removedRecords: previous.filter((r) => !kept.has(r.data)).length,
          previousRecords: previous.length,
        }
      : null,
  };
}

/** BIND zone file of the records, default line only; other lines follow as comments. */
function zoneFile(b: BindingSeed, records: DnsRecord[]): string {
  const zone = zoneOf(b);
  const width = Math.max(1, ...records.map((r) => r.name.length));
  const entry = (r: DnsRecord) =>
    `${r.name.padEnd(width)} ${r.ttl} IN ${r.type.padEnd(5)} ${r.type === "CNAME" ? `${r.data}.` : r.data}`;
  const others = [...new Set(records.map((r) => r.line ?? "").filter(Boolean))].sort();
  return [
    `$ORIGIN ${zone}.`,
    `$TTL ${b.ttl}`,
    ...records.filter((r) => !r.line).map(entry),
    ...others.flatMap((on) => [
      `; line ${on}`,
      ...records.filter((r) => r.line === on).map((r) => `; ${entry(r)}`),
    ]),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------------------------------------
// Layer-4 applications as the API returns them

function dnsNames(clusterId: string, target: string) {
  const b = bindingOf(clusterId);
  if (!b || b.mode === "off" || !b.domain) return { dnsTarget: null, dnsLines: [] };
  const full = `${target}.${b.domain}`;
  return {
    dnsTarget: full,
    dnsLines: b.lines.map((l) => ({
      name: l.name,
      target: b.lineAliases ? `${l.name}.${full}` : `${l.name}.${b.domain}`,
    })),
  };
}

const l4Apps: L4App[] = appSeeds.map((seed, index) => {
  const appIdValue = appId(index);
  return {
    id: appIdValue,
    clusterId: seed.clusterId,
    clusterName: clusterName(seed.clusterId),
    name: seed.name,
    protocol: seed.protocol,
    port: seed.port,
    enabled: seed.enabled ?? true,
    acceptProxyProtocol: seed.acceptProxyProtocol ?? false,
    proxyProtocolVersion: seed.proxyProtocolVersion ?? 0,
    origins: seed.origins.map((origin, i) => ({
      id: id(34, (index + 1) * 10 + i + 1),
      address: origin.address,
      port: origin.port,
      weight: origin.weight ?? 1,
      backup: origin.backup ?? false,
    })),
    maxFails: 3,
    failTimeoutSeconds: 30,
    connectTimeoutMs: seed.connectTimeoutMs ?? 5_000,
    idleTimeoutSeconds: seed.idleTimeoutSeconds ?? (seed.protocol === "tcp" ? 600 : 30),
    allowListIds: listIds(...(seed.allow ?? [])),
    blockListIds: listIds(...(seed.block ?? [])),
    maxConnections: seed.maxConnections ?? 0,
    newConnectionsPerSecond: seed.newConnectionsPerSecond ?? 0,
    ...dnsNames(seed.clusterId, appIdValue),
    createdAt: ago(seed.created),
    updatedAt: ago(seed.updated),
  };
});

// ---------------------------------------------------------------------------------------------
// Layer-4 statistics: a daily cycle per application, minute noise and the burst about 9.5 hours
// ago (world.ts), which the block lists mostly refused.

const BURST_AT = NOW - 9.5 * HOUR;
const BURST_SIGMA = 14 * MINUTE;

/** Activity in [0.15, 1] over the day, highest at `peakHour` (local time). */
function daily(time: number, peakHour: number): number {
  const date = new Date(time);
  const hour = date.getHours() + date.getMinutes() / 60;
  const wave = 0.5 + 0.5 * Math.cos((2 * Math.PI * (hour - peakHour)) / 24);
  const weekend = date.getDay() === 0 || date.getDay() === 6 ? 0.86 : 1;
  return (0.15 + 0.85 * wave ** 1.4) * weekend;
}

const burst = (time: number) => Math.exp(-((time - BURST_AT) ** 2) / (2 * BURST_SIGMA ** 2));

/** fra-edge-03 went offline 47 minutes ago (world.ts). */
const OFFLINE_SINCE = NOW - 47 * MINUTE;

interface Counters {
  connections: number;
  refused: number;
  peakConcurrent: number;
  bytesReceived: number;
  bytesSent: number;
}

function bucketCounters(seed: AppSeed, salt: number, time: number, bucketMs: number): Counters {
  const t = seed.traffic;
  const minutes = bucketMs / MINUTE;
  const steps = Math.min(12, Math.max(1, Math.round(minutes / 5)));
  let rate = 0;
  let peak = 0;
  let attack = 0;
  for (let i = 0; i < steps; i++) {
    const at = time + ((i + 0.5) / steps) * bucketMs;
    const jitter = 1 + (noise(Math.floor(at / MINUTE) + salt) - 0.5) * 0.16;
    const value = t.perMinute * daily(at, t.peakHour) * jitter;
    rate += value;
    peak = Math.max(peak, value);
    attack += burst(at);
  }
  rate /= steps;
  attack /= steps;
  const connections = Math.round(rate * minutes);
  return {
    connections,
    refused: Math.round(connections * t.refused * (1 + attack * 14)),
    peakConcurrent: Math.round(
      peak * t.minutes * (1.04 + noise(Math.floor(time / bucketMs) + salt * 3) * 0.08),
    ),
    bytesReceived: Math.round(connections * t.received),
    bytesSent: Math.round(connections * t.sent),
  };
}

function l4Stats(appIdValue: string, from: string, to: string): L4Stats {
  const index = l4Apps.findIndex((app) => app.id === appIdValue);
  const seed = appSeeds[index];
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  const span = toMs - fromMs;
  const bucketSeconds = span <= DAY ? 60 : span <= 5 * DAY ? 300 : 3600;
  const bucketMs = bucketSeconds * SECOND;
  const start = Math.floor(fromMs / bucketMs) * bucketMs;
  const zero = (): Counters => ({
    connections: 0,
    refused: 0,
    peakConcurrent: 0,
    bytesReceived: 0,
    bytesSent: 0,
  });
  const active = !!seed && seed.enabled !== false;
  const points: L4Stats["points"] = [];
  const totals = zero();
  for (let time = start; time < toMs; time += bucketMs) {
    const value = active && seed ? bucketCounters(seed, index * 7919, time, bucketMs) : zero();
    points.push({ time: new Date(time).toISOString(), ...value });
    totals.connections += value.connections;
    totals.refused += value.refused;
    totals.peakConcurrent = Math.max(totals.peakConcurrent, value.peakConcurrent);
    totals.bytesReceived += value.bytesReceived;
    totals.bytesSent += value.bytesSent;
  }
  const own = active && seed ? nodes.filter((n) => n.clusterId === seed.clusterId) : [];
  // Each node's weight, scaled by the part of the range it was online.
  const weights = own.map((node, i) => {
    const online = node.online ? 1 : Math.max(0, OFFLINE_SINCE - fromMs) / span;
    return (0.7 + noise(index * 13 + i) * 0.6) * online;
  });
  const sum = weights.reduce((total, w) => total + w, 0) || 1;
  const share = (value: number, w: number) => Math.round((value * w) / sum);
  const nodeRows = own
    .map((node, i) => {
      const w = weights[i] ?? 0;
      return {
        nodeId: node.id,
        nodeName: node.name,
        connections: share(totals.connections, w),
        refused: share(totals.refused, w),
        peakConcurrent: Math.round(((totals.peakConcurrent * w) / sum) * 1.12),
        bytesReceived: share(totals.bytesReceived, w),
        bytesSent: share(totals.bytesSent, w),
      };
    })
    .filter((row) => row.connections > 0)
    .sort((a, b) => b.connections - a.connections);
  return {
    appId: appIdValue,
    from: new Date(fromMs).toISOString(),
    to: new Date(toMs).toISOString(),
    bucketSeconds,
    points,
    totals,
    nodes: nodeRows,
  };
}

// ---------------------------------------------------------------------------------------------
// Node upgrades (kinds 35, 37): every node finished its upgrade to 0.2.1; eu-edge's 0.2.0 failed
// on fra-edge-02 first.

interface DeliverySeed {
  node: string;
  phase: "canary" | "rollout";
  state: UpgradeJob["deliveries"][number]["state"];
  /** Finished this long after the job was created. */
  after: number;
  errorCode?: string;
  message?: string;
}

interface JobSeed {
  n: number;
  clusterId: string;
  group: string;
  version: string;
  state: UpgradeJob["state"];
  created: number;
  deliveries: DeliverySeed[];
}

const jobSeeds: JobSeed[] = [
  {
    n: 1,
    clusterId: APAC,
    group: "singapore",
    version: "0.2.1",
    state: "succeeded",
    created: 2 * DAY + 3 * HOUR,
    deliveries: [
      { node: "sin-edge-01", phase: "canary", state: "succeeded", after: 4 * MINUTE },
      { node: "sin-edge-02", phase: "canary", state: "succeeded", after: 5 * MINUTE },
      { node: "tyo-edge-01", phase: "rollout", state: "succeeded", after: 72 * MINUTE },
      { node: "tyo-edge-02", phase: "rollout", state: "succeeded", after: 76 * MINUTE },
    ],
  },
  {
    n: 2,
    clusterId: NA,
    group: "virginia",
    version: "0.2.1",
    state: "succeeded",
    created: 1 * DAY + 22 * HOUR,
    deliveries: [
      { node: "iad-edge-01", phase: "canary", state: "succeeded", after: 4 * MINUTE },
      { node: "iad-edge-02", phase: "canary", state: "succeeded", after: 6 * MINUTE },
      { node: "iad-edge-03", phase: "canary", state: "succeeded", after: 9 * MINUTE },
    ],
  },
  {
    n: 3,
    clusterId: EU,
    group: "frankfurt",
    version: "0.2.1",
    state: "succeeded",
    created: 1 * DAY + 20 * HOUR,
    deliveries: [
      { node: "fra-edge-01", phase: "canary", state: "succeeded", after: 3 * MINUTE },
      { node: "fra-edge-02", phase: "canary", state: "succeeded", after: 5 * MINUTE },
      { node: "fra-edge-03", phase: "canary", state: "succeeded", after: 8 * MINUTE },
    ],
  },
  {
    n: 4,
    clusterId: APAC,
    group: "singapore",
    version: "0.2.0",
    state: "succeeded",
    created: 19 * DAY,
    deliveries: [
      { node: "sin-edge-01", phase: "canary", state: "succeeded", after: 5 * MINUTE },
      { node: "sin-edge-02", phase: "canary", state: "succeeded", after: 5 * MINUTE },
      { node: "tyo-edge-01", phase: "rollout", state: "succeeded", after: 3 * HOUR },
      { node: "tyo-edge-02", phase: "rollout", state: "succeeded", after: 3 * HOUR + 4 * MINUTE },
    ],
  },
  {
    n: 5,
    clusterId: EU,
    group: "frankfurt",
    version: "0.2.0",
    state: "failed",
    created: 18 * DAY,
    deliveries: [
      {
        node: "fra-edge-02",
        phase: "canary",
        state: "failed",
        after: 7 * MINUTE,
        errorCode: "upgrade_rolled_back",
        message:
          "data plane did not answer on :443 within 60s after the restart; restored the previous binary",
      },
      {
        node: "fra-edge-01",
        phase: "canary",
        state: "cancelled",
        after: 7 * MINUTE,
        errorCode: "upgrade_cancelled",
        message: "stopped after a failed node",
      },
      {
        node: "fra-edge-03",
        phase: "canary",
        state: "cancelled",
        after: 7 * MINUTE,
        errorCode: "upgrade_cancelled",
        message: "stopped after a failed node",
      },
    ],
  },
];

const upgradeJobs: UpgradeJob[] = jobSeeds
  .map((seed) => ({
    id: id(35, seed.n),
    clusterId: seed.clusterId,
    clusterName: clusterName(seed.clusterId),
    groupName: seed.group,
    version: seed.version,
    state: seed.state,
    createdAt: ago(seed.created),
    canPromote: false,
    deliveries: seed.deliveries.map((d, i) => ({
      id: id(37, seed.n * 10 + i + 1),
      nodeId: nodeNamed(d.node).id,
      nodeName: d.node,
      phase: d.phase,
      state: d.state,
      message: d.message ?? "",
      errorCode: d.errorCode ?? "",
      deadlineAt: null,
      finishedAt: ago(seed.created - d.after),
    })),
  }))
  .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

// ---------------------------------------------------------------------------------------------
// The add-node dialog: a token nobody has used yet (kind 36). Obviously fake values.

const NODE_CHANNEL = "https://edge-api.example.net:8443";
const CA_SHA256 = "5f".repeat(32);
const LAB_TOKEN = "ewt_lab-token-for-screenshots-only";

// ---------------------------------------------------------------------------------------------

export const infraFixtures: Fixtures = {
  clusters: {
    rollbackPreview: (input) => {
      const clusterId = input.id;
      // A coerced number in the contract: the input type is unknown.
      const revision = Number(input.revision);
      const list = revisionsOf(clusterId);
      const latest = list[0]?.revision ?? null;
      const named = new Set(
        list
          .filter((r) => r.revision > revision)
          .map((r) => r.reasonParams.site)
          .filter((name): name is string => typeof name === "string" && !!name),
      );
      const changed = sites
        .filter((s) => s.clusterId === clusterId && named.has(s.name))
        .map((s) => ({ id: s.id, name: s.name }));
      return {
        revision,
        currentRevision: latest,
        unchanged: changed.length === 0,
        sites: { added: [], changed, removed: [] },
      };
    },
    portPools: ({ clusterId }) => ({
      clusterId,
      pools: portPools[clusterId] ?? [],
      reservedPorts: [80, 443],
      nodesWithoutL4: nodes
        .filter(
          (n) =>
            n.clusterId === clusterId &&
            n.status === "active" &&
            !n.supportedFeatures.includes("l4-v1"),
        )
        .map((n) => ({ id: n.id, name: n.name })),
    }),
    createEnrollmentToken: (input) => ({
      tokenId: id(36, 1),
      token: LAB_TOKEN,
      expiresAt: ahead((input.ttlMinutes ?? 60) * MINUTE),
      serverUrl: NODE_CHANNEL,
      caSha256: CA_SHA256,
      installCommand: [
        `export EDGEWEIR_TOKEN='${LAB_TOKEN}'`,
        `curl -fsSL https://console.example.net/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server ${NODE_CHANNEL} --ca-sha256 ${CA_SHA256}`,
      ].join("\n"),
      warnings: [],
    }),
    getEnrollmentToken: ({ id: tokenId }) => ({
      tokenId,
      expiresAt: ahead(58 * MINUTE),
      usedAt: null,
      node: null,
    }),
  },
  upgrades: {
    latestVersion: () => ({ version: "0.2.1" }),
    list: (input) =>
      upgradeJobs.filter((j) => !input?.clusterId || j.clusterId === input.clusterId),
  },
  l4Apps: {
    list: (input) => l4Apps.filter((app) => !input.clusterId || app.clusterId === input.clusterId),
    get: ({ id: appIdValue }) =>
      l4Apps.find((app) => app.id === appIdValue) ?? Promise.reject(notFound()),
    stats: ({ id: appIdValue, from, to }) =>
      l4Apps.some((app) => app.id === appIdValue)
        ? l4Stats(appIdValue, from, to)
        : Promise.reject(notFound()),
  },
  scheduling: {
    list: (input) =>
      ruleSeeds.filter((r) => !input.clusterId || r.clusterId === input.clusterId).map(rule),
    preview: ({ clusterId }) => ({
      clusterId,
      evaluatedAt: ago(7 * SECOND),
      rules: ruleSeeds
        .filter((r) => r.clusterId === clusterId)
        .map((seed) => ({
          ruleId: ruleId(seed),
          ruleName: seed.name,
          enabled: seed.enabled ?? true,
          lineName: seed.lineName,
          match: seed.match,
          action: seed.action,
          nodes: ruleNodes(seed).map((node) => previewNode(seed, node)),
        })),
    }),
  },
  dns: {
    catalog: () => dnsCatalogDto,
    providers: () => ({ items: providers, testEnabled: false }),
    protection: () => protection,
    bindings: () =>
      [...clusters]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((cluster) => {
          const b = bindingOf(cluster.id);
          const revision = desiredRevision(cluster.id);
          return {
            clusterId: cluster.id,
            clusterName: cluster.name,
            mode: b?.mode ?? "off",
            providerId: b?.providerId ?? null,
            zone: b ? (providerOf(b)?.zone ?? "") : "",
            domain: b?.domain ?? "",
            revision,
            applied: revision?.status === "applied",
            blocked: !!blockedRevision(cluster.id),
          };
        }),
    binding: ({ clusterId }) => bindingState(clusterId),
    bindingRevisions: ({ clusterId }) => revisionsOfBinding(clusterId),
    exportBinding: ({ clusterId }) => {
      const b = bindingOf(clusterId);
      if (!b || b.mode === "off") return { origin: "", records: [], zoneFile: "" };
      const zone = zoneOf(b);
      const records = b.clusterId === EU ? recordsOf(b) : currentRecords(b);
      return {
        origin: zone,
        records: records.map((r) => ({ ...r, name: absolute(r.name, zone) })),
        zoneFile: zoneFile(b, records),
      };
    },
  },
};
