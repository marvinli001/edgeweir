import { schema } from "@edgeweir/db";
import { count, desc, gt, sql } from "drizzle-orm";
import { createAccessKey, listAccessKeys, revokeAccessKey } from "../../services/access-keys";
import { serviceAccountMe, toMe } from "../../services/account";
import { listAttention } from "../../services/attention";
import { auditFacets, listAuditLogs } from "../../services/audit";
import { ONLINE_WINDOW_SECONDS } from "../../services/nodes";
import { toRevisionDto } from "../../services/revisions";
import {
  createServiceAccount,
  createServiceAccountKey,
  deleteServiceAccount,
  listServiceAccounts,
  revokeServiceAccountKey,
  updateServiceAccount,
} from "../../services/service-accounts";
import { isInitialized, runSetup } from "../../services/setup";
import { countSites } from "../../services/sites";
import { listUsage, usageChanges } from "../../services/usage";
import { authed, os } from "../base";

/** Setup, the operator's account and keys, service accounts, usage and the audit log. */
export const systemRouter = {
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
      const [[clusters], [nodes], [online], sites, revisions, attention] = await Promise.all([
        db.select({ n: count() }).from(schema.cluster),
        db.select({ n: count() }).from(schema.node),
        db.select({ n: count() }).from(schema.node).where(gt(schema.node.lastSeenAt, since)),
        countSites(db),
        db
          .select()
          .from(schema.configRevision)
          .orderBy(desc(schema.configRevision.createdAt))
          .limit(10),
        listAttention(context.app),
      ]);
      return {
        clusters: clusters?.n ?? 0,
        nodes: nodes?.n ?? 0,
        onlineNodes: online?.n ?? 0,
        sites,
        revisions: revisions.map(toRevisionDto),
        attention,
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
  auditLogs: {
    list: authed.auditLogs.list.handler(({ input, context }) =>
      listAuditLogs(context.app.db, input),
    ),
    facets: authed.auditLogs.facets.handler(({ context }) => auditFacets(context.app.db)),
  },
};
