import { createHash } from "node:crypto";
import { clone, create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  CacheAction,
  CacheKeyPolicySchema,
  CacheKeyQuery,
  type CacheRule,
  CacheRuleSchema,
  type CacheZone,
  CacheZoneSchema,
  type CertificateRef,
  DomainSchema,
  type EdgeRule,
  EdgeRuleSchema,
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
  OriginCacheControl,
  OriginConnectionSchema,
  OriginPoolSchema,
  OriginSchema,
  OriginScheme,
  PassiveHealthCheckSchema,
  S3AuthSchema,
  type Site,
  SiteSchema,
  type TlsOptions,
} from "@edgeweir/proto";
import { type Expression, phases } from "@edgeweir/rule-engine";

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
}

export interface CacheRuleModel {
  id: string;
  priority: number;
  pathPrefixes: string[];
  paths?: string[];
  extensions: string[];
  statusCodes?: number[];
  minSizeBytes?: number;
  maxSizeBytes?: number;
  expression: string;
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

export interface SiteModel {
  id: string;
  name: string;
  enabled: boolean;
  cacheGeneration: number;
  domains: { name: string; wildcard: boolean }[];
  originPool: {
    id: string;
    policy: "weighted_random" | "round_robin" | "consistent_hash";
    origins: OriginModel[];
    /** Omitted: node defaults (verify TLS, 3 failures / 30 s, default timeouts, keep-alive). */
    settings?: OriginPoolSettingsModel;
  };
  cacheRules: CacheRuleModel[];
  /** Omitted: the default cache key. */
  cacheKey?: CacheKeyModel;
  rangeSlice?: boolean;
  /** Defaults to true. */
  websocket?: boolean;
  certificateId?: string;
  tls?: Omit<TlsOptions, "$typeName" | "$unknown">;
  rules?: RuleModel[];
}

export interface RuleModel {
  id: string;
  phase: string;
  expression: Expression;
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
  };
}
export interface IpListModel {
  id: string;
  name: string;
  entries: string[];
  kind: string;
  platform: boolean;
}
export function compileRules(rules: RuleModel[] = []): EdgeRule[] {
  return [...rules]
    .sort(
      (a, b) =>
        phases.indexOf(a.phase as (typeof phases)[number]) -
        phases.indexOf(b.phase as (typeof phases)[number]),
    )
    .map((rule) => create(EdgeRuleSchema, rule));
}
export function geoFeatures(expression: Expression): string[] {
  return [
    ...(expression.field === "ip.geoip.asnum"
      ? ["geoip-asn-v1"]
      : expression.field.startsWith("ip.geoip.")
        ? ["geoip-city-v1"]
        : []),
    ...expression.children.flatMap(geoFeatures),
  ];
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

function compileSite(model: SiteModel): Site {
  const settings = model.originPool.settings;
  const key = model.cacheKey;
  return create(SiteSchema, {
    id: model.id,
    name: model.name,
    enabled: model.enabled,
    cacheZone: DEFAULT_CACHE_ZONE,
    cacheGeneration: BigInt(model.cacheGeneration),
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
    }),
    cacheRules: model.cacheRules.map(
      (r): CacheRule =>
        create(CacheRuleSchema, {
          id: r.id,
          priority: r.priority,
          match: {
            pathPrefixes: [...r.pathPrefixes],
            extensions: r.extensions.map((e) => e.toLowerCase()),
            expression: r.expression,
            paths: sortedSet(r.paths),
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
    tls: model.tls,
    rules: compileRules(model.rules),
  });
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
  for (const list of out.ipLists) list.entries = sortedSet(list.entries);
  for (const site of out.sites) {
    if (site.tls) site.tls.gzipTypes = sortedSet(site.tls.gzipTypes);
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

/** Compiles console models into a canonical, hashed NodeConfig for `revision`. */
export function compileNodeConfig(input: CompileInput, revision: bigint): NodeConfig {
  const tlsSites = input.sites.filter((s) => s.enabled && s.certificateId);
  const defaults: ListenerModel[] = tlsSites.length
    ? [
        ...defaultListeners,
        {
          port: 443,
          protocol: "https",
          http2: tlsSites.some((s) => s.tls?.http2),
          http3: tlsSites.some((s) => s.tls?.http3),
        },
      ]
    : defaultListeners;
  const listeners = (input.listeners ?? defaults).map(
    (l): Listener =>
      create(ListenerSchema, {
        port: l.port,
        protocol: l.protocol === "https" ? ListenerProtocol.HTTPS : ListenerProtocol.HTTP,
        http2: l.http2 ?? false,
        http3: l.http3 ?? false,
        proxyProtocol: l.proxyProtocol ?? false,
      }),
  );
  const cacheZones = (input.cacheZones ?? defaultCacheZones).map((z) =>
    create(CacheZoneSchema, {
      name: z.name,
      maxSizeMb: BigInt(z.maxSizeMb),
      keysZoneMb: z.keysZoneMb,
      inactiveSeconds: z.inactiveSeconds,
    }),
  );
  // Disabled sites are not shipped to nodes; unknown hosts get a 404 there.
  const sites = input.sites.filter((s) => s.enabled).map(compileSite);
  const config = canonicalize(
    create(NodeConfigSchema, {
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
      requiredFeatures: [
        ...(input.sites.some((s) => s.enabled && s.tls) ? ["tls-v1"] : []),
        ...(input.httpChallenges?.length ? ["http01-v1"] : []),
        ...(input.sites.some((s) => s.enabled && s.tls?.http3) ? ["http3-v1"] : []),
        ...(input.sites.some((s) => s.enabled && s.rules?.length) ||
        input.platformRules?.length ||
        input.ipLists?.some((l) => l.platform && l.kind !== "collection")
          ? ["rules-v1"]
          : []),
        ...[
          ...(input.platformRules ?? []),
          ...input.sites.filter((s) => s.enabled).flatMap((s) => s.rules ?? []),
        ].flatMap((r) => geoFeatures(r.expression)),
      ],
      originAllowedCidrs: [...(input.originAllowedCidrs ?? [])],
    }),
  );
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
 * origin allow list) is sent in full.
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
      sites,
    }),
  );
  next.contentHash = contentHash(next);
  if (next.contentHash !== diff.contentHash) {
    throw new Error(`content hash mismatch after applying diff to ${base.revision}`);
  }
  return next;
}
