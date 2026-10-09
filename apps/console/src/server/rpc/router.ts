import { os } from "./base";
import { accessControlRouter } from "./routers/access-control";
import { alertsRouter } from "./routers/alerts";
import { certificatesRouter } from "./routers/certificates";
import { clustersRouter } from "./routers/clusters";
import { dnsRouter } from "./routers/dns";
import { settingsRouter } from "./routers/settings";
import { sitesRouter } from "./routers/sites";
import { systemRouter } from "./routers/system";

export type { RequestContext } from "./base";

/** Every procedure, by domain (routers/); the OpenAPI document lists them in this order. */
export const router = os.router({
  usage: systemRouter.usage,
  serviceAccounts: systemRouter.serviceAccounts,
  rules: accessControlRouter.rules,
  bulkRedirects: sitesRouter.bulkRedirects,
  platformRules: accessControlRouter.platformRules,
  ipLists: accessControlRouter.ipLists,
  ipCheck: accessControlRouter.ipCheck,
  bans: accessControlRouter.bans,
  protection: accessControlRouter.protection,
  waf: accessControlRouter.waf,
  errorPages: sitesRouter.errorPages,
  maintenance: sitesRouter.maintenance,
  authRules: sitesRouter.authRules,
  accessControl: sitesRouter.accessControl,
  security: accessControlRouter.security,
  certificates: certificatesRouter.certificates,
  probes: clustersRouter.probes,
  scheduling: clustersRouter.scheduling,
  l4Apps: sitesRouter.l4Apps,
  https: sitesRouter.https,
  dnsCredentials: certificatesRouter.dnsCredentials,
  acmeAccounts: certificatesRouter.acmeAccounts,
  system: systemRouter.system,
  account: systemRouter.account,
  overview: systemRouter.overview,
  accessKeys: systemRouter.accessKeys,
  alerts: alertsRouter.alerts,
  dns: dnsRouter.dns,
  upgrades: clustersRouter.upgrades,
  logs: sitesRouter.logs,
  analytics: sitesRouter.analytics,
  clusters: clustersRouter.clusters,
  nodeGroups: clustersRouter.nodeGroups,
  regions: clustersRouter.regions,
  nodes: clustersRouter.nodes,
  sites: sitesRouter.sites,
  cacheTasks: sitesRouter.cacheTasks,
  settings: settingsRouter.settings,
  auditLogs: systemRouter.auditLogs,
});

export type Router = typeof router;
