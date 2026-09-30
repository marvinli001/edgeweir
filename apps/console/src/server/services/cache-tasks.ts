import type {
  CacheTask,
  CacheTaskNodeState,
  CacheTaskState,
  CacheTaskType,
  cacheTaskCreateInput,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import {
  and,
  arrayContains,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  or,
  type SQL,
  sql,
} from "drizzle-orm";
import type * as z from "zod";
import { fail } from "../lib/errors";
import { TASKS_CHANNEL } from "../lib/events";
import { cleanErrorCode, cleanErrorParams, taskError } from "../lib/node-errors";
import { assertServing } from "../lib/site-state";
import { type Actor, recordAudit, systemActor } from "./audit";
import type { Executor } from "./revisions";
import type { SiteScope } from "./sites";

type CacheTaskCreate = z.output<typeof cacheTaskCreateInput>;
type TaskRow = typeof schema.cacheTask.$inferSelect;
type TaskNodeRow = typeof schema.cacheTaskNode.$inferSelect;

/** Undelivered tasks are handed out for as long as purged objects may live on a node. */
export const CACHE_TASK_TTL_MS = 7 * 24 * 3600 * 1000;
/** A task handed out without a result is handed out again after this long. */
export const CACHE_TASK_REDISPATCH_MS = 5 * 60 * 1000;

/**
 * One unit of work for the nodes of `clusterId`. Purge items carry the
 * normalized host, path and raw query; prefetch items the absolute URL.
 */
export interface CacheTaskItem {
  siteId: string;
  clusterId: string;
  type: "url" | "prefix" | "site" | "prefetch";
  host: string;
  path: string;
  query: string;
  url: string;
}

interface ParsedTarget {
  input: string;
  host: string;
  path: string;
  query: string;
  url: string;
}

/**
 * Parses an absolute http(s) URL. Prefixes must not carry a query string;
 * the fragment is dropped. The path keeps the percent-encoding of the WHATWG
 * URL parser, which is what nodes see in the request line.
 */
function parseTarget(input: string, type: CacheTaskType): ParsedTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!host) return null;
  if (type === "prefix" && url.search) return null;
  url.hash = "";
  return {
    input,
    host,
    path: url.pathname,
    query: url.search.replace(/^\?/, ""),
    url: url.toString(),
  };
}

function scopeFilter(scope: SiteScope) {
  return scope.all ? undefined : eq(schema.site.organizationId, scope.organizationId);
}

/** Maps host names to the sites (in scope) that serve them: exact domains win over wildcards. */
async function resolveHosts(db: Executor, hosts: string[], scope: SiteScope) {
  const parents = hosts.map((h) => h.slice(h.indexOf(".") + 1)).filter((p, i) => p !== hosts[i]);
  const rows = await db
    .select({
      name: schema.siteDomain.name,
      wildcard: schema.siteDomain.wildcard,
      siteId: schema.site.id,
      siteName: schema.site.name,
      clusterId: schema.site.clusterId,
      organizationId: schema.site.organizationId,
      enabled: schema.site.enabled,
      suspended: schema.site.suspended,
    })
    .from(schema.siteDomain)
    .innerJoin(schema.site, eq(schema.site.id, schema.siteDomain.siteId))
    .where(
      and(
        or(
          and(inArray(schema.siteDomain.name, hosts), eq(schema.siteDomain.wildcard, false)),
          parents.length
            ? and(inArray(schema.siteDomain.name, parents), eq(schema.siteDomain.wildcard, true))
            : undefined,
        ),
        scopeFilter(scope),
      ),
    );
  const resolved = new Map<string, (typeof rows)[number]>();
  for (const host of hosts) {
    const exact = rows.find((r) => !r.wildcard && r.name === host);
    const dot = host.indexOf(".");
    const wild =
      dot > 0 ? rows.find((r) => r.wildcard && r.name === host.slice(dot + 1)) : undefined;
    const match = exact ?? wild;
    if (match) resolved.set(host, match);
  }
  return resolved;
}

/** English text of a delivery skipped because its node was disabled (code node_disabled). */
export const NODE_DISABLED_MESSAGE = "skipped: the node is disabled";

function taskState(rows: Pick<TaskNodeRow, "state">[]): CacheTaskState {
  // Disabled nodes neither run the task nor hold it up.
  const nodes = rows.filter((n) => n.state !== "skipped");
  if (nodes.length === 0) return "succeeded";
  const finished = nodes.filter((n) => n.state === "succeeded" || n.state === "failed");
  if (finished.length === nodes.length) {
    return finished.some((n) => n.state === "failed") ? "failed" : "succeeded";
  }
  if (finished.length === 0 && nodes.every((n) => n.state === "pending")) return "pending";
  return "running";
}

async function toTaskDtos(db: Executor, rows: TaskRow[]): Promise<CacheTask[]> {
  if (rows.length === 0) return [];
  const nodes = await db
    .select()
    .from(schema.cacheTaskNode)
    .where(
      inArray(
        schema.cacheTaskNode.taskId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(schema.cacheTaskNode.nodeName);
  const siteIds = [...new Set(rows.flatMap((r) => r.siteIds))];
  const sites = siteIds.length
    ? await db
        .select({ id: schema.site.id, name: schema.site.name })
        .from(schema.site)
        .where(inArray(schema.site.id, siteIds))
    : [];
  return rows.map((r) => {
    const taskNodes = nodes.filter((n) => n.taskId === r.id);
    return {
      id: r.id,
      type: r.type as CacheTaskType,
      targets: r.targets,
      sites: r.siteIds.flatMap((id) => {
        const site = sites.find((s) => s.id === id);
        return site ? [site] : [];
      }),
      state: taskState(taskNodes),
      nodes: taskNodes.map((n) => {
        const error = taskError(n.errorCode, n.errorParams, n.message);
        return {
          nodeId: n.nodeId,
          nodeName: n.nodeName,
          state: n.state as CacheTaskNodeState,
          message: n.message,
          errorCode: error.code,
          errorParams: error.params,
          succeeded: n.succeeded,
          failed: n.failed,
          finishedAt: n.finishedAt?.toISOString() ?? null,
          recoveredAt: n.recoveredAt?.toISOString() ?? null,
        };
      }),
      source: r.source === "recovery" ? "recovery" : "user",
      createdByName: r.createdByName,
      createdAt: r.createdAt.toISOString(),
      finishedAt: r.finishedAt?.toISOString() ?? null,
    };
  });
}

/**
 * How many purge and prefetch requests one organization may make (N-H3):
 * nodes keep a marker per purged URL for days, so an unbounded stream of
 * purges would fill their purge store. Platform administrators are exempt,
 * and whole-site purges the console sends on its own (source "recovery")
 * do not count.
 */
export const CACHE_TASK_LIMITS = { tasksPerMinute: 10, urlsPerHour: 2000 } as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/**
 * Refuses a request of `count` targets (URLs, prefixes or sites) that would
 * take the organization over CACHE_TASK_LIMITS, with the seconds until it
 * would fit. Serialized per organization for the rest of the transaction.
 */
export async function assertCacheTaskQuota(
  tx: Executor,
  organizationId: string,
  count: number,
  now: Date,
) {
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtext(${`edgeweir.cache-task-quota.${organizationId}`}))`,
  );
  const recent = await tx
    .select({
      createdAt: schema.cacheTask.createdAt,
      targets: sql<number>`cardinality(${schema.cacheTask.targets})`.mapWith(Number),
    })
    .from(schema.cacheTask)
    .where(
      and(
        eq(schema.cacheTask.organizationId, organizationId),
        eq(schema.cacheTask.source, "user"),
        gt(schema.cacheTask.createdAt, new Date(now.getTime() - HOUR_MS)),
      ),
    )
    .orderBy(schema.cacheTask.createdAt);
  // The legacy site purge endpoint publishes a cache generation instead of
  // creating a typed task. Both entry points consume the same quota.
  const legacy = await tx
    .select({ createdAt: schema.auditLog.occurredAt })
    .from(schema.auditLog)
    .where(
      and(
        eq(schema.auditLog.organizationId, organizationId),
        eq(schema.auditLog.action, "site.purge_all"),
        sql`${schema.auditLog.metadata}->>'quotaLimited' = 'true'`,
        gt(schema.auditLog.occurredAt, new Date(now.getTime() - HOUR_MS)),
      ),
    );
  recent.push(...legacy.map((row) => ({ ...row, targets: 1 })));
  recent.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const { tasksPerMinute, urlsPerHour } = CACHE_TASK_LIMITS;
  let waitMs = 0;
  const lastMinute = recent.filter((r) => r.createdAt.getTime() > now.getTime() - MINUTE_MS);
  if (lastMinute.length >= tasksPerMinute) {
    // Until enough of them are older than a minute to make room for one more.
    const oldest = lastMinute[lastMinute.length - tasksPerMinute];
    waitMs = Math.max(
      waitMs,
      (oldest?.createdAt.getTime() ?? now.getTime()) + MINUTE_MS - now.getTime(),
    );
  }
  let used = recent.reduce((sum, r) => sum + r.targets, 0);
  if (used + count > urlsPerHour) {
    let until = now.getTime() + HOUR_MS;
    for (const r of recent) {
      used -= r.targets;
      if (used + count <= urlsPerHour) {
        until = r.createdAt.getTime() + HOUR_MS;
        break;
      }
    }
    waitMs = Math.max(waitMs, until - now.getTime());
  }
  if (waitMs > 0) {
    const retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    fail(
      "CACHE_TASK_RATE_LIMITED",
      `too many cache tasks: at most ${tasksPerMinute} per minute and ${urlsPerHour} URLs per hour per organization; retry in ${retryAfterSeconds} s`,
      { tasksPerMinute, urlsPerHour, retryAfterSeconds },
    );
  }
}

/**
 * Creates a purge or prefetch task: resolves URLs to sites (within the
 * caller's scope), fans the task out to every node of the affected clusters
 * and wakes their watch streams.
 */
export async function createCacheTask(
  db: Database,
  input: CacheTaskCreate,
  ctx: { scope: SiteScope; actor: Actor },
): Promise<CacheTask> {
  return db.transaction(async (tx) => {
    const items: CacheTaskItem[] = [];
    const targets: string[] = [];
    const siteMeta = new Map<string, { name: string; organizationId: string }>();

    if (input.type === "site") {
      const ids = [...new Set(input.siteIds)];
      const sites = await tx
        .select()
        .from(schema.site)
        .where(and(inArray(schema.site.id, ids), scopeFilter(ctx.scope)));
      if (sites.length !== ids.length) fail("SITE_NOT_FOUND", "site not found");
      for (const site of sites) assertServing(site);
      for (const site of sites) {
        siteMeta.set(site.id, { name: site.name, organizationId: site.organizationId });
        targets.push(site.name);
        items.push({
          siteId: site.id,
          clusterId: site.clusterId,
          type: "site",
          host: "",
          path: "",
          query: "",
          url: "",
        });
      }
    } else {
      const parsed: ParsedTarget[] = [];
      const invalid: string[] = [];
      for (const raw of new Set(input.urls)) {
        const target = parseTarget(raw, input.type);
        if (target) parsed.push(target);
        else invalid.push(raw);
      }
      if (invalid.length) {
        const urls = invalid.slice(0, 5).join(", ");
        fail("CACHE_TASK_URL_INVALID", `invalid URL: ${urls}`, { urls });
      }
      const resolved = await resolveHosts(tx, [...new Set(parsed.map((p) => p.host))], ctx.scope);
      const unknown = [...new Set(parsed.map((p) => p.host).filter((h) => !resolved.has(h)))];
      if (unknown.length) {
        const hosts = unknown.slice(0, 5).join(", ");
        fail("CACHE_TASK_HOST_UNKNOWN", `no site serves: ${hosts}`, { hosts });
      }
      for (const site of resolved.values()) assertServing(site);
      const seen = new Set<string>();
      for (const target of parsed) {
        const site = resolved.get(target.host);
        if (!site || seen.has(target.url)) continue;
        seen.add(target.url);
        siteMeta.set(site.siteId, { name: site.siteName, organizationId: site.organizationId });
        targets.push(target.url);
        items.push({
          siteId: site.siteId,
          clusterId: site.clusterId,
          type: input.type,
          host: target.host,
          path: target.path,
          query: input.type === "url" ? target.query : "",
          url: input.type === "prefetch" ? target.url : "",
        });
      }
    }

    // Platform administrators are exempt; tenants' scope is their organization.
    if (!ctx.scope.all) {
      await assertCacheTaskQuota(tx, ctx.scope.organizationId, targets.length, new Date());
    }
    const organizations = [...new Set([...siteMeta.values()].map((s) => s.organizationId))];
    const clusterIds = [...new Set(items.map((i) => i.clusterId))];
    const nodes = await tx
      .select({
        id: schema.node.id,
        name: schema.node.name,
        clusterId: schema.node.clusterId,
        status: schema.node.status,
      })
      .from(schema.node)
      .where(inArray(schema.node.clusterId, clusterIds));
    // Only enabled nodes get the task; disabled ones are listed as skipped.
    const active = nodes.filter((n) => n.status === "active");
    const now = new Date();
    const [task] = await tx
      .insert(schema.cacheTask)
      .values({
        organizationId: organizations.length === 1 ? (organizations[0] ?? null) : null,
        type: input.type,
        targets,
        siteIds: [...siteMeta.keys()],
        payload: items as unknown as Record<string, string>[],
        createdByUserId:
          ctx.actor.type === "user" || ctx.actor.type === "api_key" ? ctx.actor.id : null,
        createdByName: ctx.actor.name ?? "",
        finishedAt: active.length === 0 ? now : null,
      })
      .returning();
    if (!task) throw new Error("cache task insert failed");
    if (nodes.length) {
      await tx.insert(schema.cacheTaskNode).values(
        nodes.map((n) => ({
          taskId: task.id,
          nodeId: n.id,
          clusterId: n.clusterId,
          nodeName: n.name,
          ...(n.status === "active"
            ? {}
            : {
                state: "skipped",
                message: NODE_DISABLED_MESSAGE,
                errorCode: "node_disabled",
                finishedAt: now,
              }),
        })),
      );
    }
    if (active.length) {
      await tx.execute(sql`select pg_notify(${TASKS_CHANNEL}, ${JSON.stringify({ clusterIds })})`);
    }
    await recordAudit(tx, ctx.actor, {
      action: `cache.${input.type === "prefetch" ? "prefetch" : "purge"}`,
      organizationId: task.organizationId,
      targetType: "cache_task",
      targetId: task.id,
      targetName: targets.length === 1 ? (targets[0] ?? "") : `${targets.length} × ${input.type}`,
      metadata: {
        type: input.type,
        targets: targets.slice(0, 20),
        count: targets.length,
        sites: [...siteMeta.values()].map((s) => s.name),
        nodes: active.length,
        skippedNodes: nodes.length - active.length,
      },
    });
    const [dto] = await toTaskDtos(tx, [task]);
    if (!dto) throw new Error("cache task not readable after insert");
    return dto;
  });
}

function taskScope(scope: SiteScope): SQL | undefined {
  return scope.all ? undefined : eq(schema.cacheTask.organizationId, scope.organizationId);
}

export async function listCacheTasks(
  db: Database,
  scope: SiteScope,
  query: { siteId?: string; page: number; pageSize: number },
): Promise<{ items: CacheTask[]; total: number }> {
  const where = and(
    taskScope(scope),
    query.siteId ? arrayContains(schema.cacheTask.siteIds, [query.siteId]) : undefined,
  );
  const [total] = await db.select({ n: count() }).from(schema.cacheTask).where(where);
  const rows = await db
    .select()
    .from(schema.cacheTask)
    .where(where)
    .orderBy(desc(schema.cacheTask.createdAt), desc(schema.cacheTask.id))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);
  return { items: await toTaskDtos(db, rows), total: total?.n ?? 0 };
}

export async function getCacheTask(db: Database, id: string, scope: SiteScope): Promise<CacheTask> {
  const [row] = await db
    .select()
    .from(schema.cacheTask)
    .where(and(eq(schema.cacheTask.id, id), taskScope(scope)));
  if (!row) fail("CACHE_TASK_NOT_FOUND", "cache task not found");
  const [dto] = await toTaskDtos(db, [row]);
  if (!dto) fail("CACHE_TASK_NOT_FOUND", "cache task not found");
  return dto;
}

/** Tasks waiting for a node: pending, or handed out without a result for too long. */
function deliverable(nodeId: string, now: Date) {
  return and(
    eq(schema.cacheTaskNode.nodeId, nodeId),
    or(
      eq(schema.cacheTaskNode.state, "pending"),
      and(
        eq(schema.cacheTaskNode.state, "running"),
        lt(schema.cacheTaskNode.dispatchedAt, new Date(now.getTime() - CACHE_TASK_REDISPATCH_MS)),
      ),
    ),
  );
}

/** Purge types: a purge a node missed leaves stale objects in its cache. */
const PURGE_TYPES = ["url", "prefix", "site"];

/**
 * Purges an enabled node missed: never executed within CACHE_TASK_TTL_MS
 * (task_expired) or skipped while it was disabled (node_disabled), and not
 * made up yet.
 */
function missedPurges(nodeId: string) {
  return and(
    eq(schema.cacheTaskNode.nodeId, nodeId),
    isNull(schema.cacheTaskNode.recoveredAt),
    or(
      and(
        eq(schema.cacheTaskNode.state, "failed"),
        eq(schema.cacheTaskNode.errorCode, "task_expired"),
      ),
      and(
        eq(schema.cacheTaskNode.state, "skipped"),
        eq(schema.cacheTaskNode.errorCode, "node_disabled"),
      ),
    ),
    inArray(schema.cacheTask.type, PURGE_TYPES),
    eq(schema.node.status, "active"),
  );
}

/** Whether a node has tasks to pull: deliverable ones, or missed purges to make up. */
export async function hasDeliverableTasks(db: Executor, nodeId: string): Promise<boolean> {
  const [row] = await db
    .select({ n: count() })
    .from(schema.cacheTaskNode)
    .where(deliverable(nodeId, new Date()));
  if ((row?.n ?? 0) > 0) return true;
  const [missed] = await db
    .select({ n: count() })
    .from(schema.cacheTaskNode)
    .innerJoin(schema.cacheTask, eq(schema.cacheTask.id, schema.cacheTaskNode.taskId))
    .innerJoin(schema.node, eq(schema.node.id, schema.cacheTaskNode.nodeId))
    .where(missedPurges(nodeId));
  return (missed?.n ?? 0) > 0;
}

/**
 * N-M4: a node that comes back after purges expired unexecuted (or were
 * skipped while it was disabled) still holds the objects they should have
 * removed. For every site those purges touched, it gets one whole-site purge
 * (one task per organization, only for this node, source "recovery"), and
 * the missed deliveries are flagged with recovered_at so this happens once.
 */
async function recoverMissedPurges(
  tx: Executor,
  node: { id: string; clusterId: string },
  now: Date,
): Promise<number> {
  const missed = await tx
    .select({
      taskId: schema.cacheTaskNode.taskId,
      payload: schema.cacheTask.payload,
      nodeName: schema.node.name,
    })
    .from(schema.cacheTaskNode)
    .innerJoin(schema.cacheTask, eq(schema.cacheTask.id, schema.cacheTaskNode.taskId))
    .innerJoin(schema.node, eq(schema.node.id, schema.cacheTaskNode.nodeId))
    .where(missedPurges(node.id))
    .for("update", { of: schema.cacheTaskNode, skipLocked: true });
  if (missed.length === 0) return 0;
  const nodeName = missed[0]?.nodeName ?? "";
  const siteIds = [
    ...new Set(
      missed.flatMap((m) =>
        (m.payload as unknown as CacheTaskItem[])
          .filter((i) => i.clusterId === node.clusterId)
          .map((i) => i.siteId),
      ),
    ),
  ];
  // Sites deleted since, or moved to another cluster, are no longer on this node.
  const sites = siteIds.length
    ? await tx
        .select({
          id: schema.site.id,
          name: schema.site.name,
          organizationId: schema.site.organizationId,
        })
        .from(schema.site)
        .where(and(inArray(schema.site.id, siteIds), eq(schema.site.clusterId, node.clusterId)))
        .orderBy(schema.site.name)
    : [];
  const byOrganization = new Map<string, typeof sites>();
  for (const site of sites) {
    byOrganization.set(site.organizationId, [
      ...(byOrganization.get(site.organizationId) ?? []),
      site,
    ]);
  }
  const missedTasks = missed.map((m) => m.taskId);
  for (const [organizationId, orgSites] of byOrganization) {
    const items: CacheTaskItem[] = orgSites.map((site) => ({
      siteId: site.id,
      clusterId: node.clusterId,
      type: "site",
      host: "",
      path: "",
      query: "",
      url: "",
    }));
    const targets = orgSites.map((s) => s.name);
    const [task] = await tx
      .insert(schema.cacheTask)
      .values({
        organizationId,
        type: "site",
        source: "recovery",
        targets,
        siteIds: orgSites.map((s) => s.id),
        payload: items as unknown as Record<string, string>[],
        createdAt: now,
      })
      .returning();
    if (!task) throw new Error("recovery task insert failed");
    await tx
      .insert(schema.cacheTaskNode)
      .values({ taskId: task.id, nodeId: node.id, clusterId: node.clusterId, nodeName });
    await recordAudit(tx, systemActor, {
      action: "cache.purge",
      organizationId,
      targetType: "cache_task",
      targetId: task.id,
      targetName: targets.length === 1 ? (targets[0] ?? "") : `${targets.length} × site`,
      metadata: {
        type: "site",
        recovery: true,
        nodeId: node.id,
        node: nodeName,
        sites: targets,
        missedTasks: missedTasks.slice(0, 20),
        missedCount: missedTasks.length,
      },
    });
  }
  await tx
    .update(schema.cacheTaskNode)
    .set({ recoveredAt: now })
    .where(
      and(
        eq(schema.cacheTaskNode.nodeId, node.id),
        inArray(schema.cacheTaskNode.taskId, missedTasks),
      ),
    );
  return byOrganization.size;
}

/**
 * Hands out the oldest deliverable tasks of a node and marks them running.
 * Only the items for the node's cluster are returned. Purges older than
 * CACHE_TASK_TTL_MS are not run any more: they expire, and together with
 * purges skipped while the node was disabled they are made up with
 * whole-site purges (recoverMissedPurges).
 */
export async function pullCacheTasks(
  db: Database,
  node: { id: string; clusterId: string },
  max: number,
): Promise<{ id: string; type: string; createdAt: Date; items: CacheTaskItem[] }[]> {
  const now = new Date();
  return db.transaction(async (tx) => {
    await expireDeliveries(tx, now, node.id);
    await recoverMissedPurges(tx, node, now);
    const rows = await tx
      .select({ task: schema.cacheTask })
      .from(schema.cacheTaskNode)
      .innerJoin(schema.cacheTask, eq(schema.cacheTask.id, schema.cacheTaskNode.taskId))
      .where(deliverable(node.id, now))
      .orderBy(schema.cacheTask.createdAt)
      .limit(max)
      .for("update", { of: schema.cacheTaskNode, skipLocked: true });
    if (rows.length === 0) return [];
    await tx
      .update(schema.cacheTaskNode)
      .set({ state: "running", dispatchedAt: now })
      .where(
        and(
          eq(schema.cacheTaskNode.nodeId, node.id),
          inArray(
            schema.cacheTaskNode.taskId,
            rows.map((r) => r.task.id),
          ),
        ),
      );
    return rows.map(({ task }) => ({
      id: task.id,
      type: task.type,
      createdAt: task.createdAt,
      items: (task.payload as unknown as CacheTaskItem[]).filter(
        (i) => i.clusterId === node.clusterId,
      ),
    }));
  });
}

/** Records a node's result; the task finishes once every node reported. */
export async function reportCacheTaskResult(
  db: Database,
  node: { id: string },
  result: {
    taskId: string;
    state: "succeeded" | "failed";
    message: string;
    /** Stable code of the outcome (nodes before v0.2.1 send none). */
    errorCode?: string;
    errorParams?: Record<string, string>;
    succeeded: number;
    failed: number;
    finishedAt: Date;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(schema.cacheTaskNode)
      .set({
        state: result.state,
        message: result.message.slice(0, 2000),
        errorCode: cleanErrorCode(result.errorCode),
        errorParams: cleanErrorParams(result.errorParams),
        succeeded: result.succeeded,
        failed: result.failed,
        finishedAt: result.finishedAt,
      })
      .where(
        and(
          eq(schema.cacheTaskNode.taskId, result.taskId),
          eq(schema.cacheTaskNode.nodeId, node.id),
          inArray(schema.cacheTaskNode.state, ["pending", "running"]),
        ),
      )
      .returning({ taskId: schema.cacheTaskNode.taskId });
    if (updated.length === 0) return false;
    await finishIfDone(tx, [result.taskId]);
    return true;
  });
}

async function finishIfDone(tx: Executor, taskIds: string[]) {
  if (taskIds.length === 0) return;
  await tx
    .update(schema.cacheTask)
    .set({ finishedAt: new Date() })
    .where(
      and(
        inArray(schema.cacheTask.id, taskIds),
        sql`${schema.cacheTask.finishedAt} is null`,
        sql`not exists (select 1 from ${schema.cacheTaskNode} where ${schema.cacheTaskNode.taskId} = ${schema.cacheTask.id} and ${schema.cacheTaskNode.state} in ('pending', 'running'))`,
      ),
    );
}

/**
 * Marks the unfinished deliveries of a node that is being disabled as
 * skipped (node_disabled) instead of leaving them pending or running until
 * they expire; tasks that only waited for this node finish. Runs in the
 * transaction that disables the node.
 */
export async function skipNodeTasks(tx: Executor, nodeId: string, now = new Date()) {
  const skipped = await tx
    .update(schema.cacheTaskNode)
    .set({
      state: "skipped",
      message: NODE_DISABLED_MESSAGE,
      errorCode: "node_disabled",
      errorParams: {},
      finishedAt: now,
    })
    .where(
      and(
        eq(schema.cacheTaskNode.nodeId, nodeId),
        inArray(schema.cacheTaskNode.state, ["pending", "running"]),
      ),
    )
    .returning({ taskId: schema.cacheTaskNode.taskId });
  await finishIfDone(tx, [...new Set(skipped.map((s) => s.taskId))]);
  return skipped.length;
}

/** English text of a delivery that expired unexecuted (code task_expired). */
export const TASK_EXPIRED_MESSAGE = "expired: the node did not report a result";

/**
 * Fails the unfinished deliveries (of one node, or all) of tasks older than
 * CACHE_TASK_TTL_MS with task_expired; the tasks finish once nothing is left.
 */
async function expireDeliveries(tx: Executor, now: Date, nodeId?: string): Promise<number> {
  const cutoff = new Date(now.getTime() - CACHE_TASK_TTL_MS);
  const expired = await tx
    .update(schema.cacheTaskNode)
    .set({
      state: "failed",
      message: TASK_EXPIRED_MESSAGE,
      errorCode: "task_expired",
      errorParams: {},
      finishedAt: now,
    })
    .where(
      and(
        nodeId ? eq(schema.cacheTaskNode.nodeId, nodeId) : undefined,
        inArray(schema.cacheTaskNode.state, ["pending", "running"]),
        inArray(
          schema.cacheTaskNode.taskId,
          tx
            .select({ id: schema.cacheTask.id })
            .from(schema.cacheTask)
            .where(lt(schema.cacheTask.createdAt, cutoff)),
        ),
      ),
    )
    .returning({ taskId: schema.cacheTaskNode.taskId });
  await finishIfDone(tx, [...new Set(expired.map((e) => e.taskId))]);
  return expired.length;
}

/**
 * Fails deliveries that no node ran within CACHE_TASK_TTL_MS (node offline);
 * missed purges are made up when the node pulls tasks again.
 */
export async function expireCacheTasks(db: Database, now = new Date()): Promise<number> {
  return db.transaction((tx) => expireDeliveries(tx, now));
}
