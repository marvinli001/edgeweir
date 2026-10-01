import { upgradesContract } from "./upgrades";

export * from "./upgrades";

import { oc } from "@orpc/contract";
import * as z from "zod";
import { logsContract } from "./logs";

export * from "./logs";

import { accessKeysContract } from "./access-keys";
import { alertsContract } from "./alerts";
import { adminBansContract, banSettings, bansContract } from "./bans";
import { certificatesContract, dnsCredentialsContract, httpsContract } from "./certificates";
import { dnsContract } from "./dns";
import { domainOwnershipContract } from "./domains";
import { errorPagesContract, platformErrorPages } from "./error-pages";
import { ccTemplate, protectionContract, protectionSettings, securityContract } from "./protection";
import {
  ipListsContract,
  platformIpListsContract,
  platformRulesContract,
  rulesContract,
} from "./rules";
import * as s from "./schemas";
import { serviceAccountsContract } from "./service-accounts";
import { usageContract, usageSettings } from "./usage";
import { siteFeatures, wafContract, wafSettings } from "./waf";

export * from "./addresses";
export * from "./bans";
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
/** better-auth ids (users, organizations, members, invitations) are opaque strings. */
const textIdParam = z.object({ id: z.string().min(1).max(100) });
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
  /** Platform administrators only. */
  serviceAccounts: serviceAccountsContract,
  /** Recomputable 5-minute usage per site (members: their organization). */
  usage: usageContract,
  logs: logsContract,
  upgrades: upgradesContract,
  alerts: alertsContract,
  dns: dnsContract,
  domainOwnership: domainOwnershipContract,
  rules: rulesContract,
  platformRules: platformRulesContract,
  ipLists: ipListsContract,
  platformIpLists: platformIpListsContract,
  /** Dynamic IP bans of the caller's sites. */
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
  dnsCredentials: dnsCredentialsContract,
  https: httpsContract,
  system: {
    status: oc
      .route({ method: "GET", path: "/system/status", tags: ["system"], spec: publicOperation })
      .output(s.systemStatus),
    setup: oc
      .route({ method: "POST", path: "/system/setup", tags: ["system"], spec: publicOperation })
      .input(s.setupInput)
      .output(z.object({ userId: z.string(), organizationId: z.string() })),
  },
  account: {
    me: oc.route({ method: "GET", path: "/me", tags: ["account"] }).output(s.me),
    setActiveOrganization: oc
      .route({ method: "POST", path: "/me/active-organization", tags: ["account"] })
      .input(z.object({ organizationId: z.string().min(1).max(100) }))
      .output(s.me),
  },
  overview: {
    get: oc.route({ method: "GET", path: "/overview", tags: ["overview"] }).output(s.overview),
  },
  /** Lite analytics (per-minute node statistics), scoped like sites. */
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
    /** Leading sites, nodes (platform administrators only) or status codes over time. */
    breakdown: oc
      .route({ method: "GET", path: "/analytics/breakdown", tags: ["analytics"] })
      .input(s.trafficBreakdownInput)
      .output(s.trafficBreakdown),
    /** Platform administrators only. */
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
    /**
     * Turns the site on or off (organization owners and admins). A disabled
     * site is not shipped to nodes; its DNS records stay.
     */
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
     * affinity and error pages can be turned on for the site now, and whether
     * its cluster's nodes run purges by host or tag and variant and sitemap
     * prefetches.
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
  /** Members of the caller's active organization (organization owners and admins). */
  members: {
    list: oc.route({ method: "GET", path: "/members", tags: ["members"] }).output(s.memberList),
    invite: oc
      .route({ method: "POST", path: "/members/invitations", tags: ["members"] })
      .input(s.memberInviteInput)
      .output(s.invitationResult),
    cancelInvitation: oc
      .route({ method: "DELETE", path: "/members/invitations/{id}", tags: ["members"] })
      .input(textIdParam)
      .output(ok),
    updateRole: oc
      .route({ method: "PATCH", path: "/members/{id}", tags: ["members"] })
      .input(s.memberRoleInput)
      .output(s.member),
    remove: oc
      .route({ method: "DELETE", path: "/members/{id}", tags: ["members"] })
      .input(textIdParam)
      .output(ok),
  },
  /** Policy of the caller's active organization (organization owners and admins). */
  organization: {
    /** The active organization's technical limits and usage (any member). */
    limits: oc
      .route({ method: "GET", path: "/organization/limits", tags: ["members"] })
      .output(s.organizationLimits),
    update: oc
      .route({ method: "PATCH", path: "/organization", tags: ["members"] })
      .input(s.organizationPolicyInput)
      .output(s.me),
  },
  /** Public: opened from an invitation link. */
  invitations: {
    get: oc
      .route({
        method: "GET",
        path: "/invitations/{id}",
        tags: ["members"],
        spec: publicOperation,
      })
      .input(textIdParam)
      .output(s.invitationInfo),
    accept: oc
      .route({
        method: "POST",
        path: "/invitations/{id}/accept",
        tags: ["members"],
        spec: publicOperation,
      })
      .input(s.invitationAcceptInput)
      .output(z.object({ userId: z.string(), organizationId: z.string() })),
  },
  /** Platform actions on tenant resources (platform administrators and scoped service accounts). */
  admin: {
    sites: {
      /** Stops shipping the site until the platform resumes it; tenants cannot lift it. */
      suspend: oc
        .route({ method: "POST", path: "/admin/sites/{id}/suspend", tags: ["sites"] })
        .input(s.siteSuspendInput)
        .output(s.siteMutationResult),
      resume: oc
        .route({ method: "POST", path: "/admin/sites/{id}/resume", tags: ["sites"] })
        .input(s.siteResumeInput)
        .output(s.siteMutationResult),
    },
    organizations: {
      getLimits: oc
        .route({
          method: "GET",
          path: "/admin/organizations/{id}/limits",
          tags: ["organizations"],
        })
        .input(textIdParam)
        .output(s.organizationLimits),
      /** Lower limits keep existing resources and only refuse new ones. */
      setLimits: oc
        .route({
          method: "PUT",
          path: "/admin/organizations/{id}/limits",
          tags: ["organizations"],
        })
        .input(s.organizationLimitsInput)
        .output(s.organizationLimits),
    },
    /** Every ban, including platform bans. */
    bans: adminBansContract,
  },
  organizations: {
    list: oc
      .route({ method: "GET", path: "/organizations", tags: ["organizations"] })
      .output(z.array(s.organization)),
    create: oc
      .route({ method: "POST", path: "/organizations", tags: ["organizations"] })
      .input(s.organizationCreateInput)
      .output(s.organization),
    update: oc
      .route({ method: "PATCH", path: "/organizations/{id}", tags: ["organizations"] })
      .input(s.organizationUpdateInput)
      .output(s.organization),
    members: oc
      .route({ method: "GET", path: "/organizations/{id}/members", tags: ["organizations"] })
      .input(textIdParam)
      .output(s.memberList),
    addMember: oc
      .route({
        method: "POST",
        path: "/organizations/{organizationId}/members",
        tags: ["organizations"],
      })
      .input(s.orgMemberAddInput)
      .output(s.member),
    updateMember: oc
      .route({
        method: "PATCH",
        path: "/organizations/{organizationId}/members/{memberId}",
        tags: ["organizations"],
      })
      .input(s.orgMemberUpdateInput)
      .output(s.member),
    removeMember: oc
      .route({
        method: "DELETE",
        path: "/organizations/{organizationId}/members/{memberId}",
        tags: ["organizations"],
      })
      .input(s.orgMemberRemoveInput)
      .output(ok),
    invite: oc
      .route({
        method: "POST",
        path: "/organizations/{organizationId}/invitations",
        tags: ["organizations"],
      })
      .input(s.orgInviteInput)
      .output(s.invitationResult),
  },
  users: {
    list: oc
      .route({ method: "GET", path: "/users", tags: ["users"] })
      .input(s.userListInput)
      .output(z.array(s.user)),
    create: oc
      .route({ method: "POST", path: "/users", tags: ["users"], successStatus: 201 })
      .input(s.userCreateInput)
      .output(s.user),
    setAdmin: oc
      .route({ method: "POST", path: "/users/{id}/admin", tags: ["users"] })
      .input(s.userSetAdminInput)
      .output(s.user),
    setDisabled: oc
      .route({ method: "POST", path: "/users/{id}/disabled", tags: ["users"] })
      .input(s.userSetDisabledInput)
      .output(s.user),
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
    /** Whether tenants may turn on OWASP CRS for their sites. */
    waf: oc.route({ method: "GET", path: "/settings/waf", tags: ["settings"] }).output(wafSettings),
    /** Sites that already run CRS keep it; tenants can then only turn it off. */
    setWaf: oc
      .route({ method: "PUT", path: "/settings/waf", tags: ["settings"] })
      .input(wafSettings)
      .output(wafSettings),
    /** The platform's pages for unknown hosts and for disabled and suspended sites. */
    errorPages: oc
      .route({ method: "GET", path: "/settings/error-pages", tags: ["settings"] })
      .output(platformErrorPages),
    /** Replaces the pages and publishes a new revision for every cluster. */
    setErrorPages: oc
      .route({ method: "PUT", path: "/settings/error-pages", tags: ["settings"] })
      .input(platformErrorPages)
      .output(platformErrorPages),
    /** Recursive DNS servers for domain ownership TXT checks. */
    dnsResolvers: oc
      .route({ method: "GET", path: "/settings/dns-resolvers", tags: ["settings"] })
      .output(s.dnsResolvers),
    setDnsResolvers: oc
      .route({ method: "PUT", path: "/settings/dns-resolvers", tags: ["settings"] })
      .input(s.dnsResolversInput)
      .output(s.dnsResolvers),
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

export * from "./access-keys";
export * from "./alerts";
export * from "./dns";
export * from "./domains";
export * from "./service-accounts";
export * from "./usage";
