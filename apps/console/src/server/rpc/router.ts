import { contract } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { implement, ORPCError } from "@orpc/server";
import { and, asc, count, desc, eq, gt, sql } from "drizzle-orm";
import { API_KEY_HEADER } from "../lib/auth";
import type { AppContext } from "../lib/context";
import type { Actor } from "../services/audit";
import { createCluster, getCluster, listClusters } from "../services/clusters";
import { createEnrollmentToken } from "../services/enrollment";
import { getNode, listNodes, ONLINE_WINDOW_SECONDS } from "../services/nodes";
import { rollbackToRevision, toRevisionDto } from "../services/revisions";
import { isInitialized, runSetup } from "../services/setup";
import {
  createSite,
  deleteSite,
  getSite,
  listSites,
  purgeSite,
  type SiteScope,
} from "../services/sites";

export interface RequestContext {
  app: AppContext;
  headers: Headers;
  ip: string;
  userAgent: string;
}

const os = implement(contract).$context<RequestContext>();

/** Resolves the session (cookie or x-api-key) and the caller's tenant. */
const authed = os.use(async ({ context, next }) => {
  let result: Awaited<ReturnType<typeof context.app.auth.api.getSession>>;
  try {
    result = await context.app.auth.api.getSession({ headers: context.headers });
  } catch (error) {
    // better-auth rejects invalid/expired API keys by throwing a 4xx APIError.
    const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
    if (statusCode >= 500) throw error;
    throw new ORPCError("UNAUTHORIZED", { message: "invalid credentials" });
  }
  if (!result) throw new ORPCError("UNAUTHORIZED", { message: "authentication required" });
  const { user, session } = result;
  const roles = String((user as { role?: string | null }).role ?? "").split(",");
  const isAdmin = roles.includes("admin");
  let organizationId = (session as { activeOrganizationId?: string | null }).activeOrganizationId;
  if (!organizationId) {
    const [membership] = await context.app.db
      .select({ organizationId: schema.member.organizationId })
      .from(schema.member)
      .where(eq(schema.member.userId, user.id))
      .orderBy(asc(schema.member.createdAt))
      .limit(1);
    organizationId = membership?.organizationId ?? null;
  }
  const actor: Actor = {
    type: context.headers.has(API_KEY_HEADER) ? "api_key" : "user",
    id: user.id,
    ip: context.ip,
    userAgent: context.userAgent,
  };
  const scope: SiteScope = isAdmin
    ? { all: true }
    : organizationId
      ? { all: false, organizationId }
      : { all: false, organizationId: "__none__" };
  return next({ context: { user, isAdmin, organizationId, actor, scope } });
});

/** Platform infrastructure (clusters, nodes, audit) is administrator-only. */
const admin = authed.use(async ({ context, next }) => {
  if (!context.isAdmin) throw new ORPCError("FORBIDDEN", { message: "administrator only" });
  return next();
});

export const router = os.router({
  system: {
    status: os.system.status.handler(async ({ context }) => ({
      initialized: await isInitialized(context.app.db),
      version: context.app.env.version,
    })),
    setup: os.system.setup.handler(async ({ input, context }) =>
      runSetup(context.app, input, { ip: context.ip, userAgent: context.userAgent }),
    ),
  },
  overview: {
    get: authed.overview.get.handler(async ({ context }) => {
      const db = context.app.db;
      const since = sql`now() - make_interval(secs => ${ONLINE_WINDOW_SECONDS})`;
      const stats = schema.nodeMinuteStats;
      const [[clusters], [nodes], [online], sites, revisions, traffic] = await Promise.all([
        db.select({ n: count() }).from(schema.cluster),
        db.select({ n: count() }).from(schema.node),
        db.select({ n: count() }).from(schema.node).where(gt(schema.node.lastSeenAt, since)),
        listSites(db, context.scope),
        db
          .select()
          .from(schema.configRevision)
          .orderBy(desc(schema.configRevision.createdAt))
          .limit(10),
        db
          .select({
            minute: stats.minute,
            requests: sql<number>`sum(${stats.requests})::bigint`.mapWith(Number),
            cacheHits: sql<number>`sum(${stats.cacheHits})::bigint`.mapWith(Number),
            cacheMisses: sql<number>`sum(${stats.cacheMisses})::bigint`.mapWith(Number),
          })
          .from(stats)
          .innerJoin(schema.site, eq(schema.site.id, stats.siteId))
          .where(
            and(
              gt(stats.minute, sql`now() - interval '60 minutes'`),
              context.scope.all
                ? undefined
                : eq(schema.site.organizationId, context.scope.organizationId),
            ),
          )
          .groupBy(stats.minute)
          .orderBy(asc(stats.minute)),
      ]);
      return {
        clusters: context.isAdmin ? (clusters?.n ?? 0) : 0,
        nodes: context.isAdmin ? (nodes?.n ?? 0) : 0,
        onlineNodes: context.isAdmin ? (online?.n ?? 0) : 0,
        sites: sites.length,
        revisions: context.isAdmin ? revisions.map(toRevisionDto) : [],
        traffic: traffic.map((t) => ({ ...t, minute: new Date(t.minute).toISOString() })),
      };
    }),
  },
  clusters: {
    list: admin.clusters.list.handler(({ context }) => listClusters(context.app.db)),
    get: admin.clusters.get.handler(({ input, context }) => getCluster(context.app.db, input.id)),
    create: admin.clusters.create.handler(({ input, context }) =>
      createCluster(context.app.db, input, context.actor),
    ),
    revisions: admin.clusters.revisions.handler(async ({ input, context }) => {
      const rows = await context.app.db
        .select()
        .from(schema.configRevision)
        .where(eq(schema.configRevision.clusterId, input.id))
        .orderBy(desc(schema.configRevision.revision))
        .limit(100);
      return rows.map(toRevisionDto);
    }),
    rollback: admin.clusters.rollback.handler(async ({ input, context }) => {
      const result = await context.app.db.transaction((tx) =>
        rollbackToRevision(tx, {
          clusterId: input.id,
          revision: input.revision,
          userId: context.actor.id,
        }),
      );
      if (!result) throw new ORPCError("NOT_FOUND", { message: "revision not found" });
      return toRevisionDto(result.row);
    }),
    createEnrollmentToken: admin.clusters.createEnrollmentToken.handler(({ input, context }) =>
      createEnrollmentToken(context.app.db, input, {
        actor: context.actor,
        consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
        serverUrl: context.app.env.nodeApiUrl,
        caSha256: context.app.nodeCa.fingerprintSha256,
      }),
    ),
  },
  nodes: {
    list: admin.nodes.list.handler(({ input, context }) =>
      listNodes(context.app.db, input.clusterId),
    ),
    get: admin.nodes.get.handler(({ input, context }) => getNode(context.app.db, input.id)),
  },
  sites: {
    list: authed.sites.list.handler(({ context }) => listSites(context.app.db, context.scope)),
    get: authed.sites.get.handler(({ input, context }) =>
      getSite(context.app.db, input.id, context.scope),
    ),
    create: authed.sites.create.handler(({ input, context }) => {
      if (!context.organizationId) {
        throw new ORPCError("FORBIDDEN", { message: "caller is not a member of any organization" });
      }
      return createSite(context.app.db, input, {
        organizationId: context.organizationId,
        actor: context.actor,
      });
    }),
    delete: authed.sites.delete.handler(({ input, context }) =>
      deleteSite(context.app.db, input.id, { scope: context.scope, actor: context.actor }),
    ),
    purgeAll: authed.sites.purgeAll.handler(({ input, context }) =>
      purgeSite(context.app.db, input.id, { scope: context.scope, actor: context.actor }),
    ),
  },
  settings: {
    get: authed.settings.get.handler(({ context }) => ({
      version: context.app.env.version,
      consoleUrl: context.app.env.EDGEWEIR_PUBLIC_URL,
      nodeApiUrl: context.app.env.nodeApiUrl,
      nodeCaSha256: context.app.nodeCa.fingerprintSha256,
      telemetryEnabled: context.app.env.EDGEWEIR_TELEMETRY,
      analyticsMode: context.app.env.EDGEWEIR_ANALYTICS,
    })),
  },
  auditLogs: {
    list: admin.auditLogs.list.handler(async ({ input, context }) => {
      const rows = await context.app.db
        .select()
        .from(schema.auditLog)
        .orderBy(desc(schema.auditLog.id))
        .limit(input.limit);
      return rows.map((r) => ({
        id: r.id,
        occurredAt: r.occurredAt.toISOString(),
        actorType: r.actorType,
        actorId: r.actorId,
        action: r.action,
        targetType: r.targetType,
        targetId: r.targetId,
        metadata: r.metadata,
      }));
    }),
  },
});

export type Router = typeof router;
