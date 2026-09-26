import { schema } from "@edgeweir/db";
import { ORPCError } from "@orpc/server";
import { count, desc, eq, gt, sql } from "drizzle-orm";
import { fail } from "../lib/errors";
import {
  acceptInvitation,
  getInvitationInfo,
  resolveCaller,
  setActiveOrganization,
  toMe,
} from "../services/account";
import { topNodes, topSites, trafficBreakdown, trafficSeries } from "../services/analytics";
import { auditFacets, listAuditLogs } from "../services/audit";
import { createCacheTask, getCacheTask, listCacheTasks } from "../services/cache-tasks";
import {
  createDnsCredential,
  deleteCertificate,
  deleteDnsCredential,
  getHttps,
  listCertificates,
  listDnsCredentials,
  renewCertificate,
  requestCertificate,
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
import { createEnrollmentToken } from "../services/enrollment";
import { getLandingPage, updateLandingSettings } from "../services/landing";
import {
  addMember,
  cancelInvitation,
  createInvitation,
  invitationUrl,
  listMembers,
  removeMember,
  updateMemberRole,
} from "../services/members";
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
  setNodeStatus,
  updateNode,
} from "../services/nodes";
import {
  createOrganization,
  listOrganizations,
  updateOrganization,
} from "../services/organizations";
import { getOriginAllowList, setOriginAllowList } from "../services/origin-allow-list";
import { siteOriginHealth } from "../services/origin-health";
import { createRegion, deleteRegion, listRegions, updateRegion } from "../services/regions";
import { toRevisionDto } from "../services/revisions";
import { isInitialized, runSetup, setupCompletedAt } from "../services/setup";
import {
  countSites,
  createSite,
  deleteSite,
  getSite,
  listSites,
  purgeSite,
  setSiteStarred,
  starredSites,
  updateSite,
} from "../services/sites";
import { createUser, listUsers, setUserAdmin, setUserDisabled } from "../services/users";
import { admin, authed, maybeAuthed, orgManager, os, tenant } from "./base";

export type { RequestContext } from "./base";

const ok = { ok: true as const };

export const router = os.router({
  certificates: {
    list: tenant.certificates.list.handler(({ context }) =>
      listCertificates(context.app, context.scope),
    ),
    upload: tenant.certificates.upload.handler(({ input, context }) =>
      uploadCertificate(context.app, input, context),
    ),
    request: tenant.certificates.request.handler(({ input, context }) =>
      requestCertificate(context.app, input, context),
    ),
    renew: tenant.certificates.renew.handler(({ input, context }) =>
      renewCertificate(context.app, input.id, context),
    ),
    delete: tenant.certificates.delete.handler(({ input, context }) =>
      deleteCertificate(context.app, input.id, context),
    ),
  },
  https: {
    get: tenant.https.get.handler(({ input, context }) =>
      getHttps(context.app, input.id, context.scope),
    ),
    update: tenant.https.update.handler(({ input, context }) =>
      updateHttps(context.app, input.id, input.settings, context),
    ),
  },
  dnsCredentials: {
    list: tenant.dnsCredentials.list.handler(({ context }) =>
      listDnsCredentials(context.app, context.scope),
    ),
    create: tenant.dnsCredentials.create.handler(({ input, context }) =>
      createDnsCredential(context.app, input, context),
    ),
    delete: tenant.dnsCredentials.delete.handler(({ input, context }) =>
      deleteDnsCredential(context.app, input.id, context),
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
    me: authed.account.me.handler(({ context }) => toMe(context.caller)),
    setActiveOrganization: authed.account.setActiveOrganization.handler(
      async ({ input, context }) => {
        await setActiveOrganization(context.app.db, {
          sessionId: context.sessionId,
          caller: context.caller,
          organizationId: input.organizationId,
        });
        const caller = await resolveCaller(
          context.app.db,
          context.user,
          context.isAdmin,
          input.organizationId,
        );
        return toMe(caller);
      },
    ),
  },
  overview: {
    get: tenant.overview.get.handler(async ({ context }) => {
      const db = context.app.db;
      const since = sql`now() - make_interval(secs => ${ONLINE_WINDOW_SECONDS})`;
      const [[clusters], [nodes], [online], sites, revisions] = await Promise.all([
        db.select({ n: count() }).from(schema.cluster),
        db.select({ n: count() }).from(schema.node),
        db.select({ n: count() }).from(schema.node).where(gt(schema.node.lastSeenAt, since)),
        countSites(db, context.scope),
        db
          .select()
          .from(schema.configRevision)
          .orderBy(desc(schema.configRevision.createdAt))
          .limit(10),
      ]);
      return {
        clusters: context.isAdmin ? (clusters?.n ?? 0) : 0,
        nodes: context.isAdmin ? (nodes?.n ?? 0) : 0,
        onlineNodes: context.isAdmin ? (online?.n ?? 0) : 0,
        sites,
        revisions: context.isAdmin ? revisions.map(toRevisionDto) : [],
      };
    }),
  },
  analytics: {
    traffic: tenant.analytics.traffic.handler(async ({ input, context }) => {
      // Fails with SITE_NOT_FOUND for sites outside the caller's scope.
      if (input.siteId) await getSite(context.app.db, input.siteId, context.scope);
      return trafficSeries(context.app.db, context.scope, input);
    }),
    topSites: tenant.analytics.topSites.handler(({ input, context }) =>
      topSites(context.app.db, context.scope, input),
    ),
    breakdown: tenant.analytics.breakdown.handler(async ({ input, context }) => {
      // Nodes are platform infrastructure, like `topNodes`.
      if (input.by === "node" && !context.isAdmin) {
        throw new ORPCError("FORBIDDEN", { message: "administrator only" });
      }
      if (input.siteId) await getSite(context.app.db, input.siteId, context.scope);
      return trafficBreakdown(context.app.db, context.scope, input);
    }),
    topNodes: admin.analytics.topNodes.handler(({ input, context }) =>
      topNodes(context.app.db, input),
    ),
  },
  clusters: {
    list: admin.clusters.list.handler(({ context }) => listClusters(context.app.db)),
    get: admin.clusters.get.handler(({ input, context }) => getCluster(context.app.db, input.id)),
    create: admin.clusters.create.handler(({ input, context }) =>
      createCluster(context.app.db, input, context.actor),
    ),
    update: admin.clusters.update.handler(({ input, context }) =>
      updateCluster(context.app.db, input, context.actor),
    ),
    delete: admin.clusters.delete.handler(async ({ input, context }) => {
      await deleteCluster(context.app.db, input.id, context.actor);
      return ok;
    }),
    revisions: admin.clusters.revisions.handler(async ({ input, context }) => {
      await getCluster(context.app.db, input.id);
      const rows = await context.app.db
        .select()
        .from(schema.configRevision)
        .where(eq(schema.configRevision.clusterId, input.id))
        .orderBy(desc(schema.configRevision.revision))
        .limit(100);
      return rows.map(toRevisionDto);
    }),
    rollback: admin.clusters.rollback.handler(({ input, context }) =>
      rollbackCluster(context.app.db, input, context.actor),
    ),
    createEnrollmentToken: admin.clusters.createEnrollmentToken.handler(({ input, context }) =>
      createEnrollmentToken(context.app.db, input, {
        actor: context.actor,
        consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: context.app.env.nodeApiUrl,
        caSha256: context.app.nodeCa.fingerprintSha256,
      }),
    ),
  },
  nodeGroups: {
    list: admin.nodeGroups.list.handler(({ input, context }) =>
      listNodeGroups(context.app.db, input.clusterId),
    ),
    create: admin.nodeGroups.create.handler(({ input, context }) =>
      createNodeGroup(context.app.db, input, context.actor),
    ),
    update: admin.nodeGroups.update.handler(({ input, context }) =>
      updateNodeGroup(context.app.db, input, context.actor),
    ),
    delete: admin.nodeGroups.delete.handler(async ({ input, context }) => {
      await deleteNodeGroup(context.app.db, input.id, context.actor);
      return ok;
    }),
  },
  regions: {
    list: admin.regions.list.handler(({ context }) => listRegions(context.app.db)),
    create: admin.regions.create.handler(({ input, context }) =>
      createRegion(context.app.db, input, context.actor),
    ),
    update: admin.regions.update.handler(({ input, context }) =>
      updateRegion(context.app.db, input, context.actor),
    ),
    delete: admin.regions.delete.handler(async ({ input, context }) => {
      await deleteRegion(context.app.db, input.id, context.actor);
      return ok;
    }),
  },
  nodes: {
    list: admin.nodes.list.handler(({ input, context }) =>
      listNodes(context.app.db, input.clusterId),
    ),
    get: admin.nodes.get.handler(({ input, context }) => getNode(context.app.db, input.id)),
    update: admin.nodes.update.handler(({ input, context }) =>
      updateNode(context.app.db, input, context.actor),
    ),
    disable: admin.nodes.disable.handler(({ input, context }) =>
      setNodeStatus(context.app.db, input.id, "disabled", context.actor),
    ),
    enable: admin.nodes.enable.handler(({ input, context }) =>
      setNodeStatus(context.app.db, input.id, "active", context.actor),
    ),
    delete: admin.nodes.delete.handler(async ({ input, context }) => {
      await deleteNode(context.app.db, input.id, context.actor);
      return ok;
    }),
  },
  sites: {
    list: tenant.sites.list.handler(({ input, context }) =>
      listSites(context.app.db, context.scope, {
        ...input,
        // Clusters are platform infrastructure: tenants cannot filter by them.
        clusterId: context.isAdmin ? input.clusterId : undefined,
      }),
    ),
    get: tenant.sites.get.handler(({ input, context }) =>
      getSite(context.app.db, input.id, context.scope),
    ),
    create: tenant.sites.create.handler(({ input, context }) => {
      if (!context.organizationId) {
        fail("NOT_A_MEMBER", "caller is not a member of any organization");
      }
      if (input.clusterId && !context.isAdmin) {
        fail("CLUSTER_SELECTION_FORBIDDEN", "only platform administrators choose the cluster");
      }
      return createSite(context.app.db, input, {
        organizationId: context.organizationId,
        actor: context.actor,
        masterKey: context.app.masterKey,
      });
    }),
    update: tenant.sites.update.handler(({ input, context }) =>
      updateSite(context.app.db, input, {
        scope: context.scope,
        actor: context.actor,
        masterKey: context.app.masterKey,
      }),
    ),
    delete: tenant.sites.delete.handler(({ input, context }) =>
      deleteSite(context.app.db, input.id, { scope: context.scope, actor: context.actor }),
    ),
    purgeAll: tenant.sites.purgeAll.handler(({ input, context }) =>
      purgeSite(context.app.db, input.id, { scope: context.scope, actor: context.actor }),
    ),
    starred: tenant.sites.starred.handler(({ context }) =>
      starredSites(context.app.db, context.scope, context.user.id),
    ),
    setStarred: tenant.sites.setStarred.handler(async ({ input, context }) => {
      await setSiteStarred(context.app.db, context.scope, {
        userId: context.user.id,
        siteId: input.id,
        starred: input.starred,
      });
      return ok;
    }),
    originHealth: tenant.sites.originHealth.handler(({ input, context }) =>
      siteOriginHealth(context.app.db, input.id, context.scope),
    ),
  },
  cacheTasks: {
    list: tenant.cacheTasks.list.handler(({ input, context }) =>
      listCacheTasks(context.app.db, context.scope, input),
    ),
    get: tenant.cacheTasks.get.handler(({ input, context }) =>
      getCacheTask(context.app.db, input.id, context.scope),
    ),
    create: tenant.cacheTasks.create.handler(({ input, context }) =>
      createCacheTask(context.app.db, input, { scope: context.scope, actor: context.actor }),
    ),
  },
  members: {
    list: orgManager.members.list.handler(({ context }) =>
      listMembers(context.app.db, context.organizationId, context.manager.role),
    ),
    invite: orgManager.members.invite.handler(async ({ input, context }) => {
      const invitation = await createInvitation(
        context.app.db,
        { organizationId: context.organizationId, ...input },
        context.manager,
      );
      return {
        invitation,
        url: invitationUrl(context.app.env.EDGEWEIR_PUBLIC_URL, invitation.id),
      };
    }),
    cancelInvitation: orgManager.members.cancelInvitation.handler(async ({ input, context }) => {
      await cancelInvitation(
        context.app.db,
        { organizationId: context.organizationId, id: input.id },
        context.actor,
      );
      return ok;
    }),
    updateRole: orgManager.members.updateRole.handler(({ input, context }) =>
      updateMemberRole(
        context.app.db,
        { organizationId: context.organizationId, memberId: input.id, role: input.role },
        context.manager,
      ),
    ),
    remove: orgManager.members.remove.handler(async ({ input, context }) => {
      await removeMember(
        context.app.db,
        { organizationId: context.organizationId, memberId: input.id },
        context.manager,
      );
      return ok;
    }),
  },
  organization: {
    update: orgManager.organization.update.handler(async ({ input, context }) => {
      await updateOrganization(
        context.app.db,
        { id: context.organizationId, requireTwoFactor: input.requireTwoFactor },
        context.actor,
      );
      const caller = await resolveCaller(
        context.app.db,
        context.user,
        context.isAdmin,
        context.organizationId,
      );
      return toMe(caller);
    }),
  },
  invitations: {
    get: os.invitations.get.handler(({ input, context }) =>
      getInvitationInfo(context.app.db, input.id),
    ),
    accept: maybeAuthed.invitations.accept.handler(({ input, context }) =>
      acceptInvitation(context.app, input, context.session, {
        ip: context.ip,
        userAgent: context.userAgent,
      }),
    ),
  },
  organizations: {
    list: admin.organizations.list.handler(({ context }) => listOrganizations(context.app.db)),
    create: admin.organizations.create.handler(({ input, context }) =>
      createOrganization(context.app.db, input, context.actor),
    ),
    update: admin.organizations.update.handler(({ input, context }) =>
      updateOrganization(context.app.db, input, context.actor),
    ),
    members: admin.organizations.members.handler(({ input, context }) =>
      listMembers(context.app.db, input.id, context.manager.role),
    ),
    addMember: admin.organizations.addMember.handler(({ input, context }) =>
      addMember(context.app.db, input, context.manager),
    ),
    updateMember: admin.organizations.updateMember.handler(({ input, context }) =>
      updateMemberRole(context.app.db, input, context.manager),
    ),
    removeMember: admin.organizations.removeMember.handler(async ({ input, context }) => {
      await removeMember(context.app.db, input, context.manager);
      return ok;
    }),
    invite: admin.organizations.invite.handler(async ({ input, context }) => {
      const invitation = await createInvitation(context.app.db, input, context.manager);
      return {
        invitation,
        url: invitationUrl(context.app.env.EDGEWEIR_PUBLIC_URL, invitation.id),
      };
    }),
  },
  users: {
    list: admin.users.list.handler(({ input, context }) => listUsers(context.app.db, input.search)),
    create: admin.users.create.handler(({ input, context }) =>
      createUser(context.app, input, context.actor),
    ),
    setAdmin: admin.users.setAdmin.handler(({ input, context }) =>
      setUserAdmin(context.app.db, input, context.actor),
    ),
    setDisabled: admin.users.setDisabled.handler(({ input, context }) =>
      setUserDisabled(context.app.db, input, context.actor),
    ),
  },
  settings: {
    get: admin.settings.get.handler(async ({ context }) => ({
      version: context.app.env.version,
      consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
      nodeApiUrl: context.app.env.nodeApiUrl,
      nodeCaSha256: context.app.nodeCa.fingerprintSha256,
      telemetryEnabled: context.app.env.EDGEWEIR_TELEMETRY,
      analyticsMode: context.app.env.EDGEWEIR_ANALYTICS,
      setupCompletedAt: await setupCompletedAt(context.app.db),
    })),
    originAllowList: admin.settings.originAllowList.handler(({ context }) =>
      getOriginAllowList(context.app.db),
    ),
    setOriginAllowList: admin.settings.setOriginAllowList.handler(({ input, context }) =>
      setOriginAllowList(context.app.db, input, context.actor),
    ),
  },
  landing: {
    get: os.landing.get.handler(({ context }) => getLandingPage(context.app.db)),
    update: admin.landing.update.handler(({ input, context }) =>
      updateLandingSettings(context.app.db, input, context.actor),
    ),
  },
  auditLogs: {
    list: admin.auditLogs.list.handler(({ input, context }) =>
      listAuditLogs(context.app.db, input),
    ),
    facets: admin.auditLogs.facets.handler(({ context }) => auditFacets(context.app.db)),
  },
});

export type Router = typeof router;
