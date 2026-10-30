import { upgradesContract } from "./upgrades";

export * from "./upgrades";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { logRetention, logRetentionSetting, logsContract } from "./logs";
import { nodeLogRetention, nodeLogsContract } from "./node-logs";
import { originQuality, originQualityInput } from "./origin-stats";
import { statsDimensions, statsDimensionsInput } from "./stats-dims";

export * from "./logs";
export * from "./origin-stats";
export * from "./stats-dims";

import { accessControlContract, ipCheckContract } from "./access-control";
import { accessKeysContract } from "./access-keys";
import { aiCrawlContract } from "./ai-crawl";
import { alertsContract } from "./alerts";
import { authRulesContract } from "./auth-rules";
import { autoMitigationContract } from "./auto-mitigation";
import { banSettings, bansContract } from "./bans";
import { bulkRedirectsContract } from "./bulk-redirects";
import {
  acmeAccountsContract,
  acmeDirectoryInput,
  acmeDirectorySetting,
  certificatesContract,
  dnsCredentialsContract,
  httpsContract,
} from "./certificates";
import { connectionLimitProcedures } from "./connection-limits";
import { demoProcedures } from "./demo";
import { developmentModeContract } from "./development-mode";
import { dnsContract } from "./dns";
import { edgeProcedures } from "./edge";
import { errorPagesContract, maintenanceContract, platformErrorPages } from "./error-pages";
import { greylistContract } from "./greylist";
import { hiddenCardsContract } from "./hidden-cards";
import { imageConvertContract } from "./image-convert";
import { l4AppsContract, portPoolProcedures } from "./l4";
import { loginAllowListProcedures } from "./login-allow-list";
import { markdownContract } from "./markdown";
import { originCaContract, originCertificatesContract, originClientCaContract } from "./origin-pki";
import { probeSourcesContract } from "./probe-sources";
import {
  nodeAddressesInput,
  nodeProbeInput,
  probeSettings,
  probesContract,
  schedulingContract,
} from "./probes";
import {
  ccTemplate,
  protectionContract,
  protectionSettingsInput,
  protectionSettingsView,
  securityContract,
} from "./protection";
import { ipListsContract, platformRulesContract, rulesContract } from "./rules";
import * as s from "./schemas";
import { serviceAccountsContract } from "./service-accounts";
import { siteCopyContract } from "./site-copy";
import {
  batchResult,
  batchSetEnabledInput,
  batchSiteIds,
  batchTagsInput,
  siteTagRef,
  siteTagsContract,
  siteTagsInput,
} from "./site-tags";
import { sshInstallsContract } from "./ssh-install";
import { cnamePrefixInput, cnamePrefixState, unknownHostProcedures } from "./unknown-hosts";
import { usageContract, usageSettings } from "./usage";
import { usageGuardContract } from "./usage-guard";
import { siteFeatures, wafContract } from "./waf";

export * from "./access-control";
export * from "./addresses";
export * from "./ai-crawl";
export * from "./audit";
export * from "./auth-rules";
export * from "./bans";
export * from "./bulk-redirects";
export * from "./certificates";
export * from "./connection-limits";
export * from "./domains";
export * from "./error-pages";
export * from "./errors";
export * from "./expressions";
export * from "./greylist";
export * from "./hidden-cards";
export * from "./image-convert";
export * from "./markdown";
export * from "./node-channel";
export * from "./node-errors";
export * from "./node-features";
export * from "./node-logs";
export * from "./origin-pki";
export * from "./protection";
export * from "./rules";
export * from "./s3-presets";
export * from "./schemas";
export * from "./site-copy";
export * from "./site-tags";
export * from "./unknown-hosts";
export * from "./waf";

const idParam = z.object({ id: s.uuid });
const ok = z.object({ ok: z.literal(true) });

/**
 * OpenAPI operation of a procedure that needs no credentials: it overrides
 * the document-wide API-key requirement with an empty one.
 */
const publicOperation = <T extends object>(operation: T) => ({ ...operation, security: [] });

/**
 * The single API contract of the console. The web UI calls it over `/rpc`
 * (session cookie); third parties call the same procedures through the
 * generated OpenAPI surface under `/api/v1` with an `x-api-key` header.
 *
 * Errors carry a stable `code` (see errors.ts) that clients localize.
 */
export const contract = {
  accessKeys: accessKeysContract,
  /** Machine identities for integrations, with scoped keys for /api/v1. */
  serviceAccounts: serviceAccountsContract,
  /** Recomputable 5-minute usage per site. */
  usage: usageContract,
  logs: logsContract,
  upgrades: upgradesContract,
  alerts: alertsContract,
  dns: dnsContract,
  rules: rulesContract,
  /** A site's exact-match redirect table. */
  bulkRedirects: bulkRedirectsContract,
  /** Tags of sites: the console's own grouping (nodes never see them). */
  siteTags: siteTagsContract,
  /** Rules that apply to every site. */
  platformRules: platformRulesContract,
  ipLists: ipListsContract,
  /** Dynamic IP bans of a site or of every site. */
  bans: bansContract,
  /** IP greylist: addresses challenged or rate-limited until they expire. */
  greylist: greylistContract,
  /** Under Attack, CC policy, pass lifetime, proof of work and JA4 logging of a site. */
  protection: protectionContract,
  /** CC mitigation levels and events of a site, as the nodes report them. */
  security: securityContract,
  /** OWASP CRS managed rules of a site and the rules it matched. */
  waf: wafContract,
  /** A site's error pages for node-generated and (optionally) origin error responses. */
  errorPages: errorPagesContract,
  /** A site's maintenance mode. */
  maintenance: maintenanceContract,
  /** A site's usage protection: limits on bytes sent, requests and bandwidth. */
  usageGuard: usageGuardContract,
  /** A site's automatic mitigation: CC escalation turns on Under Attack for a while. */
  autoMitigation: autoMitigationContract,
  /** A site's access authentication: Basic, forward authentication and signed URLs. */
  authRules: authRulesContract,
  /** A site's access control: site lists, geo, CORS, hotlink, user agents, WebSocket origins, security headers. */
  accessControl: accessControlContract,
  /** A site's WebP / AVIF conversion of cached images and the bytes it saved. */
  imageConvert: imageConvertContract,
  /** A site's development mode: the edge cache bypassed for three hours. */
  developmentMode: developmentModeContract,
  /** A site's Markdown for Agents and the Markdown responses it served. */
  markdown: markdownContract,
  /** AI crawl control: the crawler catalogue, global and site actions, managed robots.txt, pay per crawl and the overview. */
  aiCrawl: aiCrawlContract,
  /** What the console knows about an address: lists, bans and client address settings. */
  ipCheck: ipCheckContract,
  certificates: certificatesContract,
  acmeAccounts: acmeAccountsContract,
  /** The origin client CA and the clusters' certificates nodes present to origins (origin mutual TLS). */
  originClientCa: originClientCaContract,
  /** The Origin CA, which signs origin server certificates only the edge trusts. */
  originCa: originCaContract,
  /** Certificates the Origin CA issued: issue, list, revoke. */
  originCertificates: originCertificatesContract,
  /** Regional probes and their latest results. */
  probes: probesContract,
  /** One-shot SSH install of nodes, one host or many (ADR-0066). */
  sshInstalls: sshInstallsContract,
  /** External probe sources: monitoring services whose results count like probe results. */
  probeSources: probeSourcesContract,
  /** Scheduling rules of a cluster: conditions on node and probe metrics, DNS actions. */
  scheduling: schedulingContract,
  /** Layer-4 (TCP / UDP) applications: ports of a cluster forwarded to origins. */
  l4Apps: l4AppsContract,
  dnsCredentials: dnsCredentialsContract,
  https: httpsContract,
  system: {
    status: oc
      .route({ method: "GET", path: "/system/status", tags: ["system"], spec: publicOperation })
      .output(s.systemStatus),
    setup: oc
      .route({ method: "POST", path: "/system/setup", tags: ["system"], spec: publicOperation })
      .input(s.setupInput)
      .output(z.object({ userId: z.string() })),
  },
  account: {
    me: oc.route({ method: "GET", path: "/me", tags: ["account"] }).output(s.me),
  },
  /** The cards the caller hid on the console home and on sites' statistics. */
  hiddenCards: hiddenCardsContract,
  overview: {
    get: oc.route({ method: "GET", path: "/overview", tags: ["overview"] }).output(s.overview),
  },
  /** Lite analytics (per-minute node statistics). */
  analytics: {
    topRequests: oc
      .route({ method: "GET", path: "/analytics/top-requests", tags: ["analytics"] })
      .input(
        z.object({
          range: s.analyticsRange.default("24h"),
          siteId: s.uuid.optional(),
          by: z.enum(["url", "ip"]),
          limit: z.number().int().min(1).max(50).default(10),
        }),
      )
      .output(
        z.object({
          approximate: z.literal(true),
          items: z.array(z.object({ value: z.string(), requests: z.number() })),
        }),
      ),
    traffic: oc
      .route({ method: "GET", path: "/analytics/traffic", tags: ["analytics"] })
      .input(s.trafficInput)
      .output(s.traffic),
    topSites: oc
      .route({ method: "GET", path: "/analytics/top-sites", tags: ["analytics"] })
      .input(s.trafficTopInput)
      .output(z.array(s.trafficTopItem)),
    /** Leading sites, nodes or status codes over time. */
    breakdown: oc
      .route({ method: "GET", path: "/analytics/breakdown", tags: ["analytics"] })
      .input(s.trafficBreakdownInput)
      .output(s.trafficBreakdown),
    topNodes: oc
      .route({ method: "GET", path: "/analytics/top-nodes", tags: ["analytics"] })
      .input(s.trafficTopInput)
      .output(z.array(s.trafficTopItem)),
    /** Countries, networks, referrers, clients, protocols, block reasons and challenges. */
    dimensions: oc
      .route({ method: "GET", path: "/analytics/dimensions", tags: ["analytics"] })
      .input(statsDimensionsInput)
      .output(statsDimensions),
  },
  clusters: {
    list: oc
      .route({ method: "GET", path: "/clusters", tags: ["clusters"] })
      .output(z.array(s.cluster)),
    get: oc
      .route({ method: "GET", path: "/clusters/{id}", tags: ["clusters"] })
      .input(idParam)
      .output(s.cluster),
    create: oc
      .route({ method: "POST", path: "/clusters", tags: ["clusters"] })
      .input(s.clusterCreateInput)
      .output(s.cluster),
    update: oc
      .route({ method: "PATCH", path: "/clusters/{id}", tags: ["clusters"] })
      .input(s.clusterUpdateInput)
      .output(s.cluster),
    delete: oc
      .route({ method: "DELETE", path: "/clusters/{id}", tags: ["clusters"] })
      .input(idParam)
      .output(ok),
    revisions: oc
      .route({ method: "GET", path: "/clusters/{id}/revisions", tags: ["clusters"] })
      .input(idParam)
      .output(z.array(s.revision)),
    rollback: oc
      .route({ method: "POST", path: "/clusters/{id}/rollback", tags: ["clusters"] })
      .input(idParam.extend({ revision: z.number().int().min(1) }))
      .output(s.revision),
    /**
     * The sites a rollback to `revision` would add, change and remove against
     * the latest revision; refuses like the rollback would. Writes nothing.
     */
    rollbackPreview: oc
      .route({ method: "GET", path: "/clusters/{id}/rollback-preview", tags: ["clusters"] })
      .input(idParam.extend({ revision: z.coerce.number().int().min(1) }))
      .output(s.rollbackPreview),
    /** Configuration canary: policy, current rollout, canary nodes and window traffic. */
    rollout: oc
      .route({ method: "GET", path: "/clusters/{id}/rollout", tags: ["clusters"] })
      .input(idParam)
      .output(s.clusterRollout),
    setRolloutPolicy: oc
      .route({ method: "PUT", path: "/clusters/{id}/rollout-policy", tags: ["clusters"] })
      .input(s.rolloutPolicyInput)
      .output(s.clusterRollout),
    /** Gives the candidate to every node now. */
    promoteRollout: oc
      .route({ method: "POST", path: "/clusters/{id}/rollout/promote", tags: ["clusters"] })
      .input(idParam)
      .output(s.clusterRollout),
    /** Returns the canary nodes to the stable revision. */
    abortRollout: oc
      .route({ method: "POST", path: "/clusters/{id}/rollout/abort", tags: ["clusters"] })
      .input(idParam)
      .output(s.clusterRollout),
    createEnrollmentToken: oc
      .route({ method: "POST", path: "/enrollment-tokens", tags: ["nodes"] })
      .input(s.enrollmentTokenInput)
      .output(s.enrollmentTokenResult),
    /** Whether the token enrolled a node yet, and that node (never the token itself). */
    getEnrollmentToken: oc
      .route({ method: "GET", path: "/enrollment-tokens/{id}", tags: ["nodes"] })
      .input(idParam)
      .output(s.enrollmentTokenStatus),
    /**
     * The cache zone of every node of the cluster (size, inactive time);
     * publishes the cluster: a structural change, nodes reload nginx.
     */
    setCache: oc
      .route({ method: "PUT", path: "/clusters/{id}/cache", tags: ["clusters"] })
      .input(s.clusterCacheInput)
      .output(s.cluster),
    /** Port ranges the cluster's layer-4 applications may listen on. */
    portPools: portPoolProcedures.portPools,
    /** Replaces the port pools (no configuration revision: nodes only see the applications). */
    setPortPools: portPoolProcedures.setPortPools,
    /** HTTP and HTTPS ports the cluster's nodes listen on besides 80 and 443. */
    listenPorts: edgeProcedures.listenPorts,
    /** Replaces the extra listener ports and publishes a revision. */
    setListenPorts: edgeProcedures.setListenPorts,
    /** How the cluster's HTTP(S) listeners find the client address. */
    clientIp: edgeProcedures.clientIp,
    /** Replaces the client address setting and publishes a revision. */
    setClientIp: edgeProcedures.setClientIp,
    /** How the cluster's nodes answer unknown hosts and requests by node IP; scan protection. */
    unknownHosts: unknownHostProcedures.unknownHosts,
    /** Replaces the unknown host settings and publishes a revision. */
    setUnknownHosts: unknownHostProcedures.setUnknownHosts,
    /** Per-client TCP connection limits the cluster's nodes enforce in the kernel. */
    connectionLimits: connectionLimitProcedures.connectionLimits,
    /** Replaces the connection limits and publishes a revision. */
    setConnectionLimits: connectionLimitProcedures.setConnectionLimits,
  },
  nodeGroups: {
    list: oc
      .route({ method: "GET", path: "/node-groups", tags: ["nodes"] })
      .input(z.object({ clusterId: s.uuid.optional() }))
      .output(z.array(s.nodeGroup)),
    create: oc
      .route({ method: "POST", path: "/node-groups", tags: ["nodes"] })
      .input(s.nodeGroupCreateInput)
      .output(s.nodeGroup),
    update: oc
      .route({ method: "PATCH", path: "/node-groups/{id}", tags: ["nodes"] })
      .input(s.nodeGroupUpdateInput)
      .output(s.nodeGroup),
    delete: oc
      .route({ method: "DELETE", path: "/node-groups/{id}", tags: ["nodes"] })
      .input(idParam)
      .output(ok),
  },
  regions: {
    list: oc
      .route({ method: "GET", path: "/regions", tags: ["regions"] })
      .output(z.array(s.region)),
    create: oc
      .route({ method: "POST", path: "/regions", tags: ["regions"] })
      .input(s.regionCreateInput)
      .output(s.region),
    update: oc
      .route({ method: "PATCH", path: "/regions/{id}", tags: ["regions"] })
      .input(s.regionUpdateInput)
      .output(s.region),
    delete: oc
      .route({ method: "DELETE", path: "/regions/{id}", tags: ["regions"] })
      .input(idParam)
      .output(ok),
  },
  nodes: {
    list: oc
      .route({ method: "GET", path: "/nodes", tags: ["nodes"] })
      .input(z.object({ clusterId: s.uuid.optional() }))
      .output(z.array(s.node)),
    get: oc
      .route({ method: "GET", path: "/nodes/{id}", tags: ["nodes"] })
      .input(idParam)
      .output(s.node),
    update: oc
      .route({ method: "PATCH", path: "/nodes/{id}", tags: ["nodes"] })
      .input(s.nodeUpdateInput)
      .output(s.node),
    disable: oc
      .route({ method: "POST", path: "/nodes/{id}/disable", tags: ["nodes"] })
      .input(idParam)
      .output(s.node),
    enable: oc
      .route({ method: "POST", path: "/nodes/{id}/enable", tags: ["nodes"] })
      .input(idParam)
      .output(s.node),
    /** Deletes the node and revokes its certificate; the agent is refused from then on. */
    delete: oc
      .route({ method: "DELETE", path: "/nodes/{id}", tags: ["nodes"] })
      .input(idParam)
      .output(ok),
    /**
     * Asks the node (decommission-v1) to stop serving and forget its
     * identity; it is deleted, its certificate revoked, once it reports the
     * task done. An offline node gets the task when it connects again.
     */
    decommission: oc
      .route({ method: "POST", path: "/nodes/{id}/decommission", tags: ["nodes"] })
      .input(idParam)
      .output(s.node),
    /** Withdraws a decommission the node has not answered yet. */
    cancelDecommission: oc
      .route({ method: "DELETE", path: "/nodes/{id}/decommission", tags: ["nodes"] })
      .input(idParam)
      .output(s.node),
    /** Lets the node probe the other nodes from its node group's region (the group needs one). */
    setProbe: oc
      .route({ method: "PUT", path: "/nodes/{id}/probe", tags: ["nodes"] })
      .input(nodeProbeInput)
      .output(s.node),
    /**
     * Scheduling addresses with levels (0 primary, 1-2 backups); DNS and probes
     * use them instead of the addresses the node reports. Empty clears them.
     */
    setAddresses: oc
      .route({ method: "PUT", path: "/nodes/{id}/addresses", tags: ["nodes"] })
      .input(nodeAddressesInput)
      .output(s.node),
    /**
     * The node's own cache zone size (cache-zone-v1); null uses the
     * cluster's. Publishes the cluster; only that node reloads nginx.
     */
    setCache: oc
      .route({ method: "PUT", path: "/nodes/{id}/cache", tags: ["nodes"] })
      .input(s.nodeCacheInput)
      .output(s.node),
    /** The node's warnings, errors and events (node-logs-v1), newest first. */
    ...nodeLogsContract,
  },
  sites: {
    list: oc
      .route({ method: "GET", path: "/sites", tags: ["sites"] })
      .input(s.siteListInput)
      .output(s.siteList),
    get: oc
      .route({ method: "GET", path: "/sites/{id}", tags: ["sites"] })
      .input(idParam)
      .output(s.site),
    create: oc
      .route({ method: "POST", path: "/sites", tags: ["sites"], successStatus: 201 })
      .input(s.siteCreateInput)
      .output(s.siteMutationResult),
    update: oc
      .route({ method: "PATCH", path: "/sites/{id}", tags: ["sites"] })
      .input(s.siteUpdateInput)
      .output(s.siteMutationResult),
    delete: oc
      .route({ method: "DELETE", path: "/sites/{id}", tags: ["sites"] })
      .input(idParam)
      .output(z.object({ revision: s.revision })),
    /** Purges the whole site: the node task cacheTasks.create creates for type "site". */
    purgeAll: oc
      .route({ method: "POST", path: "/sites/{id}/purge", tags: ["sites"] })
      .input(idParam)
      .output(s.cacheTask),
    /** The caller's starred sites, most recently starred first. */
    starred: oc
      .route({ method: "GET", path: "/starred-sites", tags: ["sites"] })
      .output(z.array(s.starredSite)),
    setStarred: oc
      .route({ method: "PUT", path: "/sites/{id}/starred", tags: ["sites"] })
      .input(s.siteStarInput)
      .output(ok),
    /**
     * Sets the first label of the site's CNAME target, or a new random one
     * without `prefix`. The replaced name keeps resolving for 24 hours.
     */
    setCnamePrefix: oc
      .route({ method: "PUT", path: "/sites/{id}/cname-prefix", tags: ["sites"] })
      .input(cnamePrefixInput)
      .output(cnamePrefixState),
    /** Turns the site on or off. A disabled site is not shipped to nodes; its DNS records stay. */
    setEnabled: oc
      .route({ method: "PUT", path: "/sites/{id}/enabled", tags: ["sites"] })
      .input(s.siteSetEnabledInput)
      .output(s.siteMutationResult),
    /**
     * Whether the site is ready to serve: where its domains point compared
     * with the cluster's edge addresses (looked up now, which can take
     * seconds), whether its certificate covers them, and its delivery.
     */
    launch: oc
      .route({ method: "GET", path: "/sites/{id}/launch", tags: ["sites"] })
      .input(idParam)
      .output(s.siteLaunch),
    /** Health of the site's origins (passive and active checks), as reported by the nodes. */
    originHealth: oc
      .route({ method: "GET", path: "/sites/{id}/origin-health", tags: ["sites"] })
      .input(idParam)
      .output(z.array(s.originHealth)),
    /**
     * Fetches from each of the site's origins over a range (attempts,
     * failures, 5xx answers, time to the response header), as the nodes
     * count them (origin-stats-v1).
     */
    originQuality: oc
      .route({ method: "GET", path: "/sites/{id}/origins/quality", tags: ["sites"] })
      .input(originQualityInput)
      .output(originQuality),
    /**
     * Whether Brotli, Zstandard, OWASP CRS, active health checks, session
     * affinity, HTTP/2 and gRPC towards the origins, error pages and the rule
     * engine extensions can be turned on for the site now, and whether its
     * cluster's nodes run purges by host or tag and variant and sitemap
     * prefetches.
     */
    features: oc
      .route({ method: "GET", path: "/sites/{id}/features", tags: ["sites"] })
      .input(idParam)
      .output(siteFeatures),
    /** Replaces the site's tags (names, any case matches an existing tag); not published. */
    setTags: oc
      .route({ method: "PUT", path: "/sites/{id}/tags", tags: ["sites"] })
      .input(siteTagsInput)
      .output(z.object({ tags: z.array(siteTagRef) })),
    /**
     * Turns sites on or off: each changed site is audited, each of their
     * clusters published once.
     */
    batchSetEnabled: oc
      .route({ method: "POST", path: "/sites/batch/enabled", tags: ["sites"] })
      .input(batchSetEnabledInput)
      .output(batchResult),
    /** Adds and removes tags on sites (not published: nodes do not see tags). */
    batchTags: oc
      .route({ method: "POST", path: "/sites/batch/tags", tags: ["sites"] })
      .input(batchTagsInput)
      .output(batchResult),
    /** Deletes sites: each is audited, each of their clusters published once. */
    batchDelete: oc
      .route({ method: "POST", path: "/sites/batch/delete", tags: ["sites"] })
      .input(z.object({ ids: batchSiteIds }))
      .output(batchResult),
    ...siteCopyContract,
  },
  /**
   * Cache purge (URL, prefix, whole site, host, Cache-Tag) and prefetch (URLs
   * in device variants, sitemaps) tasks with per-node results.
   */
  cacheTasks: {
    list: oc
      .route({ method: "GET", path: "/cache-tasks", tags: ["cache"] })
      .input(s.cacheTaskListInput)
      .output(s.cacheTaskList),
    get: oc
      .route({ method: "GET", path: "/cache-tasks/{id}", tags: ["cache"] })
      .input(idParam)
      .output(s.cacheTask),
    create: oc
      .route({ method: "POST", path: "/cache-tasks", tags: ["cache"], successStatus: 201 })
      .input(s.cacheTaskCreateInput)
      .output(s.cacheTask),
  },
  settings: {
    get: oc.route({ method: "GET", path: "/settings", tags: ["settings"] }).output(s.settings),
    /** The console's TLS handshake with its own node channel URL (advisory, cached 30 s). */
    nodeChannelCheck: oc
      .route({ method: "GET", path: "/settings/node-channel-check", tags: ["settings"] })
      .output(s.nodeChannelCheck),
    /** The URL nodes and probes connect to; install commands carry it. */
    nodeChannel: oc
      .route({ method: "GET", path: "/settings/node-channel", tags: ["settings"] })
      .output(s.nodeChannel),
    /**
     * Saves the node channel URL (empty: EDGEWEIR_NODE_API_URL or the default). The node
     * channel's certificate names it from then on and keeps the earlier URL's name; enrolled
     * nodes and probes with channel-follow-v1 check the new URL and switch to it.
     */
    setNodeChannel: oc
      .route({ method: "PUT", path: "/settings/node-channel", tags: ["settings"] })
      .input(s.nodeChannelInput)
      .output(s.nodeChannel),
    /**
     * Removes a name an earlier URL left in the node channel certificate, once no node or
     * probe may connect with it (NODE_CHANNEL_NAME_IN_USE otherwise).
     */
    removeNodeChannelName: oc
      .route({ method: "DELETE", path: "/settings/node-channel/names/{name}", tags: ["settings"] })
      .input(s.nodeChannelNameInput)
      .output(s.nodeChannel),
    /**
     * Closes the WebSocket entry an earlier wss:// or ws:// URL opened, once no node or probe
     * may use it (NODE_CHANNEL_WEBSOCKET_IN_USE, NODE_CHANNEL_WEBSOCKET_REQUIRED otherwise).
     */
    closeNodeChannelWebSocket: oc
      .route({ method: "DELETE", path: "/settings/node-channel/websocket", tags: ["settings"] })
      .output(s.nodeChannel),
    /** Special-purpose origin addresses (private, loopback...) sites may use anyway. */
    originAllowList: oc
      .route({ method: "GET", path: "/settings/origin-allow-list", tags: ["settings"] })
      .output(s.originAllowList),
    /** Replaces the list and publishes a new revision for every cluster. */
    setOriginAllowList: oc
      .route({ method: "PUT", path: "/settings/origin-allow-list", tags: ["settings"] })
      .input(s.originAllowListInput)
      .output(s.originAllowList),
    /** The custom ACME directory certificates may be requested from (ca "custom"). */
    acmeDirectory: oc
      .route({ method: "GET", path: "/settings/acme-directory", tags: ["settings"] })
      .output(acmeDirectorySetting),
    /** Saves the custom ACME directory after reading it; empty url clears the setting. */
    setAcmeDirectory: oc
      .route({ method: "PUT", path: "/settings/acme-directory", tags: ["settings"] })
      .input(acmeDirectoryInput)
      .output(acmeDirectorySetting),
    /** Mirror the console reads node release manifests from. */
    releaseSource: oc
      .route({ method: "GET", path: "/settings/release-source", tags: ["settings"] })
      .output(s.releaseSource),
    setReleaseSource: oc
      .route({ method: "PUT", path: "/settings/release-source", tags: ["settings"] })
      .input(s.releaseSourceInput)
      .output(s.releaseSource),
    /** Usage record retention and the offline threshold of completeUntil. */
    usage: oc
      .route({ method: "GET", path: "/settings/usage", tags: ["settings"] })
      .output(usageSettings),
    setUsage: oc
      .route({ method: "PUT", path: "/settings/usage", tags: ["settings"] })
      .input(usageSettings)
      .output(usageSettings),
    /** Days access logs are kept, per storage. */
    logRetention: oc
      .route({ method: "GET", path: "/settings/log-retention", tags: ["settings"] })
      .output(logRetentionSetting),
    setLogRetention: oc
      .route({ method: "PUT", path: "/settings/log-retention", tags: ["settings"] })
      .input(logRetention)
      .output(logRetentionSetting),
    /** Days node logs are kept, and at most how many per node. */
    nodeLogRetention: oc
      .route({ method: "GET", path: "/settings/node-log-retention", tags: ["settings"] })
      .output(nodeLogRetention),
    setNodeLogRetention: oc
      .route({ method: "PUT", path: "/settings/node-log-retention", tags: ["settings"] })
      .input(nodeLogRetention)
      .output(nodeLogRetention),
    /** Platform limit of manual bans and sharing of automatic bans in a cluster. */
    bans: oc
      .route({ method: "GET", path: "/settings/bans", tags: ["settings"] })
      .output(banSettings),
    setBans: oc
      .route({ method: "PUT", path: "/settings/bans", tags: ["settings"] })
      .input(banSettings)
      .output(banSettings),
    /** Platform Under Attack, the global interactive provider and the retention of security events. */
    protection: oc
      .route({ method: "GET", path: "/settings/protection", tags: ["settings"] })
      .output(protectionSettingsView),
    /** Publishes a new revision for every cluster when Under Attack or the provider changes. */
    setProtection: oc
      .route({ method: "PUT", path: "/settings/protection", tags: ["settings"] })
      .input(protectionSettingsInput)
      .output(protectionSettingsView),
    /** Default CC policy that sites can follow. */
    ccTemplate: oc
      .route({ method: "GET", path: "/settings/cc-template", tags: ["settings"] })
      .output(ccTemplate),
    /** Publishes a new revision for clusters with sites that follow the template. */
    setCcTemplate: oc
      .route({ method: "PUT", path: "/settings/cc-template", tags: ["settings"] })
      .input(ccTemplate)
      .output(ccTemplate),
    /** Probe interval, timeout and attempts, and when addresses count as down or up again. */
    probes: oc
      .route({ method: "GET", path: "/settings/probes", tags: ["settings"] })
      .output(probeSettings),
    setProbes: oc
      .route({ method: "PUT", path: "/settings/probes", tags: ["settings"] })
      .input(probeSettings)
      .output(probeSettings),
    /** The platform's pages for unknown hosts and disabled sites. */
    errorPages: oc
      .route({ method: "GET", path: "/settings/error-pages", tags: ["settings"] })
      .output(platformErrorPages),
    /** Replaces the pages and publishes a new revision for every cluster. */
    setErrorPages: oc
      .route({ method: "PUT", path: "/settings/error-pages", tags: ["settings"] })
      .input(platformErrorPages)
      .output(platformErrorPages),
    /** The view-only demo account; switching it off deletes the account and its sessions. */
    ...demoProcedures,
    /** The networks the operator may sign in from; empty: anyone may. */
    ...loginAllowListProcedures,
  },
  auditLogs: {
    list: oc
      .route({ method: "GET", path: "/audit-logs", tags: ["audit"] })
      .input(s.auditLogListInput)
      .output(s.auditLogPage),
    facets: oc
      .route({ method: "GET", path: "/audit-logs/facets", tags: ["audit"] })
      .output(s.auditLogFacets),
  },
};

export type Contract = typeof contract;

/**
 * Procedures whose response carries a credential shown once (the console
 * keeps only its hash). `/api/v1` refuses an Idempotency-Key on them with 400
 * IDEMPOTENCY_KEY_UNSUPPORTED: replaying the response would mean storing the
 * credential.
 */
export const oneTimeSecretProcedures: ReadonlySet<string> = new Set([
  "accessKeys.create",
  "serviceAccounts.createKey",
  "clusters.createEnrollmentToken",
  "probes.createToken",
  // A webhook secret the console made is shown once.
  "probeSources.create",
  "probeSources.rotateWebhookSecret",
  // A signed URL grants access until it expires (up to a year).
  "authRules.signUrl",
]);

export * from "./access-keys";
export * from "./alerts";
export * from "./auto-mitigation";
export * from "./demo";
export * from "./development-mode";
export * from "./dns";
export * from "./dns-providers";
export * from "./edge";
export * from "./l4";
export * from "./login-allow-list";
export * from "./probe-sources";
export * from "./probes";
export * from "./service-accounts";
export * from "./ssh-install";
export * from "./usage";
export * from "./usage-guard";
