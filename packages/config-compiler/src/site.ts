import { create } from "@bufbuild/protobuf";
import {
  type AuthKind as AuthRuleKind,
  CACHE_EXPRESSION_MAX_LENGTH,
  DEFAULT_HTTP_PORT,
  DEFAULT_HTTPS_PORT,
  DEFAULT_REQUEST_BODY_LIMIT,
} from "@edgeweir/contract";
import {
  AccessControlSchema,
  ActiveHealthCheckSchema,
  ActiveHealthCheckType,
  AuthKind,
  AuthRuleSchema,
  BasicAuthSchema,
  BulkRedirectSchema,
  CacheAction,
  CacheKeyPolicySchema,
  CacheKeyQuery,
  type CacheRule,
  CacheRuleSchema,
  CcPolicySchema,
  ChallengeTextSchema,
  CharsetSchema,
  ClientCertificateMode,
  ClientCertificateSchema,
  CorsSchema,
  DomainMatch,
  DomainSchema,
  type EdgeRule,
  EncodedPathExemptionSchema,
  ErrorPageSchema,
  ForwardAuthSchema,
  GeoAccessSchema,
  HotlinkSchema,
  ImageConvertSchema,
  InterstitialRuleSchema,
  LoadBalancePolicy,
  MaintenanceSchema,
  OriginCacheControl,
  OriginConnectionSchema,
  OriginPoolSchema,
  OriginProtocol,
  OriginSchema,
  OriginScheme,
  OriginTlsTrust,
  PassiveHealthCheckSchema,
  PurgeMethodSchema,
  type RuleExpression,
  S3AuthSchema,
  SecurityHeadersSchema,
  SessionAffinitySchema,
  SessionDetectionSchema,
  type Site,
  SiteErrorPagesSchema,
  SiteProtectionSchema,
  SiteSchema,
  SiteWafSchema,
  TlsOptionsSchema,
  UrlAuthSchema,
  UserAgentRuleSchema,
  UserAgentRulesSchema,
  WafExclusionSchema,
  WebSocketAccessSchema,
} from "@edgeweir/proto";
import {
  needsRulesBody,
  parseExpression,
  RULES_BODY_LIMIT,
  structuredCacheCondition,
} from "@edgeweir/rule-engine";
import { matchMap } from "./canonical";
import {
  type AccessControlModel,
  type AuthRuleModel,
  type CacheRuleModel,
  DEFAULT_CACHE_ZONE,
  DEFAULT_ORIGIN_TRIES,
  DEFAULT_SITE_PROTECTION,
  type EdgeModel,
  type ImageConvertModel,
  type SessionDetectionModel,
  type SiteModel,
  type SitePortsModel,
  type SiteProtectionModel,
  type TlsModel,
  type WafExclusionModel,
} from "./models";
import { compileRules, expressionOf } from "./rules";
import { byBytes, sortedByteSet, sortedSet } from "./sort";

const AUTH_KINDS: Record<AuthRuleKind, AuthKind> = {
  basic: AuthKind.BASIC,
  forward: AuthKind.FORWARD,
  url_a: AuthKind.URL_A,
  url_b: AuthKind.URL_B,
  url_c: AuthKind.URL_C,
  url_d: AuthKind.URL_D,
};

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

/** Splits "*.example.com" into its suffix and wildcard flag. */
export function parseDomain(value: string): { name: string; wildcard: boolean } {
  const lower = value.trim().toLowerCase();
  return lower.startsWith("*.")
    ? { name: lower.slice(2), wildcard: true }
    : { name: lower, wildcard: false };
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

export function compileSite(
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
    logBlocked: model.logBlocked ?? false,
    logQuery: model.logQuery ?? false,
    logHeaders: sortedByteSet(model.logHeaders ?? []),
    logPeer: model.logPeer ?? false,
    ...(model.imageConvert ? { imageConvert: compileImageConvert(model.imageConvert) } : {}),
    ...(model.sessionDetection
      ? { sessionDetection: compileSessionDetection(model.sessionDetection) }
      : {}),
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
          proxyProtocolVersion: o.proxyProtocolVersion ?? 0,
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
            // The node's trust store and no client certificate stay unset.
            ...(settings.tlsVerify && settings.tlsTrust === "originCa"
              ? { tlsTrust: OriginTlsTrust.ORIGIN_CA }
              : {}),
            ...(settings.clientCertificateId
              ? { clientCertificateId: settings.clientCertificateId }
              : {}),
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
            // HTTP checks stay unset: configurations encode as before.
            ...(health.type === "grpc"
              ? {
                  type: ActiveHealthCheckType.GRPC,
                  grpcService: health.grpcService ?? "",
                }
              : {}),
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
    authIdentityHeaders: sortedByteSet(
      (model.authIdentityHeaders ?? []).map((name) => name.toLowerCase()),
    ),
    accessControl: model.accessControl ? compileAccessControl(model.accessControl) : undefined,
    encodedPathExemptions: [...(model.encodedPathExemptions ?? [])]
      .sort(byBytes((e) => e.prefix))
      .map((e) =>
        create(EncodedPathExemptionSchema, {
          prefix: e.prefix,
          encodedSlash: e.encodedSlash,
          semicolon: e.semicolon,
        }),
      ),
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

function compileImageConvert(m: ImageConvertModel) {
  return create(ImageConvertSchema, {
    webp: m.webp,
    avif: m.avif,
    webpQuality: m.webp ? m.webpQuality : 0,
    avifQuality: m.avif ? m.avifQuality : 0,
    jpeg: m.jpeg,
    png: m.png,
    minSize: BigInt(m.minSize),
    maxSize: BigInt(m.maxSize),
    maxPixels: BigInt(m.maxPixels),
  });
}

function compileSessionDetection(m: SessionDetectionModel) {
  return create(SessionDetectionSchema, {
    mode: m.mode,
    interstitial: m.interstitial,
    interstitialRules: m.interstitialRules.map((r) =>
      create(InterstitialRuleSchema, {
        host: r.host,
        pathPrefix: r.pathPrefix,
        interstitial: r.interstitial,
      }),
    ),
  });
}
