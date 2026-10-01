import type { AuditLogEntry } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, count, desc, eq, gte, inArray, lte, type SQL } from "drizzle-orm";
import type { Executor } from "./revisions";

export interface Actor {
  type: "user" | "api_key" | "service_account" | "node" | "probe" | "system";
  id: string;
  /** Display name at the time of the action (user name, node name ...). */
  name?: string;
  ip?: string;
  userAgent?: string;
}

export const systemActor: Actor = { type: "system", id: "", name: "system" };

/** Appends an entry to the audit log. Every management action goes through here. */
export async function recordAudit(
  db: Executor,
  actor: Actor,
  entry: {
    action: string;
    targetType?: string;
    targetId?: string;
    /** Display name of the target, kept so the entry stays readable after deletion. */
    targetName?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  await db.insert(schema.auditLog).values({
    actorType: actor.type,
    actorId: actor.id,
    actorName: (actor.name ?? "").slice(0, 200),
    ip: actor.ip ?? "",
    userAgent: (actor.userAgent ?? "").slice(0, 512),
    action: entry.action,
    targetType: entry.targetType ?? "",
    targetId: entry.targetId ?? "",
    targetName: (entry.targetName ?? "").slice(0, 200),
    metadata: entry.metadata ?? {},
  });
}

export interface AuditQuery {
  action?: string;
  targetType?: string;
  from?: string;
  to?: string;
  limit: number;
  offset: number;
}

/**
 * Loads current display names for ids whose entries were written without one
 * (entries from before names were recorded).
 */
async function resolveNames(
  db: Database,
  rows: (typeof schema.auditLog.$inferSelect)[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  const ids = (types: string[], pick: "actor" | "target") => [
    ...new Set(
      rows
        .filter((r) =>
          pick === "actor"
            ? !r.actorName && types.includes(r.actorType)
            : !r.targetName && types.includes(r.targetType),
        )
        .map((r) => (pick === "actor" ? r.actorId : r.targetId))
        .filter(Boolean),
    ),
  ];
  const userIds = [...ids(["user", "api_key"], "actor"), ...ids(["user"], "target")];
  const nodeIds = [...ids(["node"], "actor"), ...ids(["node"], "target")].filter(isUuid);
  const siteIds = ids(["site"], "target").filter(isUuid);
  const clusterIds = ids(["cluster"], "target").filter(isUuid);
  if (userIds.length) {
    for (const u of await db
      .select({ id: schema.user.id, name: schema.user.name })
      .from(schema.user)
      .where(inArray(schema.user.id, userIds)))
      names.set(`user:${u.id}`, u.name);
  }
  if (nodeIds.length) {
    for (const n of await db
      .select({ id: schema.node.id, name: schema.node.name })
      .from(schema.node)
      .where(inArray(schema.node.id, nodeIds)))
      names.set(`node:${n.id}`, n.name);
  }
  if (siteIds.length) {
    for (const s of await db
      .select({ id: schema.site.id, name: schema.site.name })
      .from(schema.site)
      .where(inArray(schema.site.id, siteIds)))
      names.set(`site:${s.id}`, s.name);
  }
  if (clusterIds.length) {
    for (const c of await db
      .select({ id: schema.cluster.id, name: schema.cluster.name })
      .from(schema.cluster)
      .where(inArray(schema.cluster.id, clusterIds)))
      names.set(`cluster:${c.id}`, c.name);
  }
  return names;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value: string) => UUID_RE.test(value);

export async function listAuditLogs(
  db: Database,
  query: AuditQuery,
): Promise<{ items: AuditLogEntry[]; total: number }> {
  const a = schema.auditLog;
  const filters: SQL[] = [];
  if (query.action) filters.push(eq(a.action, query.action));
  if (query.targetType) filters.push(eq(a.targetType, query.targetType));
  if (query.from) filters.push(gte(a.occurredAt, new Date(query.from)));
  if (query.to) filters.push(lte(a.occurredAt, new Date(query.to)));
  const where = filters.length ? and(...filters) : undefined;
  const [[total], rows] = await Promise.all([
    db.select({ n: count() }).from(a).where(where),
    db.select().from(a).where(where).orderBy(desc(a.id)).limit(query.limit).offset(query.offset),
  ]);
  const names = await resolveNames(db, rows);
  const nameOf = (type: string, id: string) =>
    names.get(`${type === "api_key" ? "user" : type}:${id}`) ?? "";
  return {
    total: total?.n ?? 0,
    items: rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurredAt.toISOString(),
      actorType: r.actorType,
      actorId: r.actorId,
      actorName: r.actorName || nameOf(r.actorType, r.actorId),
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      targetName: r.targetName || nameOf(r.targetType, r.targetId),
      metadata: r.metadata,
    })),
  };
}

/** Distinct actions and target types, for the audit log filters. */
export async function auditFacets(
  db: Database,
): Promise<{ actions: string[]; targetTypes: string[] }> {
  const a = schema.auditLog;
  const [actions, targetTypes] = await Promise.all([
    db.selectDistinct({ v: a.action }).from(a).orderBy(a.action),
    db.selectDistinct({ v: a.targetType }).from(a).orderBy(a.targetType),
  ]);
  return {
    actions: actions.map((r) => r.v),
    targetTypes: targetTypes.map((r) => r.v).filter(Boolean),
  };
}
