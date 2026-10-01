import { createHash } from "node:crypto";
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  ActiveHealthCheckSchema,
  BulkRedirectSchema,
  CacheAction,
  CacheKeyPolicySchema,
  CacheKeyQuery,
  type CacheRule,
  CacheRuleSchema,
  type CacheZone,
  CacheZoneSchema,
  CcPolicySchema,
  type CertificateRef,
  type ChallengeKeyRef,
  ChallengeKeyRefSchema,
  DomainSchema,
  type EdgeRule,
  EdgeRuleSchema,
  ErrorPageSchema,
  type HttpChallenge,
  type IpList,
  IpListSchema,
  type Listener,
  ListenerProtocol,
  ListenerSchema,
  LoadBalancePolicy,
  type NodeConfig,
  type NodeConfigDiff,
  NodeConfigDiffSchema,
  NodeConfigSchema,
  type OfflineHost,
  OfflineHostSchema,
  OriginCacheControl,
  OriginConnectionSchema,
  OriginPoolSchema,
  OriginSchema,
  OriginScheme,
  PassiveHealthCheckSchema,
  type PlatformErrorPages,
  PlatformErrorPagesSchema,
  PlatformProtectionSchema,
  QueryParamSchema,
  type RuleAction,
  RuleActionSchema,
  type RuleExpression,
  S3AuthSchema,
  SessionAffinitySchema,
  type Site,
  SiteErrorPagesSchema,
  SiteProtectionSchema,
  SiteSchema,
  SiteWafSchema,
  type TlsOptions,
  TlsOptionsSchema,
} from "@edgeweir/proto";
import {
  type Expression,
  needsRulesV2,
  type Phase,
  parseExpression,
  parseValueExpression,
  phases,
  structuredCacheCondition,
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
}

export interface OriginPoolSettingsModel {
  tlsVerify: boolean;
  maxFails: number;
  recoverySeconds: number;
  connectTimeoutMs: number;
  sendTimeoutMs: number;
  readTimeoutMs: number;
  keepalive: boolean;
  keepaliveIdleSeconds: number;
  keepaliveMaxRequests: number;
}

export interface CacheKeyModel {
  query: "all" | "ignore" | "include";
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
 * Feature of the rule engine extensions (proto v0.13.0): functions and the
 * new fields, dynamic redirects and rewrites with query edits, origin,
 * compression and extended config actions, the compression phase, cache
 * rule conditions and browser TTLs, bulk redirects and origin groups.
 */
export const RULES_V2_FEATURE = "rules-v2";

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
  /** Any order; compiled sorted by status. Without pages nothing is compiled. */
  pages: { status: number; template: string }[];
  interceptOriginErrors: boolean;
}

/** The platform's pages; an empty template means the node's built-in page. */
export interface PlatformErrorPagesModel {
  unknownHost: string;
  siteDisabled: string;
  siteSuspended: string;
}

/** A domain of a disabled or suspended site (config.proto OfflineHost). */
export interface OfflineHostModel {
  name: string;
  wildcard: boolean;
  reason: "disabled" | "suspended";
}

type TlsFields = Omit<TlsOptions, "$typeName" | "$unknown">;
type CompressionField =
  | "brotli"
  | "brotliLevel"
  | "brotliMinLength"
  | "brotliTypes"
  | "zstd"
  | "zstdLevel"
  | "zstdMinLength"
  | "zstdTypes";
/** A site's TLS options; Brotli and Zstandard default to off. */
export type TlsModel = Omit<TlsFields, CompressionField> &
  Partial<Pick<TlsFields, CompressionField>>;

/** OWASP CRS of a site that runs it (config.proto SiteWaf). */
export interface SiteWafModel {
  mode: "detect" | "block";
  paranoiaLevel: number;
  anomalyThreshold: number;
  /** Any order; compiled ascending without duplicates. */
  excludedRuleIds: number[];
  requestBodyLimit: number;
}

export interface SiteModel {
  id: string;
  name: string;
  enabled: boolean;
  cacheGeneration: number;
  logSampleRate?: number;
  domains: { name: string; wildcard: boolean }[];
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
}

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
    setQuery?: { name: string; value: string }[];
    removeQuery?: string[];
    // rules-v2: origin
    originGroup?: string;
    hostHeader?: string;
    sni?: string;
    port?: number;
    // rules-v2: compression codings in preference order (RuleAction.compression)
    algorithms?: string[];
  };
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
    target:
      redirectOrRewrite && a.target ? parseValueExpression(a.target, phase as Phase) : undefined,
    preserveQuery:
      redirectOrRewrite && a.preserveQuery !== undefined && a.preserveQuery !== queryDefault(a.kind)
        ? a.preserveQuery
        : undefined,
    setQuery: [...(a.setQuery ?? [])]
      .sort(byString((param) => param.name))
      .map((param) => create(QueryParamSchema, { name: param.name, value: param.value })),
    removeQuery: sortedSet(a.removeQuery),
    originGroup: a.originGroup ?? "",
    hostHeader: a.hostHeader ?? "",
    sni: a.sni ?? "",
    port: a.port ?? 0,
    compression: a.kind === "compression" ? [...(a.algorithms ?? [])] : [],
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
      create(EdgeRuleSchema, {
        id: rule.id,
        phase: rule.phase,
        expression: rule.expression,
        action: compileAction(rule.phase, rule.action),
      }),
    );
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
    ...rules.flatMap((rule) => [rule.expression, rule.action?.target]),
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
  return uses ? [RULES_V2_FEATURE] : [];
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
    ...(field === "ip.geoip.asnum"
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
  return configExpressions(config).some(readsSubdivision)
    ? [...config.requiredFeatures, "geoip-subdivision-v1"]
    : [...config.requiredFeatures];
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
  /** Omitted, or every template empty: the nodes' built-in pages. */
  platformErrorPages?: PlatformErrorPagesModel;
  /** Domains of the cluster's disabled and suspended sites; any order. */
  offlineHosts?: OfflineHostModel[];
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
  return create(SiteProtectionSchema, {
    underAttack: model.underAttack,
    underAttackChallenge: model.underAttackChallenge,
    passTtlSeconds: model.passTtlSeconds,
    powDifficulty: model.powDifficulty,
    powHighDifficulty: model.powHighDifficulty,
    cc: model.cc ? create(CcPolicySchema, { enabled: true, ...model.cc }) : undefined,
    logJa4: model.logJa4,
  });
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
 * Features of the active health checks, session affinity and error pages
 * that the sites of a compiled configuration use: active-health-v1,
 * session-affinity-v1 and error-pages-v1.
 */
export function poolAndPageFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((site) => site.originPool?.activeHealthCheck)
      ? [ACTIVE_HEALTH_FEATURE]
      : []),
    ...(config.sites.some((site) => site.originPool?.sessionAffinity)
      ? [SESSION_AFFINITY_FEATURE]
      : []),
    ...(config.sites.some((site) => site.errorPages) ? [ERROR_PAGES_FEATURE] : []),
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

/**
 * TLS options of a site. Brotli and Zstandard carry their level, minimum
 * length and types only while on, so sites without them keep the encoding
 * (and content hash) they had before these fields existed.
 */
function compileTls(model: TlsModel) {
  const {
    brotli,
    brotliLevel,
    brotliMinLength,
    brotliTypes,
    zstd,
    zstdLevel,
    zstdMinLength,
    zstdTypes,
    ...rest
  } = model;
  return create(TlsOptionsSchema, {
    ...rest,
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

function compileSite(model: SiteModel, challenges: boolean): Site {
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
    domains: model.domains.map((d) => create(DomainSchema, { name: d.name, wildcard: d.wildcard })),
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
        }),
    ),
    cacheKey: key
      ? create(CacheKeyPolicySchema, {
          query: queryMap[key.query],
          queryParams: key.query === "include" ? sortedSet(key.queryParams) : [],
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
    tls: model.tls ? compileTls(model.tls) : undefined,
    rules: compileRules(model.rules),
    waf: model.waf
      ? create(SiteWafSchema, {
          mode: model.waf.mode,
          paranoiaLevel: model.waf.paranoiaLevel,
          anomalyThreshold: model.waf.anomalyThreshold,
          excludedRuleIds: sortedSet(model.waf.excludedRuleIds),
          requestBodyLimit: model.waf.requestBodyLimit,
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
            create(ErrorPageSchema, { status: page.status, template: page.template }),
          ),
          interceptOriginErrors: model.errorPages.interceptOriginErrors,
        })
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

/** Offline hosts sort like domains: by name, the exact host before the wildcard. */
const offlineHostKey = (host: OfflineHost) => `${host.name}\u0000${host.wildcard ? 1 : 0}`;

/**
 * NodeConfig.platform_error_pages: unset when every template is empty (the
 * nodes' built-in pages). Platform state: a rollback ships the current pages.
 */
export function compilePlatformErrorPages(
  pages: PlatformErrorPagesModel | undefined,
): PlatformErrorPages | undefined {
  return pages && (pages.unknownHost || pages.siteDisabled || pages.siteSuspended)
    ? create(PlatformErrorPagesSchema, {
        unknownHost: pages.unknownHost,
        siteDisabled: pages.siteDisabled,
        siteSuspended: pages.siteSuspended,
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
      create(OfflineHostSchema, { name: host.name, wildcard: host.wildcard, reason: host.reason }),
    )
    .sort(byString(offlineHostKey));
}

/** set_query by name, remove_query sorted without duplicates (v0.13.0). */
function canonicalizeAction(action: RuleAction | undefined) {
  if (!action) return;
  action.setQuery.sort(byString((param) => param.name));
  action.removeQuery = sortedSet(action.removeQuery);
}

/** Sorts every repeated field into the canonical order defined in config.proto. */
export function canonicalize<T extends NodeConfig>(config: T): T {
  const out = clone(NodeConfigSchema, config) as T;
  out.listeners.sort((a, b) => a.port - b.port);
  out.cacheZones.sort(byString((z: CacheZone) => z.name));
  out.certificates.sort(byString((c: CertificateRef) => c.id));
  out.sites.sort(byString((s: Site) => s.id));
  // A set: ascending (byte order, ASCII) without duplicates, as the Go agent sorts it.
  out.originAllowedCidrs = sortedSet(out.originAllowedCidrs);
  out.requiredFeatures = sortedSet(out.requiredFeatures);
  out.httpChallenges.sort(byString((c) => `${c.domain}/${c.token}`));
  out.ipLists.sort(byString((list: IpList) => list.id));
  out.challengeKeys.sort(byString((key: ChallengeKeyRef) => key.id));
  out.offlineHosts.sort(byString(offlineHostKey));
  for (const list of out.ipLists) list.entries = sortedSet(list.entries);
  for (const rule of out.platformRules) canonicalizeAction(rule.action);
  for (const site of out.sites) {
    if (site.tls) {
      site.tls.gzipTypes = sortedSet(site.tls.gzipTypes);
      site.tls.brotliTypes = sortedSet(site.tls.brotliTypes);
      site.tls.zstdTypes = sortedSet(site.tls.zstdTypes);
    }
    if (site.waf) site.waf.excludedRuleIds = sortedSet(site.waf.excludedRuleIds);
    site.errorPages?.pages.sort((a, b) => a.status - b.status);
    site.bulkRedirects.sort(byBytes((redirect) => redirect.source));
    for (const rule of site.rules) canonicalizeAction(rule.action);
    site.domains.sort(byString((d) => `${d.name}\u0000${d.wildcard ? 1 : 0}`));
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

/** Port 80, plus 443 when a site has a certificate (HTTP/2 and HTTP/3 if one of them enables it). */
function listenersFor(
  sites: { certificateId?: string; tls?: { http2?: boolean; http3?: boolean } }[],
) {
  const tlsSites = sites.filter((s) => s.certificateId);
  return tlsSites.length
    ? [
        ...defaultListeners,
        {
          port: 443,
          protocol: "https" as const,
          http2: tlsSites.some((s) => s.tls?.http2),
          http3: tlsSites.some((s) => s.tls?.http3),
        },
      ]
    : defaultListeners;
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
  ];
}

/**
 * Recomputes what a compiled configuration derives from its sites after
 * they were changed in place (a rollback, or changes that skip the
 * configuration canary): the default listeners, the certificate references
 * the sites still use and requiredFeatures. Canonical, with a new content hash.
 */
export function refreshDerived(config: NodeConfig): NodeConfig {
  const out = clone(NodeConfigSchema, config);
  out.listeners = listenersFor(out.sites).map(compileListener);
  const used = new Set(out.sites.map((s) => s.certificateId).filter(Boolean));
  out.certificates = out.certificates.filter((c) => used.has(c.id));
  out.requiredFeatures = derivedFeatures(out);
  const canonical = canonicalize(out);
  canonical.contentHash = contentHash(canonical);
  return canonical;
}

/** Compiles console models into a canonical, hashed NodeConfig for `revision`. */
export function compileNodeConfig(input: CompileInput, revision: bigint): NodeConfig {
  if (input.sites.filter((site) => site.enabled).length > MAX_SITES_PER_CLUSTER)
    throw new ConfigCapacityError();
  const listeners = (input.listeners ?? listenersFor(input.sites.filter((s) => s.enabled))).map(
    compileListener,
  );
  const cacheZones = (input.cacheZones ?? defaultCacheZones).map((z) =>
    create(CacheZoneSchema, {
      name: z.name,
      maxSizeMb: BigInt(z.maxSizeMb),
      keysZoneMb: z.keysZoneMb,
      inactiveSeconds: z.inactiveSeconds,
    }),
  );
  const challenges = usesChallenges(input);
  // Disabled sites are not shipped to nodes; their domains are offline hosts.
  const sites = input.sites.filter((s) => s.enabled).map((s) => compileSite(s, challenges));
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
    platformRules: compileRules(input.platformRules),
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
    platformErrorPages: compilePlatformErrorPages(input.platformErrorPages),
    offlineHosts: compileOfflineHosts(input.offlineHosts),
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

const siteBytes = (site: Site) => Buffer.from(toBinary(SiteSchema, site)).toString("base64");

/**
 * Computes the diff that turns `base` into `target`: sites are upserted or
 * removed by id, everything else (listeners, cache zones, certificates, the
 * origin allow list, platform error pages, offline hosts) is sent in full.
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
      sites,
    }),
  );
  next.contentHash = contentHash(next);
  if (next.contentHash !== diff.contentHash) {
    throw new Error(`content hash mismatch after applying diff to ${base.revision}`);
  }
  return next;
}
