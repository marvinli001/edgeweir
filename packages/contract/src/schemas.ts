import * as z from "zod";

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

/** Origin address: host name or IPv4/IPv6 literal (without port). */
export const originAddress = z
  .string()
  .trim()
  .min(1)
  .max(253)
  .refine(
    (value) =>
      HOSTNAME_RE.test(value.toLowerCase()) ||
      z.ipv4().safeParse(value).success ||
      z.ipv6().safeParse(value).success,
    "invalid origin address",
  );

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

export const originScheme = z.enum(["http", "https"]);
export const cacheAction = z.enum(["cache", "bypass"]);
export const originCacheControl = z.enum(["override", "respect"]);
export const applyState = z.enum(["applying", "applied", "failed"]);

export const originInput = z.object({
  address: originAddress,
  port: port.default(80),
  scheme: originScheme.default("http"),
  weight: z.number().int().min(1).max(100).default(1),
  backup: z.boolean().default(false),
  hostHeader: z.string().trim().max(253).default(""),
});

export const cacheRuleInput = z.object({
  priority: z.number().int().min(0).max(10000).default(100),
  pathPrefixes: z.array(pathPrefix).max(32).default([]),
  extensions: z.array(extension).max(64).default([]),
  action: cacheAction.default("cache"),
  edgeTtlSeconds: z
    .number()
    .int()
    .min(0)
    .max(365 * 24 * 3600)
    .default(3600),
  originCacheControl: originCacheControl.default("override"),
});

export const siteCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  clusterId: uuid.optional(),
  domains: z.array(domainName).min(1).max(50),
  origins: z.array(originInput).min(1).max(32),
  cacheRules: z.array(cacheRuleInput).max(64).default([]),
});

export const origin = originInput.extend({ id: uuid });
export const cacheRule = cacheRuleInput.extend({ id: uuid });

export const site = z.object({
  id: uuid,
  name: z.string(),
  enabled: z.boolean(),
  organizationId: z.string(),
  clusterId: uuid,
  clusterName: z.string(),
  domains: z.array(z.string()),
  origins: z.array(origin),
  cacheRules: z.array(cacheRule),
  cacheGeneration: z.number().int(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});

export const revision = z.object({
  clusterId: uuid,
  revision: z.number().int(),
  contentHash: z.string(),
  siteCount: z.number().int(),
  reason: z.string(),
  createdAt: isoDateTime,
});

export const siteMutationResult = z.object({
  site,
  revision,
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

export const clusterCreateInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9][a-z0-9-]*$/, "lowercase letters, digits and dashes only"),
  description: z.string().trim().max(500).default(""),
});

export const node = z.object({
  id: uuid,
  name: z.string(),
  clusterId: uuid,
  clusterName: z.string(),
  hostname: z.string(),
  status: z.enum(["active", "disabled"]),
  online: z.boolean(),
  lastSeenAt: isoDateTime.nullable(),
  enrolledAt: isoDateTime.nullable(),
  agentVersion: z.string(),
  engine: z.string(),
  engineVersion: z.string(),
  os: z.string(),
  arch: z.string(),
  ipAddresses: z.array(z.string()),
  certFingerprint: z.string().nullable(),
  certNotAfter: isoDateTime.nullable(),
  appliedRevision: z.number().int(),
  appliedContentHash: z.string(),
  applyState: applyState.nullable(),
  applyMessage: z.string(),
  dataPlaneHealthy: z.boolean(),
});

export const enrollmentTokenInput = z.object({
  clusterId: uuid,
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

export const trafficPoint = z.object({
  minute: isoDateTime,
  requests: z.number().int(),
  cacheHits: z.number().int(),
  cacheMisses: z.number().int(),
});

export const overview = z.object({
  clusters: z.number().int(),
  nodes: z.number().int(),
  onlineNodes: z.number().int(),
  sites: z.number().int(),
  revisions: z.array(revision),
  /** Per-minute totals over the last 60 minutes (lite analytics). */
  traffic: z.array(trafficPoint),
});

export const systemStatus = z.object({
  initialized: z.boolean(),
  version: z.string(),
});

export const setupInput = z.object({
  name: z.string().trim().min(1).max(100),
  email: z.email().trim().toLowerCase(),
  password: z.string().min(12).max(128),
  organizationName: z.string().trim().min(1).max(100),
});

export const settings = z.object({
  version: z.string(),
  consoleUrl: z.string(),
  nodeApiUrl: z.string(),
  nodeCaSha256: z.string(),
  telemetryEnabled: z.boolean(),
  analyticsMode: z.enum(["lite", "clickhouse"]),
});

export const auditLogEntry = z.object({
  id: z.number().int(),
  occurredAt: isoDateTime,
  actorType: z.string(),
  actorId: z.string(),
  action: z.string(),
  targetType: z.string(),
  targetId: z.string(),
  metadata: z.record(z.string(), z.unknown()),
});

export type SiteCreateInput = z.input<typeof siteCreateInput>;
export type Site = z.infer<typeof site>;
export type Cluster = z.infer<typeof cluster>;
export type Node = z.infer<typeof node>;
export type Revision = z.infer<typeof revision>;
export type Overview = z.infer<typeof overview>;
export type TrafficPoint = z.infer<typeof trafficPoint>;
export type EnrollmentTokenResult = z.infer<typeof enrollmentTokenResult>;
export type Settings = z.infer<typeof settings>;
export type AuditLogEntry = z.infer<typeof auditLogEntry>;
