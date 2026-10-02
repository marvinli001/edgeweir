import { isIP } from "node:net";
import {
  CC_LEVELS,
  type CcLevel,
  formatCidr,
  parseCidr,
  type SecurityEvent,
  type SecurityEventKind,
  type SiteSecurityState,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, count, desc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { isOnline } from "../lib/node-online";
import { getProtectionSettings } from "./protection";
import type { Executor } from "./revisions";
import { findSite } from "./sites";

/** Events a node reports per ReportSecurityEvents call. */
export const MAX_REPORTED_SECURITY_EVENTS = 500;
/** A cc_mitigation alert fires at most once per site in this window. */
export const CC_ALERT_THROTTLE_MS = 15 * 60 * 1000;
/** Addresses and paths kept per event. */
const MAX_TOP = 10;

export interface ReportedSecurityEvent {
  id: string;
  siteId: string;
  occurredAt: Date | null;
  kind: SecurityEventKind | null;
  level: string;
  previousLevel: string;
  path: string;
  address: string;
  metric: string;
  observed: number;
  threshold: number;
  topIps: { value: string; count: number }[];
  topPaths: { value: string; count: number }[];
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const METRIC_RE = /^[a-z0-9_]{1,32}$/;
const finite = (value: number) => (Number.isFinite(value) ? value : 0);
const clean = (value: string, max: number) => value.replace(/\p{Cc}/gu, "").slice(0, max);
const cleanPath = (value: string) => clean(value.split(/[?#]/, 1)[0] ?? "", 2048);
const isLevel = (value: string): value is CcLevel =>
  (CC_LEVELS as readonly string[]).includes(value);

/**
 * A client of a CC event: an IP address, or an IPv6 /64 (nodes since proto
 * v0.17.0 count and ban IPv6 clients by their /64), in canonical form; null
 * for anything else.
 */
function clientNetwork(value: string): string | null {
  if (isIP(value)) return value;
  const cidr = value.includes("/") ? parseCidr(value) : null;
  return cidr?.version === 6 && cidr.prefix === 64 ? formatCidr(cidr) : null;
}

function tops(values: { value: string; count: number }[], ip: boolean) {
  return values
    .flatMap((item) => {
      const value = ip ? clientNetwork(item.value.trim()) : cleanPath(item.value);
      if (!value) return [];
      return [{ value, count: Math.max(0, finite(item.count)) }];
    })
    .slice(0, MAX_TOP);
}

/** alert_state key of a site's cc_mitigation alert. */
export const ccAlertKey = (siteId: string) => `cc_mitigation/${siteId}/${siteId}`;

/**
 * Fires cc_mitigation for a site that left the normal level, unless it is
 * firing or fired within the last 15 minutes. A node's event raises it at
 * once; the alert sweep raises one that was held back, as soon as the 15
 * minutes are over while the site is still above normal, and resolves it
 * once no node reports the site above normal.
 */
export async function raiseCcAlert(
  tx: Executor,
  site: { id: string; name: string },
  now: Date,
): Promise<boolean> {
  const key = ccAlertKey(site.id);
  const [state] = await tx.select().from(schema.alertState).where(eq(schema.alertState.key, key));
  if (state?.active) return false;
  const [recent] = await tx
    .select({ id: schema.alertEvent.id })
    .from(schema.alertEvent)
    .where(
      and(
        eq(schema.alertEvent.siteId, site.id),
        eq(schema.alertEvent.kind, "cc_mitigation"),
        eq(schema.alertEvent.status, "firing"),
        gt(schema.alertEvent.occurredAt, new Date(now.getTime() - CC_ALERT_THROTTLE_MS)),
      ),
    )
    .limit(1);
  if (recent) return false;
  const [domain] = await tx
    .select({ name: schema.siteDomain.name })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, site.id))
    .limit(1);
  await tx
    .insert(schema.alertState)
    .values({
      key,
      siteId: site.id,
      kind: "cc_mitigation",
      resourceId: site.id,
      active: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: schema.alertState.key, set: { active: true, updatedAt: now } });
  await tx.insert(schema.alertEvent).values({
    siteId: site.id,
    kind: "cc_mitigation",
    resourceId: site.id,
    status: "firing",
    payload: { siteName: site.name, domain: domain?.name ?? "" },
    occurredAt: now,
  });
  return true;
}

/**
 * Stores CC mitigation events a node reported, idempotent by (node, event
 * id). Events of sites outside the node's cluster, with unknown kinds or
 * levels, invalid ids or addresses, or older than the retention are
 * skipped. A new site level event that leaves normal raises cc_mitigation.
 * Returns how many events were accepted (new or already stored).
 */
export async function reportSecurityEvents(
  db: Database,
  node: { id: string; clusterId: string },
  reported: ReportedSecurityEvent[],
  now = new Date(),
): Promise<number> {
  const { eventRetentionDays } = await getProtectionSettings(db);
  const oldest = now.getTime() - eventRetentionDays * 86400_000;
  const items = new Map<string, typeof schema.securityEvent.$inferInsert>();
  for (const event of reported) {
    if (!EVENT_ID_RE.test(event.id) || !UUID_RE.test(event.siteId) || !event.kind) continue;
    const at = event.occurredAt?.getTime() ?? now.getTime();
    if (!Number.isFinite(at) || at < oldest) continue;
    const levels = event.kind !== "ip_banned";
    if (levels && (!isLevel(event.level) || !isLevel(event.previousLevel))) continue;
    const address = event.kind === "ip_banned" ? clientNetwork(event.address.trim()) : "";
    if (address === null) continue;
    items.set(event.id, {
      nodeId: node.id,
      nodeEventId: event.id,
      siteId: event.siteId.toLowerCase(),
      occurredAt: new Date(Math.min(at, now.getTime())),
      receivedAt: now,
      kind: event.kind,
      level: levels ? event.level : "",
      previousLevel: levels ? event.previousLevel : "",
      path: event.kind === "path_level" ? cleanPath(event.path) : "",
      address,
      metric: METRIC_RE.test(event.metric) ? event.metric : "",
      observed: finite(event.observed),
      threshold: finite(event.threshold),
      topIps: tops(event.topIps, true),
      topPaths: tops(event.topPaths, false),
    });
  }
  if (items.size === 0) return 0;
  const siteIds = [...new Set([...items.values()].map((item) => item.siteId))];
  const sites = new Map(
    (
      await db
        .select({
          id: schema.site.id,
          name: schema.site.name,
        })
        .from(schema.site)
        .where(and(inArray(schema.site.id, siteIds), eq(schema.site.clusterId, node.clusterId)))
    ).map((site) => [site.id, site]),
  );
  const accepted = [...items.values()].flatMap((item) => {
    const site = sites.get(item.siteId);
    return site ? [item] : [];
  });
  if (accepted.length === 0) return 0;
  await db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.securityEvent)
      .values(accepted)
      .onConflictDoNothing({
        target: [schema.securityEvent.nodeId, schema.securityEvent.nodeEventId],
      })
      .returning({
        siteId: schema.securityEvent.siteId,
        kind: schema.securityEvent.kind,
        level: schema.securityEvent.level,
        previousLevel: schema.securityEvent.previousLevel,
      });
    const raised = new Set(
      inserted
        .filter(
          (e) => e.kind === "site_level" && e.previousLevel === "normal" && e.level !== "normal",
        )
        .map((e) => e.siteId),
    );
    for (const siteId of [...raised].sort()) {
      const site = sites.get(siteId);
      if (site) await raiseCcAlert(tx, site, now);
    }
  });
  return accepted.length;
}

/**
 * The CC state of a heartbeat as stored on the node row: known levels, valid
 * site ids; sites at normal only while some of their paths are escalated.
 */
export function toNodeSecurityState(
  security: { siteId: string; level: string; escalatedPaths: number }[],
): schema.NodeSiteSecurity[] {
  const seen = new Set<string>();
  return security
    .flatMap((entry) => {
      const siteId = entry.siteId.toLowerCase();
      if (!UUID_RE.test(siteId) || seen.has(siteId) || !isLevel(entry.level)) return [];
      const escalatedPaths = Math.max(
        0,
        Math.min(Math.trunc(finite(entry.escalatedPaths)), 1_000_000),
      );
      if (entry.level === "normal" && escalatedPaths === 0) return [];
      seen.add(siteId);
      return [{ siteId, level: entry.level, escalatedPaths }];
    })
    .slice(0, 2000);
}

/** Sites above normal on an online, active node (the cc_mitigation condition). */
export async function elevatedSites(db: Executor, now = Date.now()): Promise<Set<string>> {
  const nodes = await db
    .select({ lastSeenAt: schema.node.lastSeenAt, securityState: schema.node.securityState })
    .from(schema.node)
    .where(eq(schema.node.status, "active"));
  const elevated = new Set<string>();
  for (const node of nodes)
    if (isOnline(node.lastSeenAt, now))
      for (const entry of node.securityState)
        if (entry.level !== "normal") elevated.add(entry.siteId);
  // A raise reported moments ago counts until the next heartbeat carries it.
  // Literal conditions: they select the partial index security_event_raise_idx.
  const recent = await db
    .selectDistinct({ siteId: schema.securityEvent.siteId })
    .from(schema.securityEvent)
    .where(
      and(
        sql`${schema.securityEvent.kind} = 'site_level'`,
        sql`${schema.securityEvent.level} <> 'normal'`,
        gt(schema.securityEvent.receivedAt, new Date(now - 120_000)),
      ),
    );
  for (const row of recent) elevated.add(row.siteId);
  return elevated;
}

/** Current level of the site on every active node of its cluster, and recent heavy hitters. */
export async function siteSecurityState(
  db: Database,
  siteId: string,
  hours: number,
  now = new Date(),
): Promise<SiteSecurityState> {
  const site = await findSite(db, siteId);
  const nodes = await db
    .select({
      id: schema.node.id,
      name: schema.node.name,
      lastSeenAt: schema.node.lastSeenAt,
      securityState: schema.node.securityState,
    })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")))
    .orderBy(schema.node.name, schema.node.id);
  const since = new Date(now.getTime() - hours * 3600_000);
  const top = async (column: "top_ips" | "top_paths") =>
    (
      await db.execute<{ value: string; count: number | string }>(sql`
        select t.value, sum(t."count")::float8 as count
        from ${schema.securityEvent} e,
          jsonb_to_recordset(e.${sql.raw(column)}) as t(value text, "count" float8)
        where e.site_id = ${site.id} and e.occurred_at >= ${since.toISOString()}::timestamptz
        group by t.value order by count desc, t.value limit ${MAX_TOP}`)
    ).rows.map((row) => ({ value: row.value, count: Number(row.count) }));
  return {
    nodes: nodes.map((node) => {
      const entry = node.securityState.find((s) => s.siteId === site.id);
      return {
        id: node.id,
        name: node.name,
        online: isOnline(node.lastSeenAt, now.getTime()),
        level: entry && isLevel(entry.level) ? entry.level : "normal",
        escalatedPaths: entry?.escalatedPaths ?? 0,
        reportedAt: node.lastSeenAt?.toISOString() ?? null,
      };
    }),
    topIps: await top("top_ips"),
    topPaths: await top("top_paths"),
    hours,
  };
}

/** The site's events, newest first. */
export async function listSecurityEvents(
  db: Database,
  input: { id: string; kind?: SecurityEventKind; page: number; pageSize: number },
): Promise<{ items: SecurityEvent[]; total: number }> {
  const site = await findSite(db, input.id);
  const where = and(
    eq(schema.securityEvent.siteId, site.id),
    input.kind ? eq(schema.securityEvent.kind, input.kind) : undefined,
  );
  const [total] = await db.select({ n: count() }).from(schema.securityEvent).where(where);
  const rows = await db
    .select({ event: schema.securityEvent, nodeName: schema.node.name })
    .from(schema.securityEvent)
    .leftJoin(schema.node, eq(schema.node.id, schema.securityEvent.nodeId))
    .where(where)
    .orderBy(desc(schema.securityEvent.occurredAt), desc(schema.securityEvent.id))
    .limit(input.pageSize)
    .offset((input.page - 1) * input.pageSize);
  return {
    items: rows.map(({ event, nodeName }) => ({
      id: event.id,
      node: event.nodeId ? { id: event.nodeId, name: nodeName ?? "" } : null,
      occurredAt: event.occurredAt.toISOString(),
      kind: event.kind as SecurityEventKind,
      level: event.level,
      previousLevel: event.previousLevel,
      path: event.path,
      address: event.address,
      metric: event.metric,
      observed: event.observed,
      threshold: event.threshold,
      topIps: event.topIps,
      topPaths: event.topPaths,
    })),
    total: total?.n ?? 0,
  };
}

/** Deletes events older than the retention of the protection settings. */
export async function pruneSecurityEvents(db: Database, now = new Date()): Promise<number> {
  const { eventRetentionDays } = await getProtectionSettings(db);
  const deleted = await db
    .delete(schema.securityEvent)
    .where(
      lt(schema.securityEvent.occurredAt, new Date(now.getTime() - eventRetentionDays * 86400_000)),
    )
    .returning({ id: schema.securityEvent.id });
  return deleted.length;
}
