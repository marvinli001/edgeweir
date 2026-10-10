import { getAccessControl, updateAccessControl } from "../../services/access-control";
import { configureLogs, logSettings, logsCsv, queryLogs } from "../../services/access-logs";
import {
  topNodes,
  topRequests,
  topSites,
  trafficBreakdown,
  trafficSeries,
} from "../../services/analytics";
import {
  authFailures,
  getAuthRules,
  signAuthUrl,
  updateAuthRules,
} from "../../services/auth-rules";
import { getBulkRedirects, saveBulkRedirects } from "../../services/bulk-redirects";
import { createCacheTask, getCacheTask, listCacheTasks } from "../../services/cache-tasks";
import { getHttps, updateHttps } from "../../services/certificates";
import { setCnamePrefix } from "../../services/cname-prefixes";
import { getSiteErrorPages, updateSiteErrorPages } from "../../services/error-pages";
import { checkHttps } from "../../services/https-check";
import {
  createL4App,
  deleteL4App,
  getL4App,
  l4AppStats,
  listL4Apps,
  setL4AppEnabled,
  updateL4App,
} from "../../services/l4";
import { getSiteMaintenance, updateSiteMaintenance } from "../../services/maintenance";
import { siteOriginHealth } from "../../services/origin-health";
import { batchDeleteSites, batchSetEnabled } from "../../services/site-batch";
import { cloneSite, copySiteSettings, previewSiteCopy } from "../../services/site-copy";
import { siteLaunch } from "../../services/site-launch";
import {
  batchSiteTags,
  deleteSiteTag,
  listSiteTags,
  renameSiteTag,
  setSiteTags,
} from "../../services/site-tags";
import {
  createSite,
  deleteSite,
  getSite,
  listSites,
  setSiteEnabled,
  setSiteStarred,
  starredSites,
  updateSite,
} from "../../services/sites";
import { siteFeatures } from "../../services/waf";
import { authed, ok } from "../base";

/** Sites, their settings, logs, analytics and cache tasks, and layer-4 applications. */
export const sitesRouter = {
  bulkRedirects: {
    get: authed.bulkRedirects.get.handler(({ input, context }) =>
      getBulkRedirects(context.app.db, input.id),
    ),
    save: authed.bulkRedirects.save.handler(({ input, context }) =>
      saveBulkRedirects(context.app.db, input, { actor: context.actor }),
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
  maintenance: {
    get: authed.maintenance.get.handler(({ input, context }) =>
      getSiteMaintenance(context.app.db, input.id),
    ),
    update: authed.maintenance.update.handler(({ input, context }) =>
      updateSiteMaintenance(context.app.db, input, { actor: context.actor }),
    ),
  },
  authRules: {
    get: authed.authRules.get.handler(({ input, context }) =>
      getAuthRules(context.app.db, input.id),
    ),
    update: authed.authRules.update.handler(({ input, context }) =>
      updateAuthRules(context.app.db, context.app.masterKey, input, { actor: context.actor }),
    ),
    signUrl: authed.authRules.signUrl.handler(({ input, context }) =>
      signAuthUrl(context.app.db, context.app.masterKey, input, { actor: context.actor }),
    ),
    failures: authed.authRules.failures.handler(({ input, context }) =>
      authFailures(context.app.db, input),
    ),
  },
  accessControl: {
    get: authed.accessControl.get.handler(({ input, context }) =>
      getAccessControl(context.app.db, input.id),
    ),
    update: authed.accessControl.update.handler(({ input, context }) =>
      updateAccessControl(context.app.db, input, { actor: context.actor }),
    ),
  },
  https: {
    get: authed.https.get.handler(({ input, context }) => getHttps(context.app, input.id)),
    update: authed.https.update.handler(({ input, context }) =>
      updateHttps(context.app, input.id, input.settings, context),
    ),
    check: authed.https.check.handler(({ input, context }) =>
      checkHttps(context.app, input.id, input.ca),
    ),
  },
  l4Apps: {
    list: authed.l4Apps.list.handler(({ input, context }) =>
      listL4Apps(context.app.db, input.clusterId),
    ),
    get: authed.l4Apps.get.handler(({ input, context }) => getL4App(context.app.db, input.id)),
    create: authed.l4Apps.create.handler(({ input, context }) =>
      createL4App(context.app, input, context.actor),
    ),
    update: authed.l4Apps.update.handler(({ input, context }) =>
      updateL4App(context.app, input, context.actor),
    ),
    delete: authed.l4Apps.delete.handler(({ input, context }) =>
      deleteL4App(context.app.db, input.id, context.actor),
    ),
    setEnabled: authed.l4Apps.setEnabled.handler(({ input, context }) =>
      setL4AppEnabled(context.app.db, input, context.actor),
    ),
    setCnamePrefix: authed.l4Apps.setCnamePrefix.handler(({ input, context }) =>
      setCnamePrefix(context.app, { app: input.id }, input.prefix, context.actor),
    ),
    stats: authed.l4Apps.stats.handler(({ input, context }) => l4AppStats(context.app.db, input)),
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
      createCacheTask(
        context.app.db,
        { type: "site", siteIds: [input.id], urls: [] },
        { actor: context.actor },
      ),
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
    setCnamePrefix: authed.sites.setCnamePrefix.handler(({ input, context }) =>
      setCnamePrefix(context.app, { site: input.id }, input.prefix, context.actor),
    ),
    launch: authed.sites.launch.handler(({ input, context }) => siteLaunch(context.app, input.id)),
    originHealth: authed.sites.originHealth.handler(({ input, context }) =>
      siteOriginHealth(context.app.db, input.id),
    ),
    features: authed.sites.features.handler(({ input, context }) =>
      siteFeatures(context.app.db, input.id),
    ),
    setTags: authed.sites.setTags.handler(({ input, context }) =>
      setSiteTags(context.app.db, input, context.actor),
    ),
    batchSetEnabled: authed.sites.batchSetEnabled.handler(({ input, context }) =>
      batchSetEnabled(context.app.db, input, { actor: context.actor }),
    ),
    batchTags: authed.sites.batchTags.handler(({ input, context }) =>
      batchSiteTags(context.app.db, input, context.actor),
    ),
    batchDelete: authed.sites.batchDelete.handler(({ input, context }) =>
      batchDeleteSites(context.app.db, input.ids, { actor: context.actor }),
    ),
    copySettingsPreview: authed.sites.copySettingsPreview.handler(({ input, context }) =>
      previewSiteCopy(context.app.db, input, {
        masterKey: context.app.masterKey,
        actor: context.actor,
      }),
    ),
    copySettings: authed.sites.copySettings.handler(({ input, context }) =>
      copySiteSettings(context.app.db, input, {
        masterKey: context.app.masterKey,
        actor: context.actor,
      }),
    ),
    clone: authed.sites.clone.handler(({ input, context }) =>
      cloneSite(context.app.db, input, { masterKey: context.app.masterKey, actor: context.actor }),
    ),
  },
  siteTags: {
    list: authed.siteTags.list.handler(({ context }) => listSiteTags(context.app.db)),
    rename: authed.siteTags.rename.handler(({ input, context }) =>
      renameSiteTag(context.app.db, input, context.actor),
    ),
    delete: authed.siteTags.delete.handler(({ input, context }) =>
      deleteSiteTag(context.app.db, input.id, context.actor),
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
};
