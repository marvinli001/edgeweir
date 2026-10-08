import { clone, create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  compileOfflineHosts,
  compilePlatformErrorPages,
  compileRules,
  compileSitePorts,
  DEFAULT_SITE_PROTECTION,
  decodeNodeConfig,
  refreshDerived,
  usesSessionTickets,
} from "@edgeweir/config-compiler";
import { certificateUnloadable, tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  ChallengeKeyRefSchema,
  type DomainMatch,
  HttpChallengeSchema,
  IpListSchema,
  type NodeConfig,
  NodeConfigSchema,
  PlatformProtectionSchema,
  type RuleExpression,
  SessionTicketKeyRefSchema,
  SiteProtectionSchema,
} from "@edgeweir/proto";
import { listReferences } from "@edgeweir/rule-engine";
import { eq, inArray } from "drizzle-orm";
import { failUncovered, uncoveredByAll } from "../lib/certificate-names";
import { fail } from "../lib/errors";
import { lockClusterPublish } from "../lib/locks";
import { formatDomain, namesHosts, protoKind } from "../lib/site-domains";
import type { Actor } from "./audit";
import { ensureChallengeKeys } from "./challenge-keys";
import {
  loadHttpChallenges,
  loadOfflineHosts,
  loadOriginAllowList,
  platformRuleModels,
  previousConfig,
} from "./config-input";
import { loadEdgeModel } from "./edge";
import { loadPlatformErrorPages } from "./error-pages";
import { restoreL4Apps } from "./l4-config";
import { loadPlatformProtection, loadSiteProtectionModels } from "./protection";
import {
  getRevision,
  insertRevision,
  loadRollout,
  prebuilt,
  publisher,
  type Tx,
  updateRollout,
} from "./revisions";
import { ensureSessionTicketKeys } from "./session-ticket-keys";

/** Domain identity: name and form. */
const rowKey = (domain: { name: string; kind: string }) => `${domain.name}\u0000${domain.kind}`;
/** The identity of a compiled Domain or OfflineHost. */
const hostKey = (host: { name: string; wildcard: boolean; match: DomainMatch }) =>
  rowKey({ name: host.name, kind: protoKind(host) });

/**
 * The sites of an earlier configuration as they may be published now.
 * Sites that are disabled now are dropped; cache
 * generations are the current ones (a purge is never undone), certificate
 * references carry the current certificate (one renewed in place exists in
 * its current version only) and the log sampling rate never exceeds the
 * current one. A site or domain removed since: `strict` (the operator's
 * rollback) refuses with ROLLBACK_RESOURCE_UNAVAILABLE, as it does for an
 * expired, unavailable or unloadable certificate; otherwise (the canary's stable
 * revision) it is dropped. Offline hosts follow the current sites; layer-4
 * applications follow the same rules (restoreL4Apps).
 * Derived fields are left to refreshDerived.
 */
async function restoreSites(
  tx: Tx,
  clusterId: string,
  config: NodeConfig,
  opts: { strict: boolean },
) {
  const out = clone(NodeConfigSchema, config);
  const edge = await loadEdgeModel(tx, clusterId);
  const currentSites = await tx
    .select()
    .from(schema.site)
    .where(eq(schema.site.clusterId, clusterId));
  const currentDomains = currentSites.length
    ? await tx
        .select()
        .from(schema.siteDomain)
        .where(
          inArray(
            schema.siteDomain.siteId,
            currentSites.map((site) => site.id),
          ),
        )
    : [];
  const siteCertificates = (site: (typeof out.sites)[number]) =>
    site.certificateId ? [site.certificateId, ...site.additionalCertificateIds] : [];
  const certificateIds = [...new Set(out.sites.flatMap(siteCertificates))];
  const certificates = certificateIds.length
    ? await tx
        .select()
        .from(schema.certificate)
        .where(inArray(schema.certificate.id, certificateIds))
    : [];
  const sites: typeof out.sites = [];
  for (const site of out.sites) {
    const current = currentSites.find((s) => s.id === site.id);
    // Rollback is configuration history, never authorization to resurrect a
    // deleted site or a domain the site no longer has.
    if (!current && opts.strict)
      fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback references a removed site or domain");
    // Enabling is current policy: no site that is disabled now is shipped.
    if (!current?.enabled) continue;
    const live = (domain: { name: string; wildcard: boolean; match: DomainMatch }) =>
      currentDomains.some(
        (d) => d.siteId === site.id && d.name === domain.name && d.kind === protoKind(domain),
      );
    if (site.domains.some((domain) => !live(domain))) {
      if (opts.strict)
        fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback references a removed site or domain");
      site.domains = site.domains.filter(live);
      if (!site.domains.length) continue;
    }
    site.cacheGeneration = BigInt(current.cacheGeneration);
    // Sampling is current privacy policy; rollback must not revive disabled collection.
    site.logSampleRate = opts.strict
      ? current.logSampleRate
      : Math.min(site.logSampleRate, current.logSampleRate);
    const ids = siteCertificates(site);
    if (opts.strict && ids.length) {
      const chains: string[] = [];
      for (const id of ids) {
        const cert = certificates.find((c) => c.id === id);
        if (!cert?.notAfter || cert.notAfter.getTime() <= Date.now() || certificateUnloadable(cert))
          fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback certificate is unavailable or expired");
        if (!out.certificates.some((c) => c.id === id))
          fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback certificate reference is missing");
        chains.push(cert.chainPem);
      }
      // Every domain needs one of the site's certificates; domains served
      // over HTTP until a certificate covers them need none.
      const uncovered = uncoveredByAll(
        chains,
        site.domains
          .filter((domain) => !domain.tlsPending)
          .map((domain) => ({ name: domain.name, kind: protoKind(domain) })),
      );
      if (uncovered.length) failUncovered(uncovered);
    }
    for (const id of ids) {
      const cert = certificates.find((c) => c.id === id);
      const ref = out.certificates.find((c) => c.id === id);
      if (cert && ref) {
        ref.names = cert.names;
        ref.sha256Fingerprint = cert.fingerprint;
        ref.notAfter = cert.notAfter ? timestampFromDate(cert.notAfter) : undefined;
      }
    }
    // Listener ports are current infrastructure: the site's current ports
    // and its HTTPS redirect, which names one of them and its domains.
    site.ports = compileSitePorts(
      {
        ports: { http: current.httpPorts, https: current.httpsPorts },
        certificateId: site.certificateId,
      },
      edge,
    );
    if (site.tls) {
      const settings = tlsSettings.parse({
        ...current.tlsSettings,
        certificateId: current.certificateId,
      });
      const names = new Set(
        site.domains
          .map((d) => ({ name: d.name, kind: protoKind(d) }))
          .filter(namesHosts)
          .map(formatDomain),
      );
      const port = settings.redirectPort === 443 ? 0 : settings.redirectPort;
      site.tls.redirectStatus = settings.redirectStatus === 301 ? 0 : settings.redirectStatus;
      site.tls.redirectPort = site.certificateId && site.ports.includes(port) ? port : 0;
      site.tls.redirectExcludedDomains = settings.redirectExcludedDomains.filter((d) =>
        names.has(d),
      );
    }
    sites.push(site);
  }
  out.sites = sites;
  const offline = compileOfflineHosts(await loadOfflineHosts(tx, clusterId));
  if (opts.strict) out.offlineHosts = offline;
  else {
    // Hosts that were offline stay offline while their site is not served
    // here (a site enabled since waits for the canary); the current ones win.
    const served = new Set(sites.flatMap((s) => s.domains.map(hostKey)));
    const known = new Set(currentDomains.map(rowKey));
    const hosts = new Map(
      out.offlineHosts.filter((h) => known.has(hostKey(h))).map((h) => [hostKey(h), h]),
    );
    for (const host of offline) hosts.set(hostKey(host), host);
    out.offlineHosts = [...hosts.values()].filter((h) => !served.has(hostKey(h)));
  }
  out.l4Apps = await restoreL4Apps(tx, clusterId, out.l4Apps, opts);
  return { config: out, currentSites, edge };
}

/**
 * The canary's stable content with what never waits for a canary: the
 * current state of sites (restoreSites: sites taken offline and removed
 * domains are gone, renewed certificates apply), the current
 * ACME challenges (`challenges`, else loaded), challenge keys and Under
 * Attack of sites and the platform. Every publication refreshes the stable
 * revision with it and the automatic rollback publishes it.
 */
export async function currentStable(
  tx: Tx,
  clusterId: string,
  stable: NodeConfig,
  challenges?: NodeConfig["httpChallenges"],
) {
  const { config, currentSites, edge } = await restoreSites(tx, clusterId, stable, {
    strict: false,
  });
  config.httpChallenges = (challenges ?? (await loadHttpChallenges(tx, clusterId))).map((c) =>
    clone(HttpChallengeSchema, c),
  );
  await restoreProtection(tx, clusterId, config, currentSites, { underAttack: "current" });
  return refreshDerived(config, edge);
}

/**
 * Publishes the content of an older revision as a new revision. The origin
 * allow list, the platform's error pages and the offline hosts are platform
 * policy and current state, not cluster content: the new revision carries
 * the current ones, not those the old revision had.
 */
export async function rollbackToRevision(
  tx: Tx,
  opts: { clusterId: string; revision: number; actor: Actor },
): Promise<Awaited<ReturnType<typeof insertRevision>> | undefined> {
  await lockClusterPublish(tx, opts.clusterId);
  const content = await rollbackContent(tx, opts.clusterId, opts.revision);
  if (!content) return undefined;
  const result = await insertRevision(
    tx,
    opts.clusterId,
    prebuilt(content),
    { code: "rollback", params: { revision: opts.revision } },
    publisher(opts.actor),
  );
  // The operator's rollback restores known content: it goes to every node, no canary.
  const rollout = await loadRollout(tx, opts.clusterId);
  if (rollout?.enabled)
    await updateRollout(tx, opts.clusterId, {
      stableRevision: result.row.revision,
      candidateRevision: null,
      lastCandidateRevision: rollout.candidateRevision ?? rollout.lastCandidateRevision,
      state: "promoted",
      outcome: "manual_rollback",
      finishedAt: new Date(),
    });
  return result;
}

/**
 * The content (revision 0) a rollback to `revision` publishes, or undefined
 * when the revision does not exist; refuses with ROLLBACK_RESOURCE_UNAVAILABLE
 * like the rollback. It may write (challenge keys a restored site needs):
 * a preview runs it in a transaction it rolls back.
 */
export async function rollbackContent(
  tx: Tx,
  clusterId: string,
  revision: number,
): Promise<NodeConfig | undefined> {
  const target = await getRevision(tx, clusterId, revision);
  if (!target) return undefined;
  const {
    config: restored,
    currentSites,
    edge,
  } = await restoreSites(tx, clusterId, decodeNodeConfig(target.ir), { strict: true });
  const currentLists = await tx.select().from(schema.ipList);
  for (const site of restored.sites) {
    const unavailable = (expression: RuleExpression) =>
      listReferences(expression).some((id) => !currentLists.some((list) => list.id === id));
    for (const rule of site.rules)
      if (!rule.expression || unavailable(rule.expression))
        fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback IP list is unavailable");
    for (const rule of site.cacheRules)
      if (rule.match?.condition && unavailable(rule.match.condition))
        fail("ROLLBACK_RESOURCE_UNAVAILABLE", "rollback IP list is unavailable");
  }
  // Access lists and platform enforcement are current security policy.
  restored.ipLists = currentLists.map((list) =>
    create(IpListSchema, {
      id: list.id,
      name: list.name,
      kind: list.kind,
      entries: list.entries,
      platform: true,
    }),
  );
  restored.platformRules = compileRules(
    await platformRuleModels(tx, currentLists, previousConfig(tx, clusterId), []),
  );
  restored.platformErrorPages = compilePlatformErrorPages(await loadPlatformErrorPages(tx));
  restored.originAllowedCidrs = await loadOriginAllowList(tx);
  // Challenge tokens are short-lived issuance state, never rollback content.
  restored.httpChallenges = [];
  await restoreProtection(tx, clusterId, restored, currentSites, { underAttack: "restored" });
  return refreshDerived(restored, edge);
}

/**
 * Brings the protection of a restored configuration in line with current
 * policy: platform Under Attack and JA4 logging are current settings, and
 * challenge keys are always the cluster's current keys (older ones are gone),
 * carried whenever challenges or a restored site's session affinity use them.
 * Sites keep their restored CC policy and, after the operator's rollback
 * (`underAttack: "restored"`), their restored Under Attack; the canary's
 * stable revision takes the current one.
 */
async function restoreProtection(
  tx: Tx,
  clusterId: string,
  restored: NodeConfig,
  currentSites: { id: string }[],
  opts: { underAttack: "restored" | "current" },
) {
  const platform = await loadPlatformProtection(tx);
  const current = await loadSiteProtectionModels(
    tx,
    currentSites.map((site) => site.id),
  );
  if (opts.underAttack === "current")
    for (const site of restored.sites) {
      const now = current.get(site.id);
      if (!now || (!now.underAttack && !site.protection?.underAttack)) continue;
      site.protection ??= create(SiteProtectionSchema, {
        passTtlSeconds: now.passTtlSeconds,
        powDifficulty: now.powDifficulty,
        powHighDifficulty: now.powHighDifficulty,
      });
      site.protection.underAttack = now.underAttack;
      site.protection.underAttackChallenge = now.underAttackChallenge;
    }
  const rules = [...restored.platformRules, ...restored.sites.flatMap((site) => site.rules)];
  const challenges =
    platform.underAttack ||
    rules.some((rule) => rule.action?.kind === "challenge" || rule.action?.underAttack === true) ||
    restored.sites.some((site) => site.protection?.underAttack || site.protection?.cc?.enabled);
  const affinity = restored.sites.some((site) => site.originPool?.sessionAffinity);
  const keys = challenges || affinity ? await ensureChallengeKeys(tx, clusterId) : [];
  restored.challengeKeys = keys.map((key) => create(ChallengeKeyRefSchema, key));
  // The cluster's ticket keys now, not those of the revision rolled back to.
  const ticketKeys = usesSessionTickets(restored.sites)
    ? await ensureSessionTicketKeys(tx, clusterId)
    : [];
  restored.sessionTicketKeys = ticketKeys.map((key) => create(SessionTicketKeyRefSchema, key));
  restored.platformProtection = challenges ? create(PlatformProtectionSchema, platform) : undefined;
  for (const site of restored.sites) {
    const logJa4 = current.get(site.id)?.logJa4 ?? false;
    if (!challenges && !logJa4) {
      site.protection = undefined;
      continue;
    }
    // A site without protection in the restored revision had neither Under Attack nor CC.
    const defaults = current.get(site.id) ?? DEFAULT_SITE_PROTECTION;
    site.protection ??= create(SiteProtectionSchema, {
      underAttack: false,
      underAttackChallenge: defaults.underAttackChallenge,
      passTtlSeconds: defaults.passTtlSeconds,
      powDifficulty: defaults.powDifficulty,
      powHighDifficulty: defaults.powHighDifficulty,
    });
    site.protection.logJa4 = logJa4;
    if (!challenges) {
      site.protection.underAttack = false;
      site.protection.cc = undefined;
    }
  }
}
