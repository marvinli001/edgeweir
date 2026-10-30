import type { AuthKind as AuthRuleKind } from "@edgeweir/contract";
import type { CertificateRef, EdgeRule, HttpChallenge, TlsOptions } from "@edgeweir/proto";
import type { Expression } from "@edgeweir/rule-engine";

/** Matches the node's fixed 256 KiB site partitions (128 MiB at full capacity). */
export const MAX_SITES_PER_CLUSTER = 512;
export class ConfigCapacityError extends Error {
  constructor() {
    super(`A cluster supports at most ${MAX_SITES_PER_CLUSTER} published sites`);
    this.name = "ConfigCapacityError";
  }
}

/** Console-side model of an origin, independent of the database layer. */
interface OriginModel {
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
  /** PROXY protocol version sent to the origin; omitted or 0: none (origin-proxy-protocol-v1 otherwise). */
  proxyProtocolVersion?: number;
}

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
  /** Trust anchors when tlsVerify: omitted or system, the node's trust store (origin-ca-v1 otherwise). */
  tlsTrust?: "system" | "originCa";
  /**
   * Id of the cluster's origin client certificate (CompileInput.originClientCertificates)
   * the nodes present to HTTPS origins; omitted: none (origin-mtls-v1 otherwise).
   */
  clientCertificateId?: string;
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

interface CacheKeyModel {
  /** exclude: every parameter but queryParams ("prefix*" patterns allowed); site-content-v1. */
  query: "all" | "ignore" | "include" | "exclude";
  queryParams: string[];
  sortQuery: boolean;
  headers: string[];
  cookies: string[];
  deviceType: boolean;
  includeHost: boolean;
}

/** Compiling a site that uses an origin authority the input does not carry. */
export class OriginAuthorityMissingError extends Error {
  constructor(what: string) {
    super(`origin protection: ${what} is missing`);
    this.name = "OriginAuthorityMissingError";
  }
}
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
  /** Omitted or http: the HTTP request above; grpc: grpc.health.v1 (active-health-grpc-v1). */
  type?: "http" | "grpc";
  /** grpc: the service asked about; omitted or "": the server's overall health. */
  grpcService?: string;
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
interface MaintenanceModel {
  template: string;
  retryAfterSeconds: number;
  /** CIDRs in canonical form; any order, compiled sorted without duplicates. */
  allowedCidrs: string[];
  allowedPathPrefixes: string[];
}

/** A site's charset setting while on (config.proto Charset). */
interface CharsetModel {
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
type DomainMatchModel = "suffix" | "regex";
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

/**
 * A site's WebP / AVIF conversion (config.proto ImageConvert), only while it
 * is on: a site without it compiles as before. The quality of a format the
 * site does not offer is not sent.
 */
export interface ImageConvertModel {
  webp: boolean;
  avif: boolean;
  webpQuality: number;
  avifQuality: number;
  jpeg: boolean;
  png: boolean;
  minSize: number;
  maxSize: number;
  maxPixels: number;
}

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
interface ClientCertificateModel {
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
   * Access log options (feature access-logs-v2): blocked, challenged and
   * authentication-refused requests always logged; the query string, the
   * named request headers (lowercase, at most 8) and the connection's peer
   * on lines. Off and empty compile as before.
   */
  logBlocked?: boolean;
  logQuery?: boolean;
  logHeaders?: readonly string[];
  logPeer?: boolean;
  /** WebP / AVIF conversion (feature image-convert-v1); absent while off. */
  imageConvert?: ImageConvertModel;
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
  /**
   * Identity headers nodes remove from every request of the site: those of
   * all its rules, disabled ones included, and of former ones (proto v1.1.0;
   * no feature: older nodes remove those of the enabled rules). Omitted: none.
   */
  authIdentityHeaders?: string[];
  /** Access control (access-control-v1); omitted or null: none. */
  accessControl?: AccessControlModel | null;
  /**
   * Raw path prefixes that may carry "%2F" and / or ";" as they are
   * (Site.encoded_path_exemptions; no feature: older nodes keep such paths
   * ambiguous). Omitted: none.
   */
  encodedPathExemptions?: readonly EncodedPathExemptionModel[];
  /**
   * Largest request body the rules read (rules-body-v1); compiled only when the site's or
   * the platform's rules read the body. Omitted: RULES_BODY_LIMIT.default.
   */
  rulesBodyLimit?: number;
}

/** One of a site's encoded path exemptions (rule-engine encoded-path). */
interface EncodedPathExemptionModel {
  prefix: string;
  encodedSlash: boolean;
  semicolon: boolean;
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
  /** Omitted or null: no connection limits. */
  connectionLimits?: ConnectionLimitsModel | null;
}

/**
 * Per-client TCP connection limits (config.proto ConnectionLimits): perIp
 * and newPerSecond 0 when off (not both), burst 0 is newPerSecond; ports
 * null: the listener and TCP layer-4 application ports.
 */
export interface ConnectionLimitsModel {
  perIp: number;
  newPerSecond: number;
  burst: number;
  ports: { start: number; end: number }[] | null;
}

/** One entry of a site's bulk redirect table (config.proto BulkRedirect). */
interface BulkRedirectModel {
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
  // challenge-v3; omitted compiles as before.
  /** Third-party widget of the interactive challenge; omitted or null: the built-in image. */
  interactive?: ChallengeProviderModelInput | null;
}

/** A site's interactive provider (SiteProtection.interactive); the secret is an origin credential. */
export interface ChallengeProviderModelInput {
  kind: string;
  siteKey: string;
  credentialId: string;
  credentialVersion: number;
  /** recaptcha_v3 / recaptcha_enterprise, hundredths. */
  minScore: number;
  projectId: string;
  region: string;
  prefix: string;
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
interface IpListModel {
  id: string;
  name: string;
  entries: string[];
  kind: string;
  platform: boolean;
}
/** An origin of a layer-4 application (config.proto L4Origin). */
interface L4OriginModel {
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
  /**
   * The cluster's origin client certificates; compiled are those a served
   * site presents (OriginPoolSettingsModel.clientCertificateId), sorted by id.
   */
  originClientCertificates?: CertificateRef[];
  /** The Origin CA and its CRL; compiled only when a served site trusts it. */
  originCa?: { certificatePem: string; crlPem: string };
  /**
   * The previous Origin CA and its CRL while the Origin CA is rotated:
   * compiled along with originCa, which pools trusting it then trust too.
   */
  originCaPrevious?: { certificatePem: string; crlPem: string };
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
  /**
   * The cluster has active greylist entries that challenge (platform ones
   * or of its sites): the configuration carries challenge keys.
   */
  greylistChallenges?: boolean;
}

export const DEFAULT_CACHE_ZONE = "default";
