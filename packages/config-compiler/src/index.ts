import { createHash } from "node:crypto";
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  AccessControlSchema,
  ActiveHealthCheckSchema,
  AuthKind,
  AuthRuleSchema,
  BasicAuthSchema,
  BulkRedirectSchema,
  CacheAction,
  CacheKeyPolicySchema,
  CacheKeyQuery,
  type CacheRule,
  CacheRuleSchema,
  type CacheZone,
  CacheZoneNodeSizeSchema,
  CacheZoneSchema,
  CcPolicySchema,
  type CertificateRef,
  type ChallengeKeyRef,
  ChallengeKeyRefSchema,
  ChallengeTextSchema,
  CharsetSchema,
  type ClientAddress,
  ClientAddressSchema,
  ClientCertificateMode,
  ClientCertificateSchema,
  CorsSchema,
  DomainMatch,
  DomainSchema,
  type EdgeRule,
  EdgeRuleSchema,
  ErrorPageSchema,
  ForwardAuthSchema,
  GeoAccessSchema,
  HotlinkSchema,
  type HttpChallenge,
  type IpList,
  IpListSchema,
  type L4App,
  L4AppSchema,
  L4OriginSchema,
  L4Protocol,
  type Listener,
  ListenerProtocol,
  ListenerSchema,
  LoadBalancePolicy,
  MaintenanceSchema,
  type NodeConfig,
  type NodeConfigDiff,
  NodeConfigDiffSchema,
  NodeConfigSchema,
  type OfflineHost,
  OfflineHostSchema,
  OriginCacheControl,
  OriginConnectionSchema,
  OriginPoolSchema,
  OriginProtocol,
  OriginSchema,
  OriginScheme,
  PassiveHealthCheckSchema,
  type PlatformErrorPages,
  PlatformErrorPagesSchema,
  PlatformProtectionSchema,
  PurgeMethodSchema,
  QueryParamSchema,
  type RuleAction,
  RuleActionSchema,
  type RuleExpression,
  S3AuthSchema,
  SecurityHeadersSchema,
  SessionAffinitySchema,
  type SessionTicketKeyRef,
  SessionTicketKeyRefSchema,
  type Site,
  SiteErrorPagesSchema,
  SiteProtectionSchema,
  SiteSchema,
  SiteWafSchema,
  type TlsOptions,
  TlsOptionsSchema,
  type UnknownHosts,
  UnknownHostsSchema,
  UrlAuthSchema,
  UserAgentRuleSchema,
  UserAgentRulesSchema,
  WafExclusionSchema,
  WebSocketAccessSchema,
} from "@edgeweir/proto";
import {
  type Expression,
  needsBotFields,
  needsClientCertificate,
  needsClientIp,
  needsRulesBody,
  needsRulesV2,
  needsRulesV3,
  type Phase,
  parseExpression,
  parseValueExpression,
  phases,
  RULES_BODY_LIMIT,
  structuredCacheCondition,
  usesRulesV3Placeholders,
} from "@edgeweir/rule-engine";

/** Matches the node's fixed 256 KiB site partitions (128 MiB at full capacity). */
export const MAX_SITES_PER_CLUSTER = 512;
export class ConfigCapacityError extends Error {
  constructor() {
    super(`A cluster supports at most ${MAX_SITES_PER_CLUSTER} published sites`);
    this.name = "ConfigCapacityError";
  }
}

/** Console-side model of an origin, independent of the database layer. */
export interface OriginModel {
  id: string;
  address: string;
  port: number;
  scheme: "http" | "https";
  weight: number;
  backup: boolean;
  hostHeader: string;
  sni: string;
  /** Set for S3-compatible origins (requests signed with AWS Signature V4). */
  s3?: { region: string; bucket: string; credentialId: string; credentialVersion: number } | null;
  /** Origin group inside the site; omitted or "" is the default group (rules-v2 otherwise). */
  group?: string;
}

/** Longest cache rule condition (source characters). */
export const CACHE_EXPRESSION_MAX_LENGTH = 16384;

export interface CacheRuleModel {
  id: string;
  priority: number;
  /**
   * The structured condition, used only while `expression` is empty (and no
   * `condition` is given): rules saved before conditions became expressions.
   */
  pathPrefixes: string[];
  paths?: string[];
  extensions: string[];
  statusCodes?: number[];
  minSizeBytes?: number;
  maxSizeBytes?: number;
  /**
   * The request condition (phase cache). An expression in the structured
   * shape compiles to path_prefixes, paths and extensions as before; any
   * other to CacheRuleMatch.condition (rules-v2).
   */
  expression: string;
  /** `expression` parsed, with IP lists bound to their ids; parsed from `expression` when omitted. */
  condition?: Expression;
  /** Cache-Control max-age towards clients; 0 or omitted keeps the origin's (rules-v2 otherwise). */
  browserTtlSeconds?: number;
  action: "cache" | "bypass";
  edgeTtlSeconds: number;
  originCacheControl: "override" | "respect";
  staleWhileRevalidateSeconds?: number;
  staleIfErrorSeconds?: number;
  /** Cache responses to requests with an Authorization header; defaults to false. */
  cacheAuthorized?: boolean;
  /** Cache responses with Set-Cookie (only the fetched response carries it); site-content-v1. */
  cacheSetCookie?: boolean;
}

export interface OriginPoolSettingsModel {
  tlsVerify: boolean;
  /** HTTP version towards the origins; omitted: HTTP/1.1. */
  protocol?: "http1" | "http2";
  /** gRPC proxied over HTTP/2 end to end (protocol http2 only). */
  grpc?: boolean;
  maxFails: number;
  recoverySeconds: number;
  connectTimeoutMs: number;
  sendTimeoutMs: number;
  readTimeoutMs: number;
  keepalive: boolean;
  keepaliveIdleSeconds: number;
  keepaliveMaxRequests: number;
  /** Origins a request tries, 1-5; omitted or 3 compiles as before (site-content-v1 otherwise). */
  tries?: number;
  /** Retry after 502, 503 and 504 responses; omitted or true compiles as before. */
  statusRetry?: boolean;
}

export interface CacheKeyModel {
  /** exclude: every parameter but queryParams ("prefix*" patterns allowed); site-content-v1. */
  query: "all" | "ignore" | "include" | "exclude";
  queryParams: string[];
  sortQuery: boolean;
  headers: string[];
  cookies: string[];
  deviceType: boolean;
  includeHost: boolean;
}

/** Features of the compression modules and ModSecurity (reported by nodes built with them). */
export const BROTLI_FEATURE = "brotli-v1";
export const ZSTD_FEATURE = "zstd-v1";
export const MODSECURITY_FEATURE = "modsecurity-v1";
/**
 * Features of an origin pool's active health check and session affinity and
 * of a site's error pages (proto v0.12.0). Cache-Tag forwarding, the
 * platform's error pages and offline hosts need none: older nodes ignore them.
 */
export const ACTIVE_HEALTH_FEATURE = "active-health-v1";
export const SESSION_AFFINITY_FEATURE = "session-affinity-v1";
export const ERROR_PAGES_FEATURE = "error-pages-v1";
/**
 * Feature of HTTP/2 towards an origin pool's origins and of gRPC proxied
 * over HTTP/2 end to end (proto v0.21.0, OriginPool.protocol and grpc).
 */
export const ORIGIN_HTTP2_FEATURE = "origin-http2-v1";
/**
 * Feature of the rule engine extensions (proto v0.13.0): functions and the
 * new fields, dynamic redirects and rewrites with query edits, origin,
 * compression and extended config actions, the compression phase, cache
 * rule conditions and browser TTLs, bulk redirects and origin groups.
 */
export const RULES_V2_FEATURE = "rules-v2";
/**
 * Feature of the rule engine additions (proto v0.22.0): the new fields
 * (cookies and query parameters by name, Referer, User-Agent, request
 * version, scheme, id and timestamp, listener port, AS name, cache status),
 * the new functions and wildcard comparisons, header values and set query
 * parameters computed per request, response header lines (append), redirect
 * status 303 and the error page placeholders {{time}} and {{path}}.
 */
export const RULES_V3_FEATURE = "rules-v3";
/** Feature of layer-4 (TCP / UDP) applications (proto v0.15.0, NodeConfig.l4_apps). */
export const L4_FEATURE = "l4-v1";
/**
 * Feature of domains served over HTTP until the site's certificate covers
 * them (proto v0.19.0, Domain.tls_pending).
 */
export const TLS_PENDING_DOMAINS_FEATURE = "tls-pending-domains-v1";
/**
 * Feature of the site settings of proto v0.24.0: cache keys that drop
 * parameters, responses cached with Set-Cookie, the PURGE method, hiding
 * X-Cache, error pages for more statuses, classes and redirects,
 * maintenance, charsets, the gzip level and the largest compressed
 * response, request body limits and origin tries.
 */
export const SITE_CONTENT_FEATURE = "site-content-v1";
/** Feature of per-node cache zone sizes (proto v0.24.0, CacheZone.node_sizes). */
export const CACHE_ZONE_FEATURE = "cache-zone-v1";
/** A site's body limit when it sets none: nodes' former global 100 MiB. */
export const DEFAULT_REQUEST_BODY_LIMIT = 100 * 1024 * 1024;
/** Origins a request tries when the pool sets none. */
export const DEFAULT_ORIGIN_TRIES = 3;
/**
 * keys_zone of a cache zone of maxSizeMb (ADR-0035): nginx keeps about
 * 8000 keys per MiB; 64 MiB for the default 10 GiB, at most 512 MiB.
 */
export const keysZoneMbFor = (maxSizeMb: number) =>
  Math.min(Math.max(Math.ceil(maxSizeMb / 160), 16), 512);
/** Layer-4 applications a cluster may have (enabled or not). */
export const MAX_L4_APPS_PER_CLUSTER = 256;

/** An origin pool's active health check while it is on (config.proto ActiveHealthCheck). */
export interface ActiveHealthCheckModel {
  path: string;
  method: "GET" | "HEAD";
  expectedStatusMin: number;
  expectedStatusMax: number;
  host: string;
  intervalSeconds: number;
  timeoutSeconds: number;
  healthyThreshold: number;
  unhealthyThreshold: number;
}

/** An origin pool's session affinity while it is on (config.proto SessionAffinity). */
export interface SessionAffinityModel {
  ttlSeconds: number;
}

/** A site's error pages (config.proto SiteErrorPages). */
export interface SiteErrorPagesModel {
  /**
   * Any order; compiled sorted by status. Without pages nothing is compiled.
   * status 4 and 5 are the 4xx and 5xx classes; redirectUrl replaces the
   * template; responseStatus (0: keep) replaces a template page's status.
   */
  pages: { status: number; template: string; redirectUrl?: string; responseStatus?: number }[];
  interceptOriginErrors: boolean;
}

/** A site's maintenance mode while on (config.proto Maintenance). */
export interface MaintenanceModel {
  template: string;
  retryAfterSeconds: number;
  /** CIDRs in canonical form; any order, compiled sorted without duplicates. */
  allowedCidrs: string[];
  allowedPathPrefixes: string[];
}

/** A site's charset setting while on (config.proto Charset). */
export interface CharsetModel {
  name: string;
  force: boolean;
  uppercase: boolean;
}

/** The platform's pages; an empty template means the node's built-in page. */
export interface PlatformErrorPagesModel {
  unknownHost: string;
  siteDisabled: string;
}

/** A domain of a disabled site (config.proto OfflineHost). */
export interface OfflineHostModel {
  name: string;
  wildcard: boolean;
  /** `.a.com` (suffix) and `~pattern` (regex) domains; domains-v2. */
  match?: DomainMatchModel;
  reason: "disabled";
}

/** How a domain matches besides exact and `*.` (config.proto DomainMatch, domains-v2). */
export type DomainMatchModel = "suffix" | "regex";
/** Feature of `.a.com` and `~pattern` site domains (proto v0.25.0). */
export const DOMAINS_V2_FEATURE = "domains-v2";
/** Feature of the cluster's unknown host handling and scan protection (proto v0.25.0). */
export const UNKNOWN_HOST_FEATURE = "unknown-host-v1";
/** Feature of sites with more than one certificate (proto v0.26.0, Site.additional_certificate_ids). */
export const MULTI_CERTIFICATE_FEATURE = "multi-certificate-v1";
/**
 * Feature of client certificates (mutual TLS) and the tls.client.* fields
 * (proto v0.26.0, Site.client_certificate).
 */
export const CLIENT_CERT_FEATURE = "client-cert-v1";
/** Feature of access authentication rules (proto v0.27.0, Site.auth_rules; ADR-0038). */
export const ACCESS_AUTH_FEATURE = "access-auth-v1";

/** Kinds of access authentication rules (the contract's names). */
export type AuthRuleKind = "basic" | "forward" | "url_a" | "url_b" | "url_c" | "url_d";

/**
 * An enabled access authentication rule (config.proto AuthRule). The
 * secret (Basic users and hashes, URL keys) is only referenced: nodes fetch
 * it with GetOriginCredentials.
 */
export interface AuthRuleModel {
  id: string;
  kind: AuthRuleKind;
  scope: {
    domains: string[];
    pathPrefixes: string[];
    extensions: string[];
    excludePathPrefixes: string[];
  };
  /** Basic and URL rules. */
  credential?: { id: string; version: number };
  basic?: { realm: string; keepAuthorization: boolean; userHeader: boolean };
  forward?: {
    url: string;
    method: "GET" | "HEAD";
    timeoutMs: number;
    requestHeaders: string[];
    responseHeaders: string[];
    cacheSeconds: number;
    passRedirects: boolean;
    allowUnavailable: boolean;
  };
  url?: { validitySeconds: number; skewSeconds: number; signParam: string; timeParam: string };
}

const AUTH_KINDS: Record<AuthRuleKind, AuthKind> = {
  basic: AuthKind.BASIC,
  forward: AuthKind.FORWARD,
  url_a: AuthKind.URL_A,
  url_b: AuthKind.URL_B,
  url_c: AuthKind.URL_C,
  url_d: AuthKind.URL_D,
};

/** Feature of a site's access control (proto v0.28.0, Site.access_control; ADR-0039). */
export const ACCESS_CONTROL_FEATURE = "access-control-v1";
/** G14 (proto v0.29.0, ADR-0040). */
export const WAF_V2_FEATURE = "waf-v2";
export const RULES_BODY_FEATURE = "rules-body-v1";
export const CHALLENGE_V2_FEATURE = "challenge-v2";

/**
 * A site's access control (config.proto AccessControl). Parts that are off
 * are omitted; a site without any part has none, so it compiles as before.
 */
export interface AccessControlModel {
  blockListIds: string[];
  allowListIds: string[];
  hotlink?: {
    allowEmpty: boolean;
    allowSiteDomains: boolean;
    allowed: string[];
    denied: string[];
    checkOrigin: boolean;
    extensions: string[];
    pathPrefixes: string[];
    excludePathPrefixes: string[];
    /** "" for 403. */
    redirectUrl: string;
  };
  userAgents?: {
    rules: { pattern: string; allow: boolean }[];
    pathPrefixes: string[];
    excludePathPrefixes: string[];
  };
  cors?: {
    allowedOrigins: string[];
    allowCredentials: boolean;
    allowedMethods: string[];
    allowedHeaders: string[];
    echoRequestHeaders: boolean;
    exposedHeaders: string[];
    maxAgeSeconds: number;
    preflightToOrigin: boolean;
    keepOriginHeaders: boolean;
    pathPrefixes: string[];
  };
  geo?: {
    allowOnly: boolean;
    countries: string[];
    subdivisions: string[];
    asns: number[];
    pathPrefixes: string[];
    exceptPathPrefixes: string[];
  };
  /** origins empty: every origin; idleTimeoutSeconds 0: 3600. */
  websocket?: { origins: string[]; idleTimeoutSeconds: number };
  securityHeaders?: {
    nosniff: boolean;
    /** "", "DENY" or "SAMEORIGIN". */
    frameOptions: string;
    /** "" or a Referrer-Policy value. */
    referrerPolicy: string;
    permissionsPolicy: string;
    hideServer: boolean;
    removePoweredBy: boolean;
  };
}

/** A site's client certificates (config.proto ClientCertificate); off is omitted. */
export interface ClientCertificateModel {
  mode: "optional" | "required";
  /** Re-encoded PEM of the CA certificates. */
  caPem: string;
  depth: number;
  forwardHeaders: boolean;
}

/**
 * The cluster's unknown host handling (config.proto UnknownHosts):
 * page | close | site per case; scanThreshold 0 turns scan protection off.
 */
export interface UnknownHostsModel {
  unknownHost: "page" | "close" | "site";
  ipAccess: "page" | "close" | "site";
  defaultSiteId: string | null;
  defaultCertificate: boolean;
  scanThreshold: number;
  scanBanSeconds: number;
}

type TlsFields = Omit<TlsOptions, "$typeName" | "$unknown" | "gzipLevel" | "compressMaxLength">;
type CompressionField =
  | "brotli"
  | "brotliLevel"
  | "brotliMinLength"
  | "brotliTypes"
  | "zstd"
  | "zstdLevel"
  | "zstdMinLength"
  | "zstdTypes";
type RedirectField = "redirectStatus" | "redirectPort" | "redirectExcludedDomains";
/**
 * A site's TLS options; Brotli and Zstandard default to off, the HTTPS
 * redirect to 301 towards 443 with no domain excluded, the gzip level
 * (0: nginx's default) and the largest compressed response (0: no limit)
 * to 0 (site-content-v1 otherwise).
 */
export type TlsModel = Omit<TlsFields, CompressionField | RedirectField> &
  Partial<Pick<TlsFields, CompressionField | RedirectField>> & {
    gzipLevel?: number;
    compressMaxLength?: number;
  };

/** A CRS exclusion (config.proto WafExclusion); path "" is the whole site. */
export interface WafExclusionModel {
  path: string;
  exact: boolean;
  /** Any order; compiled ascending without duplicates. */
  ruleIds: number[];
  /** Any order; compiled sorted without duplicates. */
  targets: string[];
}

/** OWASP CRS of a site that runs it (config.proto SiteWaf). */
export interface SiteWafModel {
  mode: "detect" | "block";
  paranoiaLevel: number;
  anomalyThreshold: number;
  /**
   * In the site's order. Whole-site ones without targets compile into
   * excluded_rule_ids (as before waf-v2), the others into exclusions.
   */
  exclusions: WafExclusionModel[];
  requestBodyLimit: number;
}

export interface SiteModel {
  id: string;
  name: string;
  enabled: boolean;
  cacheGeneration: number;
  logSampleRate?: number;
  /**
   * `tlsPending`: the site's certificate does not cover the domain yet; it
   * is served over HTTP only (feature tls-pending-domains-v1). Ignored on a
   * site without a certificate.
   */
  domains: {
    name: string;
    wildcard: boolean;
    tlsPending?: boolean;
    /** suffix (`.a.com`) or regex (`~pattern`, name the pattern); domains-v2. */
    match?: DomainMatchModel;
    /** Regex only: site creation time in Unix ms × 16 + the pattern's index in the site. */
    order?: number;
  }[];
  originPool: {
    id: string;
    policy: "weighted_random" | "round_robin" | "consistent_hash";
    origins: OriginModel[];
    /** Omitted: node defaults (verify TLS, 3 failures / 30 s, default timeouts, keep-alive). */
    settings?: OriginPoolSettingsModel;
    /** Omitted or null: passive checks only. */
    activeHealthCheck?: ActiveHealthCheckModel | null;
    /** Omitted or null: no session affinity. */
    sessionAffinity?: SessionAffinityModel | null;
  };
  cacheRules: CacheRuleModel[];
  /** Omitted: the default cache key. */
  cacheKey?: CacheKeyModel;
  rangeSlice?: boolean;
  /** Defaults to true. */
  websocket?: boolean;
  certificateId?: string;
  /** Further certificates in the site's order (needs certificateId); omitted: none. */
  additionalCertificateIds?: string[];
  /** Omitted or null: off. Needs certificateId. */
  clientCertificate?: ClientCertificateModel | null;
  tls?: TlsModel;
  rules?: RuleModel[];
  /** Omitted or null: CRS off. */
  waf?: SiteWafModel | null;
  /** Omitted: the defaults (DEFAULT_SITE_PROTECTION, everything off). */
  protection?: SiteProtectionModel;
  /** Forward the origin's Cache-Tag header to clients; defaults to false. */
  keepCacheTag?: boolean;
  /** Omitted, null or without pages: the node's built-in pages. */
  errorPages?: SiteErrorPagesModel | null;
  /** Exact-match redirect table; any order, compiled sorted by source (rules-v2). */
  bulkRedirects?: BulkRedirectModel[];
  /**
   * The listener ports the site is served on (HTTPS ones only with a
   * certificate). Omitted: 80 and 443.
   */
  ports?: SitePortsModel;
  // site-content-v1 (proto v0.24.0); omitted values compile as before.
  /** The PURGE method's key reference; omitted or null: off. */
  purge?: { credentialId: string; credentialVersion: number } | null;
  /** Send no X-Cache header. */
  hideXCache?: boolean;
  /** Omitted or null: off. */
  maintenance?: MaintenanceModel | null;
  /** Omitted or null: off. */
  charset?: CharsetModel | null;
  /** Bytes, 0 no limit; omitted or DEFAULT_REQUEST_BODY_LIMIT compiles as before. */
  requestBodyLimit?: number;
  /** Enabled access authentication rules in order (access-auth-v1); omitted: none. */
  authRules?: AuthRuleModel[];
  /** Access control (access-control-v1); omitted or null: none. */
  accessControl?: AccessControlModel | null;
  /**
   * Largest request body the rules read (rules-body-v1); compiled only when the site's or
   * the platform's rules read the body. Omitted: RULES_BODY_LIMIT.default.
   */
  rulesBodyLimit?: number;
}

/** A site's listener ports. */
export interface SitePortsModel {
  http: number[];
  https: number[];
}

/** The cluster's client address setting (config.proto ClientAddress); null is direct. */
export interface ClientIpModel {
  mode: "direct" | "proxy_protocol" | "header";
  trustedCidrs: string[];
  header: string;
  dropForwardedFor: boolean;
}

/**
 * The cluster's listener ports besides 80 and 443, its client address
 * setting and its unknown host handling (cluster state a rollback keeps).
 */
export interface EdgeModel {
  httpPorts: number[];
  httpsPorts: number[];
  clientIp: ClientIpModel | null;
  /** Omitted or null: the platform's page for both, no scan protection. */
  unknownHosts?: UnknownHostsModel | null;
}

export const DEFAULT_HTTP_PORT = 80;
export const DEFAULT_HTTPS_PORT = 443;
export const EDGE_PORTS_FEATURE = "edge-ports-v1";
export const CLIENT_IP_FEATURE = "client-ip-v1";
export const L4_V2_FEATURE = "l4-v2";

/** One entry of a site's bulk redirect table (config.proto BulkRedirect). */
export interface BulkRedirectModel {
  source: string;
  target: string;
  statusCode: number;
  preserveQuery: boolean;
}

/** Thresholds of an enabled CC policy (config.proto CcPolicy). */
export interface CcPolicyModel {
  maxLevel: string;
  highPowInsteadOfCaptcha: boolean;
  windowSeconds: number;
  siteQps: number;
  urlQps: number;
  ipQps: number;
  ipBanSeconds: number;
  originErrorPercent: number;
  originErrorMinRequests: number;
  escalateAfterSeconds: number;
  cooldownSeconds: number;
}

/** Challenges and CC mitigation of a site (config.proto SiteProtection). */
export interface SiteProtectionModel {
  underAttack: boolean;
  underAttackChallenge: string;
  passTtlSeconds: number;
  powDifficulty: number;
  powHighDifficulty: number;
  /** The effective thresholds (template or the site's own); null while CC is off. */
  cc: CcPolicyModel | null;
  logJa4: boolean;
  // challenge-v2; omitted compiles as before.
  /** Skip Under Attack and CC challenges for verified crawlers. */
  allowVerifiedBots?: boolean;
  /** Title and hint of the challenge pages; empty values keep the built-in text. */
  challengeText?: { titleZh: string; hintZh: string; titleEn: string; hintEn: string };
  /** Ban after repeated challenge failures; omitted or null: off. */
  failureBan?: { threshold: number; banSeconds: number } | null;
}

export const DEFAULT_SITE_PROTECTION: SiteProtectionModel = {
  underAttack: false,
  underAttackChallenge: "js",
  passTtlSeconds: 1800,
  powDifficulty: 16,
  powHighDifficulty: 20,
  cc: null,
  logJa4: false,
};

export interface PlatformProtectionModel {
  underAttack: boolean;
  underAttackChallenge: string;
}

/** A challenge pass key of the cluster: next, current or previous. */
export interface ChallengeKeyModel {
  id: string;
  role: string;
}

export interface RuleModel {
  id: string;
  phase: string;
  expression: Expression;
  /** A rule action as the contract's ruleAction parses it. */
  action: {
    kind: string;
    value?: string;
    header?: string;
    statusCode?: number;
    limit?: number;
    windowSeconds?: number;
    key?: string;
    cacheBypass?: boolean;
    forceHttps?: boolean;
    gzip?: boolean;
    remove?: boolean;
    /** Challenge type of a challenge action (RuleAction.challenge). */
    type?: string;
    // rules-v2: config (phase config only)
    brotli?: boolean;
    zstd?: boolean;
    websocket?: boolean;
    underAttack?: boolean;
    ccEnabled?: boolean;
    ccMaxLevel?: string;
    originConnectTimeoutMs?: number;
    originSendTimeoutMs?: number;
    originReadTimeoutMs?: number;
    logSampleRate?: number;
    // rules-v2: redirect and rewrite
    /** Value expression source computed per request instead of the static value; "" for none. */
    target?: string;
    /** Redirects drop the query by default, rewrites keep it. */
    preserveQuery?: boolean;
    /** rules-v3: `expression` (a value expression's source) computes the value instead. */
    setQuery?: { name: string; value: string; expression?: string }[];
    removeQuery?: string[];
    // rules-v3: request and response headers
    /** Value expression source of a header computed per request instead of the value; "" for none. */
    expression?: string;
    /** Response headers: add a line next to the response's own. */
    append?: boolean;
    // rules-v2: origin
    originGroup?: string;
    hostHeader?: string;
    sni?: string;
    port?: number;
    // rules-v2: compression codings in preference order (RuleAction.compression)
    algorithms?: string[];
    // site-content-v1: config (phase config only)
    /** The request's body limit in bytes (0: none); omitted keeps the site's. */
    requestBodyLimit?: number;
    // waf-v2
    /** ban; rate_limit (0: no ban). */
    banSeconds?: number;
    /** ban: site (default) or platform (platform rules only). */
    banScope?: string;
    /** ban: IPv4 /16-/32 and IPv6 /48-/64; /32 and /64 compile as 0 (the default). */
    banPrefixV4?: number;
    banPrefixV6?: number;
    /** respond */
    contentType?: string;
    body?: string;
    errorPage?: boolean;
    /** skip: any order; compiled sorted. */
    skip?: string[];
    /** log: write an access log line whatever the sample rate. */
    accessLog?: boolean;
    /** config (phase config only): the request's CRS mode. */
    crs?: string;
  };
  /** A rule compiled earlier: compileRules keeps it as it is (see ruleModelOf). */
  compiled?: EdgeRule;
}
export interface IpListModel {
  id: string;
  name: string;
  entries: string[];
  kind: string;
  platform: boolean;
}
/** Whether a kind keeps the request's query string by default (rewrites do, redirects not). */
const queryDefault = (kind: string) => kind === "rewrite";

/**
 * A rule action as nodes receive it: only the fields its kind carries.
 * preserve_query is set only where it differs from the kind's default
 * (redirects drop the query, rewrites keep it), set_query is sorted by name
 * and remove_query sorted without duplicates, so that rules without the
 * rules-v2 fields encode as before.
 */
function compileAction(phase: string, a: RuleModel["action"]): RuleAction {
  const redirectOrRewrite = a.kind === "redirect" || a.kind === "rewrite";
  const header = (a.kind === "request_header" || a.kind === "response_header") && !a.remove;
  const value = (source: string | undefined) =>
    source ? parseValueExpression(source, phase as Phase) : undefined;
  return create(RuleActionSchema, {
    kind: a.kind,
    value: a.value,
    header: a.header,
    statusCode: a.statusCode,
    limit: a.limit,
    windowSeconds: a.windowSeconds,
    key: a.key,
    cacheBypass: a.cacheBypass,
    forceHttps: a.forceHttps,
    gzip: a.gzip,
    remove: a.remove,
    challenge: a.kind === "challenge" ? (a.type ?? "") : "",
    brotli: a.brotli,
    zstd: a.zstd,
    websocket: a.websocket,
    underAttack: a.underAttack,
    ccEnabled: a.ccEnabled,
    ccMaxLevel: a.ccMaxLevel ?? "",
    originConnectTimeoutMs: a.originConnectTimeoutMs ?? 0,
    originSendTimeoutMs: a.originSendTimeoutMs ?? 0,
    originReadTimeoutMs: a.originReadTimeoutMs ?? 0,
    logSampleRate: a.logSampleRate,
    target: redirectOrRewrite ? value(a.target) : header ? value(a.expression) : undefined,
    preserveQuery:
      redirectOrRewrite && a.preserveQuery !== undefined && a.preserveQuery !== queryDefault(a.kind)
        ? a.preserveQuery
        : undefined,
    setQuery: [...(a.setQuery ?? [])].sort(byString((param) => param.name)).map((param) =>
      create(QueryParamSchema, {
        name: param.name,
        value: param.value,
        expression: value(param.expression),
      }),
    ),
    removeQuery: sortedSet(a.removeQuery),
    originGroup: a.originGroup ?? "",
    hostHeader: a.hostHeader ?? "",
    sni: a.sni ?? "",
    port: a.port ?? 0,
    compression: a.kind === "compression" ? [...(a.algorithms ?? [])] : [],
    append: a.kind === "response_header" && header && a.append === true,
    requestBodyLimit:
      a.kind === "config" && a.requestBodyLimit !== undefined
        ? BigInt(a.requestBodyLimit)
        : undefined,
    // waf-v2: only the kind's own fields, defaults as zero values.
    banSeconds: a.kind === "ban" || a.kind === "rate_limit" ? (a.banSeconds ?? 0) : 0,
    banScope: a.kind === "ban" && a.banScope === "platform" ? "platform" : "",
    banPrefixV4: a.kind === "ban" && a.banPrefixV4 && a.banPrefixV4 !== 32 ? a.banPrefixV4 : 0,
    banPrefixV6: a.kind === "ban" && a.banPrefixV6 && a.banPrefixV6 !== 64 ? a.banPrefixV6 : 0,
    contentType: a.kind === "respond" && !a.errorPage ? (a.contentType ?? "") : "",
    body: a.kind === "respond" && !a.errorPage ? (a.body ?? "") : "",
    errorPage: a.kind === "respond" && a.errorPage === true,
    skip: a.kind === "skip" ? sortedSet(a.skip) : [],
    accessLog: a.kind === "log" && a.accessLog === true,
    crs: a.kind === "config" ? (a.crs ?? "") : "",
  });
}

export function compileRules(rules: RuleModel[] = []): EdgeRule[] {
  return [...rules]
    .sort(
      (a, b) =>
        phases.indexOf(a.phase as (typeof phases)[number]) -
        phases.indexOf(b.phase as (typeof phases)[number]),
    )
    .map((rule) =>
      rule.compiled
        ? clone(EdgeRuleSchema, rule.compiled)
        : create(EdgeRuleSchema, {
            id: rule.id,
            phase: rule.phase,
            expression: rule.expression,
            action: compileAction(rule.phase, rule.action),
          }),
    );
}

/** A compiled expression as the rule engine's Expression (empty when unset). */
export function expressionOf(e: RuleExpression | undefined): Expression {
  return {
    op: e?.op ?? "",
    field: e?.field ?? "",
    valueType: e?.valueType ?? "",
    value: e?.value ?? "",
    values: [...(e?.values ?? [])],
    children: (e?.children ?? []).map(expressionOf),
  };
}

/**
 * The model of a compiled rule, which compileRules keeps as it is: a stored
 * rule the current validator refuses keeps its last compiled form. The
 * action carries what usesChallenges reads.
 */
export function ruleModelOf(rule: EdgeRule): RuleModel {
  return {
    id: rule.id,
    phase: rule.phase,
    expression: expressionOf(rule.expression),
    action: {
      kind: rule.action?.kind ?? "",
      type: rule.action?.challenge,
      underAttack: rule.action?.underAttack,
    },
    compiled: rule,
  };
}

/**
 * Every expression of a compiled configuration: rule conditions, redirect
 * and rewrite targets and cache rule conditions, platform rules first.
 */
export function configExpressions(
  config: Pick<NodeConfig, "platformRules" | "sites">,
): RuleExpression[] {
  const rules = [...config.platformRules, ...config.sites.flatMap((site) => site.rules)];
  return [
    ...rules.flatMap((rule) => [
      rule.expression,
      rule.action?.target,
      ...(rule.action?.setQuery ?? []).map((param) => param.expression),
    ]),
    ...config.sites.flatMap((site) => site.cacheRules.map((rule) => rule.match?.condition)),
  ].filter((expression): expression is RuleExpression => !!expression);
}

/** Whether a compiled action uses fields or kinds only rules-v2 nodes know. */
function actionNeedsRulesV2(action: RuleAction | undefined): boolean {
  if (!action) return false;
  return (
    action.kind === "origin" ||
    action.kind === "compression" ||
    action.gzip === true ||
    action.brotli !== undefined ||
    action.zstd !== undefined ||
    action.websocket !== undefined ||
    action.underAttack !== undefined ||
    action.ccEnabled !== undefined ||
    action.ccMaxLevel !== "" ||
    action.originConnectTimeoutMs !== 0 ||
    action.originSendTimeoutMs !== 0 ||
    action.originReadTimeoutMs !== 0 ||
    action.logSampleRate !== undefined ||
    !!action.target ||
    action.preserveQuery !== undefined ||
    action.setQuery.length > 0 ||
    action.removeQuery.length > 0 ||
    action.originGroup !== "" ||
    action.hostHeader !== "" ||
    action.sni !== "" ||
    action.port !== 0 ||
    action.compression.length > 0
  );
}

/**
 * rules-v2 when the compiled configuration uses any of the rule engine
 * extensions (proto v0.13.0): functions or the new fields in a condition or
 * target, the new action kinds and fields, the compression phase, a cache
 * rule condition or browser TTL, bulk redirects or an origin group. Others
 * encode exactly as before and need nothing new.
 */
export function rulesFeatures(config: NodeConfig): string[] {
  const rules = [...config.platformRules, ...config.sites.flatMap((site) => site.rules)];
  const uses =
    configExpressions(config).some((expression) => needsRulesV2(expression)) ||
    rules.some((rule) => rule.phase === "compression" || actionNeedsRulesV2(rule.action)) ||
    config.sites.some(
      (site) =>
        site.bulkRedirects.length > 0 ||
        !!site.originPool?.origins.some((origin) => origin.group !== "") ||
        site.cacheRules.some((rule) => !!rule.match?.condition || rule.browserTtlSeconds > 0),
    );
  return [
    ...(uses ? [RULES_V2_FEATURE] : []),
    ...(rulesV3Used(config, rules) ? [RULES_V3_FEATURE] : []),
  ];
}

/**
 * Whether the compiled configuration uses any of the rules-v3 additions (proto v0.22.0): new
 * fields, functions, comparisons or integer arguments in an expression, a computed header value
 * or query parameter, a response header line, a 303 redirect, or {{time}} or {{path}} in a
 * site's or the platform's error page. Others encode exactly as before.
 */
function rulesV3Used(config: NodeConfig, rules: EdgeRule[]): boolean {
  const pages = config.platformErrorPages;
  return (
    configExpressions(config).some((expression) => needsRulesV3(expression)) ||
    rules.some(({ action }) => {
      if (!action) return false;
      return (
        action.append ||
        (action.kind === "redirect" && action.statusCode === 303) ||
        ((action.kind === "request_header" || action.kind === "response_header") &&
          !!action.target) ||
        action.setQuery.some((param) => !!param.expression)
      );
    }) ||
    config.sites.some((site) =>
      site.errorPages?.pages.some((page) => usesRulesV3Placeholders(page.template)),
    ) ||
    usesRulesV3Placeholders(pages?.unknownHost ?? "") ||
    usesRulesV3Placeholders(pages?.siteDisabled ?? "")
  );
}
/**
 * requiredFeatures for GeoIP fields. geoip-city-v1 keeps its original name so
 * nodes of every version accept the configuration; nodes now report it for any
 * country data (IPinfo Lite or a City MMDB). Subdivisions are checked by the
 * console only, see nodeRequirements.
 */
export function geoFeatures(expression: Expression): string[] {
  // A call's field is the function's name.
  const field = expression.op === "call" ? "" : expression.field;
  return [
    ...(field === "ip.geoip.asnum" || field === "ip.geoip.as_name"
      ? ["geoip-asn-v1"]
      : field.startsWith("ip.geoip.")
        ? ["geoip-city-v1"]
        : []),
    ...expression.children.flatMap(geoFeatures),
  ];
}

/**
 * Capabilities a node needs for `config`: its requiredFeatures, plus
 * geoip-subdivision-v1 when a rule reads ip.geoip.subdivision. That one never
 * enters requiredFeatures, which nodes check against their own list, so nodes
 * that predate it keep accepting the configuration. Compare with
 * nodeSupportsFeature from @edgeweir/contract.
 */
export function nodeRequirements(config: NodeConfig): string[] {
  const readsSubdivision = (expression: RuleExpression): boolean =>
    (expression.op !== "call" && expression.field === "ip.geoip.subdivision") ||
    expression.children.some(readsSubdivision);
  const geoSubdivisions = config.sites.some(
    (site) => (site.accessControl?.geo?.subdivisions.length ?? 0) > 0,
  );
  return configExpressions(config).some(readsSubdivision) || geoSubdivisions
    ? [...config.requiredFeatures, "geoip-subdivision-v1"]
    : [...config.requiredFeatures];
}

/** An origin of a layer-4 application (config.proto L4Origin). */
export interface L4OriginModel {
  id: string;
  address: string;
  /** Compiled 0 while the application's originPortMode is same. */
  port: number;
  weight: number;
  backup: boolean;
}

/** A layer-4 application (config.proto L4App); only enabled ones are compiled. */
export interface L4AppModel {
  id: string;
  enabled: boolean;
  protocol: "tcp" | "udp";
  port: number;
  /** TCP only; compiled false for UDP. */
  acceptProxyProtocol: boolean;
  /** TCP only (0 none, 1, 2); compiled 0 for UDP. */
  proxyProtocolVersion: number;
  /** Any order; compiled sorted by id. */
  origins: L4OriginModel[];
  maxFails: number;
  failTimeoutSeconds: number;
  connectTimeoutMs: number;
  idleTimeoutSeconds: number;
  /** Ids of IP lists; any order, compiled sorted without duplicates. */
  allowListIds: string[];
  blockListIds: string[];
  maxConnections: number;
  newConnectionsPerSecond: number;
  /** The last port of a range (l4-v2); omitted or null: the single port. */
  portEnd?: number | null;
  /** same: origins take the port the connection arrived on (l4-v2). Omitted: fixed. */
  originPortMode?: "fixed" | "same";
  /** TCP only: TLS terminated with this certificate (l4-v2); omitted or null: none. */
  certificateId?: string | null;
  tlsMinimumVersion?: "1.2" | "1.3";
}

/**
 * NodeConfig.l4_apps of the enabled applications: PROXY protocol only for
 * TCP, origins by id and list ids as sorted sets (canonicalize sorts the
 * applications).
 */
export function compileL4Apps(apps: readonly L4AppModel[] | undefined): L4App[] {
  return (apps ?? [])
    .filter((app) => app.enabled)
    .map((app) => {
      const tcp = app.protocol === "tcp";
      return create(L4AppSchema, {
        id: app.id,
        protocol: tcp ? L4Protocol.TCP : L4Protocol.UDP,
        port: app.port,
        acceptProxyProtocol: tcp && app.acceptProxyProtocol,
        proxyProtocolVersion: tcp ? app.proxyProtocolVersion : 0,
        // l4-v2: ranges, origins on the arriving port and TLS; unset
        // otherwise, so applications without them encode as before.
        portEnd: app.portEnd && app.portEnd > app.port ? app.portEnd : 0,
        certificateId: tcp && app.certificateId ? app.certificateId : "",
        tlsMinimumVersion: tcp && app.certificateId ? (app.tlsMinimumVersion ?? "1.2") : "",
        origins: [...app.origins].sort(byBytes((origin) => origin.id)).map((origin) =>
          create(L4OriginSchema, {
            id: origin.id,
            address: origin.address,
            port: app.originPortMode === "same" ? 0 : origin.port,
            weight: Math.max(1, origin.weight),
            backup: origin.backup,
          }),
        ),
        maxFails: app.maxFails,
        failTimeoutSeconds: app.failTimeoutSeconds,
        connectTimeoutMs: app.connectTimeoutMs,
        idleTimeoutSeconds: app.idleTimeoutSeconds,
        allowListIds: sortedByteSet(app.allowListIds),
        blockListIds: sortedByteSet(app.blockListIds),
        maxConnections: app.maxConnections,
        newConnectionsPerSecond: app.newConnectionsPerSecond,
      });
    });
}

export interface ListenerModel {
  port: number;
  protocol: "http" | "https";
  http2?: boolean;
  http3?: boolean;
  proxyProtocol?: boolean;
}

export interface CacheZoneModel {
  name: string;
  maxSizeMb: number;
  keysZoneMb: number;
  inactiveSeconds: number;
  /** Sizes on single nodes (cache-zone-v1); any order, compiled sorted by node id. */
  nodeSizes?: { nodeId: string; maxSizeMb: number; keysZoneMb: number }[];
}

export interface CompileInput {
  clusterId: string;
  sites: SiteModel[];
  listeners?: ListenerModel[];
  cacheZones?: CacheZoneModel[];
  /**
   * CIDRs that origins may use although they are special-purpose addresses
   * (the platform's origin allow list); any order, duplicates allowed.
   */
  originAllowedCidrs?: string[];
  certificates?: CertificateRef[];
  httpChallenges?: HttpChallenge[];
  ipLists?: IpListModel[];
  platformRules?: RuleModel[];
  /** Platform-wide Under Attack; omitted: off. */
  platformProtection?: PlatformProtectionModel;
  /**
   * The cluster's challenge pass keys. Required when usesChallengeKeys(input);
   * compiled only then, sorted by id.
   */
  challengeKeys?: ChallengeKeyModel[];
  /**
   * The cluster's TLS session ticket keys. Compiled only when a served
   * site has a certificate (usesSessionTickets), sorted by id.
   */
  sessionTicketKeys?: ChallengeKeyModel[];
  /** Omitted, or every template empty: the nodes' built-in pages. */
  platformErrorPages?: PlatformErrorPagesModel;
  /** Domains of the cluster's disabled sites; any order. */
  offlineHosts?: OfflineHostModel[];
  /** The cluster's layer-4 applications; disabled ones are left out. */
  l4Apps?: L4AppModel[];
  /** Listener ports besides 80 and 443 and the client address setting; omitted: none, direct. */
  edge?: EdgeModel;
}

/**
 * Whether the cluster's configuration uses challenges: platform Under
 * Attack, a platform or site rule with the challenge action or a config
 * action that turns Under Attack on, or a served site with Under Attack or
 * an enabled CC policy. Only then does the configuration
 * carry challenge keys, the platform protection and every site's protection
 * (feature challenge-v1); other clusters keep their content hash.
 */
export function usesChallenges(input: CompileInput): boolean {
  // A config rule that turns Under Attack on challenges the requests it matches.
  const challengeRule = (rules: RuleModel[] | undefined) =>
    (rules ?? []).some(
      (rule) =>
        rule.action.kind === "challenge" ||
        (rule.action.kind === "config" && rule.action.underAttack === true),
    );
  return (
    !!input.platformProtection?.underAttack ||
    challengeRule(input.platformRules) ||
    input.sites.some(
      (site) =>
        site.enabled &&
        (!!site.protection?.underAttack || !!site.protection?.cc || challengeRule(site.rules)),
    )
  );
}

/**
 * Whether the cluster's configuration carries challenge keys: it uses
 * challenges, or a served site's pool has session affinity (the keys sign
 * its cookies). Keys bring challenge-v1 with them (protectionFeatures).
 */
export function usesChallengeKeys(input: CompileInput): boolean {
  return (
    usesChallenges(input) ||
    input.sites.some((site) => site.enabled && !!site.originPool.sessionAffinity)
  );
}

function compileSiteProtection(model: SiteProtectionModel) {
  const text = model.challengeText;
  return create(SiteProtectionSchema, {
    underAttack: model.underAttack,
    underAttackChallenge: model.underAttackChallenge,
    passTtlSeconds: model.passTtlSeconds,
    powDifficulty: model.powDifficulty,
    powHighDifficulty: model.powHighDifficulty,
    cc: model.cc ? create(CcPolicySchema, { enabled: true, ...model.cc }) : undefined,
    logJa4: model.logJa4,
    // challenge-v2: absent unless used, so that other sites encode as before.
    allowVerifiedBots: model.allowVerifiedBots === true,
    challengeText:
      text && (text.titleZh || text.hintZh || text.titleEn || text.hintEn)
        ? create(ChallengeTextSchema, text)
        : undefined,
    failureThreshold: model.failureBan?.threshold ?? 0,
    failureBanSeconds: model.failureBan ? model.failureBan.banSeconds : 0,
  });
}

/** Whether compiled rules read the request body (rules-body-v1). */
export function rulesReadBody(rules: readonly EdgeRule[]): boolean {
  return rules.some((rule) =>
    [
      rule.expression,
      rule.action?.target,
      ...(rule.action?.setQuery ?? []).map((p) => p.expression),
    ]
      .filter((e): e is RuleExpression => !!e)
      .some((e) => needsRulesBody(expressionOf(e))),
  );
}

/**
 * Exclusions of a site's CRS: whole-site ones without targets merge into
 * excluded_rule_ids (understood by every node with modsecurity-v1), the
 * others stay entries in the site's order (waf-v2).
 */
export function splitWafExclusions(exclusions: readonly WafExclusionModel[]): {
  excludedRuleIds: number[];
  exclusions: WafExclusionModel[];
} {
  const whole = exclusions.filter((e) => e.path === "" && e.targets.length === 0);
  return {
    excludedRuleIds: sortedSet(whole.flatMap((e) => e.ruleIds)),
    exclusions: exclusions
      .filter((e) => !(e.path === "" && e.targets.length === 0))
      .map((e) => ({
        path: e.path,
        exact: e.path !== "" && e.exact,
        ruleIds: sortedSet(e.ruleIds),
        targets: sortedSet(e.targets),
      })),
  };
}

/**
 * Features that the protection of a compiled configuration needs:
 * challenge-v1 when it carries site or platform protection, challenge keys,
 * a challenge rule or a rule that turns Under Attack on; ja4-v1 when an
 * expression reads tls.ja4 (a condition, target or cache rule condition), a
 * rule counts by it or a site records JA4 in its access logs.
 */
export function protectionFeatures(config: NodeConfig): string[] {
  const rules = [...config.platformRules, ...config.sites.flatMap((site) => site.rules)];
  const readsJa4 = (expression: RuleExpression): boolean =>
    (expression.op !== "call" && expression.field === "tls.ja4") ||
    expression.children.some(readsJa4);
  return [
    ...(config.platformProtection ||
    config.challengeKeys.length ||
    config.sites.some((site) => site.protection) ||
    rules.some((rule) => rule.action?.kind === "challenge" || rule.action?.underAttack === true)
      ? ["challenge-v1"]
      : []),
    ...(config.sites.some((site) => site.protection?.logJa4) ||
    configExpressions(config).some(readsJa4) ||
    rules.some((rule) => rule.action?.key === "tls.ja4")
      ? ["ja4-v1"]
      : []),
  ];
}

/**
 * Features of the optional OpenResty modules that the sites of a compiled
 * configuration use: brotli-v1, zstd-v1 and modsecurity-v1.
 */
export function moduleFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((site) => site.tls?.brotli) ? [BROTLI_FEATURE] : []),
    ...(config.sites.some((site) => site.tls?.zstd) ? [ZSTD_FEATURE] : []),
    ...(config.sites.some((site) => site.waf) ? [MODSECURITY_FEATURE] : []),
  ];
}

/**
 * Features of the active health checks, session affinity, HTTP/2 towards
 * the origins and error pages that the sites of a compiled configuration
 * use: active-health-v1, session-affinity-v1, origin-http2-v1 and
 * error-pages-v1.
 */
export function poolAndPageFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((site) => site.originPool?.activeHealthCheck)
      ? [ACTIVE_HEALTH_FEATURE]
      : []),
    ...(config.sites.some((site) => site.originPool?.sessionAffinity)
      ? [SESSION_AFFINITY_FEATURE]
      : []),
    ...(config.sites.some((site) => site.originPool?.protocol === OriginProtocol.HTTP2)
      ? [ORIGIN_HTTP2_FEATURE]
      : []),
    ...(config.sites.some((site) => site.errorPages) ? [ERROR_PAGES_FEATURE] : []),
  ];
}

/** Error page statuses of error-pages-v1; others need site-content-v1. */
const ERROR_PAGES_V1_STATUSES = new Set([403, 429, 502, 503, 504]);

/** Whether a compiled site uses a setting of site-content-v1. */
export function usesSiteContent(site: Site): boolean {
  const pool = site.originPool;
  const tls = site.tls;
  return (
    !!site.purge ||
    site.hideXCache ||
    !!site.maintenance ||
    !!site.charset ||
    site.requestBodyLimit !== undefined ||
    (tls !== undefined && (tls.gzipLevel !== 0 || tls.compressMaxLength !== 0n)) ||
    (pool !== undefined && (pool.tries !== 0 || pool.statusRetryDisabled)) ||
    site.cacheRules.some((rule) => rule.cacheSetCookie) ||
    site.cacheKey?.query === CacheKeyQuery.EXCLUDE ||
    (site.errorPages?.pages ?? []).some(
      (page) =>
        !ERROR_PAGES_V1_STATUSES.has(page.status) ||
        page.redirectUrl !== "" ||
        page.responseStatus !== 0,
    ) ||
    site.rules.some((rule) => rule.action?.requestBodyLimit !== undefined)
  );
}

/**
 * Features of the proto v0.24.0 settings a compiled configuration uses:
 * site-content-v1 (a site's settings, or a platform rule's body limit) and
 * cache-zone-v1 (per-node cache zone sizes).
 */
export function contentFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some(usesSiteContent) ||
    config.platformRules.some((rule) => rule.action?.requestBodyLimit !== undefined)
      ? [SITE_CONTENT_FEATURE]
      : []),
    ...(config.cacheZones.some((zone) => zone.nodeSizes.length) ? [CACHE_ZONE_FEATURE] : []),
  ];
}

export const DEFAULT_CACHE_ZONE = "default";

export const defaultListeners: ListenerModel[] = [{ port: 80, protocol: "http" }];

export const defaultCacheZones: CacheZoneModel[] = [
  {
    name: DEFAULT_CACHE_ZONE,
    maxSizeMb: 10 * 1024,
    keysZoneMb: 64,
    inactiveSeconds: 7 * 24 * 3600,
  },
];

/** Splits "*.example.com" into its suffix and wildcard flag. */
export function parseDomain(value: string): { name: string; wildcard: boolean } {
  const lower = value.trim().toLowerCase();
  return lower.startsWith("*.")
    ? { name: lower.slice(2), wildcard: true }
    : { name: lower, wildcard: false };
}

export function formatDomain(domain: { name: string; wildcard: boolean }): string {
  return domain.wildcard ? `*.${domain.name}` : domain.name;
}

const policyMap = {
  weighted_random: LoadBalancePolicy.WEIGHTED_RANDOM,
  round_robin: LoadBalancePolicy.ROUND_ROBIN,
  consistent_hash: LoadBalancePolicy.CONSISTENT_HASH,
} as const;

const queryMap = {
  all: CacheKeyQuery.ALL,
  ignore: CacheKeyQuery.IGNORE,
  include: CacheKeyQuery.INCLUDE,
  exclude: CacheKeyQuery.EXCLUDE,
} as const;

/** Sorted, de-duplicated copy: list order carries no meaning in these fields. */
const sortedSet = <T extends string | number>(values: readonly T[] | undefined): T[] =>
  [...new Set(values ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

const byString =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };

/** Byte order of the UTF-8 encoding, as Go compares strings (unlike UTF-16 beyond U+FFFF). */
const byBytes =
  <T>(key: (item: T) => string) =>
  (a: T, b: T) =>
    Buffer.compare(Buffer.from(key(a), "utf8"), Buffer.from(key(b), "utf8"));

/** Sorted (UTF-8 byte order), de-duplicated copy of a set of strings. */
const sortedByteSet = (values: readonly string[] | undefined): string[] =>
  [...new Set(values ?? [])].sort(byBytes((value) => value));

/**
 * TLS options of a site. Brotli and Zstandard carry their level, minimum
 * length and types only while on, so sites without them keep the encoding
 * (and content hash) they had before these fields existed.
 */
function compileTls(
  model: TlsModel,
  site: { certificate: boolean; ports: readonly number[]; domains: ReadonlySet<string> },
) {
  const {
    brotli,
    brotliLevel,
    brotliMinLength,
    brotliTypes,
    zstd,
    zstdLevel,
    zstdMinLength,
    zstdTypes,
    redirectStatus,
    redirectPort,
    redirectExcludedDomains,
    gzipLevel,
    compressMaxLength,
    ...rest
  } = model;
  return create(TlsOptionsSchema, {
    ...rest,
    // edge-ports-v1: the defaults (301 to 443, nothing excluded) stay unset.
    // Nodes refuse a redirect port the site is not served on over HTTPS and
    // excluded names that are no domain of the site: those compile as unset
    // (as in rollback), not into a revision the cluster cannot apply.
    redirectStatus: redirectStatus === 301 ? 0 : (redirectStatus ?? 0),
    redirectPort:
      redirectPort &&
      redirectPort !== DEFAULT_HTTPS_PORT &&
      site.certificate &&
      site.ports.includes(redirectPort)
        ? redirectPort
        : 0,
    redirectExcludedDomains: sortedByteSet(
      redirectExcludedDomains?.filter((name) => site.domains.has(name)),
    ),
    gzipLevel: gzipLevel ?? 0,
    compressMaxLength: BigInt(compressMaxLength ?? 0),
    ...(brotli
      ? {
          brotli: true,
          brotliLevel: brotliLevel ?? 0,
          brotliMinLength: brotliMinLength ?? 0,
          brotliTypes: [...(brotliTypes ?? [])],
        }
      : {}),
    ...(zstd
      ? {
          zstd: true,
          zstdLevel: zstdLevel ?? 0,
          zstdMinLength: zstdMinLength ?? 0,
          zstdTypes: [...(zstdTypes ?? [])],
        }
      : {}),
  });
}

/**
 * Site.ports of a site: its HTTP ports among 80 and the cluster's extra
 * HTTP ports, and with a certificate its HTTPS ports among 443 and the
 * extra HTTPS ports, sorted. Empty (every listener) when the cluster has no
 * extra ports and the site keeps the defaults, so such configurations
 * encode as before edge-ports-v1.
 */
export function compileSitePorts(
  site: { ports?: SitePortsModel; certificateId?: string },
  edge: EdgeModel | undefined,
): number[] {
  const ports = site.ports ?? { http: [DEFAULT_HTTP_PORT], https: [DEFAULT_HTTPS_PORT] };
  const http = new Set([DEFAULT_HTTP_PORT, ...(edge?.httpPorts ?? [])]);
  const https = new Set([DEFAULT_HTTPS_PORT, ...(edge?.httpsPorts ?? [])]);
  const out = sortedSet([
    ...ports.http.filter((port) => http.has(port)),
    ...(site.certificateId ? ports.https.filter((port) => https.has(port)) : []),
  ]);
  const extra = (edge?.httpPorts.length ?? 0) + (edge?.httpsPorts.length ?? 0) > 0;
  const defaults = site.certificateId
    ? [DEFAULT_HTTP_PORT, DEFAULT_HTTPS_PORT]
    : [DEFAULT_HTTP_PORT];
  return !extra && out.join() === defaults.join() ? [] : out;
}

function compileSite(
  model: SiteModel,
  challenges: boolean,
  edge?: EdgeModel,
  platformReadsBody = false,
): Site {
  const rules = compileRules(model.rules);
  const waf = model.waf ? splitWafExclusions(model.waf.exclusions) : undefined;
  const settings = model.originPool.settings;
  const health = model.originPool.activeHealthCheck;
  const affinity = model.originPool.sessionAffinity;
  const key = model.cacheKey;
  return create(SiteSchema, {
    id: model.id,
    name: model.name,
    enabled: model.enabled,
    cacheZone: DEFAULT_CACHE_ZONE,
    cacheGeneration: BigInt(model.cacheGeneration),
    logSampleRate: model.logSampleRate ?? 0,
    domains: model.domains.map((d) =>
      create(DomainSchema, {
        name: d.name,
        wildcard: !d.match && d.wildcard,
        tlsPending: !d.match && !!d.tlsPending && !!model.certificateId,
        match: d.match ? matchMap[d.match] : DomainMatch.UNSPECIFIED,
        order: d.match === "regex" ? BigInt(d.order ?? 0) : 0n,
      }),
    ),
    originPool: create(OriginPoolSchema, {
      id: model.originPool.id,
      policy: policyMap[model.originPool.policy],
      origins: model.originPool.origins.map((o) =>
        create(OriginSchema, {
          id: o.id,
          address: o.address,
          port: o.port,
          scheme: o.scheme === "https" ? OriginScheme.HTTPS : OriginScheme.HTTP,
          weight: Math.max(1, o.weight),
          backup: o.backup,
          hostHeader: o.hostHeader,
          sni: o.sni,
          group: o.group ?? "",
          s3: o.s3
            ? create(S3AuthSchema, {
                region: o.s3.region,
                bucket: o.s3.bucket,
                credentialId: o.s3.credentialId,
                credentialVersion: BigInt(o.s3.credentialVersion),
              })
            : undefined,
        }),
      ),
      ...(settings
        ? {
            skipTlsVerify: !settings.tlsVerify,
            // HTTP/1.1 stays unset: configurations encode as before.
            ...(settings.protocol === "http2"
              ? { protocol: OriginProtocol.HTTP2, grpc: !!settings.grpc }
              : {}),
            // Three tries with status retries stay unset (site-content-v1 otherwise).
            tries:
              settings.tries !== undefined && settings.tries !== DEFAULT_ORIGIN_TRIES
                ? settings.tries
                : 0,
            statusRetryDisabled: settings.statusRetry === false,
            healthCheck: create(PassiveHealthCheckSchema, {
              maxFails: settings.maxFails,
              recoverySeconds: settings.recoverySeconds,
            }),
            connection: create(OriginConnectionSchema, {
              connectTimeoutMs: settings.connectTimeoutMs,
              sendTimeoutMs: settings.sendTimeoutMs,
              readTimeoutMs: settings.readTimeoutMs,
              keepaliveDisabled: !settings.keepalive,
              keepaliveIdleSeconds: settings.keepaliveIdleSeconds,
              keepaliveMaxRequests: settings.keepaliveMaxRequests,
            }),
          }
        : {}),
      activeHealthCheck: health
        ? create(ActiveHealthCheckSchema, {
            path: health.path,
            method: health.method,
            expectedStatusMin: health.expectedStatusMin,
            expectedStatusMax: health.expectedStatusMax,
            host: health.host,
            intervalSeconds: health.intervalSeconds,
            timeoutSeconds: health.timeoutSeconds,
            healthyThreshold: health.healthyThreshold,
            unhealthyThreshold: health.unhealthyThreshold,
          })
        : undefined,
      sessionAffinity: affinity
        ? create(SessionAffinitySchema, { ttlSeconds: affinity.ttlSeconds })
        : undefined,
    }),
    cacheRules: model.cacheRules.map(
      (r): CacheRule =>
        create(CacheRuleSchema, {
          id: r.id,
          priority: r.priority,
          match: {
            ...cacheCondition(r),
            statusCodes: sortedSet(r.statusCodes),
            minSizeBytes: BigInt(r.minSizeBytes ?? 0),
            maxSizeBytes: BigInt(r.maxSizeBytes ?? 0),
          },
          action: r.action === "bypass" ? CacheAction.BYPASS : CacheAction.CACHE,
          edgeTtlSeconds: r.edgeTtlSeconds,
          originCacheControl:
            r.originCacheControl === "respect"
              ? OriginCacheControl.RESPECT
              : OriginCacheControl.OVERRIDE,
          staleWhileRevalidateSeconds: r.staleWhileRevalidateSeconds ?? 0,
          staleIfErrorSeconds: r.staleIfErrorSeconds ?? 0,
          cacheAuthorized: r.cacheAuthorized ?? false,
          browserTtlSeconds: r.browserTtlSeconds ?? 0,
          cacheSetCookie: r.cacheSetCookie ?? false,
        }),
    ),
    cacheKey: key
      ? create(CacheKeyPolicySchema, {
          query: queryMap[key.query],
          queryParams:
            key.query === "include" || key.query === "exclude" ? sortedSet(key.queryParams) : [],
          sortQuery: key.sortQuery,
          headers: sortedSet(key.headers.map((h) => h.toLowerCase())),
          cookies: sortedSet(key.cookies),
          deviceType: key.deviceType,
          excludeHost: !key.includeHost,
        })
      : undefined,
    rangeSlice: model.rangeSlice ?? false,
    websocketDisabled: model.websocket === false,
    certificateId: model.certificateId ?? "",
    additionalCertificateIds: model.certificateId
      ? [...(model.additionalCertificateIds ?? [])]
      : [],
    clientCertificate:
      model.certificateId && model.clientCertificate
        ? create(ClientCertificateSchema, {
            mode:
              model.clientCertificate.mode === "required"
                ? ClientCertificateMode.REQUIRED
                : ClientCertificateMode.OPTIONAL,
            caPem: model.clientCertificate.caPem,
            depth: model.clientCertificate.depth,
            forwardHeaders: model.clientCertificate.forwardHeaders,
          })
        : undefined,
    tls: model.tls
      ? compileTls(model.tls, {
          certificate: !!model.certificateId,
          ports: compileSitePorts(model, edge),
          domains: new Set(
            model.domains.filter((d) => !d.match).map((d) => (d.wildcard ? `*.${d.name}` : d.name)),
          ),
        })
      : undefined,
    rules,
    // rules-body-v1: only for sites whose rules (or the platform's) read the body.
    rulesBodyLimit:
      platformReadsBody || rulesReadBody(rules)
        ? (model.rulesBodyLimit ?? RULES_BODY_LIMIT.default)
        : 0,
    waf:
      model.waf && waf
        ? create(SiteWafSchema, {
            mode: model.waf.mode,
            paranoiaLevel: model.waf.paranoiaLevel,
            anomalyThreshold: model.waf.anomalyThreshold,
            excludedRuleIds: waf.excludedRuleIds,
            requestBodyLimit: model.waf.requestBodyLimit,
            exclusions: waf.exclusions.map((e) => create(WafExclusionSchema, e)),
          })
        : undefined,
    // Sites in clusters with challenges get their protection (defaults included);
    // elsewhere only a site that records JA4 carries it.
    protection:
      challenges || model.protection?.logJa4
        ? compileSiteProtection(model.protection ?? DEFAULT_SITE_PROTECTION)
        : undefined,
    keepCacheTag: model.keepCacheTag ?? false,
    // Intercepting origin errors means nothing without pages.
    errorPages: model.errorPages?.pages.length
      ? create(SiteErrorPagesSchema, {
          pages: model.errorPages.pages.map((page) =>
            create(ErrorPageSchema, {
              status: page.status,
              // A redirect page has no template (site-content-v1).
              template: page.redirectUrl ? "" : page.template,
              redirectUrl: page.redirectUrl ?? "",
              responseStatus: page.redirectUrl ? 0 : (page.responseStatus ?? 0),
            }),
          ),
          interceptOriginErrors: model.errorPages.interceptOriginErrors,
        })
      : undefined,
    purge: model.purge
      ? create(PurgeMethodSchema, {
          credentialId: model.purge.credentialId,
          credentialVersion: BigInt(model.purge.credentialVersion),
        })
      : undefined,
    hideXCache: model.hideXCache ?? false,
    maintenance: model.maintenance
      ? create(MaintenanceSchema, {
          template: model.maintenance.template,
          retryAfterSeconds: model.maintenance.retryAfterSeconds,
          allowedCidrs: sortedSet(model.maintenance.allowedCidrs),
          // Byte order: nodes sort the prefixes as Go compares strings.
          allowedPathPrefixes: sortedByteSet(model.maintenance.allowedPathPrefixes),
        })
      : undefined,
    charset: model.charset ? create(CharsetSchema, model.charset) : undefined,
    // The default limit stays unset: configurations encode as before.
    requestBodyLimit:
      model.requestBodyLimit !== undefined && model.requestBodyLimit !== DEFAULT_REQUEST_BODY_LIMIT
        ? BigInt(model.requestBodyLimit)
        : undefined,
    bulkRedirects: [...(model.bulkRedirects ?? [])]
      .sort(byBytes((redirect) => redirect.source))
      .map((redirect) =>
        create(BulkRedirectSchema, {
          source: redirect.source,
          target: redirect.target,
          statusCode: redirect.statusCode,
          preserveQuery: redirect.preserveQuery,
        }),
      ),
    ports: compileSitePorts(model, edge),
    authRules: (model.authRules ?? []).map(compileAuthRule),
    accessControl: model.accessControl ? compileAccessControl(model.accessControl) : undefined,
  });
}

/** A site's access control; lists as sets (byte order) but UA rules and CORS methods in order. */
function compileAccessControl(model: AccessControlModel) {
  const { hotlink, userAgents, cors, geo, websocket, securityHeaders } = model;
  return create(AccessControlSchema, {
    blockListIds: sortedByteSet(model.blockListIds),
    allowListIds: sortedByteSet(model.allowListIds),
    hotlink: hotlink
      ? create(HotlinkSchema, {
          allowEmpty: hotlink.allowEmpty,
          allowSiteDomains: hotlink.allowSiteDomains,
          allowed: sortedByteSet(hotlink.allowed),
          denied: sortedByteSet(hotlink.denied),
          checkOrigin: hotlink.checkOrigin,
          extensions: sortedByteSet(hotlink.extensions),
          pathPrefixes: sortedByteSet(hotlink.pathPrefixes),
          excludePathPrefixes: sortedByteSet(hotlink.excludePathPrefixes),
          redirectUrl: hotlink.redirectUrl,
        })
      : undefined,
    userAgents: userAgents
      ? create(UserAgentRulesSchema, {
          rules: userAgents.rules.map((rule) => create(UserAgentRuleSchema, rule)),
          pathPrefixes: sortedByteSet(userAgents.pathPrefixes),
          excludePathPrefixes: sortedByteSet(userAgents.excludePathPrefixes),
        })
      : undefined,
    cors: cors
      ? create(CorsSchema, {
          allowedOrigins: sortedByteSet(cors.allowedOrigins),
          allowCredentials: cors.allowCredentials,
          allowedMethods: [...new Set(cors.allowedMethods)],
          allowedHeaders: sortedByteSet(cors.allowedHeaders),
          echoRequestHeaders: cors.echoRequestHeaders,
          exposedHeaders: sortedByteSet(cors.exposedHeaders),
          maxAgeSeconds: cors.maxAgeSeconds,
          preflightToOrigin: cors.preflightToOrigin,
          keepOriginHeaders: cors.keepOriginHeaders,
          pathPrefixes: sortedByteSet(cors.pathPrefixes),
        })
      : undefined,
    geo: geo
      ? create(GeoAccessSchema, {
          allowOnly: geo.allowOnly,
          countries: sortedByteSet(geo.countries),
          subdivisions: sortedByteSet(geo.subdivisions),
          asns: sortedSet(geo.asns),
          pathPrefixes: sortedByteSet(geo.pathPrefixes),
          exceptPathPrefixes: sortedByteSet(geo.exceptPathPrefixes),
        })
      : undefined,
    websocket: websocket
      ? create(WebSocketAccessSchema, {
          origins: sortedByteSet(websocket.origins),
          idleTimeoutSeconds: websocket.idleTimeoutSeconds,
        })
      : undefined,
    securityHeaders: securityHeaders ? create(SecurityHeadersSchema, securityHeaders) : undefined,
  });
}

/** An access authentication rule; scope lists as sets (byte order, as Go sorts them). */
function compileAuthRule(rule: AuthRuleModel) {
  return create(AuthRuleSchema, {
    id: rule.id,
    kind: AUTH_KINDS[rule.kind],
    domains: sortedByteSet(rule.scope.domains),
    pathPrefixes: sortedByteSet(rule.scope.pathPrefixes),
    extensions: sortedByteSet(rule.scope.extensions),
    excludePathPrefixes: sortedByteSet(rule.scope.excludePathPrefixes),
    credentialId: rule.credential?.id ?? "",
    credentialVersion: BigInt(rule.credential?.version ?? 0),
    basic: rule.basic ? create(BasicAuthSchema, rule.basic) : undefined,
    forward: rule.forward
      ? create(ForwardAuthSchema, {
          url: rule.forward.url,
          head: rule.forward.method === "HEAD",
          timeoutMs: rule.forward.timeoutMs,
          requestHeaders: sortedByteSet(rule.forward.requestHeaders),
          responseHeaders: sortedByteSet(rule.forward.responseHeaders),
          cacheSeconds: rule.forward.cacheSeconds,
          passRedirects: rule.forward.passRedirects,
          allowUnavailable: rule.forward.allowUnavailable,
        })
      : undefined,
    url: rule.url ? create(UrlAuthSchema, rule.url) : undefined,
  });
}

/**
 * The request condition of a cache rule: the structured lists (paths sorted,
 * extensions lowercase in the rule's order) when the expression has the
 * builder's shape, which nodes of every version understand, else the typed
 * condition (rules-v2). Rules without an expression keep their lists.
 */
function cacheCondition(r: CacheRuleModel) {
  const lists = (structured: {
    pathPrefixes: string[];
    paths?: string[];
    extensions: string[];
  }) => ({
    pathPrefixes: [...structured.pathPrefixes],
    extensions: structured.extensions.map((e) => e.toLowerCase()),
    paths: sortedSet(structured.paths),
  });
  if (!r.expression && !r.condition) return lists(r);
  const condition =
    r.condition ??
    parseExpression(r.expression, "cache", { maxLength: CACHE_EXPRESSION_MAX_LENGTH });
  const structured = structuredCacheCondition(condition);
  return structured ? lists(structured) : { condition };
}

/** Domains and offline hosts sort by (name, wildcard, match): the exact host first. */
const domainKey = (d: { name: string; wildcard: boolean; match: DomainMatch }) =>
  `${d.name}\u0000${d.wildcard ? 1 : 0}\u0000${d.match}`;
const offlineHostKey = domainKey;
const matchMap = { suffix: DomainMatch.SUFFIX, regex: DomainMatch.REGEX } as const;

/**
 * NodeConfig.platform_error_pages: unset when every template is empty (the
 * nodes' built-in pages). Platform state: a rollback ships the current pages.
 */
export function compilePlatformErrorPages(
  pages: PlatformErrorPagesModel | undefined,
): PlatformErrorPages | undefined {
  return pages && (pages.unknownHost || pages.siteDisabled)
    ? create(PlatformErrorPagesSchema, {
        unknownHost: pages.unknownHost,
        siteDisabled: pages.siteDisabled,
      })
    : undefined;
}

/**
 * NodeConfig.offline_hosts, in canonical order. Current state: a rollback
 * ships the hosts of the sites that are offline now.
 */
export function compileOfflineHosts(hosts: OfflineHostModel[] | undefined): OfflineHost[] {
  return (hosts ?? [])
    .map((host) =>
      create(OfflineHostSchema, {
        name: host.name,
        wildcard: !host.match && host.wildcard,
        reason: host.reason,
        match: host.match ? matchMap[host.match] : DomainMatch.UNSPECIFIED,
      }),
    )
    .sort(byString(offlineHostKey));
}

/** set_query by name, remove_query sorted without duplicates (v0.13.0). */
function canonicalizeAction(action: RuleAction | undefined) {
  if (!action) return;
  action.setQuery.sort(byString((param) => param.name));
  action.removeQuery = sortedSet(action.removeQuery);
  action.skip = sortedSet(action.skip);
}

/** Sorts every repeated field into the canonical order defined in config.proto. */
export function canonicalize<T extends NodeConfig>(config: T): T {
  const out = clone(NodeConfigSchema, config) as T;
  out.listeners.sort((a, b) => a.port - b.port);
  out.cacheZones.sort(byString((z: CacheZone) => z.name));
  for (const zone of out.cacheZones) zone.nodeSizes.sort(byString((n) => n.nodeId));
  out.certificates.sort(byString((c: CertificateRef) => c.id));
  out.sites.sort(byString((s: Site) => s.id));
  // A set: ascending (byte order, ASCII) without duplicates, as the Go agent sorts it.
  out.originAllowedCidrs = sortedSet(out.originAllowedCidrs);
  out.requiredFeatures = sortedSet(out.requiredFeatures);
  out.httpChallenges.sort(byString((c) => `${c.domain}/${c.token}`));
  out.ipLists.sort(byString((list: IpList) => list.id));
  out.challengeKeys.sort(byString((key: ChallengeKeyRef) => key.id));
  out.sessionTicketKeys.sort(byString((key: SessionTicketKeyRef) => key.id));
  out.offlineHosts.sort(byString(offlineHostKey));
  // v0.15.0: layer-4 applications by id (UTF-8 bytes), their origins by id
  // and the list ids as sets.
  out.l4Apps.sort(byBytes((app: L4App) => app.id));
  for (const app of out.l4Apps) {
    app.origins.sort(byBytes((origin) => origin.id));
    app.allowListIds = sortedByteSet(app.allowListIds);
    app.blockListIds = sortedByteSet(app.blockListIds);
  }
  for (const list of out.ipLists) list.entries = sortedSet(list.entries);
  if (out.clientAddress) out.clientAddress.trustedCidrs = sortedSet(out.clientAddress.trustedCidrs);
  for (const rule of out.platformRules) canonicalizeAction(rule.action);
  for (const site of out.sites) {
    if (site.tls) {
      site.tls.gzipTypes = sortedSet(site.tls.gzipTypes);
      site.tls.brotliTypes = sortedSet(site.tls.brotliTypes);
      site.tls.zstdTypes = sortedSet(site.tls.zstdTypes);
    }
    if (site.waf) {
      site.waf.excludedRuleIds = sortedSet(site.waf.excludedRuleIds);
      // Exclusions keep the site's order; their lists are sets.
      for (const exclusion of site.waf.exclusions) {
        exclusion.ruleIds = sortedSet(exclusion.ruleIds);
        exclusion.targets = sortedSet(exclusion.targets);
      }
    }
    // v0.23.0: listener ports and excluded domains as sets.
    site.ports = sortedSet(site.ports);
    if (site.tls)
      site.tls.redirectExcludedDomains = sortedByteSet(site.tls.redirectExcludedDomains);
    site.errorPages?.pages.sort((a, b) => a.status - b.status);
    if (site.maintenance) {
      site.maintenance.allowedCidrs = sortedSet(site.maintenance.allowedCidrs);
      site.maintenance.allowedPathPrefixes = sortedByteSet(site.maintenance.allowedPathPrefixes);
    }
    site.bulkRedirects.sort(byBytes((redirect) => redirect.source));
    // Access control: sets, but UA rules and CORS methods keep their order.
    const access = site.accessControl;
    if (access) {
      access.blockListIds = sortedByteSet(access.blockListIds);
      access.allowListIds = sortedByteSet(access.allowListIds);
      const h = access.hotlink;
      if (h) {
        h.allowed = sortedByteSet(h.allowed);
        h.denied = sortedByteSet(h.denied);
        h.extensions = sortedByteSet(h.extensions);
        h.pathPrefixes = sortedByteSet(h.pathPrefixes);
        h.excludePathPrefixes = sortedByteSet(h.excludePathPrefixes);
      }
      const u = access.userAgents;
      if (u) {
        u.pathPrefixes = sortedByteSet(u.pathPrefixes);
        u.excludePathPrefixes = sortedByteSet(u.excludePathPrefixes);
      }
      const c = access.cors;
      if (c) {
        c.allowedOrigins = sortedByteSet(c.allowedOrigins);
        c.allowedHeaders = sortedByteSet(c.allowedHeaders);
        c.exposedHeaders = sortedByteSet(c.exposedHeaders);
        c.pathPrefixes = sortedByteSet(c.pathPrefixes);
      }
      const g = access.geo;
      if (g) {
        g.countries = sortedByteSet(g.countries);
        g.subdivisions = sortedByteSet(g.subdivisions);
        g.asns = sortedSet(g.asns);
        g.pathPrefixes = sortedByteSet(g.pathPrefixes);
        g.exceptPathPrefixes = sortedByteSet(g.exceptPathPrefixes);
      }
      if (access.websocket) access.websocket.origins = sortedByteSet(access.websocket.origins);
    }
    // Access authentication rules keep their order; their lists are sets.
    for (const rule of site.authRules) {
      rule.domains = sortedByteSet(rule.domains);
      rule.pathPrefixes = sortedByteSet(rule.pathPrefixes);
      rule.extensions = sortedByteSet(rule.extensions);
      rule.excludePathPrefixes = sortedByteSet(rule.excludePathPrefixes);
      if (rule.forward) {
        rule.forward.requestHeaders = sortedByteSet(rule.forward.requestHeaders);
        rule.forward.responseHeaders = sortedByteSet(rule.forward.responseHeaders);
      }
    }
    for (const rule of site.rules) canonicalizeAction(rule.action);
    site.domains.sort(byString(domainKey));
    site.originPool?.origins.sort(byString((o) => o.id));
    site.cacheRules.sort((a, b) =>
      a.priority !== b.priority ? a.priority - b.priority : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
  }
  return out;
}

/**
 * Lowercase hex SHA-256 of the deterministic binary encoding of the config
 * with `revision` and `content_hash` cleared. Must be given a canonical config.
 */
export function contentHash(config: NodeConfig): string {
  const bare = clone(NodeConfigSchema, config);
  bare.revision = 0n;
  bare.contentHash = "";
  return createHash("sha256").update(toBinary(NodeConfigSchema, bare)).digest("hex");
}

/**
 * The listeners of compiled sites: 80 and the cluster's extra HTTP ports;
 * 443 while a site with a certificate is served there and the extra HTTPS
 * ports. An HTTPS port takes HTTP/2 and HTTP/3 when a site with a
 * certificate served there enables them; every listener takes the PROXY
 * protocol in the proxy_protocol mode. Without extra ports and sites
 * bound to other ports this is 80 plus 443 once a site has a certificate,
 * as before edge-ports-v1.
 */
export function listenersFor(
  sites: Pick<Site, "certificateId" | "tls" | "ports">[],
  edge?: EdgeModel,
): ListenerModel[] {
  const tlsSites = sites.filter((s) => s.certificateId);
  const on = (site: Pick<Site, "ports">, port: number) =>
    site.ports.length === 0 || site.ports.includes(port);
  const proxyProtocol = edge?.clientIp?.mode === "proxy_protocol";
  const https = sortedSet([
    ...(tlsSites.some((s) => on(s, DEFAULT_HTTPS_PORT)) ? [DEFAULT_HTTPS_PORT] : []),
    ...(edge?.httpsPorts ?? []),
  ]);
  const extra = (listener: ListenerModel) =>
    proxyProtocol ? { ...listener, proxyProtocol } : listener;
  return [
    ...sortedSet([DEFAULT_HTTP_PORT, ...(edge?.httpPorts ?? [])]).map((port) =>
      extra({ port, protocol: "http" as const }),
    ),
    ...https.map((port) => {
      const served = tlsSites.filter((s) => on(s, port));
      return extra({
        port,
        protocol: "https" as const,
        http2: served.some((s) => s.tls?.http2),
        http3: served.some((s) => s.tls?.http3),
      });
    }),
  ].sort((a, b) => a.port - b.port);
}

/** NodeConfig.client_address: unset for direct without dropping X-Forwarded-For. */
export function compileClientAddress(
  model: ClientIpModel | null | undefined,
): ClientAddress | undefined {
  if (!model || (model.mode === "direct" && !model.dropForwardedFor)) return undefined;
  return create(ClientAddressSchema, {
    mode: model.mode,
    trustedCidrs: model.mode === "header" ? sortedSet(model.trustedCidrs) : [],
    header: model.mode === "header" ? model.header : "",
    dropForwardedFor: model.mode === "direct" && model.dropForwardedFor,
  });
}

/**
 * NodeConfig.unknown_hosts: unset for the defaults (the platform's page for
 * both cases, scan protection off). A default site that is not among the
 * compiled sites hands nothing over (page), and its certificate is only
 * offered when it has one.
 */
export function compileUnknownHosts(
  model: UnknownHostsModel | null | undefined,
  sites: Pick<Site, "id" | "certificateId">[],
): UnknownHosts | undefined {
  if (!model) return undefined;
  const site = model.defaultSiteId ? sites.find((s) => s.id === model.defaultSiteId) : undefined;
  const resolve = (action: UnknownHostsModel["unknownHost"]) =>
    action === "site" && !site ? "page" : action;
  const unknownHost = resolve(model.unknownHost);
  const ipAccess = resolve(model.ipAccess);
  const scan = model.scanThreshold > 0;
  if (unknownHost === "page" && ipAccess === "page" && !scan) return undefined;
  const handsOver = unknownHost === "site" || ipAccess === "site";
  return create(UnknownHostsSchema, {
    unknownHost,
    ipAccess,
    defaultSiteId: handsOver && site ? site.id : "",
    defaultCertificate: model.defaultCertificate && unknownHost === "site" && !!site?.certificateId,
    scanThreshold: scan ? model.scanThreshold : 0,
    scanBanSeconds: scan ? model.scanBanSeconds : 0,
  });
}

/**
 * The listener ports, client address setting and unknown host handling a
 * compiled configuration was made with (refreshDerived keeps them when no
 * current ones are given).
 */
export function edgeOf(config: NodeConfig): EdgeModel {
  const extra = (protocol: ListenerProtocol, standard: number) =>
    config.listeners
      .filter((l) => l.protocol === protocol && l.port !== standard)
      .map((l) => l.port)
      .filter((port) => port !== DEFAULT_HTTP_PORT && port !== DEFAULT_HTTPS_PORT);
  const ca = config.clientAddress;
  const uh = config.unknownHosts;
  return {
    httpPorts: extra(ListenerProtocol.HTTP, DEFAULT_HTTP_PORT),
    httpsPorts: extra(ListenerProtocol.HTTPS, DEFAULT_HTTPS_PORT),
    clientIp: ca
      ? {
          mode: ca.mode as ClientIpModel["mode"],
          trustedCidrs: [...ca.trustedCidrs],
          header: ca.header,
          dropForwardedFor: ca.dropForwardedFor,
        }
      : null,
    // Only configurations with unknown host handling carry it.
    ...(uh
      ? {
          unknownHosts: {
            unknownHost: uh.unknownHost as UnknownHostsModel["unknownHost"],
            ipAccess: uh.ipAccess as UnknownHostsModel["ipAccess"],
            defaultSiteId: uh.defaultSiteId || null,
            defaultCertificate: uh.defaultCertificate,
            scanThreshold: uh.scanThreshold,
            scanBanSeconds: uh.scanBanSeconds,
          },
        }
      : {}),
  };
}

/** Features of the domain forms and unknown host handling a compiled configuration uses. */
export function domainFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((site) =>
      site.domains.some((d) => d.match !== DomainMatch.UNSPECIFIED),
    ) || config.offlineHosts.some((host) => host.match !== DomainMatch.UNSPECIFIED)
      ? [DOMAINS_V2_FEATURE]
      : []),
    ...(config.unknownHosts ? [UNKNOWN_HOST_FEATURE] : []),
  ];
}

/** Features of the listener ports and client address setting a compiled configuration uses. */
export function edgeFeatures(config: NodeConfig): string[] {
  const rules = [...config.platformRules, ...config.sites.flatMap((site) => site.rules)];
  return [
    ...(config.listeners.some(
      (l) => l.port !== DEFAULT_HTTP_PORT && l.port !== DEFAULT_HTTPS_PORT,
    ) ||
    config.sites.some(
      (site) =>
        site.ports.length > 0 ||
        !!site.tls?.redirectStatus ||
        !!site.tls?.redirectPort ||
        (site.tls?.redirectExcludedDomains.length ?? 0) > 0,
    )
      ? [EDGE_PORTS_FEATURE]
      : []),
    ...(config.clientAddress ||
    config.listeners.some((l) => l.proxyProtocol) ||
    configExpressions(config).some(needsClientIp) ||
    rules.some((rule) => rule.action?.key === "ip.peer")
      ? [CLIENT_IP_FEATURE]
      : []),
    ...(config.l4Apps.some(
      (app) => app.portEnd > 0 || !!app.certificateId || app.origins.some((o) => o.port === 0),
    )
      ? [L4_V2_FEATURE]
      : []),
  ];
}

const compileListener = (l: ListenerModel): Listener =>
  create(ListenerSchema, {
    port: l.port,
    protocol: l.protocol === "https" ? ListenerProtocol.HTTPS : ListenerProtocol.HTTP,
    http2: l.http2 ?? false,
    http3: l.http3 ?? false,
    proxyProtocol: l.proxyProtocol ?? false,
  });

/** requiredFeatures of a compiled configuration, derived from its content. */
export function derivedFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((s) => s.logSampleRate) ? ["access-logs-v1"] : []),
    ...(config.sites.some((s) => s.tls) ? ["tls-v1"] : []),
    ...(config.httpChallenges.length ? ["http01-v1"] : []),
    ...(config.sites.some((s) => s.domains.some((d) => d.tlsPending))
      ? [TLS_PENDING_DOMAINS_FEATURE]
      : []),
    ...(config.sites.some((s) => s.tls?.http3) ? ["http3-v1"] : []),
    ...(config.sites.some((s) => s.rules.length) ||
    config.platformRules.length ||
    config.ipLists.some((l) => l.platform && l.kind !== "collection")
      ? ["rules-v1"]
      : []),
    ...configExpressions(config).flatMap(geoFeatures),
    ...rulesFeatures(config),
    ...protectionFeatures(config),
    ...moduleFeatures(config),
    ...poolAndPageFeatures(config),
    ...contentFeatures(config),
    // Without applications the configuration encodes exactly as before.
    ...(config.l4Apps.length ? [L4_FEATURE] : []),
    ...edgeFeatures(config),
    ...domainFeatures(config),
    ...certificateFeatures(config),
    ...(config.sites.some((site) => site.authRules.length) ? [ACCESS_AUTH_FEATURE] : []),
    ...accessControlFeatures(config),
    ...g14Features(config),
  ];
}

/** Whether a compiled action uses the waf-v2 actions or fields. */
function actionNeedsWafV2(action: RuleAction | undefined): boolean {
  if (!action) return false;
  return (
    ["ban", "respond", "close", "skip"].includes(action.kind) ||
    action.accessLog ||
    action.banSeconds > 0 ||
    action.crs !== ""
  );
}

/**
 * Features of G14 (proto v0.29.0): waf-v2 (the ban, respond, close and skip
 * actions, access log lines from log rules, rate limit bans, the CRS
 * override and exclusions by path or target), rules-body-v1 (request body
 * fields and functions, the rules' body limit) and challenge-v2 (verified
 * crawlers, their fields, challenge page texts and failure bans).
 */
export function g14Features(config: NodeConfig): string[] {
  const rules = [...config.platformRules, ...config.sites.flatMap((site) => site.rules)];
  const expressions = configExpressions(config).map(expressionOf);
  return [
    ...(rules.some((rule) => actionNeedsWafV2(rule.action)) ||
    config.sites.some((site) => (site.waf?.exclusions.length ?? 0) > 0)
      ? [WAF_V2_FEATURE]
      : []),
    ...(expressions.some(needsRulesBody) || config.sites.some((site) => site.rulesBodyLimit > 0)
      ? [RULES_BODY_FEATURE]
      : []),
    ...(expressions.some(needsBotFields) ||
    config.sites.some(
      (site) =>
        site.protection?.allowVerifiedBots ||
        site.protection?.challengeText ||
        (site.protection?.failureThreshold ?? 0) > 0,
    )
      ? [CHALLENGE_V2_FEATURE]
      : []),
  ];
}

/**
 * Features of sites' access control: access-control-v1, and the GeoIP data
 * geo access reads (countries and subdivisions: geoip-city-v1; ASNs:
 * geoip-asn-v1; subdivisions are checked by the console, see nodeRequirements).
 */
export function accessControlFeatures(config: NodeConfig): string[] {
  const sites = config.sites.filter((site) => site.accessControl);
  const geo = sites.map((site) => site.accessControl?.geo).filter((g) => g !== undefined);
  return [
    ...(sites.length ? [ACCESS_CONTROL_FEATURE] : []),
    ...(geo.some((g) => g.countries.length || g.subdivisions.length) ? ["geoip-city-v1"] : []),
    ...(geo.some((g) => g.asns.length) ? ["geoip-asn-v1"] : []),
  ];
}

/** Features of sites with several certificates or client certificates (proto v0.26.0). */
export function certificateFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((site) => site.additionalCertificateIds.length)
      ? [MULTI_CERTIFICATE_FEATURE]
      : []),
    ...(config.sites.some((site) => site.clientCertificate) ||
    configExpressions(config).some(needsClientCertificate)
      ? [CLIENT_CERT_FEATURE]
      : []),
  ];
}

/**
 * Whether the configuration carries the cluster's session ticket keys: a
 * served site has a certificate. Others keep their content hash.
 */
export const usesSessionTickets = (sites: readonly Site[]) =>
  sites.some((site) => site.certificateId !== "");

/**
 * Recomputes what a compiled configuration derives from its sites after
 * they were changed in place (a rollback, or changes that skip the
 * configuration canary): the listeners (of `edge`, else the ports and
 * client address setting the configuration has), the certificate references
 * the sites and layer-4 applications still use and requiredFeatures.
 * Canonical, with a new content hash.
 */
export function refreshDerived(config: NodeConfig, edge?: EdgeModel): NodeConfig {
  const out = clone(NodeConfigSchema, config);
  const current = edge ?? edgeOf(config);
  out.listeners = listenersFor(out.sites, current).map(compileListener);
  out.clientAddress = compileClientAddress(current.clientIp);
  out.unknownHosts = compileUnknownHosts(current.unknownHosts, out.sites);
  const used = new Set(
    [
      ...out.sites.flatMap((s) => [s.certificateId, ...s.additionalCertificateIds]),
      ...out.l4Apps.map((a) => a.certificateId),
    ].filter(Boolean),
  );
  out.certificates = out.certificates.filter((c) => used.has(c.id));
  if (!usesSessionTickets(out.sites)) out.sessionTicketKeys = [];
  out.requiredFeatures = derivedFeatures(out);
  const canonical = canonicalize(out);
  canonical.contentHash = contentHash(canonical);
  return canonical;
}

/** Compiles console models into a canonical, hashed NodeConfig for `revision`. */
export function compileNodeConfig(input: CompileInput, revision: bigint): NodeConfig {
  if (input.sites.filter((site) => site.enabled).length > MAX_SITES_PER_CLUSTER)
    throw new ConfigCapacityError();
  const challenges = usesChallenges(input);
  const platformRules = compileRules(input.platformRules);
  const platformReadsBody = rulesReadBody(platformRules);
  // Disabled sites are not shipped to nodes; their domains are offline hosts.
  const sites = input.sites
    .filter((s) => s.enabled)
    .map((s) => compileSite(s, challenges, input.edge, platformReadsBody));
  const listeners = (input.listeners ?? listenersFor(sites, input.edge)).map(compileListener);
  const cacheZones = (input.cacheZones ?? defaultCacheZones).map((z) =>
    create(CacheZoneSchema, {
      name: z.name,
      maxSizeMb: BigInt(z.maxSizeMb),
      keysZoneMb: z.keysZoneMb,
      inactiveSeconds: z.inactiveSeconds,
      nodeSizes: [...(z.nodeSizes ?? [])].sort(byString((n) => n.nodeId)).map((n) =>
        create(CacheZoneNodeSizeSchema, {
          nodeId: n.nodeId,
          maxSizeMb: BigInt(n.maxSizeMb),
          keysZoneMb: n.keysZoneMb,
        }),
      ),
    }),
  );
  const compiled = create(NodeConfigSchema, {
    revision,
    clusterId: input.clusterId,
    listeners,
    cacheZones,
    sites,
    certificates: input.certificates ?? [],
    httpChallenges: input.httpChallenges ?? [],
    ipLists: (input.ipLists ?? []).map((list) =>
      create(IpListSchema, { ...list, entries: sortedSet(list.entries) }),
    ),
    platformRules,
    originAllowedCidrs: [...(input.originAllowedCidrs ?? [])],
    platformProtection: challenges
      ? create(PlatformProtectionSchema, {
          underAttack: input.platformProtection?.underAttack ?? false,
          underAttackChallenge: input.platformProtection?.underAttackChallenge ?? "js",
        })
      : undefined,
    challengeKeys: usesChallengeKeys(input)
      ? (input.challengeKeys ?? []).map((key) => create(ChallengeKeyRefSchema, key))
      : [],
    sessionTicketKeys: usesSessionTickets(sites)
      ? (input.sessionTicketKeys ?? []).map((key) => create(SessionTicketKeyRefSchema, key))
      : [],
    platformErrorPages: compilePlatformErrorPages(input.platformErrorPages),
    offlineHosts: compileOfflineHosts(input.offlineHosts),
    l4Apps: compileL4Apps(input.l4Apps),
    clientAddress: compileClientAddress(input.edge?.clientIp),
    unknownHosts: compileUnknownHosts(input.edge?.unknownHosts, sites),
  });
  compiled.requiredFeatures = derivedFeatures(compiled);
  const config = canonicalize(compiled);
  config.contentHash = contentHash(config);
  return config;
}

export function encodeNodeConfig(config: NodeConfig): Uint8Array {
  return toBinary(NodeConfigSchema, config);
}

export function decodeNodeConfig(bytes: Uint8Array): NodeConfig {
  return fromBinary(NodeConfigSchema, bytes);
}

/** A site's compiled form as text: two configurations run the same site when it is equal. */
export const siteBytes = (site: Site) => Buffer.from(toBinary(SiteSchema, site)).toString("base64");

/**
 * Computes the diff that turns `base` into `target`: sites are upserted or
 * removed by id, everything else (listeners, cache zones, certificates, the
 * origin allow list, platform error pages, offline hosts, layer-4
 * applications) is sent in full.
 */
export function diffNodeConfig(base: NodeConfig, target: NodeConfig): NodeConfigDiff {
  const baseSites = new Map(base.sites.map((s) => [s.id, siteBytes(s)]));
  const targetIds = new Set(target.sites.map((s) => s.id));
  return create(NodeConfigDiffSchema, {
    baseRevision: base.revision,
    revision: target.revision,
    contentHash: target.contentHash,
    clusterId: target.clusterId,
    listeners: target.listeners,
    cacheZones: target.cacheZones,
    certificates: target.certificates,
    originAllowedCidrs: target.originAllowedCidrs,
    requiredFeatures: target.requiredFeatures,
    httpChallenges: target.httpChallenges,
    ipLists: target.ipLists,
    platformRules: target.platformRules,
    platformProtection: target.platformProtection,
    challengeKeys: target.challengeKeys,
    platformErrorPages: target.platformErrorPages,
    offlineHosts: target.offlineHosts,
    l4Apps: target.l4Apps,
    clientAddress: target.clientAddress,
    unknownHosts: target.unknownHosts,
    sessionTicketKeys: target.sessionTicketKeys,
    upsertedSites: target.sites.filter((s) => baseSites.get(s.id) !== siteBytes(s)),
    removedSiteIds: base.sites
      .filter((s) => !targetIds.has(s.id))
      .map((s) => s.id)
      .sort(),
  });
}

/** Applies a diff to `base` (the reference implementation agents mirror). */
export function applyNodeConfigDiff(base: NodeConfig, diff: NodeConfigDiff): NodeConfig {
  if (base.revision !== diff.baseRevision) {
    throw new Error(`diff base ${diff.baseRevision} does not match config ${base.revision}`);
  }
  const removed = new Set(diff.removedSiteIds);
  const upserted = new Map(diff.upsertedSites.map((s) => [s.id, s]));
  const sites = base.sites
    .filter((s) => !removed.has(s.id) && !upserted.has(s.id))
    .concat(diff.upsertedSites);
  const next = canonicalize(
    create(NodeConfigSchema, {
      revision: diff.revision,
      clusterId: diff.clusterId,
      listeners: diff.listeners,
      cacheZones: diff.cacheZones,
      certificates: diff.certificates,
      originAllowedCidrs: diff.originAllowedCidrs,
      requiredFeatures: diff.requiredFeatures,
      httpChallenges: diff.httpChallenges,
      ipLists: diff.ipLists,
      platformRules: diff.platformRules,
      platformProtection: diff.platformProtection,
      challengeKeys: diff.challengeKeys,
      platformErrorPages: diff.platformErrorPages,
      offlineHosts: diff.offlineHosts,
      l4Apps: diff.l4Apps,
      clientAddress: diff.clientAddress,
      unknownHosts: diff.unknownHosts,
      sessionTicketKeys: diff.sessionTicketKeys,
      sites,
    }),
  );
  next.contentHash = contentHash(next);
  if (next.contentHash !== diff.contentHash) {
    throw new Error(`content hash mismatch after applying diff to ${base.revision}`);
  }
  return next;
}
