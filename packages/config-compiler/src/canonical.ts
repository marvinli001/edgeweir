import { createHash } from "node:crypto";
import { clone, toBinary } from "@bufbuild/protobuf";
import {
  type CacheZone,
  type CertificateRef,
  type ChallengeKeyRef,
  DomainMatch,
  type IpList,
  type L4App,
  type NodeConfig,
  NodeConfigSchema,
  type RuleAction,
  type SessionTicketKeyRef,
  type Site,
} from "@edgeweir/proto";
import { byBytes, byString, sortedByteSet, sortedSet } from "./sort";

/** Domains and offline hosts sort by (name, wildcard, match): the exact host first. */
const domainKey = (d: { name: string; wildcard: boolean; match: DomainMatch }) =>
  `${d.name}\u0000${d.wildcard ? 1 : 0}\u0000${d.match}`;
export const offlineHostKey = domainKey;
export const matchMap = { suffix: DomainMatch.SUFFIX, regex: DomainMatch.REGEX } as const;

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
  out.originClientCertificates.sort(byString((c: CertificateRef) => c.id));
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
    // v0.30.0: the recorded request headers as a set.
    site.logHeaders = sortedByteSet(site.logHeaders);
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
    site.authIdentityHeaders = sortedByteSet(site.authIdentityHeaders);
    site.encodedPathExemptions.sort(byBytes((e) => e.prefix));
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
