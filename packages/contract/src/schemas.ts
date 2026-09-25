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
  organizationName: z.string(),
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
});

export const nodeGroupUpdateInput = z.object({
  id: uuid,
  name: nodeGroupName.optional(),
  regionId: uuid.nullable().optional(),
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
  /** The site's organization or the node's cluster. */
  parentId: z.string(),
  parentName: z.string(),
  requests: z.number().int(),
  bytesSent: z.number().int(),
  cacheHits: z.number().int(),
  cacheMisses: z.number().int(),
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
  organizationName: z.string().trim().min(1).max(100),
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

export const auditLogEntry = z.object({
  id: z.number().int(),
  occurredAt: isoDateTime,
  actorType: z.string(),
  actorId: z.string(),
  actorName: z.string(),
  organizationId: z.string().nullable(),
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
});

export const siteListInput = z.object({
  /** Matches the site name or any of its domains. */
  search: z.string().trim().max(100).optional(),
  /** Platform administrators only. */
  clusterId: uuid.optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const siteList = z.object({
  items: z.array(site),
  total: z.number().int(),
});

export const orgRole = z.enum(["owner", "admin", "member"]);
const orgId = z.string().trim().min(1).max(100);
const userId = z.string().trim().min(1).max(100);
const email = z.string().trim().toLowerCase().pipe(z.email());
const password = z.string().min(12).max(128);
const personName = z.string().trim().min(1).max(100);

export const me = z.object({
  user: z.object({
    id: z.string(),
    name: z.string(),
    email: z.string(),
    isAdmin: z.boolean(),
    twoFactorEnabled: z.boolean(),
  }),
  organizations: z.array(
    z.object({ id: z.string(), name: z.string(), slug: z.string(), role: orgRole }),
  ),
  activeOrganization: z
    .object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      /** The caller's role; platform administrators who are not members get "owner" rights. */
      role: orgRole,
      requireTwoFactor: z.boolean(),
    })
    .nullable(),
  /** The active organization requires 2FA and the caller has not enabled it yet. */
  twoFactorRequired: z.boolean(),
});

export const member = z.object({
  id: z.string(),
  userId: z.string(),
  name: z.string(),
  email: z.string(),
  role: orgRole,
  twoFactorEnabled: z.boolean(),
  disabled: z.boolean(),
  createdAt: isoDateTime,
});

export const invitation = z.object({
  id: z.string(),
  email: z.string(),
  role: orgRole,
  inviterName: z.string(),
  expiresAt: isoDateTime,
  createdAt: isoDateTime,
});

export const memberList = z.object({
  members: z.array(member),
  invitations: z.array(invitation),
});

export const memberInviteInput = z.object({ email, role: orgRole.default("member") });

export const invitationResult = z.object({
  invitation,
  /** Link the invitee opens to join; valid until the invitation expires. */
  url: z.string(),
});

export const memberRoleInput = z.object({ id: z.string().min(1).max(100), role: orgRole });

export const organizationPolicyInput = z.object({ requireTwoFactor: z.boolean() });

export const invitationInfo = z.object({
  id: z.string(),
  organizationName: z.string(),
  email: z.string(),
  role: orgRole,
  inviterName: z.string(),
  expiresAt: isoDateTime,
  /** An account with the invited email exists: sign in to accept. */
  userExists: z.boolean(),
});

export const invitationAcceptInput = z.object({
  id: z.string().min(1).max(100),
  /** Required when no account exists for the invited email. */
  name: personName.optional(),
  password: password.optional(),
});

export const organization = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  memberCount: z.number().int(),
  siteCount: z.number().int(),
  defaultClusterId: uuid.nullable(),
  defaultClusterName: z.string().nullable(),
  requireTwoFactor: z.boolean(),
  createdAt: isoDateTime,
});

export const organizationSlug = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "lowercase letters, digits and dashes only");

export const organizationCreateInput = z.object({
  name: z.string().trim().min(1).max(100),
  /** Derived from the name when omitted. */
  slug: organizationSlug.optional(),
  defaultClusterId: uuid.nullable().default(null),
});

export const organizationUpdateInput = z.object({
  id: orgId,
  name: z.string().trim().min(1).max(100).optional(),
  defaultClusterId: uuid.nullable().optional(),
  requireTwoFactor: z.boolean().optional(),
});

export const orgMemberAddInput = z.object({
  organizationId: orgId,
  userId,
  role: orgRole.default("member"),
});

export const orgMemberUpdateInput = z.object({
  organizationId: orgId,
  memberId: z.string().min(1).max(100),
  role: orgRole,
});

export const orgMemberRemoveInput = z.object({
  organizationId: orgId,
  memberId: z.string().min(1).max(100),
});

export const orgInviteInput = z.object({
  organizationId: orgId,
  email,
  role: orgRole.default("member"),
});

export const user = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  isAdmin: z.boolean(),
  disabled: z.boolean(),
  twoFactorEnabled: z.boolean(),
  createdAt: isoDateTime,
  memberships: z.array(
    z.object({ organizationId: z.string(), organizationName: z.string(), role: orgRole }),
  ),
});

export const userListInput = z.object({ search: z.string().trim().max(100).optional() });

export const userCreateInput = z.object({
  name: personName,
  email,
  password,
  isAdmin: z.boolean().default(false),
  /** Optionally add the new user to an organization right away. */
  organizationId: orgId.optional(),
  role: orgRole.default("member"),
});

export const userSetAdminInput = z.object({ id: userId, isAdmin: z.boolean() });
export const userSetDisabledInput = z.object({ id: userId, disabled: z.boolean() });

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
export type StarredSite = z.infer<typeof starredSite>;
export type EnrollmentTokenResult = z.infer<typeof enrollmentTokenResult>;
export type Settings = z.infer<typeof settings>;
export type AuditLogEntry = z.infer<typeof auditLogEntry>;
export type NodeGroup = z.infer<typeof nodeGroup>;
export type Region = z.infer<typeof region>;
export type Me = z.infer<typeof me>;
export type Member = z.infer<typeof member>;
export type Invitation = z.infer<typeof invitation>;
export type InvitationResult = z.infer<typeof invitationResult>;
export type InvitationInfo = z.infer<typeof invitationInfo>;
export type Organization = z.infer<typeof organization>;
export type OrgRole = z.infer<typeof orgRole>;
export type User = z.infer<typeof user>;
export type SiteUpdateInput = z.input<typeof siteUpdateInput>;
export type Origin = z.infer<typeof origin>;
export type CacheRule = z.infer<typeof cacheRule>;
