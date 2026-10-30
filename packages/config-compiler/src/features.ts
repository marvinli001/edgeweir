import { clone } from "@bufbuild/protobuf";
import {
  CACHE_ZONE_FEATURE,
  CLIENT_IP_FEATURE,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  DOMAINS_V2_FEATURE,
  EDGE_PORTS_FEATURE,
  ERROR_PAGES_V1_STATUSES,
  L4_FEATURE,
  L4_V2_FEATURE,
  UNKNOWN_HOST_FEATURE,
} from "@edgeweir/contract";
import {
  ActiveHealthCheckType,
  CacheKeyQuery,
  DomainMatch,
  type EdgeRule,
  type NodeConfig,
  NodeConfigSchema,
  OriginProtocol,
  OriginTlsTrust,
  type RuleAction,
  type RuleExpression,
  type Site,
} from "@edgeweir/proto";
import {
  challengeActionKinds,
  type Expression,
  needsBotFields,
  needsClientCertificate,
  needsClientIp,
  needsRulesBody,
  needsRulesV2,
  needsRulesV3,
  usesRulesV3Placeholders,
} from "@edgeweir/rule-engine";
import { canonicalize, contentHash } from "./canonical";
import {
  compileClientAddress,
  compileConnectionLimits,
  compileListener,
  compileUnknownHosts,
  edgeOf,
  listenersFor,
} from "./edge";
import type { CompileInput, EdgeModel, RuleModel } from "./models";
import { configExpressions, expressionOf } from "./rules";

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
 * Features of origin protection (proto v1.3.0): client certificates presented
 * to origins (OriginPool.client_certificate_id) and the Origin CA as the
 * only trust anchor (OriginPool.tls_trust, NodeConfig.origin_ca).
 */
export const ORIGIN_MTLS_FEATURE = "origin-mtls-v1";
export const ORIGIN_CA_FEATURE = "origin-ca-v1";
/**
 * Features of proto v1.6.0: PROXY protocol towards origins
 * (Origin.proxy_protocol_version) and grpc.health.v1 active health checks
 * (ActiveHealthCheck.type GRPC).
 */
export const ORIGIN_PROXY_PROTOCOL_FEATURE = "origin-proxy-protocol-v1";
export const ACTIVE_HEALTH_GRPC_FEATURE = "active-health-grpc-v1";
/**
 * Feature of trusting the previous Origin CA along with the current one
 * while the console rotates it (proto v1.6.0, NodeConfig.origin_ca_previous).
 */
export const ORIGIN_CA_ROTATION_FEATURE = "origin-ca-rotation-v1";

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
/** Feature of sites with more than one certificate (proto v0.26.0, Site.additional_certificate_ids). */
export const MULTI_CERTIFICATE_FEATURE = "multi-certificate-v1";
/**
 * Feature of client certificates (mutual TLS) and the tls.client.* fields
 * (proto v0.26.0, Site.client_certificate).
 */
export const CLIENT_CERT_FEATURE = "client-cert-v1";
/** Feature of access authentication rules (proto v0.27.0, Site.auth_rules; ADR-0038). */
export const ACCESS_AUTH_FEATURE = "access-auth-v1";

/** Feature of a site's access control (proto v0.28.0, Site.access_control; ADR-0039). */
export const ACCESS_CONTROL_FEATURE = "access-control-v1";
/** G14 (proto v0.29.0, ADR-0040). */
export const WAF_V2_FEATURE = "waf-v2";
export const RULES_BODY_FEATURE = "rules-body-v1";
export const CHALLENGE_V2_FEATURE = "challenge-v2";
/** The managed challenge and third-party interactive providers (proto PROTO_NEXT, SiteProtection.interactive). */
export const CHALLENGE_V3_FEATURE = "challenge-v3";
/** A site's access log options (proto v0.30.0, Site.log_blocked..log_peer; ADR-0041). */
export const ACCESS_LOGS_V2_FEATURE = "access-logs-v2";
/** A site's WebP / AVIF conversion (proto v0.31.0, Site.image_convert; ADR-0043). */
export const IMAGE_CONVERT_FEATURE = "image-convert-v1";

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
        rule.action.kind in challengeActionKinds ||
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
 * challenges, greylist entries challenge (they travel outside revisions),
 * or a served site's pool has session affinity (the keys sign its cookies). Keys bring challenge-v1 with them (protectionFeatures).
 */
export function usesChallengeKeys(input: CompileInput): boolean {
  return (
    usesChallenges(input) ||
    !!input.greylistChallenges ||
    input.sites.some((site) => site.enabled && !!site.originPool.sessionAffinity)
  );
}

/**
 * Features that the protection of a compiled configuration needs:
 * challenge-v1 when it carries site or platform protection, challenge keys,
 * a challenge rule or a rule that turns Under Attack on; challenge-v3 when a
 * challenge is managed or a site has an interactive provider; ja4-v1 when an
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
    ...(config.platformProtection?.underAttackChallenge === "managed" ||
    config.sites.some(
      (site) =>
        site.protection?.underAttackChallenge === "managed" || !!site.protection?.interactive,
    ) ||
    rules.some((rule) => rule.action?.kind === "challenge" && rule.action.challenge === "managed")
      ? [CHALLENGE_V3_FEATURE]
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
 * Features of the active health checks, session affinity, HTTP/2 and PROXY
 * protocol towards the origins, origin protection and error pages that the
 * sites of a compiled configuration use: active-health-v1,
 * active-health-grpc-v1, session-affinity-v1, origin-http2-v1,
 * origin-proxy-protocol-v1, origin-mtls-v1, origin-ca-v1,
 * origin-ca-rotation-v1 and error-pages-v1.
 */
export function poolAndPageFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((site) => site.originPool?.activeHealthCheck)
      ? [ACTIVE_HEALTH_FEATURE]
      : []),
    ...(config.sites.some(
      (site) => site.originPool?.activeHealthCheck?.type === ActiveHealthCheckType.GRPC,
    )
      ? [ACTIVE_HEALTH_GRPC_FEATURE]
      : []),
    ...(config.sites.some((site) =>
      site.originPool?.origins.some((origin) => origin.proxyProtocolVersion !== 0),
    )
      ? [ORIGIN_PROXY_PROTOCOL_FEATURE]
      : []),
    ...(config.sites.some((site) => site.originPool?.sessionAffinity)
      ? [SESSION_AFFINITY_FEATURE]
      : []),
    ...(config.sites.some((site) => site.originPool?.protocol === OriginProtocol.HTTP2)
      ? [ORIGIN_HTTP2_FEATURE]
      : []),
    ...(config.sites.some((site) => site.originPool?.clientCertificateId)
      ? [ORIGIN_MTLS_FEATURE]
      : []),
    ...(usesOriginCa(config.sites) ? [ORIGIN_CA_FEATURE] : []),
    ...(config.originCaPrevious ? [ORIGIN_CA_ROTATION_FEATURE] : []),
    ...(config.sites.some((site) => site.errorPages) ? [ERROR_PAGES_FEATURE] : []),
  ];
}

/** Whether a compiled site uses a setting of site-content-v1. */
function usesSiteContent(site: Site): boolean {
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
        !(ERROR_PAGES_V1_STATUSES as readonly number[]).includes(page.status) ||
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
function contentFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some(usesSiteContent) ||
    config.platformRules.some((rule) => rule.action?.requestBodyLimit !== undefined)
      ? [SITE_CONTENT_FEATURE]
      : []),
    ...(config.cacheZones.some((zone) => zone.nodeSizes.length) ? [CACHE_ZONE_FEATURE] : []),
  ];
}

/** Features of the domain forms and unknown host handling a compiled configuration uses. */
function domainFeatures(config: NodeConfig): string[] {
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
function edgeFeatures(config: NodeConfig): string[] {
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

/** requiredFeatures of a compiled configuration, derived from its content. */
export function derivedFeatures(config: NodeConfig): string[] {
  return [
    ...(config.sites.some((s) => s.logSampleRate) ? ["access-logs-v1"] : []),
    ...(config.sites.some((s) => s.logBlocked || s.logQuery || s.logHeaders.length || s.logPeer)
      ? [ACCESS_LOGS_V2_FEATURE]
      : []),
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
    ...(config.sites.some((site) => site.imageConvert) ? [IMAGE_CONVERT_FEATURE] : []),
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
function accessControlFeatures(config: NodeConfig): string[] {
  const sites = config.sites.filter((site) => site.accessControl);
  const geo = sites.map((site) => site.accessControl?.geo).filter((g) => g !== undefined);
  return [
    ...(sites.length ? [ACCESS_CONTROL_FEATURE] : []),
    ...(geo.some((g) => g.countries.length || g.subdivisions.length) ? ["geoip-city-v1"] : []),
    ...(geo.some((g) => g.asns.length) ? ["geoip-asn-v1"] : []),
  ];
}

/** Features of sites with several certificates or client certificates (proto v0.26.0). */
function certificateFeatures(config: NodeConfig): string[] {
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
 * client address setting the configuration has; the connection limits'
 * ports with `edge`), the certificate references
 * the sites and layer-4 applications still use and requiredFeatures.
 * Canonical, with a new content hash.
 */
export function refreshDerived(config: NodeConfig, edge?: EdgeModel): NodeConfig {
  const out = clone(NodeConfigSchema, config);
  const current = edge ?? edgeOf(config);
  out.listeners = listenersFor(out.sites, current).map(compileListener);
  out.clientAddress = compileClientAddress(current.clientIp);
  out.unknownHosts = compileUnknownHosts(current.unknownHosts, out.sites);
  // The cluster's ports may have changed; without `edge` the limits stay as compiled.
  if (edge)
    out.connectionLimits = compileConnectionLimits(
      edge.connectionLimits,
      out.listeners,
      out.l4Apps,
    );
  const used = new Set(
    [
      ...out.sites.flatMap((s) => [s.certificateId, ...s.additionalCertificateIds]),
      ...out.l4Apps.map((a) => a.certificateId),
    ].filter(Boolean),
  );
  out.certificates = out.certificates.filter((c) => used.has(c.id));
  if (!usesSessionTickets(out.sites)) out.sessionTicketKeys = [];
  const presented = clientCertificateIds(out.sites);
  out.originClientCertificates = out.originClientCertificates.filter((c) => presented.has(c.id));
  if (!usesOriginCa(out.sites)) {
    out.originCa = undefined;
    out.originCaPrevious = undefined;
  }
  out.requiredFeatures = derivedFeatures(out);
  const canonical = canonicalize(out);
  canonical.contentHash = contentHash(canonical);
  return canonical;
}

/** Whether a site of the configuration verifies its origins against the Origin CA alone. */
export const usesOriginCa = (sites: readonly Site[]) =>
  sites.some((site) => site.originPool?.tlsTrust === OriginTlsTrust.ORIGIN_CA);

/** Ids of the origin client certificates the sites present. */
export const clientCertificateIds = (sites: readonly Site[]) =>
  new Set(sites.map((site) => site.originPool?.clientCertificateId ?? "").filter(Boolean));
