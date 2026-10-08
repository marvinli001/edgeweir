/**
 * Certificates, DNS credentials, purge tasks, IP lists, bans and the platform protection
 * settings. Ties to the world: most sites have a valid certificate (shop.example.com included),
 * fra-edge-03 is offline (its newest purges wait for it), sin-edge-02 struggled during the burst
 * about 9.5 hours ago, and the burst left many bans on shop.example.com.
 */
import {
  type Ban,
  type BanSettings,
  banLookupCidr,
  type CacheTask,
  type CacheTaskNodeState,
  type CacheTaskType,
  type CcThresholds,
  type CertificateDto,
  cidrsOverlap,
  type IpListDto,
  type Node,
  type PrefetchVariant,
  type ProtectionSettings,
  parseBanCidr,
  parseCidr,
  type Site,
} from "@edgeweir/contract";
import { canonicalCidr } from "@edgeweir/rule-engine";
import { type Fixtures, notFound } from "./define";
import { ago, ahead, DAY, HOUR, id, MINUTE, NOW, nodes, noise, sites } from "./world";

const SECOND = 1_000;

const siteNamed = (name: string) => sites.find((s) => s.name === name) as Site;
const nodeNamed = (name: string) => nodes.find((n) => n.name === name) as Node;

const OPERATOR = { type: "user", id: "lab-operator", name: "Operator" };
/** An access key of the operator's own automation. */
const SOC_KEY = { type: "api_key", id: "lab-key-soc", name: "soc-automation" };
/** The deploy pipeline's service account (purges after releases). */
const CI = "ci-release";

/** Deterministic lowercase hex of `length` characters. */
function hex(seed: number, length: number): string {
  let out = "";
  for (let i = 0; out.length < length; i++) {
    out += Math.floor(noise(seed * 977 + i) * 0x10000)
      .toString(16)
      .padStart(4, "0");
  }
  return out.slice(0, length);
}

// ---------------------------------------------------------------------------------------------
// Certificates and DNS credentials (kinds 20, 24)

export const dnsCredentials = [
  { id: id(24, 1), name: "dns-webhook", provider: "webhook", zone: "example.com" },
  { id: id(24, 2), name: "powerdns-eu", provider: "powerdns", zone: "example.org" },
  { id: id(24, 3), name: "tsig-example-net", provider: "rfc2136", zone: "example.net" },
];

interface CertificateSeed {
  n: number;
  name: string;
  names?: string[];
  source?: CertificateDto["source"];
  status?: CertificateDto["status"];
  /** Issued this long ago and valid for `validFor` (issued certificates only). */
  issued?: number;
  validFor?: number;
  autoRenew?: boolean;
  /** Next renewal (ahead), for automatic certificates. */
  renewIn?: number | null;
  lastError?: string;
  bindSite?: string;
}

function certificate(seed: CertificateSeed): CertificateDto {
  const source = seed.source ?? "acme";
  const issued = seed.issued !== undefined;
  const autoRenew = seed.autoRenew ?? source === "acme";
  const notAfter = issued ? NOW - (seed.issued as number) + (seed.validFor ?? 90 * DAY) : null;
  return {
    id: id(20, seed.n),
    name: seed.name,
    names: seed.names ?? [seed.name],
    source,
    status: seed.status ?? "ready",
    fingerprint: issued ? hex(seed.n, 64) : "",
    notBefore: issued ? ago(seed.issued as number) : null,
    notAfter: notAfter === null ? null : new Date(notAfter).toISOString(),
    autoRenew,
    renewAt:
      autoRenew && seed.renewIn !== undefined && seed.renewIn !== null
        ? ahead(seed.renewIn)
        : autoRenew && notAfter !== null
          ? new Date(notAfter - 30 * DAY).toISOString()
          : null,
    lastError: seed.lastError ?? "",
    bindSiteId: seed.bindSite ? siteNamed(seed.bindSite).id : null,
  };
}

export const certificates: CertificateDto[] = [
  certificate({
    n: 1,
    name: "example.com",
    names: ["example.com", "www.example.com"],
    issued: 29 * DAY,
  }),
  certificate({
    n: 2,
    name: "shop.example.com",
    names: ["shop.example.com", "m.shop.example.com"],
    issued: 16 * DAY,
  }),
  // Uploaded, from a commercial CA: nine days left and nothing renews it.
  certificate({
    n: 3,
    name: "api.example.com",
    source: "upload",
    issued: 356 * DAY,
    validFor: 365 * DAY,
  }),
  // DNS-01 through tsig-example-net: static, img, app, media, video and auth.example.net.
  certificate({
    n: 4,
    name: "*.example.net",
    names: ["*.example.net", "example.net"],
    issued: 42 * DAY,
  }),
  certificate({ n: 5, name: "docs.example.org", issued: 7 * DAY }),
  // Still valid for 23 days; the renewal hit the CA's rate limit and retries in 5 hours.
  certificate({
    n: 6,
    name: "cdn.example.org",
    names: ["cdn.example.org", "assets.example.org"],
    status: "error",
    issued: 67 * DAY,
    renewIn: 5 * HOUR,
    lastError: "acme_rate_limited",
  }),
  // One-click HTTPS for download.example.com: mirror.example.com still points elsewhere.
  certificate({
    n: 7,
    name: "download.example.com",
    names: ["download.example.com", "mirror.example.com"],
    status: "error",
    lastError: "http01_dns_not_pointing",
    bindSite: "download.example.com",
  }),
  // One-click HTTPS for blog.example.org, being issued now.
  certificate({ n: 8, name: "blog.example.org", status: "issuing", bindSite: "blog.example.org" }),
  // The disabled site's uploaded certificate expired 12 days ago.
  certificate({
    n: 9,
    name: "legacy.example.org",
    source: "upload",
    issued: 377 * DAY,
    validFor: 365 * DAY,
  }),
  // DNS-01 through dns-webhook, queued.
  certificate({
    n: 10,
    name: "*.example.com",
    names: ["*.example.com", "example.com"],
    status: "pending",
  }),
  // DNS-01 through powerdns-eu: the server refused the credentials.
  certificate({
    n: 11,
    name: "*.example.org",
    names: ["*.example.org", "example.org"],
    status: "error",
    lastError: "dns_auth_failed",
  }),
  // Uploaded for the MQTT broker's TLS (layer 4, eu-edge).
  certificate({
    n: 12,
    name: "mqtt.example.org",
    source: "upload",
    issued: 40 * DAY,
    validFor: 397 * DAY,
  }),
  // Uploaded before explicit EC curve parameters were refused: nodes cannot load its key.
  certificate({
    n: 13,
    name: "intranet.example.net",
    source: "upload",
    status: "error",
    issued: 200 * DAY,
    validFor: 365 * DAY,
    lastError: "certificate_key_explicit_curve",
  }),
];

/** The issued certificate that covers every domain of a site, if any. */
export function siteCertificateId(siteId: string): string | null {
  const site = sites.find((s) => s.id === siteId);
  if (!site) return null;
  const covers = (names: string[], domain: string) =>
    names.some((name) => {
      if (name === domain) return true;
      const suffix = name.startsWith("*.") ? name.slice(1) : null;
      return !!suffix && domain.endsWith(suffix) && !domain.slice(0, -suffix.length).includes(".");
    });
  const match = certificates.find(
    (c) =>
      !!c.fingerprint &&
      !!c.notAfter &&
      Date.parse(c.notAfter) > NOW &&
      site.domains.every((d) => covers(c.names, d)),
  );
  return match?.id ?? null;
}

// ---------------------------------------------------------------------------------------------
// Cache tasks (kind 21)

type NodeOverride = Partial<{
  state: CacheTaskNodeState;
  errorCode: string;
  errorParams: Record<string, string>;
  message: string;
  succeeded: number;
  failed: number;
  /** Seconds after the task was created. */
  after: number;
  recoveredAt: string;
}>;

interface TaskSeed {
  n: number;
  at: number;
  type: CacheTaskType;
  sites: string[];
  targets: string[];
  variants?: PrefetchVariant[];
  maxUrls?: number;
  by?: string;
  recovery?: boolean;
  /** A PURGE request this node accepted. */
  purgeNode?: string;
  /** Only these nodes (a recovery purge goes to one node). */
  only?: string[];
  /** Targets each node reports (default: targets × variants). */
  count?: number;
  nodes?: Record<string, NodeOverride>;
}

const FRA_OFFLINE_SINCE = 47 * MINUTE;

function task(seed: TaskSeed): CacheTask {
  const created = NOW - seed.at;
  const taskSites = seed.sites.map(siteNamed);
  const clusterIds = new Set(taskSites.map((s) => s.clusterId));
  const targetNodes = nodes
    .filter((n) => clusterIds.has(n.clusterId) && (!seed.only || seed.only.includes(n.name)))
    .sort((a, b) => a.name.localeCompare(b.name));
  const variants =
    seed.type === "prefetch" || seed.type === "sitemap" ? (seed.variants ?? ["desktop"]) : [];
  const count = seed.count ?? seed.targets.length * Math.max(1, variants.length);
  const taskNodes = targetNodes.map((node, index) => {
    const override = seed.nodes?.[node.name] ?? {};
    // The offline node never got what was created after it went away.
    const missed = !node.online && seed.at < FRA_OFFLINE_SINCE;
    const state: CacheTaskNodeState = override.state ?? (missed ? "pending" : "succeeded");
    const done = state === "succeeded" || state === "failed";
    const after =
      override.after ?? 2 + Math.round(noise(seed.n * 41 + index) * 18) + (index % 2) * 3;
    return {
      nodeId: node.id,
      nodeName: node.name,
      state,
      message: override.message ?? "",
      errorCode: override.errorCode ?? "",
      errorParams: override.errorParams ?? {},
      succeeded: done ? (override.succeeded ?? (state === "succeeded" ? count : 0)) : 0,
      failed: done ? (override.failed ?? 0) : 0,
      finishedAt: done ? new Date(created + after * SECOND).toISOString() : null,
      recoveredAt: override.recoveredAt ?? null,
    };
  });
  const counted = taskNodes.filter((n) => n.state !== "skipped");
  const finished = counted.filter((n) => n.state === "succeeded" || n.state === "failed");
  const state: CacheTask["state"] =
    finished.length === counted.length
      ? counted.some((n) => n.state === "failed")
        ? "failed"
        : "succeeded"
      : finished.length > 0
        ? "running"
        : "pending";
  const lastFinish = finished
    .map((n) => n.finishedAt as string)
    .sort()
    .at(-1);
  return {
    id: id(21, seed.n),
    type: seed.type,
    targets: seed.targets,
    sites: taskSites.map((s) => ({ id: s.id, name: s.name })),
    variants,
    maxUrls: seed.type === "sitemap" ? (seed.maxUrls ?? 1000) : null,
    state,
    nodes: taskNodes,
    source: seed.recovery ? "recovery" : seed.purgeNode ? "purge_method" : "user",
    createdByName: seed.recovery ? "" : (seed.purgeNode ?? seed.by ?? OPERATOR.name),
    createdAt: new Date(created).toISOString(),
    finishedAt: state === "succeeded" || state === "failed" ? (lastFinish ?? null) : null,
  };
}

const RECOVERED_AT = 7.9 * DAY;

export const cacheTasks: CacheTask[] = [
  task({
    n: 26,
    at: 12 * SECOND,
    type: "prefetch",
    sites: ["static.example.net"],
    targets: [
      "https://static.example.net/js/app-3f9c1a.js",
      "https://static.example.net/css/app-3f9c1a.css",
      "https://img.example.net/hero@2x.webp",
    ],
    variants: ["desktop", "mobile"],
    by: CI,
    nodes: Object.fromEntries(
      ["tyo-edge-01", "tyo-edge-02", "sin-edge-01", "sin-edge-02"].map((name) => [
        name,
        { state: "pending" as const },
      ]),
    ),
  }),
  task({
    n: 25,
    at: 2 * MINUTE,
    type: "url",
    sites: ["shop.example.com"],
    targets: [
      "https://shop.example.com/products/sneaker-42",
      "https://m.shop.example.com/products/sneaker-42",
      "https://shop.example.com/api/v2/products?page=1",
    ],
    nodes: { "sin-edge-01": { state: "running" }, "sin-edge-02": { state: "pending" } },
  }),
  // The storefront's CMS sent PURGE for an edited product page through the Tokyo node.
  task({
    n: 27,
    at: 9 * MINUTE,
    type: "url",
    sites: ["shop.example.com"],
    targets: ["https://shop.example.com/products/trail-runner-9"],
    purgeNode: "tyo-edge-01",
  }),
  // fra-edge-03 is offline: the purge waits for it.
  task({
    n: 24,
    at: 24 * MINUTE,
    type: "host",
    sites: ["docs.example.org", "blog.example.org"],
    targets: ["docs.example.org", "blog.example.org"],
  }),
  task({
    n: 23,
    at: 52 * MINUTE,
    type: "site",
    sites: ["docs.example.org"],
    targets: ["docs.example.org"],
  }),
  task({
    n: 22,
    at: 1.6 * HOUR,
    type: "tag",
    sites: ["shop.example.com"],
    targets: ["product-42", "category-shoes"],
    by: CI,
  }),
  task({
    n: 21,
    at: 2.4 * HOUR,
    type: "url",
    sites: ["api.example.com"],
    targets: ["https://api.example.com/v1/catalog.json", "https://api.example.com/v1/openapi.yaml"],
  }),
  task({
    n: 20,
    at: 3.1 * HOUR,
    type: "prefix",
    sites: ["app.example.net"],
    targets: ["https://app.example.net/static/"],
    by: CI,
  }),
  task({
    n: 19,
    at: 4.2 * HOUR,
    type: "sitemap",
    sites: ["example.com"],
    targets: ["https://www.example.com/sitemap.xml"],
    variants: ["desktop", "mobile"],
    maxUrls: 1000,
    count: 1284,
    nodes: { "sin-edge-02": { after: 214 } },
  }),
  task({
    n: 18,
    at: 6 * HOUR,
    type: "prefix",
    sites: ["media.example.net"],
    targets: ["https://video.example.net/hls/launch-event/", "https://media.example.net/posters/"],
  }),
  // After the burst: everything of the shop, once.
  task({
    n: 17,
    at: 9.2 * HOUR,
    type: "site",
    sites: ["shop.example.com"],
    targets: ["shop.example.com"],
  }),
  // During the burst sin-edge-02 was too busy to finish the purge.
  task({
    n: 16,
    at: 9.45 * HOUR,
    type: "url",
    sites: ["shop.example.com"],
    targets: ["https://shop.example.com/", "https://shop.example.com/api/v2/cart"],
    nodes: {
      "sin-edge-02": {
        state: "failed",
        errorCode: "purge_failed",
        message: "purge did not complete: cache manager busy",
        succeeded: 1,
        failed: 1,
        after: 48,
      },
    },
  }),
  task({
    n: 15,
    at: 13 * HOUR,
    type: "sitemap",
    sites: ["docs.example.org"],
    targets: ["https://docs.example.org/sitemap.xml"],
    maxUrls: 2000,
    nodes: Object.fromEntries(
      ["fra-edge-01", "fra-edge-02", "fra-edge-03"].map((name) => [
        name,
        {
          state: "failed" as const,
          errorCode: "sitemap_failed",
          errorParams: {
            url: "https://docs.example.org/sitemap.xml",
            reason: "status",
            status: "404",
          },
          message: "GET https://docs.example.org/sitemap.xml: 404 Not Found",
          succeeded: 0,
          failed: 0,
        },
      ]),
    ),
  }),
  task({
    n: 14,
    at: 19 * HOUR,
    type: "tag",
    sites: ["cdn.example.org", "docs.example.org"],
    targets: ["theme-v7"],
    by: CI,
  }),
  task({
    n: 13,
    at: 26 * HOUR,
    type: "url",
    sites: ["example.com"],
    targets: [
      "https://www.example.com/",
      "https://www.example.com/pricing",
      "https://example.com/",
    ],
  }),
  task({
    n: 12,
    at: 1.6 * DAY,
    type: "prefetch",
    sites: ["download.example.com"],
    targets: [
      "https://download.example.com/releases/v4.2.0/app-linux-amd64.tar.gz",
      "https://download.example.com/releases/v4.2.0/app-darwin-arm64.tar.gz",
      "https://mirror.example.com/releases/v4.2.0/checksums.txt",
    ],
    by: CI,
    nodes: {
      "iad-edge-02": {
        state: "failed",
        errorCode: "prefetch_failed",
        errorParams: {
          failed: "1",
          total: "3",
          url: "https://download.example.com/releases/v4.2.0/app-darwin-arm64.tar.gz",
          reason: "timeout",
        },
        message:
          "1 of 3 URLs failed: https://download.example.com/releases/v4.2.0/app-darwin-arm64.tar.gz (timeout)",
        succeeded: 2,
        failed: 1,
        after: 300,
      },
    },
  }),
  task({
    n: 11,
    at: 2 * DAY,
    type: "host",
    sites: ["static.example.net"],
    targets: ["img.example.net"],
  }),
  task({
    n: 10,
    at: 2.7 * DAY,
    type: "url",
    sites: ["auth.example.net"],
    targets: ["https://auth.example.net/assets/login.js"],
  }),
  task({
    n: 9,
    at: 3 * DAY,
    type: "site",
    sites: ["static.example.net", "media.example.net"],
    targets: ["static.example.net", "media.example.net"],
  }),
  task({
    n: 8,
    at: 3.6 * DAY,
    type: "tag",
    sites: ["shop.example.com"],
    targets: ["price-update"],
    by: CI,
  }),
  task({
    n: 7,
    at: 4.5 * DAY,
    type: "url",
    sites: ["blog.example.org"],
    targets: ["https://blog.example.org/feed.xml"],
  }),
  task({
    n: 6,
    at: 5 * DAY,
    type: "prefetch",
    sites: ["shop.example.com"],
    targets: ["https://shop.example.com/", "https://shop.example.com/collections/autumn"],
    variants: ["desktop", "mobile"],
  }),
  // fra-edge-03 came back from maintenance: the purges it missed, made up at once.
  task({
    n: 5,
    at: RECOVERED_AT,
    type: "site",
    sites: ["cdn.example.org"],
    targets: ["cdn.example.org"],
    recovery: true,
    only: ["fra-edge-03"],
  }),
  task({
    n: 4,
    at: 8 * DAY,
    type: "url",
    sites: ["cdn.example.org"],
    targets: ["https://assets.example.org/css/site.css"],
    nodes: {
      "fra-edge-03": {
        state: "skipped",
        errorCode: "node_disabled",
        message: "node disabled",
        recoveredAt: ago(RECOVERED_AT - 40 * SECOND),
      },
    },
  }),
  task({
    n: 3,
    at: 9 * DAY,
    type: "url",
    sites: ["api.example.com"],
    targets: ["https://api.example.com/v1/status"],
  }),
  task({
    n: 2,
    at: 11 * DAY,
    type: "prefix",
    sites: ["docs.example.org"],
    targets: ["https://docs.example.org/v3/"],
  }),
  task({
    n: 1,
    at: 13 * DAY,
    type: "site",
    sites: ["download.example.com"],
    targets: ["download.example.com"],
  }),
];

// ---------------------------------------------------------------------------------------------
// IP lists (kind 22)

function ipList(n: number, name: string, kind: IpListDto["kind"], entries: string[]): IpListDto {
  return {
    id: id(22, n),
    name,
    kind,
    entries: [...new Set(entries.map(canonicalCidr))].sort(),
  };
}

const range = <T>(count: number, map: (i: number) => T): T[] =>
  Array.from({ length: count }, (_, i) => map(i));

export const ipLists: IpListDto[] = [
  ipList(1, "anonymizers", "block", [
    ...range(24, (i) => `198.51.100.${160 + i}`),
    ...range(40, (i) => `2001:db8:e${(i >> 4).toString(16)}${(i & 15).toString(16)}::/48`),
  ]),
  ipList(2, "api_partners", "collection", [
    "192.0.2.16/28",
    "198.51.100.128/27",
    "203.0.113.60",
    "203.0.113.61",
    "203.0.113.62",
    "2001:db8:200::/48",
  ]),
  ipList(3, "bad_bots", "collection", [
    ...range(18, (i) => `203.0.113.${150 + i * 3}`),
    ...range(14, (i) => `192.0.2.${100 + i * 5}`),
    ...range(6, (i) => `2001:db8:bad:${i + 1}::/64`),
  ]),
  // Collected from abuse reports: mostly IPv6 /64s.
  ipList(4, "blocklist", "block", [
    ...range(
      180,
      (i) =>
        `2001:db8:f${(i >> 8).toString(16)}${((i >> 4) & 15).toString(16)}${(i & 15).toString(16)}::/56`,
    ),
    ...range(1060, (i) => `2001:db8:c0de:${i.toString(16)}::/64`),
  ]),
  ipList(5, "monitoring", "allow", ["203.0.113.200/29", "2001:db8:300::/56"]),
  ipList(6, "office_vpn", "allow", ["192.0.2.0/28", "198.51.100.0/29", "2001:db8:100::/48"]),
  ipList(7, "payment_webhooks", "collection", [
    "198.51.100.240/28",
    "203.0.113.250",
    "203.0.113.251",
  ]),
  ipList(8, "retired_partners", "collection", []),
];

// ---------------------------------------------------------------------------------------------
// Bans (kind 23)

/** The platform CC template; sites that follow it ban for its ipBanSeconds. */
export const ccTemplate: CcThresholds = {
  maxLevel: "captcha",
  highPowInsteadOfCaptcha: true,
  windowSeconds: 10,
  siteQps: 1500,
  urlQps: 300,
  ipQps: 40,
  ipBanSeconds: 43_200,
  originErrorPercent: 40,
  originErrorMinRequests: 100,
  escalateAfterSeconds: 10,
  cooldownSeconds: 120,
};

const BURST_AT = 9.5 * HOUR;

interface BanSeed {
  cidr: string;
  at: number;
  /** Seconds. */
  duration: number;
  reason: Ban["reason"];
  site?: string;
  node?: string;
  observed?: number;
  threshold?: number;
  by?: Ban["createdBy"];
  distributed?: boolean;
  unappliedNodes?: number;
}

function banOf(seed: BanSeed, n: number): Omit<Ban, "seq"> {
  const auto = seed.reason === "cc_ip_rate";
  const parsed = parseBanCidr(seed.cidr);
  if (!parsed.ok) throw new Error(`lab: bad ban ${seed.cidr}`);
  const site = seed.site ? siteNamed(seed.site) : null;
  const node = seed.node ? nodeNamed(seed.node) : null;
  return {
    id: id(23, n),
    scope: site ? "site" : "platform",
    cidr: parsed.text,
    reason: seed.reason,
    source: auto ? "auto" : "manual",
    siteId: site?.id ?? null,
    siteName: site?.name ?? null,
    node: auto && node ? { id: node.id, name: node.name } : null,
    trigger: auto
      ? {
          metric: "ip_qps",
          observed: seed.observed ?? 0,
          threshold: seed.threshold ?? ccTemplate.ipQps,
          windowSeconds: ccTemplate.windowSeconds,
        }
      : null,
    createdBy: auto ? null : (seed.by ?? OPERATOR),
    createdAt: ago(seed.at),
    expiresAt: ago(seed.at - seed.duration * SECOND),
    distributed: seed.distributed ?? true,
    unappliedNodes: seed.unappliedNodes ?? 0,
  };
}

const APAC_NODES = ["tyo-edge-01", "tyo-edge-02", "sin-edge-01", "sin-edge-02"];

/** Addresses the shop's nodes banned on their own during the burst. */
const burstAddresses = [
  "198.51.100.204",
  "203.0.113.140",
  "192.0.2.18",
  "2001:db8:4f::/64",
  "198.51.100.9",
  "2001:db8:91::/64",
  "198.51.100.63",
  "203.0.113.5",
  ...range(22, (i) => `203.0.113.${132 + i * 3}`),
  ...range(10, (i) => `198.51.100.${210 + i * 3}`),
  ...range(4, (i) => `2001:db8:7e:${(i + 1).toString(16)}::/64`),
];

const banSeeds: BanSeed[] = [
  ...burstAddresses.map(
    (cidr, i): BanSeed => ({
      cidr,
      // Spread over the burst, a few minutes either side of its peak.
      at: BURST_AT + (noise(i * 13 + 5) - 0.45) * 36 * MINUTE,
      duration: ccTemplate.ipBanSeconds,
      reason: "cc_ip_rate",
      site: "shop.example.com",
      node: APAC_NODES[Math.floor(noise(i * 7 + 1) * APAC_NODES.length)],
      observed: Math.round(ccTemplate.ipQps * (1.6 + noise(i * 29 + 3) * 20)),
    }),
  ),
  // The heaviest client of the burst: off every site for a week.
  {
    cidr: "203.0.113.77",
    at: 9.2 * HOUR,
    duration: 7 * 86_400,
    reason: "attack",
    unappliedNodes: 1,
  },
  { cidr: "2001:db8:4f::/48", at: 9.1 * HOUR, duration: 7 * 86_400, reason: "attack" },
  {
    cidr: "192.0.2.192/26",
    at: 9 * HOUR,
    duration: 3 * 86_400,
    reason: "scanner",
    site: "shop.example.com",
  },
  {
    cidr: "198.51.100.208/28",
    at: 8.8 * HOUR,
    duration: 86_400,
    reason: "attack",
    site: "shop.example.com",
    by: SOC_KEY,
  },
  // api.example.com in the last hour: its own (looser) policy.
  ...range(
    5,
    (i): BanSeed => ({
      cidr: `192.0.2.${150 + i * 7}`,
      at: (6 + i * 9) * MINUTE,
      duration: 3_600,
      reason: "cc_ip_rate",
      site: "api.example.com",
      node: ["iad-edge-01", "iad-edge-02", "iad-edge-03"][i % 3],
      observed: 180 + Math.round(noise(i + 90) * 400),
      threshold: 150,
    }),
  ),
  {
    cidr: "203.0.113.240/28",
    at: 62 * MINUTE,
    duration: 6 * 3_600,
    reason: "abuse",
    site: "api.example.com",
    by: SOC_KEY,
  },
  // A spammer of the docs' comment form: twenty minutes left.
  {
    cidr: "203.0.113.9",
    at: 40 * MINUTE,
    duration: 3_600,
    reason: "spam",
    site: "docs.example.org",
  },
  { cidr: "198.51.100.66", at: 20 * HOUR, duration: 86_400, reason: "scanner" },
  // Reported while sharing was briefly off: only the node that banned it knows.
  {
    cidr: "2001:db8:a7:3::/64",
    at: 11 * HOUR,
    duration: ccTemplate.ipBanSeconds,
    reason: "cc_ip_rate",
    site: "media.example.net",
    node: "sin-edge-01",
    observed: 212,
    distributed: false,
  },
  {
    cidr: "192.0.2.144",
    at: 1.5 * DAY,
    duration: 3 * 86_400,
    reason: "abuse",
    site: "auth.example.net",
  },
  { cidr: "2001:db8:dead::/48", at: 5 * DAY, duration: 7 * 86_400, reason: "other" },
];

/** Active bans, newest first, with change sequence numbers in creation order. */
export const bans: Ban[] = (() => {
  const built = banSeeds
    .map(banOf)
    .filter((ban) => Date.parse(ban.expiresAt) > NOW)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const first = 9_812 - built.length;
  return built.map((ban, i): Ban => ({ ...ban, seq: String(first + i) })).reverse();
})();

// ---------------------------------------------------------------------------------------------
// Settings

const banSettings: BanSettings = { maxTotal: 20_000, shareAutoBans: true };
const protectionSettings: ProtectionSettings = {
  underAttack: false,
  underAttackChallenge: "pow",
  eventRetentionDays: 90,
};

// ---------------------------------------------------------------------------------------------

const page = <T>(items: T[], pageInput: unknown, sizeInput: unknown, fallback: number) => {
  const number = Math.max(1, Number(pageInput ?? 1));
  const size = Math.max(1, Number(sizeInput ?? fallback));
  return { items: items.slice((number - 1) * size, number * size), total: items.length };
};

export const accessFixtures: Fixtures = {
  certificates: {
    list: () => certificates,
    settings: () => ({ acmeDirectory: null, acmeDirectoryEab: false, defaultCa: "letsencrypt" }),
  },
  acmeAccounts: {
    list: () => [],
  },
  dnsCredentials: {
    list: () => dnsCredentials,
  },
  cacheTasks: {
    list: (input) =>
      page(
        cacheTasks.filter((t) => !input.siteId || t.sites.some((s) => s.id === input.siteId)),
        input.page,
        input.pageSize,
        20,
      ),
    get: ({ id: taskId }) => cacheTasks.find((t) => t.id === taskId) ?? Promise.reject(notFound()),
  },
  ipLists: {
    list: () => ipLists,
  },
  bans: {
    list: (input) => {
      const lookup = input.address ? banLookupCidr(input.address) : null;
      const address = lookup ? parseCidr(lookup) : null;
      const matching = bans.filter((ban) => {
        if (input.scope && ban.scope !== input.scope) return false;
        if (input.siteId && ban.siteId !== input.siteId) return false;
        if (input.source && ban.source !== input.source) return false;
        if (input.address) {
          const cidr = parseCidr(ban.cidr);
          if (!address || !cidr || !cidrsOverlap(cidr, address)) return false;
        }
        return true;
      });
      return page(matching, input.page, input.pageSize, 50);
    },
  },
  settings: {
    bans: () => banSettings,
    protection: () => protectionSettings,
    ccTemplate: () => ccTemplate,
  },
};
