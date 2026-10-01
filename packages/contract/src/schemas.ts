import * as z from "zod";
import { normalizeCidr, parseIp } from "./addresses";

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`);

/** A host name, optionally prefixed with "*." for a wildcard. Normalised to lowercase. */
export const domainName = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => {
    const host = value.startsWith("*.") ? value.slice(2) : value;
    return host.includes(".") || host === "localhost" ? HOSTNAME_RE.test(host) : false;
  }, "invalid domain name");

/**
 * A last label that resolvers (inet_aton) read as a number, as in "127.1",
 * "0x7f000001" or "2130706433": such names are ambiguous IP literals, and no
 * real top-level domain is numeric.
 */
const NUMERIC_LABEL_RE = /(?:^|\.)(?:[0-9]+|0x[0-9a-f]*)$/i;

/**
 * Origin address: host name or IPv4/IPv6 literal (without port or brackets).
 * Special-purpose IP literals are refused by the service unless the platform
 * allows them (see addresses.ts).
 */
export const originAddress = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      parseIp(value) !== null ||
      (HOSTNAME_RE.test(value.toLowerCase()) && !NUMERIC_LABEL_RE.test(value)),
    "invalid origin address",
  );

/** An IPv4 or IPv6 CIDR (a bare address is a single host), normalized ("10.1.2.3/8" → "10.0.0.0/8"). */
export const cidr = z
  .string()
  .trim()
  .max(64)
  .transform((value, ctx) => {
    const normalized = normalizeCidr(value);
    if (normalized === null) {
      ctx.addIssue({ code: "custom", message: "invalid CIDR", input: value });
      return z.NEVER;
    }
    return normalized;
  });

export const port = z.number().int().min(1).max(65535);
export const uuid = z.uuid();
export const isoDateTime = z.iso.datetime({ offset: true });

export const pathPrefix = z
  .string()
  .trim()
  .startsWith("/")
  .max(1024)
  .refine((value) => !/\s/.test(value), "path prefix must not contain whitespace");

export const extension = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) => value.replace(/^\./, ""))
  .pipe(z.string().regex(/^[a-z0-9]{1,16}$/, "invalid file extension"));

/** An exact URI path, e.g. "/index.html". */
export const exactPath = pathPrefix;

/** Host name used as TLS SNI or Host override; empty means derived. */
const optionalHostname = z
  .string()
  .trim()
  .toLowerCase()
  .max(253)
  .refine((value) => value === "" || HOSTNAME_RE.test(value), "invalid host name");

/** A host name without wildcard or port (purge by host). Normalised to lowercase. */
export const hostName = domainName.refine(
  (value) => !value.startsWith("*."),
  "wildcards are not allowed",
);

/** RFC 7230 token, used for header and cookie names in cache keys. */
const TOKEN_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/;

export const headerName = z
  .string()
  .trim()
  .toLowerCase()
  .regex(TOKEN_RE, "invalid header name")
  .refine(
    (value) => !["cookie", "host"].includes(value),
    "use the cookie and host options instead",
  );

export const cookieName = z.string().trim().regex(TOKEN_RE, "invalid cookie name");

export const queryParamName = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .refine((value) => !/[\s&=#]/.test(value), "invalid query parameter name");

export const originScheme = z.enum(["http", "https"]);
export const loadBalancePolicy = z.enum(["weighted_random", "round_robin", "consistent_hash"]);
export const cacheAction = z.enum(["cache", "bypass"]);
export const originCacheControl = z.enum(["override", "respect"]);
export const applyState = z.enum(["applying", "applied", "failed"]);

/** S3-compatible object storage: requests are signed with AWS Signature V4. */
export const s3Input = z.object({
  region: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{0,63}$/, "invalid region"),
  /** Path-style bucket; leave empty when the origin address names the bucket. */
  bucket: z
    .string()
    .trim()
    .regex(/^([a-z0-9][a-z0-9.-]{1,61}[a-z0-9])?$/, "invalid bucket name")
    .default(""),
  accessKeyId: z.string().trim().min(1).max(128),
  /** Write-only. Omit to keep the stored secret of the same access key. */
  secretAccessKey: z.string().min(1).max(256).optional(),
});

export const originInput = z.object({
  address: originAddress,
  port: port.default(80),
  scheme: originScheme.default("http"),
  weight: z.number().int().min(1).max(100).default(1),
  backup: z.boolean().default(false),
  hostHeader: z.string().trim().max(253).default(""),
  /** TLS server name for HTTPS origins; empty derives it from the Host or address. */
  sni: optionalHostname.default(""),
  s3: s3Input.nullable().default(null),
});

const MAX_TTL = 365 * 24 * 3600;
const MAX_STALE = 30 * 24 * 3600;

export const cacheRuleInput = z
  .object({
    priority: z.number().int().min(0).max(10000).default(100),
    pathPrefixes: z.array(pathPrefix).max(32).default([]),
    paths: z.array(exactPath).max(32).default([]),
    extensions: z.array(extension).max(64).default([]),
    /** Response status codes; empty matches any status the rule may cache. */
    statusCodes: z.array(z.number().int().min(100).max(599)).max(16).default([]),
    /** Response size bounds in bytes; 0 means unbounded. */
    minSizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    maxSizeBytes: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).default(0),
    action: cacheAction.default("cache"),
    edgeTtlSeconds: z.number().int().min(0).max(MAX_TTL).default(3600),
    /** Respect by default: override also caches private and no-store responses. */
    originCacheControl: originCacheControl.default("respect"),
    staleWhileRevalidateSeconds: z.number().int().min(0).max(MAX_STALE).default(0),
    staleIfErrorSeconds: z.number().int().min(0).max(MAX_STALE).default(0),
    /**
     * Cache responses to requests that carry an Authorization header. Off, such
     * requests bypass the cache (RFC 9111 section 3.5).
     */
    cacheAuthorized: z.boolean().default(false),
  })
  .refine((r) => r.maxSizeBytes === 0 || r.maxSizeBytes >= r.minSizeBytes, {
    message: "maximum size must not be below the minimum size",
    path: ["maxSizeBytes"],
  });

/** Absolute path with an optional query: 1-1024 printable ASCII bytes without spaces. */
export const HEALTH_CHECK_PATH_RE = /^\/[\x21-\x7e]{0,1023}$/;

/**
 * Active health checks of an origin pool, run by the agent of every node
 * (feature active-health-v1). An origin goes down after unhealthyThreshold
 * failed probes in a row and comes back after healthyThreshold successful
 * ones; either check marking an origin down takes it out of rotation. The
 * settings are kept while the check is off.
 */
export const activeHealthCheck = z
  .object({
    enabled: z.boolean().default(false),
    path: z.string().regex(HEALTH_CHECK_PATH_RE, "invalid health check path").default("/"),
    method: z.enum(["GET", "HEAD"]).default("GET"),
    /** Expected response status range, inclusive. */
    expectedStatusMin: z.number().int().min(100).max(599).default(200),
    expectedStatusMax: z.number().int().min(100).max(599).default(399),
    /** Host header of the probes; empty: the origin's Host header, else its address. */
    host: optionalHostname.default(""),
    intervalSeconds: z.number().int().min(5).max(300).default(30),
    /** At most intervalSeconds. */
    timeoutSeconds: z.number().int().min(1).max(60).default(5),
    healthyThreshold: z.number().int().min(1).max(10).default(2),
    unhealthyThreshold: z.number().int().min(1).max(10).default(3),
  })
  .refine((check) => check.expectedStatusMin <= check.expectedStatusMax, {
    message: "the minimum status must not be above the maximum",
    path: ["expectedStatusMax"],
  })
  .refine((check) => check.timeoutSeconds <= check.intervalSeconds, {
    message: "the timeout must not be longer than the interval",
    path: ["timeoutSeconds"],
  });

/**
 * Cookie-based session affinity of an origin pool (feature
 * session-affinity-v1): the signed cookie pins a client to the origin that
 * served it for ttlSeconds. Kept while off.
 */
export const sessionAffinity = z.object({
  enabled: z.boolean().default(false),
  ttlSeconds: z.number().int().min(60).max(604_800).default(3600),
});

/** Origin pool behaviour: load balancing, health, TLS, connections, WebSocket. */
export const originSettings = z.object({
  policy: loadBalancePolicy.default("weighted_random"),
  /** Verify certificates of HTTPS origins against the system trust store. */
  tlsVerify: z.boolean().default(true),
  /** Passive health check: consecutive failures that mark an origin down. */
  maxFails: z.number().int().min(1).max(100).default(3),
  /** Passive health check: seconds before a down origin is tried again. */
  recoverySeconds: z.number().int().min(1).max(3600).default(30),
  connectTimeoutMs: z.number().int().min(100).max(120_000).default(10_000),
  sendTimeoutMs: z.number().int().min(100).max(3_600_000).default(60_000),
  readTimeoutMs: z.number().int().min(100).max(3_600_000).default(60_000),
  /** Reuse upstream connections. */
  keepalive: z.boolean().default(true),
  keepaliveIdleSeconds: z.number().int().min(1).max(3600).default(60),
  keepaliveMaxRequests: z.number().int().min(1).max(100_000).default(1000),
  /** Proxy WebSocket upgrades to the origin. */
  websocket: z.boolean().default(true),
  activeHealthCheck: activeHealthCheck.prefault({}),
  sessionAffinity: sessionAffinity.prefault({}),
});

export const cacheKeyQuery = z.enum(["all", "ignore", "include"]);

/** How the cache key of every request of a site is composed. */
export const cacheKeyPolicy = z.object({
  query: cacheKeyQuery.default("all"),
  /** Parameters kept by `include`. */
  queryParams: z.array(queryParamName).max(32).default([]),
  /** Sort parameters so that their order does not matter. */
  sortQuery: z.boolean().default(false),
  /** Request headers whose values vary the key. */
  headers: z.array(headerName).max(8).default([]),
  /** Cookies whose values vary the key. */
  cookies: z.array(cookieName).max(8).default([]),
  /** Separate mobile and desktop user agents. */
  deviceType: z.boolean().default(false),
  /** Include the Host; when off, all domains of the site share cached objects. */
  includeHost: z.boolean().default(true),
});

export const cacheSettings = z.object({
  cacheKey: cacheKeyPolicy.prefault({}),
  /** Fetch and cache large files in 1 MiB slices (Range requests). */
  rangeSlice: z.boolean().default(false),
  /**
   * Forward the origin's Cache-Tag response header to clients. Off, the edge
   * removes it; nodes index the tags of cached objects either way.
   */
  keepCacheTag: z.boolean().default(false),
});

export const siteCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  clusterId: uuid.optional(),
  domains: z.array(domainName).min(1).max(50),
  origins: z.array(originInput).min(1).max(32),
  cacheRules: z.array(cacheRuleInput).max(64).default([]),
  originSettings: originSettings.prefault({}),
  cacheSettings: cacheSettings.prefault({}),
});

export const origin = originInput.omit({ s3: true }).extend({
  id: uuid,
  /** Secrets are never returned. */
  s3: z.object({ region: z.string(), bucket: z.string(), accessKeyId: z.string() }).nullable(),
});
export const cacheRule = z.object({
  id: uuid,
  priority: z.number().int(),
  pathPrefixes: z.array(z.string()),
  paths: z.array(z.string()),
  extensions: z.array(z.string()),
  statusCodes: z.array(z.number().int()),
  minSizeBytes: z.number().int(),
  maxSizeBytes: z.number().int(),
  action: cacheAction,
  edgeTtlSeconds: z.number().int(),
  originCacheControl,
  staleWhileRevalidateSeconds: z.number().int(),
  staleIfErrorSeconds: z.number().int(),
  cacheAuthorized: z.boolean(),
});

export const site = z.object({
  id: uuid,
  name: z.string(),
  /** A disabled site is not shipped to nodes. */
  enabled: z.boolean(),
  clusterId: uuid,
  clusterName: z.string(),
  domains: z.array(z.string()),
  origins: z.array(origin),
  cacheRules: z.array(cacheRule),
  originSettings: originSettings.required(),
  cacheSettings: z.object({
    cacheKey: cacheKeyPolicy.required(),
    rangeSlice: z.boolean(),
    keepCacheTag: z.boolean(),
  }),
  cacheGeneration: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const revision = z.object({
  clusterId: uuid,
  revision: z.number().int(),
  contentHash: z.string(),
  siteCount: z.number().int(),
  /** English text; the UI renders `reasonCode` with `reasonParams` instead. */
  reason: z.string(),
  /** Empty for revisions published before reason codes existed. */
  reasonCode: z.string(),
  reasonParams: z.record(z.string(), z.union([z.string(), z.number()])),
  createdAt: isoDateTime,
});

export const siteMutationResult = z.object({
  site,
  revision,
});

/** Optimistic concurrency: the `updatedAt` the caller last read; a mismatch is a 409. */
export const expectedUpdatedAt = isoDateTime.optional();

export const siteSetEnabledInput = z.object({
  id: uuid,
  enabled: z.boolean(),
  expectedUpdatedAt,
});

export const cluster = z.object({
  id: uuid,
  name: z.string(),
  description: z.string(),
  nodeCount: z.number().int(),
  onlineNodeCount: z.number().int(),
  siteCount: z.number().int(),
  latestRevision: revision.nullable(),
  createdAt: isoDateTime,
});

const clusterName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes only");

export const clusterCreateInput = z.object({
  name: clusterName,
  description: z.string().trim().max(500).default(""),
});

export const clusterUpdateInput = z.object({
  id: uuid,
  name: clusterName.optional(),
  description: z.string().trim().max(500).optional(),
});

export const regionCode = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,31}$/, "lowercase letters, digits and dashes only");

export const region = z.object({
  id: uuid,
  name: z.string(),
  code: z.string(),
  nodeGroupCount: z.number().int(),
  createdAt: isoDateTime,
});

export const regionCreateInput = z.object({
  name: z.string().trim().min(1).max(64),
  code: regionCode,
});

export const regionUpdateInput = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(64).optional(),
  code: regionCode.optional(),
});

export const nodeGroup = z.object({
  id: uuid,
  clusterId: uuid,
  name: z.string(),
  isDefault: z.boolean(),
  /** Nodes of canary groups get candidate revisions first (configuration canary). */
  isCanary: z.boolean(),
  regionId: uuid.nullable(),
  regionName: z.string().nullable(),
  regionCode: z.string().nullable(),
  nodeCount: z.number().int(),
  createdAt: isoDateTime,
});

const nodeGroupName = z.string().trim().min(1).max(64);

export const nodeGroupCreateInput = z.object({
  clusterId: uuid,
  name: nodeGroupName,
  regionId: uuid.nullable().default(null),
  isCanary: z.boolean().default(false),
});

export const nodeGroupUpdateInput = z.object({
  id: uuid,
  name: nodeGroupName.optional(),
  regionId: uuid.nullable().optional(),
  isCanary: z.boolean().optional(),
});

/** Configuration canary policy of a cluster. */
export const rolloutPolicy = z.object({
  enabled: z.boolean(),
  /** Observation window. */
  windowSeconds: z.number().int().min(60).max(3600),
  /** Promote automatically when the window passes; otherwise wait for an administrator. */
  autoPromote: z.boolean(),
  /** Roll back when the canary 5xx ratio exceeds max(baseline × multiplier, floor). */
  errorRatioMultiplier: z.number().min(1).max(100),
  errorRatioFloor: z.number().min(0.001).max(1),
  /** …and the canary nodes served at least this many requests in the window. */
  minRequests: z.number().int().min(1).max(1_000_000),
});

export const rolloutState = z.enum([
  "idle",
  "canary",
  "awaiting_promotion",
  "promoted",
  "rolled_back",
  "direct",
]);

export const rolloutOutcome = z.enum([
  "",
  "auto_promote",
  "manual_promote",
  "apply_failed",
  "apply_timeout",
  "unhealthy",
  "error_ratio",
  "manual_abort",
  "no_canary",
  "policy_disabled",
  "manual_rollback",
  "withdrawn",
]);

export const clusterRollout = z.object({
  clusterId: uuid,
  policy: rolloutPolicy,
  state: rolloutState,
  /** Revision of the non-canary nodes. */
  stableRevision: z.number().int().nullable(),
  /** Revision of the canary nodes while a rollout runs. */
  candidateRevision: z.number().int().nullable(),
  /** The candidate that was promoted or rolled back last. */
  lastCandidateRevision: z.number().int().nullable(),
  windowStartedAt: isoDateTime.nullable(),
  windowEndsAt: isoDateTime.nullable(),
  outcome: rolloutOutcome,
  finishedAt: isoDateTime.nullable(),
  canaryNodes: z.array(
    z.object({
      id: uuid,
      name: z.string(),
      online: z.boolean(),
      appliedRevision: z.number().int(),
      /** Takes part in the running window. */
      participating: z.boolean(),
    }),
  ),
  /** Traffic of the running window: canary nodes and the others (baseline). */
  window: z
    .object({
      canaryRequests: z.number().int(),
      canary5xx: z.number().int(),
      baselineRequests: z.number().int(),
      baseline5xx: z.number().int(),
    })
    .nullable(),
  updatedAt: isoDateTime,
});

export const rolloutPolicyInput = rolloutPolicy.extend({ id: uuid, expectedUpdatedAt });

/** How a node holds the dynamic bans, from its last heartbeat (nodes with bans-v1). */
export const nodeBanStatus = z.object({
  /** Highest ban sequence applied to the data plane (decimal). */
  appliedSequence: z.string(),
  entries: z.number().int(),
  capacity: z.number().int(),
  /** Manual bans the node could not hold (at most 100 ids). */
  unappliedIds: z.array(z.string()),
  unapplied: z.number().int(),
  /** Platform bans held by nftables (kernel-ban-v1). */
  kernelEntries: z.number().int(),
  /** Automatic bans dropped to make room since the agent started (decimal). */
  autoEvicted: z.string(),
  reportedAt: isoDateTime,
});

export const node = z.object({
  id: uuid,
  name: z.string(),
  clusterId: uuid,
  clusterName: z.string(),
  nodeGroupId: uuid.nullable(),
  nodeGroupName: z.string().nullable(),
  regionName: z.string().nullable(),
  hostname: z.string(),
  status: z.enum(["active", "disabled"]),
  online: z.boolean(),
  lastSeenAt: isoDateTime.nullable(),
  enrolledAt: isoDateTime.nullable(),
  agentVersion: z.string(),
  supportedFeatures: z.array(z.string()),
  upgradeRequired: z.boolean(),
  engine: z.string(),
  engineVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  ipAddresses: z.array(z.string()),
  certFingerprint: z.string().nullable(),
  certNotAfter: isoDateTime.nullable(),
  appliedRevision: z.number().int(),
  appliedContentHash: z.string(),
  /** The revision this node should run (with a canary: stable or candidate). */
  targetRevision: z.number().int().nullable(),
  applyState: applyState.nullable(),
  applyMessage: z.string(),
  dataPlaneHealthy: z.boolean(),
  /** Null for nodes without dynamic bans (bans-v1). */
  banStatus: nodeBanStatus.nullable(),
});

export const nodeUpdateInput = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(64).optional(),
  nodeGroupId: uuid.optional(),
});

export const enrollmentTokenInput = z.object({
  clusterId: uuid,
  /** Defaults to the cluster's default node group. */
  nodeGroupId: uuid.optional(),
  nodeName: z.string().trim().max(64).default(""),
  ttlMinutes: z
    .number()
    .int()
    .min(5)
    .max(7 * 24 * 60)
    .default(60),
});

export const enrollmentTokenResult = z.object({
  tokenId: uuid,
  token: z.string(),
  expiresAt: isoDateTime,
  serverUrl: z.string(),
  caSha256: z.string(),
  installCommand: z.string(),
});

export const overview = z.object({
  clusters: z.number().int(),
  nodes: z.number().int(),
  onlineNodes: z.number().int(),
  sites: z.number().int(),
  revisions: z.array(revision),
});

/** Time windows the analytics views offer, each ending now. */
export const analyticsRange = z.enum(["1h", "6h", "24h", "7d", "30d"]);

/** Traffic counters of one time bucket or a whole period, summed over nodes and sites. */
const trafficCounters = {
  requests: z.number().int(),
  bytesSent: z.number().int(),
  bytesReceived: z.number().int(),
  cacheHits: z.number().int(),
  cacheMisses: z.number().int(),
  /** Responses by status class. */
  status2xx: z.number().int(),
  status3xx: z.number().int(),
  status4xx: z.number().int(),
  status5xx: z.number().int(),
};

export const trafficPoint = z.object({ time: isoDateTime, ...trafficCounters });

export const trafficTotals = z.object({
  ...trafficCounters,
  /** Egress of the busiest bucket, in bytes per second. */
  peakBytesPerSecond: z.number(),
});

export const trafficInput = z.object({
  range: analyticsRange.default("24h"),
  /** Only this site; it must be visible to the caller. */
  siteId: uuid.optional(),
});

export const traffic = z.object({
  range: analyticsRange,
  /** Width of one point, in seconds. */
  bucketSeconds: z.number().int(),
  from: isoDateTime,
  to: isoDateTime,
  /** One point per bucket, oldest first; buckets without traffic are zero. */
  points: z.array(trafficPoint),
  totals: trafficTotals,
  /** The same-length period right before `from`, for change indicators. */
  previous: trafficTotals,
});

export const trafficTopInput = z.object({
  range: analyticsRange.default("24h"),
  limit: z.coerce.number().int().min(1).max(50).default(5),
});

/** A site or node ranked by requests over a period. */
export const trafficTopItem = z.object({
  id: uuid,
  name: z.string(),
  /** The cluster of the site or node. */
  parentId: z.string(),
  parentName: z.string(),
  requests: z.number().int(),
  bytesSent: z.number().int(),
  cacheHits: z.number().int(),
  cacheMisses: z.number().int(),
});

export const trafficBreakdownInput = z.object({
  range: analyticsRange.default("24h"),
  /** Only this site; it must be visible to the caller. */
  siteId: uuid.optional(),
  /** Sites, edge nodes or HTTP status codes. */
  by: z.enum(["site", "node", "status"]),
  /** What the items are ranked and plotted by; status codes always count requests. */
  metric: z.enum(["requests", "bytesSent"]).default("requests"),
  /** With `by: status`, only codes of this class (4 → 4xx). */
  statusClass: z.coerce.number().int().min(1).max(5).optional(),
  limit: z.coerce.number().int().min(1).max(20).default(10),
});

/** One site, node or status code with its share of the metric. */
export const trafficBreakdownItem = z.object({
  /** Site or node id, or the status code ("404"). */
  id: z.string(),
  name: z.string(),
  /** The cluster of the site or node; null for status codes. */
  parentId: z.string().nullable(),
  parentName: z.string().nullable(),
  total: z.number().int(),
  /** Per bucket, aligned with `times`. */
  series: z.array(z.number().int()),
});

export const trafficBreakdown = z.object({
  range: analyticsRange,
  bucketSeconds: z.number().int(),
  from: isoDateTime,
  to: isoDateTime,
  /** Start of each bucket, oldest first. */
  times: z.array(isoDateTime),
  /** The leading items over the range, largest first. */
  items: z.array(trafficBreakdownItem),
  /** The metric over everything the breakdown covers, so the remainder beyond `items` is known. */
  total: z.number().int(),
  totalSeries: z.array(z.number().int()),
});

/** A starred site, as the console home lists it. */
export const starredSite = z.object({
  id: uuid,
  name: z.string(),
  domains: z.array(z.string()),
});

export const siteStarInput = z.object({ id: uuid, starred: z.boolean() });

export const systemStatus = z.object({
  initialized: z.boolean(),
  version: z.string(),
});

export const setupInput = z.object({
  /** One-time token printed to the console's log at startup. */
  setupToken: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(100),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12).max(128),
});

/** Special-purpose origin addresses the platform allows (compiled into every cluster). */
export const originAllowList = z.object({
  /** Sorted, without duplicates. */
  cidrs: z.array(z.string()),
});

export const MAX_ORIGIN_ALLOWED_CIDRS = 256;

export const originAllowListInput = z.object({
  cidrs: z.array(cidr).max(MAX_ORIGIN_ALLOWED_CIDRS),
});

export const settings = z.object({
  version: z.string(),
  consoleUrl: z.string(),
  nodeApiUrl: z.string(),
  nodeCaSha256: z.string(),
  telemetryEnabled: z.boolean(),
  analyticsMode: z.enum(["lite", "clickhouse"]),
  /** When the setup wizard consumed the one-time setup token. */
  setupCompletedAt: isoDateTime.nullable(),
});

/** Where the console reads node release manifests unless configured otherwise. */
export const DEFAULT_NODE_RELEASE_BASE_URL =
  "https://github.com/marvinli001/edgeweir-node/releases/download";

/** Base URL of a node release mirror (`<base>/v<version>/checksums.txt`). */
export const releaseBaseUrl = z
  .url()
  .max(2048)
  .refine((value) => {
    const url = new URL(value);
    return (
      ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash
    );
  });

export const releaseSource = z.object({
  /** Saved in system settings; empty when none is saved. */
  url: z.string(),
  /** The base URL upgrades use now. */
  effectiveUrl: z.string(),
  source: z.enum(["setting", "environment", "default"]),
});

/** Empty clears the saved value (the environment or the default applies). */
export const releaseSourceInput = z.object({
  url: z.union([z.literal(""), releaseBaseUrl]),
});

export const auditLogEntry = z.object({
  id: z.number().int(),
  occurredAt: isoDateTime,
  actorType: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  targetName: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

export const auditLogListInput = z.object({
  action: z.string().trim().max(100).optional(),
  targetType: z.string().trim().max(100).optional(),
  from: isoDateTime.optional(),
  to: isoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const auditLogPage = z.object({
  items: z.array(auditLogEntry),
  total: z.number().int(),
});

export const auditLogFacets = z.object({
  actions: z.array(z.string()),
  targetTypes: z.array(z.string()),
});

export const siteUpdateInput = z.object({
  id: uuid,
  name: z.string().trim().min(1).max(100).optional(),
  domains: z.array(domainName).min(1).max(50).optional(),
  origins: z.array(originInput).min(1).max(32).optional(),
  cacheRules: z.array(cacheRuleInput).max(64).optional(),
  /**
   * Replaces the pool settings; omitted fields take their defaults, except
   * activeHealthCheck and sessionAffinity, which stay as they are when omitted.
   */
  originSettings: originSettings
    .extend({
      activeHealthCheck: activeHealthCheck.optional(),
      sessionAffinity: sessionAffinity.optional(),
    })
    .optional(),
  /** Replaces the cache settings; keepCacheTag stays as it is when omitted. */
  cacheSettings: cacheSettings.extend({ keepCacheTag: z.boolean().optional() }).optional(),
});

/** Parameters of a node error code (see node-errors.ts). */
const errorParams = z.record(z.string(), z.string());

/** Which check reported an origin's state: real traffic (passive) or the agent's probes (active). */
export const originHealthSource = z.enum(["passive", "active"]);

/** Health of one origin as reported by the nodes (passive and active checks). */
export const originHealth = z.object({
  originId: uuid,
  /** Online nodes where either check currently marks the origin down. */
  downNodes: z.number().int(),
  /** Online nodes of the site's cluster. */
  onlineNodes: z.number().int(),
  /** The most recent failure across nodes: the node's text ... */
  lastError: z.string(),
  /** ... and its stable code (nodeErrorDefs) with parameters; empty when unknown. */
  lastErrorCode: z.string(),
  lastErrorParams: errorParams,
  lastFailureAt: isoDateTime.nullable(),
  /** One entry per node and check; a node's active entry only exists while active checks run. */
  nodes: z.array(
    z.object({
      nodeId: uuid,
      nodeName: z.string(),
      source: originHealthSource,
      healthy: z.boolean(),
      consecutiveFailures: z.number().int(),
      lastError: z.string(),
      lastErrorCode: z.string(),
      lastErrorParams: errorParams,
      lastFailureAt: isoDateTime.nullable(),
      /** End of a passive down period; always null for active entries. */
      downUntil: isoDateTime.nullable(),
      reportedAt: isoDateTime,
    }),
  ),
});

/**
 * url, prefix, site, host and tag purge cached objects; prefetch and sitemap
 * load URLs into the cache. host and tag need nodes with purge-tag-v1;
 * sitemap, and prefetching the mobile variant, need prefetch-v2.
 */
export const cacheTaskType = z.enum([
  "url",
  "prefix",
  "site",
  "prefetch",
  "host",
  "tag",
  "sitemap",
]);
export const cacheTaskState = z.enum(["pending", "running", "succeeded", "failed"]);
/** A node's delivery: also "skipped" when the node was disabled before it ran the task. */
export const cacheTaskNodeState = z.enum(["pending", "running", "succeeded", "failed", "skipped"]);
/** Device class of a prefetch request; mobile only differs for cache keys with deviceType. */
export const prefetchVariant = z.enum(["desktop", "mobile"]);

export const MAX_CACHE_TASK_URLS = 500;
export const MAX_CACHE_TASK_HOSTS = 500;
export const MAX_CACHE_TASK_TAGS = 500;
/** Sites one task purges entirely (site) or by tag (tag). */
export const MAX_CACHE_TASK_SITES = 100;
/** URLs a sitemap task prefetches at most (each in every variant). */
export const SITEMAP_MAX_URLS = { min: 1, max: 10_000, default: 1000 } as const;
/** A Cache-Tag value: 1-128 bytes of printable ASCII without commas. */
export const CACHE_TAG_MAX_BYTES = 128;

/**
 * A Cache-Tag value as nodes compare it: trimmed and lowercased (ASCII
 * letters only). Null unless it is 1-128 bytes of printable ASCII
 * (0x20-0x7e) without commas.
 */
export function normalizeCacheTag(raw: string): string | null {
  const tag = raw.trim().replace(/[A-Z]+/g, (letters) => letters.toLowerCase());
  return /^[\x20-\x7e]{1,128}$/.test(tag) && !tag.includes(",") ? tag : null;
}

export const cacheTaskCreateInput = z
  .object({
    type: cacheTaskType,
    /**
     * Absolute URLs (url, prefetch), URL prefixes (prefix) or exactly one
     * sitemap URL (sitemap), one per entry.
     */
    urls: z.array(z.string().trim().min(1).max(2048)).max(MAX_CACHE_TASK_URLS).default([]),
    /** Sites to purge entirely (site) or by tag (tag). */
    siteIds: z.array(uuid).max(MAX_CACHE_TASK_SITES).default([]),
    /** Host names whose every URL is purged (host): no wildcard, no port. */
    hosts: z.array(z.string().trim().min(1).max(253)).max(MAX_CACHE_TASK_HOSTS).default([]),
    /** Cache-Tag values to purge on every site of siteIds (tag); compared in lowercase. */
    tags: z.array(z.string().max(1024)).max(MAX_CACHE_TASK_TAGS).default([]),
    /** Device variants to prefetch (prefetch, sitemap). */
    variants: z.array(prefetchVariant).min(1).max(2).default(["desktop"]),
    /** URLs a sitemap task prefetches at most (sitemap). */
    maxUrls: z
      .number()
      .int()
      .min(SITEMAP_MAX_URLS.min)
      .max(SITEMAP_MAX_URLS.max)
      .default(SITEMAP_MAX_URLS.default),
  })
  .superRefine((task, ctx) => {
    const missing = (path: "urls" | "siteIds" | "hosts" | "tags") =>
      ctx.addIssue({ code: "custom", message: "nothing to do", path: [path] });
    switch (task.type) {
      case "site":
        if (!task.siteIds.length) missing("siteIds");
        break;
      case "host":
        if (!task.hosts.length) missing("hosts");
        break;
      case "tag":
        if (!task.siteIds.length) missing("siteIds");
        if (!task.tags.length) missing("tags");
        break;
      case "sitemap":
        if (task.urls.length !== 1)
          ctx.addIssue({ code: "custom", message: "exactly one sitemap URL", path: ["urls"] });
        break;
      default:
        if (!task.urls.length) missing("urls");
    }
  });

export const cacheTaskNode = z.object({
  nodeId: uuid,
  nodeName: z.string(),
  state: cacheTaskNodeState,
  /** The node's text of the outcome (English fallback for unknown codes) ... */
  message: z.string(),
  /** ... and its stable code (taskErrorDefs) with parameters; empty on success. */
  errorCode: z.string(),
  errorParams: errorParams,
  succeeded: z.number().int(),
  failed: z.number().int(),
  finishedAt: isoDateTime.nullable(),
  /** When a missed purge (task_expired, node_disabled) was made up with a whole-site purge. */
  recoveredAt: isoDateTime.nullable(),
});

export const cacheTaskSource = z.enum(["user", "recovery"]);

export const cacheTask = z.object({
  id: uuid,
  type: cacheTaskType,
  /** What was asked for: URLs, prefixes, site names, hosts, tags or the sitemap URL. */
  targets: z.array(z.string()),
  sites: z.array(z.object({ id: z.string(), name: z.string() })),
  /** Device variants of a prefetch or sitemap task; empty for purges. */
  variants: z.array(prefetchVariant),
  /** URL limit of a sitemap task; null for every other type. */
  maxUrls: z.number().int().nullable(),
  /**
   * pending: no node finished; running: some finished; then succeeded or
   * failed. Skipped (disabled) nodes do not count.
   */
  state: cacheTaskState,
  nodes: z.array(cacheTaskNode),
  /**
   * user: requested in the console or the API; recovery: a whole-site purge
   * the console sent a node that missed purges (offline beyond the delivery
   * window, or disabled).
   */
  source: cacheTaskSource,
  createdByName: z.string(),
  createdAt: isoDateTime,
  finishedAt: isoDateTime.nullable(),
});

export const cacheTaskListInput = z.object({
  siteId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const cacheTaskList = z.object({
  items: z.array(cacheTask),
  total: z.number().int(),
});

export const siteListInput = z.object({
  /** Matches the site name or any of its domains. */
  search: z.string().trim().max(100).optional(),
  clusterId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const siteList = z.object({
  items: z.array(site),
  total: z.number().int(),
});

export const me = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    twoFactorEnabled: z.boolean(),
  }),
  /**
   * Set when the caller is a service account (then `user` carries its id and
   * name, with no e-mail).
   */
  serviceAccount: z
    .object({ id: z.string(), name: z.string(), scopes: z.array(z.string()) })
    .nullable(),
});

export type OriginAllowList = z.infer<typeof originAllowList>;
export type SiteCreateInput = z.input<typeof siteCreateInput>;
export type Site = z.infer<typeof site>;
export type Cluster = z.infer<typeof cluster>;
export type Node = z.infer<typeof node>;
export type Revision = z.infer<typeof revision>;
export type Overview = z.infer<typeof overview>;
export type AnalyticsRange = z.infer<typeof analyticsRange>;
export type TrafficPoint = z.infer<typeof trafficPoint>;
export type TrafficTotals = z.infer<typeof trafficTotals>;
export type Traffic = z.infer<typeof traffic>;
export type TrafficTopItem = z.infer<typeof trafficTopItem>;
export type TrafficBreakdownInput = z.infer<typeof trafficBreakdownInput>;
export type TrafficBreakdownItem = z.infer<typeof trafficBreakdownItem>;
export type TrafficBreakdown = z.infer<typeof trafficBreakdown>;
export type StarredSite = z.infer<typeof starredSite>;
export type EnrollmentTokenResult = z.infer<typeof enrollmentTokenResult>;
export type Settings = z.infer<typeof settings>;
export type ReleaseSource = z.infer<typeof releaseSource>;
export type ReleaseSourceInput = z.infer<typeof releaseSourceInput>;
export type AuditLogEntry = z.infer<typeof auditLogEntry>;
export type NodeGroup = z.infer<typeof nodeGroup>;
export type RolloutPolicy = z.infer<typeof rolloutPolicy>;
export type ClusterRollout = z.infer<typeof clusterRollout>;
export type RolloutState = z.infer<typeof rolloutState>;
export type RolloutOutcome = z.infer<typeof rolloutOutcome>;
export type Region = z.infer<typeof region>;
export type Me = z.infer<typeof me>;
export type SiteUpdateInput = z.input<typeof siteUpdateInput>;
export type Origin = z.infer<typeof origin>;
export type CacheRule = z.infer<typeof cacheRule>;
export type OriginInput = z.input<typeof originInput>;
export type CacheRuleInput = z.input<typeof cacheRuleInput>;
export type OriginSettings = z.infer<typeof site>["originSettings"];
export type ActiveHealthCheck = OriginSettings["activeHealthCheck"];
export type SessionAffinity = OriginSettings["sessionAffinity"];
export type CacheSettings = z.infer<typeof site>["cacheSettings"];
export type CacheKeyPolicy = CacheSettings["cacheKey"];
export type OriginHealth = z.infer<typeof originHealth>;
export type OriginHealthSource = z.infer<typeof originHealthSource>;
export type CacheTask = z.infer<typeof cacheTask>;
export type CacheTaskType = z.infer<typeof cacheTaskType>;
export type PrefetchVariant = z.infer<typeof prefetchVariant>;
export type CacheTaskState = z.infer<typeof cacheTaskState>;
export type CacheTaskNodeState = z.infer<typeof cacheTaskNodeState>;
export type CacheTaskCreateInput = z.input<typeof cacheTaskCreateInput>;
