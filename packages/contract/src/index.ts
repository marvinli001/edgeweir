import { oc } from "@orpc/contract";
import * as z from "zod";
import * as s from "./schemas";

export * from "./errors";
export * from "./schemas";

const idParam = z.object({ id: s.uuid });
/** better-auth ids (users, organizations, members, invitations) are opaque strings. */
const textIdParam = z.object({ id: z.string().min(1).max(100) });
const ok = z.object({ ok: z.literal(true) });

/**
 * The single API contract of the console. The web UI calls it over `/rpc`
 * (session cookie); third parties call the same procedures through the
 * generated OpenAPI surface under `/api/v1` with an `x-api-key` header.
 *
 * Errors carry a stable `code` (see errors.ts) that clients localize.
 */
export const contract = {
  system: {
    status: oc
      .route({ method: "GET", path: "/system/status", tags: ["system"] })
      .output(s.systemStatus),
    setup: oc
      .route({ method: "POST", path: "/system/setup", tags: ["system"] })
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
    /** Passive health of the site's origins, as reported by the nodes. */
    originHealth: oc
      .route({ method: "GET", path: "/sites/{id}/origin-health", tags: ["sites"] })
      .input(idParam)
      .output(z.array(s.originHealth)),
  },
  /** Cache purge (URL, prefix, whole site) and prefetch tasks with per-node results. */
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
    update: oc
      .route({ method: "PATCH", path: "/organization", tags: ["members"] })
      .input(s.organizationPolicyInput)
      .output(s.me),
  },
  /** Public: opened from an invitation link. */
  invitations: {
    get: oc
      .route({ method: "GET", path: "/invitations/{id}", tags: ["members"] })
      .input(textIdParam)
      .output(s.invitationInfo),
    accept: oc
      .route({ method: "POST", path: "/invitations/{id}/accept", tags: ["members"] })
      .input(s.invitationAcceptInput)
      .output(z.object({ userId: z.string(), organizationId: z.string() })),
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
