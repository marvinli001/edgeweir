import { upgradesContract } from "./upgrades";

export * from "./upgrades";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { logsContract } from "./logs";

export * from "./logs";

import { accessKeysContract } from "./access-keys";
import { alertsContract } from "./alerts";
import { banSettings, bansContract } from "./bans";
import { bulkRedirectsContract } from "./bulk-redirects";
import { certificatesContract, dnsCredentialsContract, httpsContract } from "./certificates";
import { dnsContract } from "./dns";
import { errorPagesContract, platformErrorPages } from "./error-pages";
import {
  nodeAddressesInput,
  nodeProbeInput,
  probeSettings,
  probesContract,
  schedulingContract,
} from "./probes";
import { ccTemplate, protectionContract, protectionSettings, securityContract } from "./protection";
import { ipListsContract, platformRulesContract, rulesContract } from "./rules";
import * as s from "./schemas";
import { serviceAccountsContract } from "./service-accounts";
import { usageContract, usageSettings } from "./usage";
import { siteFeatures, wafContract } from "./waf";

export * from "./addresses";
export * from "./bans";
export * from "./bulk-redirects";
export * from "./certificates";
export * from "./error-pages";
export * from "./errors";
export * from "./node-errors";
export * from "./node-features";
export * from "./protection";
export * from "./rules";
export * from "./schemas";
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
  /** Rules that apply to every site. */
  platformRules: platformRulesContract,
  ipLists: ipListsContract,
  /** Dynamic IP bans of a site or of every site. */
  bans: bansContract,
  /** Under Attack, CC policy, pass lifetime, proof of work and JA4 logging of a site. */
  protection: protectionContract,
  /** CC mitigation levels and events of a site, as the nodes report them. */
  security: securityContract,
  /** OWASP CRS managed rules of a site and the rules it matched. */
  waf: wafContract,
  /** A site's error pages for node-generated 403, 429, 502, 503 and 504 responses. */
  errorPages: errorPagesContract,
  certificates: certificatesContract,
  /** Regional probes and their latest results. */
  probes: probesContract,
  /** Scheduling rules of a cluster: conditions on node and probe metrics, DNS actions. */
  scheduling: schedulingContract,
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
    purgeAll: oc
      .route({ method: "POST", path: "/sites/{id}/purge", tags: ["sites"] })
      .input(idParam)
      .output(s.siteMutationResult),
    /** The caller's starred sites, most recently starred first. */
    starred: oc
      .route({ method: "GET", path: "/starred-sites", tags: ["sites"] })
      .output(z.array(s.starredSite)),
    setStarred: oc
      .route({ method: "PUT", path: "/sites/{id}/starred", tags: ["sites"] })
      .input(s.siteStarInput)
      .output(ok),
    /** Turns the site on or off. A disabled site is not shipped to nodes; its DNS records stay. */
    setEnabled: oc
      .route({ method: "PUT", path: "/sites/{id}/enabled", tags: ["sites"] })
      .input(s.siteSetEnabledInput)
      .output(s.siteMutationResult),
    /** Health of the site's origins (passive and active checks), as reported by the nodes. */
    originHealth: oc
      .route({ method: "GET", path: "/sites/{id}/origin-health", tags: ["sites"] })
      .input(idParam)
      .output(z.array(s.originHealth)),
    /**
     * Whether Brotli, Zstandard, OWASP CRS, active health checks, session
     * affinity, error pages and the rule engine extensions can be turned on
     * for the site now, and whether its cluster's nodes run purges by host or
     * tag and variant and sitemap prefetches.
     */
    features: oc
      .route({ method: "GET", path: "/sites/{id}/features", tags: ["sites"] })
      .input(idParam)
      .output(siteFeatures),
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
    /** Special-purpose origin addresses (private, loopback...) sites may use anyway. */
    originAllowList: oc
      .route({ method: "GET", path: "/settings/origin-allow-list", tags: ["settings"] })
      .output(s.originAllowList),
    /** Replaces the list and publishes a new revision for every cluster. */
    setOriginAllowList: oc
      .route({ method: "PUT", path: "/settings/origin-allow-list", tags: ["settings"] })
      .input(s.originAllowListInput)
      .output(s.originAllowList),
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
    /** Platform limit of manual bans and sharing of automatic bans in a cluster. */
    bans: oc
      .route({ method: "GET", path: "/settings/bans", tags: ["settings"] })
      .output(banSettings),
    setBans: oc
      .route({ method: "PUT", path: "/settings/bans", tags: ["settings"] })
      .input(banSettings)
      .output(banSettings),
    /** Platform Under Attack and the retention of security events. */
    protection: oc
      .route({ method: "GET", path: "/settings/protection", tags: ["settings"] })
      .output(protectionSettings),
    /** Publishes a new revision for every cluster when Under Attack changes. */
    setProtection: oc
      .route({ method: "PUT", path: "/settings/protection", tags: ["settings"] })
      .input(protectionSettings)
      .output(protectionSettings),
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
]);

export * from "./access-keys";
export * from "./alerts";
export * from "./dns";
export * from "./dns-providers";
export * from "./probes";
export * from "./service-accounts";
export * from "./usage";
