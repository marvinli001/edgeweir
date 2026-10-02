import { dnsCatalogDto } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { count, desc, eq, gt, sql } from "drizzle-orm";
import { createAccessKey, listAccessKeys, revokeAccessKey } from "../services/access-keys";
import { configureLogs, logSettings, logsCsv, queryLogs } from "../services/access-logs";
import { serviceAccountMe, toMe } from "../services/account";
import {
  createAlertChannel,
  deleteAlertChannel,
  getAlertPolicy,
  getSmtpConfig,
  listAlertChannels,
  listAlertEvents,
  listAlertSubscriptions,
  setAlertPolicy,
  setSmtpConfig,
  subscribeAlerts,
  testAlertChannel,
  unsubscribeAlerts,
  updateAlertChannel,
} from "../services/alerts";
import {
  topNodes,
  topRequests,
  topSites,
  trafficBreakdown,
  trafficSeries,
} from "../services/analytics";
import { auditFacets, listAuditLogs } from "../services/audit";
import { createBan, deleteBan, getBanSettings, listBans, setBanSettings } from "../services/bans";
import { getBulkRedirects, saveBulkRedirects } from "../services/bulk-redirects";
import { createCacheTask, getCacheTask, listCacheTasks } from "../services/cache-tasks";
import {
  createDnsCredential,
  deleteCertificate,
  deleteDnsCredential,
  dnsCredentialZones,
  getHttps,
  listCertificates,
  listDnsCredentials,
  renewCertificate,
  requestCertificate,
  testDnsCredential,
  updateDnsCredential,
  updateHttps,
  uploadCertificate,
} from "../services/certificates";
import {
  createCluster,
  deleteCluster,
  getCluster,
  listClusters,
  rollbackCluster,
  updateCluster,
} from "../services/clusters";
import {
  createDnsProvider,
  deleteDnsProvider,
  exportBinding,
  forceBindingPublish,
  getBinding,
  getDnsProtection,
  listBindingRevisions,
  listBindings,
  listDnsProviders,
  listProviderZones,
  reconcileDns,
  rollbackBinding,
  saveBinding,
  setDnsProtection,
  siteDnsTarget,
  testProvider,
  updateDnsProvider,
} from "../services/dns";
import { failFromCertd } from "../services/dns-providers";
import { createEnrollmentToken, getEnrollmentToken } from "../services/enrollment";
import {
  getPlatformErrorPages,
  getSiteErrorPages,
  setPlatformErrorPages,
  updateSiteErrorPages,
} from "../services/error-pages";
import {
  createL4App,
  deleteL4App,
  getL4App,
  getPortPools,
  l4AppStats,
  listL4Apps,
  setL4AppEnabled,
  setPortPools,
  updateL4App,
} from "../services/l4";
import {
  createNodeGroup,
  deleteNodeGroup,
  listNodeGroups,
  updateNodeGroup,
} from "../services/node-groups";
import {
  deleteNode,
  getNode,
  listNodes,
  ONLINE_WINDOW_SECONDS,
  setNodeAddresses,
  setNodeProbe,
  setNodeStatus,
  updateNode,
} from "../services/nodes";
import { getOriginAllowList, setOriginAllowList } from "../services/origin-allow-list";
import { siteOriginHealth } from "../services/origin-health";
import {
  createProbeToken,
  deleteProbe,
  getProbeSettings,
  listProbeResults,
  listProbes,
  setProbeSettings,
  updateProbe,
} from "../services/probes";
import {
  getCcTemplate,
  getProtectionSettings,
  getSiteProtection,
  setCcTemplate,
  setProtectionSettings,
  updateSiteProtection,
} from "../services/protection";
import { createRegion, deleteRegion, listRegions, updateRegion } from "../services/regions";
import { getReleaseSource, setReleaseSource } from "../services/release-source";
import { toRevisionDto } from "../services/revisions";
import { abortRollout, getRollout, promoteRollout, setRolloutPolicy } from "../services/rollout";
import {
  createIpList,
  deleteIpList,
  getRules,
  listIpLists,
  saveRules,
  updateIpList,
  validateExpression,
} from "../services/rules";
import {
  createSchedulingRule,
  deleteSchedulingRule,
  listSchedulingRules,
  previewScheduling,
  updateSchedulingRule,
} from "../services/scheduling";
import { listSecurityEvents, siteSecurityState } from "../services/security";
import {
  createServiceAccount,
  createServiceAccountKey,
  deleteServiceAccount,
  listServiceAccounts,
  revokeServiceAccountKey,
  updateServiceAccount,
} from "../services/service-accounts";
import { isInitialized, runSetup, setupCompletedAt } from "../services/setup";
import {
  countSites,
  createSite,
  deleteSite,
  getSite,
  listSites,
  purgeSite,
  setSiteEnabled,
  setSiteStarred,
  starredSites,
  updateSite,
} from "../services/sites";
import {
  cancelUpgrade,
  createUpgrade,
  listUpgrades,
  nodeRelease,
  promoteUpgrade,
} from "../services/upgrades";
import { getUsageSettings, listUsage, setUsageSettings, usageChanges } from "../services/usage";
import { getSiteWaf, siteFeatures, topWafRules, updateSiteWaf } from "../services/waf";
import { authed, os } from "./base";

export type { RequestContext } from "./base";

const ok = { ok: true as const };

export const router = os.router({
  usage: {
    list: authed.usage.list.handler(({ input, context }) => listUsage(context.app.db, input)),
    changes: authed.usage.changes.handler(({ input, context }) =>
      usageChanges(context.app.db, input),
    ),
  },
  serviceAccounts: {
    list: authed.serviceAccounts.list.handler(({ context }) => listServiceAccounts(context.app.db)),
    create: authed.serviceAccounts.create.handler(({ input, context }) =>
      createServiceAccount(context.app.db, input, context.actor),
    ),
    update: authed.serviceAccounts.update.handler(({ input, context }) =>
      updateServiceAccount(context.app.db, input, context.actor),
    ),
    delete: authed.serviceAccounts.delete.handler(({ input, context }) =>
      deleteServiceAccount(context.app.db, input.id, context.actor),
    ),
    createKey: authed.serviceAccounts.createKey.handler(({ input, context }) =>
      createServiceAccountKey(context.app.db, input, context.actor),
    ),
    revokeKey: authed.serviceAccounts.revokeKey.handler(({ input, context }) =>
      revokeServiceAccountKey(context.app.db, input, context.actor),
    ),
  },
  rules: {
    get: authed.rules.get.handler(({ input, context }) => getRules(context.app, input.id)),
    save: authed.rules.save.handler(({ input, context }) =>
      saveRules(context.app, input.id, input.rules, context),
    ),
    validate: authed.rules.validate.handler(({ input }) =>
      validateExpression(input.expression, input.phase, input.kind),
    ),
  },
  bulkRedirects: {
    get: authed.bulkRedirects.get.handler(({ input, context }) =>
      getBulkRedirects(context.app.db, input.id),
    ),
    save: authed.bulkRedirects.save.handler(({ input, context }) =>
      saveBulkRedirects(context.app.db, input, { actor: context.actor }),
    ),
  },
  platformRules: {
    get: authed.platformRules.get.handler(({ context }) => getRules(context.app, null)),
    save: authed.platformRules.save.handler(({ input, context }) =>
      saveRules(context.app, null, input.rules, context),
    ),
  },
  ipLists: {
    list: authed.ipLists.list.handler(({ context }) => listIpLists(context.app)),
    create: authed.ipLists.create.handler(({ input, context }) =>
      createIpList(context.app, input, context.actor),
    ),
    update: authed.ipLists.update.handler(({ input, context }) =>
      updateIpList(context.app, input.id, input.entries, input.kind, context.actor),
    ),
    delete: authed.ipLists.delete.handler(({ input, context }) =>
      deleteIpList(context.app, input.id, context.actor),
    ),
  },
  bans: {
    list: authed.bans.list.handler(({ input, context }) => listBans(context.app.db, input)),
    create: authed.bans.create.handler(({ input, context }) =>
      createBan(context.app.db, input, { actor: context.actor }),
    ),
    delete: authed.bans.delete.handler(({ input, context }) =>
      deleteBan(context.app.db, input.id, { actor: context.actor }),
    ),
  },
  protection: {
    get: authed.protection.get.handler(({ input, context }) =>
      getSiteProtection(context.app.db, input.id),
    ),
    update: authed.protection.update.handler(({ input, context }) =>
      updateSiteProtection(context.app.db, input, { actor: context.actor }),
    ),
  },
  waf: {
    get: authed.waf.get.handler(({ input, context }) => getSiteWaf(context.app.db, input.id)),
    update: authed.waf.update.handler(({ input, context }) =>
      updateSiteWaf(context.app.db, input, { actor: context.actor }),
    ),
    topRules: authed.waf.topRules.handler(({ input, context }) =>
      topWafRules(context.app.db, input),
    ),
  },
  errorPages: {
    get: authed.errorPages.get.handler(({ input, context }) =>
      getSiteErrorPages(context.app.db, input.id),
    ),
    update: authed.errorPages.update.handler(({ input, context }) =>
      updateSiteErrorPages(context.app.db, input, { actor: context.actor }),
    ),
  },
  security: {
    state: authed.security.state.handler(({ input, context }) =>
      siteSecurityState(context.app.db, input.id, input.hours),
    ),
    events: authed.security.events.handler(({ input, context }) =>
      listSecurityEvents(context.app.db, input),
    ),
  },
  certificates: {
    list: authed.certificates.list.handler(({ context }) => listCertificates(context.app)),
    upload: authed.certificates.upload.handler(({ input, context }) =>
      uploadCertificate(context.app, input, context),
    ),
    request: authed.certificates.request.handler(({ input, context }) =>
      requestCertificate(context.app, input, context),
    ),
    renew: authed.certificates.renew.handler(({ input, context }) =>
      renewCertificate(context.app, input.id, context),
    ),
    delete: authed.certificates.delete.handler(({ input, context }) =>
      deleteCertificate(context.app, input.id, context),
    ),
  },
  probes: {
    list: authed.probes.list.handler(({ context }) => listProbes(context.app.db)),
    createToken: authed.probes.createToken.handler(({ input, context }) =>
      createProbeToken(context.app.db, input, {
        actor: context.actor,
        serverUrl: context.app.env.nodeApiUrl,
        caSha256: context.app.nodeCa.fingerprintSha256,
      }),
    ),
    update: authed.probes.update.handler(({ input, context }) =>
      updateProbe(context.app.db, input, context.actor),
    ),
    delete: authed.probes.delete.handler(({ input, context }) =>
      deleteProbe(context.app.db, input.id, context.actor),
    ),
    results: authed.probes.results.handler(({ input, context }) =>
      listProbeResults(context.app.db, input),
    ),
  },
  scheduling: {
    list: authed.scheduling.list.handler(({ input, context }) =>
      listSchedulingRules(context.app.db, input.clusterId),
    ),
    create: authed.scheduling.create.handler(({ input, context }) =>
      createSchedulingRule(context.app.db, input, context.actor),
    ),
    update: authed.scheduling.update.handler(({ input, context }) =>
      updateSchedulingRule(context.app, input, context.actor),
    ),
    delete: authed.scheduling.delete.handler(({ input, context }) =>
      deleteSchedulingRule(context.app, input.id, context.actor),
    ),
    preview: authed.scheduling.preview.handler(({ input, context }) =>
      previewScheduling(context.app.db, input.clusterId),
    ),
  },
  l4Apps: {
    list: authed.l4Apps.list.handler(({ input, context }) =>
      listL4Apps(context.app.db, input.clusterId),
    ),
    get: authed.l4Apps.get.handler(({ input, context }) => getL4App(context.app.db, input.id)),
    create: authed.l4Apps.create.handler(({ input, context }) =>
      createL4App(context.app.db, input, context.actor),
    ),
    update: authed.l4Apps.update.handler(({ input, context }) =>
      updateL4App(context.app.db, input, context.actor),
    ),
    delete: authed.l4Apps.delete.handler(({ input, context }) =>
      deleteL4App(context.app.db, input.id, context.actor),
    ),
    setEnabled: authed.l4Apps.setEnabled.handler(({ input, context }) =>
      setL4AppEnabled(context.app.db, input, context.actor),
    ),
    stats: authed.l4Apps.stats.handler(({ input, context }) => l4AppStats(context.app.db, input)),
  },
  https: {
    get: authed.https.get.handler(({ input, context }) => getHttps(context.app, input.id)),
    update: authed.https.update.handler(({ input, context }) =>
      updateHttps(context.app, input.id, input.settings, context),
    ),
  },
  dnsCredentials: {
    list: authed.dnsCredentials.list.handler(({ context }) => listDnsCredentials(context.app)),
    create: authed.dnsCredentials.create.handler(({ input, context }) =>
      createDnsCredential(context.app, input, context),
    ),
    update: authed.dnsCredentials.update.handler(({ input, context }) =>
      updateDnsCredential(context.app, input, context),
    ),
    delete: authed.dnsCredentials.delete.handler(({ input, context }) =>
      deleteDnsCredential(context.app, input.id, context),
    ),
    zones: authed.dnsCredentials.zones.handler(({ input, context }) =>
      dnsCredentialZones(context.app, input),
    ),
    test: authed.dnsCredentials.test.handler(({ input, context }) =>
      testDnsCredential(context.app, input),
    ),
  },
  system: {
    status: os.system.status.handler(async ({ context }) => ({
      initialized: await isInitialized(context.app.db),
      version: context.app.env.version,
    })),
    setup: os.system.setup.handler(async ({ input, context }) =>
      runSetup(context.app, input, { ip: context.ip, userAgent: context.userAgent }),
    ),
  },
  account: {
    me: authed.account.me.handler(({ context }) =>
      context.serviceAccount ? serviceAccountMe(context.serviceAccount) : toMe(context.user),
    ),
  },
  overview: {
    get: authed.overview.get.handler(async ({ context }) => {
      const db = context.app.db;
      const since = sql`now() - make_interval(secs => ${ONLINE_WINDOW_SECONDS})`;
      const [[clusters], [nodes], [online], sites, revisions] = await Promise.all([
        db.select({ n: count() }).from(schema.cluster),
        db.select({ n: count() }).from(schema.node),
        db.select({ n: count() }).from(schema.node).where(gt(schema.node.lastSeenAt, since)),
        countSites(db),
        db
          .select()
          .from(schema.configRevision)
          .orderBy(desc(schema.configRevision.createdAt))
          .limit(10),
      ]);
      return {
        clusters: clusters?.n ?? 0,
        nodes: nodes?.n ?? 0,
        onlineNodes: online?.n ?? 0,
        sites,
        revisions: revisions.map(toRevisionDto),
      };
    }),
  },
  accessKeys: {
    list: authed.accessKeys.list.handler(({ context }) =>
      listAccessKeys(context.app, context.user.id),
    ),
    create: authed.accessKeys.create.handler(({ input, context }) =>
      createAccessKey(context.app, context.user.id, input, context.actor),
    ),
    revoke: authed.accessKeys.revoke.handler(({ input, context }) =>
      revokeAccessKey(context.app, context.user.id, input.id, context.actor),
    ),
  },
  alerts: {
    channels: authed.alerts.channels.handler(({ context }) => listAlertChannels(context.app)),
    createChannel: authed.alerts.createChannel.handler(({ input, context }) =>
      createAlertChannel(context.app, input, context.actor),
    ),
    updateChannel: authed.alerts.updateChannel.handler(({ input, context }) =>
      updateAlertChannel(context.app, input, context.actor),
    ),
    deleteChannel: authed.alerts.deleteChannel.handler(({ input, context }) =>
      deleteAlertChannel(context.app, input.id, context.actor),
    ),
    testChannel: authed.alerts.testChannel.handler(({ input, context }) =>
      testAlertChannel(context.app, input.id, context.actor),
    ),
    policy: authed.alerts.policy.handler(({ context }) => getAlertPolicy(context.app)),
    setPolicy: authed.alerts.setPolicy.handler(({ input, context }) =>
      setAlertPolicy(context.app, input, context.actor),
    ),
    smtp: authed.alerts.smtp.handler(({ context }) => getSmtpConfig(context.app)),
    setSmtp: authed.alerts.setSmtp.handler(({ input, context }) =>
      setSmtpConfig(context.app, input, context.actor),
    ),
    subscriptions: authed.alerts.subscriptions.handler(({ context }) =>
      listAlertSubscriptions(context.app, { actor: context.actor, userId: context.user.id }),
    ),
    subscribe: authed.alerts.subscribe.handler(({ input, context }) =>
      subscribeAlerts(context.app, input, { actor: context.actor, userId: context.user.id }),
    ),
    unsubscribe: authed.alerts.unsubscribe.handler(({ input, context }) =>
      unsubscribeAlerts(context.app, input.id, { actor: context.actor, userId: context.user.id }),
    ),
    events: authed.alerts.events.handler(({ input, context }) =>
      listAlertEvents(context.app, input.siteId),
    ),
  },
  dns: {
    catalog: authed.dns.catalog.handler(() => dnsCatalogDto),
    updateProvider: authed.dns.updateProvider.handler(({ input, context }) =>
      updateDnsProvider(context.app, input, context.actor),
    ),
    providers: authed.dns.providers.handler(({ context }) => listDnsProviders(context.app)),
    createProvider: authed.dns.createProvider.handler(({ input, context }) =>
      createDnsProvider(context.app, input, context.actor),
    ),
    deleteProvider: authed.dns.deleteProvider.handler(({ input, context }) =>
      deleteDnsProvider(context.app, input.id, context.actor),
    ),
    zones: authed.dns.zones.handler(({ input, context }) => listProviderZones(context.app, input)),
    testProvider: authed.dns.testProvider.handler(({ input, context }) =>
      testProvider(context.app, input),
    ),
    bindings: authed.dns.bindings.handler(({ context }) => listBindings(context.app)),
    binding: authed.dns.binding.handler(({ input, context }) =>
      getBinding(context.app, input.clusterId),
    ),
    saveBinding: authed.dns.saveBinding.handler(({ input, context }) =>
      saveBinding(context.app, input.clusterId, input.binding, context.actor),
    ),
    bindingRevisions: authed.dns.bindingRevisions.handler(({ input, context }) =>
      listBindingRevisions(context.app, input.clusterId),
    ),
    rollbackBinding: authed.dns.rollbackBinding.handler(({ input, context }) =>
      rollbackBinding(context.app, input.clusterId, input.revision, context.actor),
    ),
    forcePublishBinding: authed.dns.forcePublishBinding.handler(({ input, context }) =>
      forceBindingPublish(context.app, input.clusterId, input.revision, context.actor),
    ),
    exportBinding: authed.dns.exportBinding.handler(({ input, context }) =>
      exportBinding(context.app, input.clusterId),
    ),
    protection: authed.dns.protection.handler(({ context }) => getDnsProtection(context.app.db)),
    setProtection: authed.dns.setProtection.handler(({ input, context }) =>
      setDnsProtection(context.app, input, context.actor),
    ),
    reconcile: authed.dns.reconcile.handler(async ({ input, context }) => {
      await reconcileDns(context.app, context.actor, input.clusterId).catch(failFromCertd);
      return ok;
    }),
    siteTarget: authed.dns.siteTarget.handler(({ input, context }) =>
      siteDnsTarget(context.app, input.siteId),
    ),
  },
  upgrades: {
    release: authed.upgrades.release.handler(({ input, context }) =>
      nodeRelease(context.app, input.version),
    ),
    list: authed.upgrades.list.handler(({ input, context }) =>
      listUpgrades(context.app, input.clusterId),
    ),
    create: authed.upgrades.create.handler(({ input, context }) =>
      createUpgrade(context.app, input, context.actor),
    ),
    promote: authed.upgrades.promote.handler(({ input, context }) =>
      promoteUpgrade(context.app, input.id, context.actor),
    ),
    cancel: authed.upgrades.cancel.handler(({ input, context }) =>
      cancelUpgrade(context.app, input.id, context.actor),
    ),
  },
  logs: {
    settings: authed.logs.settings.handler(({ input, context }) =>
      logSettings(context.app, input.siteId),
    ),
    configure: authed.logs.configure.handler(({ input, context }) =>
      configureLogs(context.app, context.actor, input),
    ),
    query: authed.logs.query.handler(({ input, context }) => queryLogs(context.app, input)),
    export: authed.logs.export.handler(async ({ input, context }) => {
      const result = await queryLogs(context.app, input);
      return { csv: logsCsv(result.entries), truncated: result.truncated };
    }),
  },
  analytics: {
    topRequests: authed.analytics.topRequests.handler(async ({ input, context }) => {
      if (input.siteId) await getSite(context.app.db, input.siteId);
      return topRequests(context.app.db, input);
    }),
    traffic: authed.analytics.traffic.handler(async ({ input, context }) => {
      if (input.siteId) await getSite(context.app.db, input.siteId);
      return trafficSeries(context.app.db, input);
    }),
    topSites: authed.analytics.topSites.handler(({ input, context }) =>
      topSites(context.app.db, input),
    ),
    breakdown: authed.analytics.breakdown.handler(async ({ input, context }) => {
      if (input.siteId) await getSite(context.app.db, input.siteId);
      return trafficBreakdown(context.app.db, input);
    }),
    topNodes: authed.analytics.topNodes.handler(({ input, context }) =>
      topNodes(context.app.db, input),
    ),
  },
  clusters: {
    list: authed.clusters.list.handler(({ context }) => listClusters(context.app.db)),
    get: authed.clusters.get.handler(({ input, context }) => getCluster(context.app.db, input.id)),
    create: authed.clusters.create.handler(({ input, context }) =>
      createCluster(context.app.db, input, context.actor),
    ),
    update: authed.clusters.update.handler(({ input, context }) =>
      updateCluster(context.app.db, input, context.actor),
    ),
    delete: authed.clusters.delete.handler(async ({ input, context }) => {
      await deleteCluster(context.app.db, input.id, context.actor);
      return ok;
    }),
    revisions: authed.clusters.revisions.handler(async ({ input, context }) => {
      await getCluster(context.app.db, input.id);
      const rows = await context.app.db
        .select()
        .from(schema.configRevision)
        .where(eq(schema.configRevision.clusterId, input.id))
        .orderBy(desc(schema.configRevision.revision))
        .limit(100);
      return rows.map(toRevisionDto);
    }),
    rollback: authed.clusters.rollback.handler(({ input, context }) =>
      rollbackCluster(context.app.db, input, context.actor),
    ),
    rollout: authed.clusters.rollout.handler(({ input, context }) =>
      getRollout(context.app.db, input.id),
    ),
    setRolloutPolicy: authed.clusters.setRolloutPolicy.handler(({ input, context }) =>
      setRolloutPolicy(context.app.db, input, context.actor),
    ),
    promoteRollout: authed.clusters.promoteRollout.handler(({ input, context }) =>
      promoteRollout(context.app.db, input.id, context.actor),
    ),
    abortRollout: authed.clusters.abortRollout.handler(({ input, context }) =>
      abortRollout(context.app.db, input.id, context.actor),
    ),
    portPools: authed.clusters.portPools.handler(({ input, context }) =>
      getPortPools(context.app.db, input.clusterId),
    ),
    setPortPools: authed.clusters.setPortPools.handler(({ input, context }) =>
      setPortPools(context.app.db, input, context.actor),
    ),
    createEnrollmentToken: authed.clusters.createEnrollmentToken.handler(({ input, context }) =>
      createEnrollmentToken(context.app.db, input, {
        actor: context.actor,
        consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: context.app.env.nodeApiUrl,
        caSha256: context.app.nodeCa.fingerprintSha256,
      }),
    ),
    getEnrollmentToken: authed.clusters.getEnrollmentToken.handler(({ input, context }) =>
      getEnrollmentToken(context.app.db, input.id),
    ),
  },
  nodeGroups: {
    list: authed.nodeGroups.list.handler(({ input, context }) =>
      listNodeGroups(context.app.db, input.clusterId),
    ),
    create: authed.nodeGroups.create.handler(({ input, context }) =>
      createNodeGroup(context.app.db, input, context.actor),
    ),
    update: authed.nodeGroups.update.handler(({ input, context }) =>
      updateNodeGroup(context.app.db, input, context.actor),
    ),
    delete: authed.nodeGroups.delete.handler(async ({ input, context }) => {
      await deleteNodeGroup(context.app.db, input.id, context.actor);
      return ok;
    }),
  },
  regions: {
    list: authed.regions.list.handler(({ context }) => listRegions(context.app.db)),
    create: authed.regions.create.handler(({ input, context }) =>
      createRegion(context.app.db, input, context.actor),
    ),
    update: authed.regions.update.handler(({ input, context }) =>
      updateRegion(context.app.db, input, context.actor),
    ),
    delete: authed.regions.delete.handler(async ({ input, context }) => {
      await deleteRegion(context.app.db, input.id, context.actor);
      return ok;
    }),
  },
  nodes: {
    list: authed.nodes.list.handler(({ input, context }) =>
      listNodes(context.app.db, input.clusterId),
    ),
    get: authed.nodes.get.handler(({ input, context }) => getNode(context.app.db, input.id)),
    update: authed.nodes.update.handler(({ input, context }) =>
      updateNode(context.app.db, input, context.actor),
    ),
    disable: authed.nodes.disable.handler(({ input, context }) =>
      setNodeStatus(context.app.db, input.id, "disabled", context.actor),
    ),
    enable: authed.nodes.enable.handler(({ input, context }) =>
      setNodeStatus(context.app.db, input.id, "active", context.actor),
    ),
    delete: authed.nodes.delete.handler(async ({ input, context }) => {
      await deleteNode(context.app.db, input.id, context.actor);
      return ok;
    }),
    setProbe: authed.nodes.setProbe.handler(({ input, context }) =>
      setNodeProbe(context.app.db, input, context.actor),
    ),
    setAddresses: authed.nodes.setAddresses.handler(({ input, context }) =>
      setNodeAddresses(context.app.db, input, context.actor),
    ),
  },
  sites: {
    list: authed.sites.list.handler(({ input, context }) => listSites(context.app.db, input)),
    get: authed.sites.get.handler(({ input, context }) => getSite(context.app.db, input.id)),
    create: authed.sites.create.handler(({ input, context }) =>
      createSite(context.app.db, input, {
        actor: context.actor,
        masterKey: context.app.masterKey,
      }),
    ),
    update: authed.sites.update.handler(({ input, context }) =>
      updateSite(context.app.db, input, {
        actor: context.actor,
        masterKey: context.app.masterKey,
      }),
    ),
    delete: authed.sites.delete.handler(({ input, context }) =>
      deleteSite(context.app.db, input.id, { actor: context.actor }),
    ),
    purgeAll: authed.sites.purgeAll.handler(({ input, context }) =>
      purgeSite(context.app.db, input.id, { actor: context.actor }),
    ),
    starred: authed.sites.starred.handler(({ context }) =>
      starredSites(context.app.db, context.user.id),
    ),
    setStarred: authed.sites.setStarred.handler(async ({ input, context }) => {
      await setSiteStarred(context.app.db, {
        userId: context.user.id,
        siteId: input.id,
        starred: input.starred,
      });
      return ok;
    }),
    setEnabled: authed.sites.setEnabled.handler(({ input, context }) =>
      setSiteEnabled(context.app.db, input, { actor: context.actor }),
    ),
    originHealth: authed.sites.originHealth.handler(({ input, context }) =>
      siteOriginHealth(context.app.db, input.id),
    ),
    features: authed.sites.features.handler(({ input, context }) =>
      siteFeatures(context.app.db, input.id),
    ),
  },
  cacheTasks: {
    list: authed.cacheTasks.list.handler(({ input, context }) =>
      listCacheTasks(context.app.db, input),
    ),
    get: authed.cacheTasks.get.handler(({ input, context }) =>
      getCacheTask(context.app.db, input.id),
    ),
    create: authed.cacheTasks.create.handler(({ input, context }) =>
      createCacheTask(context.app.db, input, { actor: context.actor }),
    ),
  },
  settings: {
    get: authed.settings.get.handler(async ({ context }) => ({
      version: context.app.env.version,
      consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
      nodeApiUrl: context.app.env.nodeApiUrl,
      nodeCaSha256: context.app.nodeCa.fingerprintSha256,
      telemetryEnabled: context.app.env.EDGEWEIR_TELEMETRY,
      analyticsMode: context.app.env.EDGEWEIR_ANALYTICS,
      setupCompletedAt: await setupCompletedAt(context.app.db),
    })),
    originAllowList: authed.settings.originAllowList.handler(({ context }) =>
      getOriginAllowList(context.app.db),
    ),
    setOriginAllowList: authed.settings.setOriginAllowList.handler(({ input, context }) =>
      setOriginAllowList(context.app.db, input, context.actor),
    ),
    releaseSource: authed.settings.releaseSource.handler(({ context }) =>
      getReleaseSource(context.app),
    ),
    setReleaseSource: authed.settings.setReleaseSource.handler(({ input, context }) =>
      setReleaseSource(context.app, input, context.actor),
    ),
    bans: authed.settings.bans.handler(({ context }) => getBanSettings(context.app.db)),
    setBans: authed.settings.setBans.handler(({ input, context }) =>
      setBanSettings(context.app.db, input, context.actor),
    ),
    protection: authed.settings.protection.handler(({ context }) =>
      getProtectionSettings(context.app.db),
    ),
    setProtection: authed.settings.setProtection.handler(({ input, context }) =>
      setProtectionSettings(context.app.db, input, context.actor),
    ),
    ccTemplate: authed.settings.ccTemplate.handler(({ context }) => getCcTemplate(context.app.db)),
    setCcTemplate: authed.settings.setCcTemplate.handler(({ input, context }) =>
      setCcTemplate(context.app.db, input, context.actor),
    ),
    errorPages: authed.settings.errorPages.handler(({ context }) =>
      getPlatformErrorPages(context.app.db),
    ),
    setErrorPages: authed.settings.setErrorPages.handler(({ input, context }) =>
      setPlatformErrorPages(context.app.db, input, context.actor),
    ),
    probes: authed.settings.probes.handler(({ context }) => getProbeSettings(context.app.db)),
    setProbes: authed.settings.setProbes.handler(({ input, context }) =>
      setProbeSettings(context.app.db, input, context.actor),
    ),
    usage: authed.settings.usage.handler(({ context }) => getUsageSettings(context.app.db)),
    setUsage: authed.settings.setUsage.handler(({ input, context }) =>
      setUsageSettings(context.app.db, input, context.actor),
    ),
  },
  auditLogs: {
    list: authed.auditLogs.list.handler(({ input, context }) =>
      listAuditLogs(context.app.db, input),
    ),
    facets: authed.auditLogs.facets.handler(({ context }) => auditFacets(context.app.db)),
  },
});

export type Router = typeof router;
