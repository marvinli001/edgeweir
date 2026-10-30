import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import {
  CacheZoneNodeSizeSchema,
  CacheZoneSchema,
  type CertificateRef,
  ChallengeKeyRefSchema,
  DomainMatch,
  IpListSchema,
  type NodeConfig,
  type NodeConfigDiff,
  NodeConfigDiffSchema,
  NodeConfigSchema,
  type OfflineHost,
  OfflineHostSchema,
  OriginCaSchema,
  type PlatformErrorPages,
  PlatformErrorPagesSchema,
  PlatformProtectionSchema,
  SessionTicketKeyRefSchema,
  type Site,
  SiteSchema,
} from "@edgeweir/proto";
import { canonicalize, contentHash, matchMap, offlineHostKey } from "./canonical";
import {
  compileClientAddress,
  compileConnectionLimits,
  compileListener,
  compileUnknownHosts,
  listenersFor,
} from "./edge";
import {
  clientCertificateIds,
  derivedFeatures,
  usesChallengeKeys,
  usesChallenges,
  usesOriginCa,
  usesSessionTickets,
} from "./features";
import { compileL4Apps } from "./l4";
import {
  type CacheZoneModel,
  type CompileInput,
  ConfigCapacityError,
  DEFAULT_CACHE_ZONE,
  MAX_SITES_PER_CLUSTER,
  type OfflineHostModel,
  OriginAuthorityMissingError,
  type PlatformErrorPagesModel,
} from "./models";
import { compileRules } from "./rules";
import { compileSite, rulesReadBody } from "./site";
import { byString, sortedSet } from "./sort";
import { compileTieredCache } from "./tiers";

const defaultCacheZones: CacheZoneModel[] = [
  {
    name: DEFAULT_CACHE_ZONE,
    maxSizeMb: 10 * 1024,
    keysZoneMb: 64,
    inactiveSeconds: 7 * 24 * 3600,
  },
];

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

function compileOriginClientCertificates(sites: Site[], input: CompileInput): CertificateRef[] {
  const ids = clientCertificateIds(sites);
  const refs = (input.originClientCertificates ?? []).filter((c) => ids.has(c.id));
  for (const id of ids) {
    if (!refs.some((c) => c.id === id))
      throw new OriginAuthorityMissingError(`client certificate ${id}`);
  }
  return refs;
}

function compileOriginCa(sites: Site[], input: CompileInput) {
  if (!usesOriginCa(sites)) return undefined;
  // Never fall back to the node's trust store: that would accept public certificates.
  if (!input.originCa) throw new OriginAuthorityMissingError("Origin CA");
  return create(OriginCaSchema, input.originCa);
}

function compileOriginCaPrevious(sites: Site[], input: CompileInput) {
  if (!usesOriginCa(sites) || !input.originCaPrevious) return undefined;
  return create(OriginCaSchema, input.originCaPrevious);
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
  const tieredCache = compileTieredCache(input.tieredCache, sites);
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
    originClientCertificates: compileOriginClientCertificates(sites, input),
    originCa: compileOriginCa(sites, input),
    originCaPrevious: compileOriginCaPrevious(sites, input),
    platformErrorPages: compilePlatformErrorPages(input.platformErrorPages),
    offlineHosts: compileOfflineHosts(input.offlineHosts),
    l4Apps: compileL4Apps(input.l4Apps),
    clientAddress: compileClientAddress(input.edge?.clientIp),
    unknownHosts: compileUnknownHosts(input.edge?.unknownHosts, sites),
    tieredCache,
  });
  compiled.connectionLimits = compileConnectionLimits(
    input.edge?.connectionLimits,
    compiled.listeners,
    compiled.l4Apps,
  );
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
 * applications, origin client certificates and the Origin CAs) is sent in full.
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
    originClientCertificates: target.originClientCertificates,
    originCa: target.originCa,
    connectionLimits: target.connectionLimits,
    originCaPrevious: target.originCaPrevious,
    tieredCache: target.tieredCache,
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
      originClientCertificates: diff.originClientCertificates,
      originCa: diff.originCa,
      connectionLimits: diff.connectionLimits,
      originCaPrevious: diff.originCaPrevious,
      tieredCache: diff.tieredCache,
      sites,
    }),
  );
  next.contentHash = contentHash(next);
  if (next.contentHash !== diff.contentHash) {
    throw new Error(`content hash mismatch after applying diff to ${base.revision}`);
  }
  return next;
}
