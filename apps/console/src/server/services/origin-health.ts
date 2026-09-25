import type { OriginHealth } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, gt, inArray } from "drizzle-orm";
import { cleanErrorCode, cleanErrorParams, originError } from "../lib/node-errors";
import { ONLINE_WINDOW_SECONDS } from "./nodes";
import type { Executor } from "./revisions";
import { findSite, type SiteScope } from "./sites";

export interface ReportedOriginHealth {
  siteId: string;
  originId: string;
  healthy: boolean;
  consecutiveFailures: number;
  lastError: string;
  /** Stable code of the last failure (nodes before v0.2.1 send none). */
  lastErrorCode?: string;
  lastErrorParams?: Record<string, string>;
  lastFailureAt: Date | null;
  downUntil: Date | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Replaces the origin health a node reported. Nodes only list origins that
 * failed recently; everything else counts as healthy. Entries for origins
 * outside the node's cluster (or already deleted) are dropped.
 */
export async function replaceOriginHealth(
  tx: Executor,
  node: { id: string; clusterId: string },
  reports: ReportedOriginHealth[],
  now = new Date(),
): Promise<number> {
  await tx.delete(schema.originHealth).where(eq(schema.originHealth.nodeId, node.id));
  const ids = [...new Set(reports.map((r) => r.originId).filter((id) => UUID_RE.test(id)))];
  if (ids.length === 0) return 0;
  const known = await tx
    .select({ originId: schema.origin.id, siteId: schema.site.id })
    .from(schema.origin)
    .innerJoin(schema.originPool, eq(schema.originPool.id, schema.origin.poolId))
    .innerJoin(schema.site, eq(schema.site.id, schema.originPool.siteId))
    .where(and(inArray(schema.origin.id, ids), eq(schema.site.clusterId, node.clusterId)));
  const siteOf = new Map(known.map((k) => [k.originId, k.siteId]));
  const seen = new Set<string>();
  const values = reports.flatMap((r) => {
    const siteId = siteOf.get(r.originId);
    if (!siteId || seen.has(r.originId)) return [];
    seen.add(r.originId);
    return [
      {
        nodeId: node.id,
        originId: r.originId,
        siteId,
        healthy: r.healthy,
        consecutiveFailures: r.consecutiveFailures,
        lastError: r.lastError.slice(0, 500),
        lastErrorCode: cleanErrorCode(r.lastErrorCode),
        lastErrorParams: cleanErrorParams(r.lastErrorParams),
        lastFailureAt: r.lastFailureAt,
        downUntil: r.downUntil,
        reportedAt: now,
      },
    ];
  });
  if (values.length) await tx.insert(schema.originHealth).values(values);
  return values.length;
}

/**
 * Health of a site's origins across the online nodes of its cluster. An
 * origin is down on a node while that node's latest report marks it down.
 */
export async function siteOriginHealth(
  db: Database,
  siteId: string,
  scope: SiteScope,
): Promise<OriginHealth[]> {
  const site = await findSite(db, siteId, scope);
  const since = new Date(Date.now() - ONLINE_WINDOW_SECONDS * 1000);
  const onlineNodes = await db
    .select({ id: schema.node.id, name: schema.node.name })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), gt(schema.node.lastSeenAt, since)));
  const origins = await db
    .select({ id: schema.origin.id })
    .from(schema.origin)
    .innerJoin(schema.originPool, eq(schema.originPool.id, schema.origin.poolId))
    .where(eq(schema.originPool.siteId, site.id));
  const reports = await db
    .select()
    .from(schema.originHealth)
    .where(eq(schema.originHealth.siteId, site.id));
  const online = new Map(onlineNodes.map((n) => [n.id, n.name]));
  const error = (r: (typeof reports)[number] | undefined) => {
    const e = originError(r?.lastErrorCode ?? "", r?.lastErrorParams ?? {}, r?.lastError ?? "");
    return { lastError: r?.lastError ?? "", lastErrorCode: e.code, lastErrorParams: e.params };
  };
  return origins.map((o) => {
    const rows = reports.filter((r) => r.originId === o.id && online.has(r.nodeId));
    const last = rows
      .filter((r) => r.lastFailureAt)
      .sort((a, b) => (b.lastFailureAt?.getTime() ?? 0) - (a.lastFailureAt?.getTime() ?? 0))[0];
    return {
      originId: o.id,
      downNodes: rows.filter((r) => !r.healthy).length,
      onlineNodes: onlineNodes.length,
      ...error(last),
      lastFailureAt: last?.lastFailureAt?.toISOString() ?? null,
      nodes: rows.map((r) => ({
        nodeId: r.nodeId,
        nodeName: online.get(r.nodeId) ?? "",
        healthy: r.healthy,
        consecutiveFailures: r.consecutiveFailures,
        ...error(r),
        lastFailureAt: r.lastFailureAt?.toISOString() ?? null,
        downUntil: r.downUntil?.toISOString() ?? null,
        reportedAt: r.reportedAt.toISOString(),
      })),
    };
  });
}
