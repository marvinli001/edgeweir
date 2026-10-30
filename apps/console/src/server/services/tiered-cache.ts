import {
  chooseTiers,
  type TierCandidate,
  type TieredCacheModel,
  type TierHopModel,
  tierTargetId,
} from "@edgeweir/config-compiler";
import {
  type AnalyticsRange,
  nodeSupportsFeature,
  SITE_TIERED_CACHE_DEFAULTS,
  type SiteTieredCacheSettings,
  siteTieredCacheSettings,
  TIER_HIT_STATUSES,
  TIER_UPPER_FEATURE,
  TIERED_CACHE_DEFAULTS,
  TIERED_CACHE_FEATURE,
  type TieredCacheSettings,
  type TierIdleReason,
  type TierSelection,
  type TierStats,
  type TierTopology,
  tieredCacheSettings,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import { lockClusterPublish } from "../lib/locks";
import { rangeWindow, sourceFor } from "./analytics";
import { type Actor, systemActor } from "./audit";
import { nodeIpRows, schedulingAddressesOf } from "./node-addresses";
import { type Executor, publishClusters, publishRevision, type Tx } from "./revisions";
import { defineSetting } from "./settings";
import { publishSiteChange } from "./site-change";
import { findSite } from "./sites";

/**
 * Tiered cache (ADR-0073): the console-wide topology and each site's, the
 * upper tiers chosen per site (tier_selection, with hysteresis) from the
 * nodes' round trip times to the sites' origins (tier_latency), and the
 * model compiled into NodeConfig.tiered_cache.
 */

const tieredCacheSetting = defineSetting({
  key: "tiered_cache",
  schema: tieredCacheSettings,
  defaults: TIERED_CACHE_DEFAULTS as TieredCacheSettings,
  auditAction: "system.tiered_cache_update",
  targetName: "tiered_cache",
});

export const getTieredCache = tieredCacheSetting.read;

/** Measurements older than this do not count (a node measures every minute). */
const TIER_LATENCY_MAX_AGE_MS = 10 * 60_000;
/** Nodes not seen for this long take no part. */
const TIER_NODE_MAX_SILENCE_MS = 10 * 60_000;

export function readSiteTieredCache(stored: unknown): SiteTieredCacheSettings {
  if (!stored || typeof stored !== "object")
    return { ...SITE_TIERED_CACHE_DEFAULTS, upperNodeIds: [], upperNodeGroupIds: [] };
  const parsed = siteTieredCacheSettings.safeParse({ ...SITE_TIERED_CACHE_DEFAULTS, ...stored });
  return parsed.success
    ? parsed.data
    : { ...SITE_TIERED_CACHE_DEFAULTS, upperNodeIds: [], upperNodeGroupIds: [] };
}

interface Effective {
  topology: TierTopology;
  inherited: boolean;
  upperNodeIds: readonly string[];
  upperNodeGroupIds: readonly string[];
}

function effective(site: SiteTieredCacheSettings, global: TieredCacheSettings): Effective {
  if (site.topology === "inherit")
    return {
      topology: global.topology,
      inherited: true,
      upperNodeIds: global.upperNodeIds,
      upperNodeGroupIds: global.upperNodeGroupIds,
    };
  return {
    topology: site.topology,
    inherited: false,
    upperNodeIds: site.upperNodeIds,
    upperNodeGroupIds: site.upperNodeGroupIds,
  };
}

/** The address lower tiers reach a node at: its first primary scheduling address, IPv4 first. */
export function tierAddressOf(rows: Parameters<typeof schedulingAddressesOf>[0]): string {
  const primary = schedulingAddressesOf(rows).filter((a) => a.level === 0);
  return (primary.find((a) => !a.address.includes(":")) ?? primary[0])?.address ?? "";
}

interface TierNodeRow {
  id: string;
  name: string;
  regionId: string | null;
  regionName: string | null;
  nodeGroupId: string | null;
  features: string[];
  lastSeenAt: Date | null;
}

/** A cluster's active nodes, the ones taking part as candidates, their addresses and latencies. */
async function loadTierNodes(db: Executor, clusterId: string, now: number) {
  const nodes: TierNodeRow[] = await db
    .select({
      id: schema.node.id,
      name: schema.node.name,
      regionId: schema.nodeGroup.regionId,
      regionName: schema.region.name,
      nodeGroupId: schema.node.nodeGroupId,
      features: schema.node.supportedFeatures,
      lastSeenAt: schema.node.lastSeenAt,
    })
    .from(schema.node)
    .leftJoin(schema.nodeGroup, eq(schema.nodeGroup.id, schema.node.nodeGroupId))
    .leftJoin(schema.region, eq(schema.region.id, schema.nodeGroup.regionId))
    .where(and(eq(schema.node.clusterId, clusterId), eq(schema.node.status, "active")))
    .orderBy(asc(schema.node.id));
  const participants = nodes.filter(
    (n) =>
      nodeSupportsFeature(n.features, TIERED_CACHE_FEATURE) &&
      !!n.lastSeenAt &&
      now - n.lastSeenAt.getTime() <= TIER_NODE_MAX_SILENCE_MS,
  );
  const ips = await nodeIpRows(
    db,
    participants.map((n) => n.id),
  );
  const addresses: Record<string, string> = {};
  for (const n of participants) addresses[n.id] = tierAddressOf(ips.get(n.id) ?? []);
  const candidates: TierCandidate[] = participants.map((n) => ({
    id: n.id,
    regionId: n.regionId,
    upper: nodeSupportsFeature(n.features, TIER_UPPER_FEATURE) && addresses[n.id] !== "",
    groupIds: n.nodeGroupId ? [n.nodeGroupId] : [],
  }));
  const latencyRows = participants.length
    ? await db
        .select()
        .from(schema.tierLatency)
        .where(
          and(
            inArray(
              schema.tierLatency.nodeId,
              participants.map((n) => n.id),
            ),
            eq(schema.tierLatency.ok, true),
            gt(schema.tierLatency.measuredAt, new Date(now - TIER_LATENCY_MAX_AGE_MS)),
          ),
        )
    : [];
  const latency = new Map<string, number>();
  for (const row of latencyRows) latency.set(`${row.nodeId}|${row.targetId}`, row.rttMs);
  const rttFor = (targetId: string) => (nodeId: string) =>
    targetId ? (latency.get(`${nodeId}|${targetId}`) ?? null) : null;
  return { nodes, candidates, addresses, rttFor };
}

interface TierSite {
  id: string;
  name: string;
  enabled: boolean;
  settings: Effective;
  /** The default origin group's first primary origin; null without one. */
  target: { id: string; host: string; port: number } | null;
}

/** The cluster's sites with their effective topology and latency target. */
async function loadTierSites(db: Executor, clusterId: string): Promise<TierSite[]> {
  const global = await getTieredCache(db);
  const sites = await db
    .select({
      id: schema.site.id,
      name: schema.site.name,
      enabled: schema.site.enabled,
      tieredCache: schema.site.tieredCache,
    })
    .from(schema.site)
    .where(eq(schema.site.clusterId, clusterId))
    .orderBy(asc(schema.site.id));
  const ids = sites.map((s) => s.id);
  const origins = ids.length
    ? await db
        .select({
          siteId: schema.originPool.siteId,
          address: schema.origin.address,
          port: schema.origin.port,
        })
        .from(schema.origin)
        .innerJoin(schema.originPool, eq(schema.originPool.id, schema.origin.poolId))
        .where(
          and(
            inArray(schema.originPool.siteId, ids),
            eq(schema.origin.groupName, ""),
            eq(schema.origin.backup, false),
          ),
        )
        .orderBy(asc(schema.origin.createdAt), asc(schema.origin.id))
    : [];
  const first = new Map<string, { host: string; port: number }>();
  for (const o of origins)
    if (!first.has(o.siteId)) first.set(o.siteId, { host: o.address.toLowerCase(), port: o.port });
  return sites.map((s) => {
    const origin = first.get(s.id);
    return {
      id: s.id,
      name: s.name,
      enabled: s.enabled,
      settings: effective(readSiteTieredCache(s.tieredCache), global),
      target: origin ? { id: tierTargetId(origin.host, origin.port), ...origin } : null,
    };
  });
}

const tiered = (site: TierSite) => site.enabled && site.settings.topology !== "off";

/** The structure the nodes see: which node uses which upper tiers, in order. */
const structure = (hops: readonly TierHopModel[]) =>
  JSON.stringify(hops.map((h) => [h.nodeId, h.uppers.map((u) => [u.nodeId, u.reason])]));

/**
 * Chooses the upper tiers of the cluster's sites again and stores the
 * choices (tier_selection); a choice stays while the hysteresis keeps it.
 * Returns the number of sites whose upper tiers changed. Callers hold the
 * cluster's publish lock.
 */
export async function syncTierSelections(
  tx: Executor,
  clusterId: string,
  now = Date.now(),
): Promise<number> {
  const sites = await loadTierSites(tx, clusterId);
  if (sites.length === 0) return 0;
  const previous = new Map(
    (
      await tx
        .select()
        .from(schema.tierSelection)
        .where(
          inArray(
            schema.tierSelection.siteId,
            sites.map((s) => s.id),
          ),
        )
    ).map((row) => [row.siteId, row]),
  );
  const cluster = sites.some(tiered) ? await loadTierNodes(tx, clusterId, now) : null;
  let changed = 0;
  for (const site of sites) {
    const before = previous.get(site.id);
    if (!cluster || !tiered(site)) {
      if (before) {
        await tx.delete(schema.tierSelection).where(eq(schema.tierSelection.siteId, site.id));
        if (before.hops.length > 0) changed++;
      }
      continue;
    }
    const topology = site.settings.topology as Exclude<TierTopology, "off">;
    const targetId = site.target?.id ?? "";
    const comparable = before && before.topology === topology && before.targetId === targetId;
    const choice = chooseTiers({
      topology,
      candidates: cluster.candidates,
      rtt: cluster.rttFor(targetId),
      upperNodeIds: site.settings.upperNodeIds,
      upperNodeGroupIds: site.settings.upperNodeGroupIds,
      previous: comparable ? (before.hops as TierHopModel[]) : null,
    });
    const moved = structure(choice.hops) !== structure((before?.hops ?? []) as TierHopModel[]);
    if (moved) changed++;
    if (
      before &&
      !moved &&
      comparable &&
      JSON.stringify(before.hops) === JSON.stringify(choice.hops)
    )
      continue;
    const values = {
      topology,
      hops: choice.hops,
      targetId,
      ...(moved || !before ? { chosenAt: new Date(now) } : {}),
    };
    await tx
      .insert(schema.tierSelection)
      .values({ siteId: site.id, ...values })
      .onConflictDoUpdate({ target: schema.tierSelection.siteId, set: values });
  }
  return changed;
}

/** The tiered cache of a cluster for compileNodeConfig (CompileInput.tieredCache). */
export async function loadTieredCacheModel(
  db: Executor,
  clusterId: string,
  now = Date.now(),
): Promise<TieredCacheModel | undefined> {
  const sites = (await loadTierSites(db, clusterId)).filter(tiered);
  if (sites.length === 0) return undefined;
  const global = await getTieredCache(db);
  const selections = await db
    .select()
    .from(schema.tierSelection)
    .where(
      inArray(
        schema.tierSelection.siteId,
        sites.map((s) => s.id),
      ),
    );
  const { addresses } = await loadTierNodes(db, clusterId, now);
  return {
    port: global.port,
    addresses,
    sites: selections.map((row) => ({ siteId: row.siteId, hops: row.hops as TierHopModel[] })),
    latencyTargets: sites.flatMap((s) => (s.target ? [s.target] : [])),
  };
}

/**
 * Every minute: chooses the upper tiers of every cluster with a tiered site
 * again and publishes the clusters where they changed.
 */
export async function selectTiers(db: Database, now = Date.now()): Promise<string[]> {
  const clusters = await db
    .selectDistinct({ id: schema.site.clusterId })
    .from(schema.site)
    .where(eq(schema.site.enabled, true));
  const global = await getTieredCache(db);
  const published: string[] = [];
  for (const { id } of clusters) {
    if (global.topology === "off") {
      const [own] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.site)
        .where(and(eq(schema.site.clusterId, id), sql`${schema.site.tieredCache} is not null`));
      const [chosen] = await db
        .select({ n: sql<number>`count(*)`.mapWith(Number) })
        .from(schema.tierSelection)
        .innerJoin(schema.site, eq(schema.site.id, schema.tierSelection.siteId))
        .where(eq(schema.site.clusterId, id));
      if (!own?.n && !chosen?.n) continue;
    }
    await db.transaction(async (tx) => {
      await lockClusterPublish(tx, id);
      const changed = await syncTierSelections(tx, id, now);
      if (changed === 0) return;
      await publishRevision(tx, {
        clusterId: id,
        reason: { code: "tier_selection_changed", params: { count: changed } },
        actor: systemActor,
      });
      published.push(id);
    });
  }
  return published;
}

/**
 * Replaces the console-wide setting and publishes every cluster with a site
 * that follows it, in one transaction with the audit entry.
 */
export async function updateTieredCache(
  db: Database,
  input: TieredCacheSettings,
  actor: Actor,
): Promise<TieredCacheSettings> {
  return db.transaction((tx) =>
    tieredCacheSetting.write(tx, actor, input, {
      afterWrite: async () => {
        const rows = await tx
          .selectDistinct({ id: schema.site.clusterId })
          .from(schema.site)
          .where(
            sql`${schema.site.tieredCache} is null or ${schema.site.tieredCache}->>'topology' = 'inherit'`,
          );
        const published = await publishClusters(
          tx,
          rows.map((r) => r.id),
          { reason: { code: "tiered_cache_updated", params: {} }, actor },
        );
        return { clusters: published.size };
      },
    }),
  );
}

export async function getSiteTieredCache(
  db: Database,
  id: string,
): Promise<SiteTieredCacheSettings> {
  return readSiteTieredCache((await findSite(db, id)).tieredCache);
}

/** Replaces a site's setting and publishes its cluster; audited with the topology. */
export async function updateSiteTieredCache(
  db: Database,
  input: SiteTieredCacheSettings & { id: string },
  ctx: { actor: Actor },
): Promise<SiteTieredCacheSettings> {
  const { id, ...settings } = input;
  return db.transaction(async (tx) => {
    const site = await findSite(tx, id, true);
    const before = readSiteTieredCache(site.tieredCache);
    await tx
      .update(schema.site)
      .set({
        tieredCache: settings.topology === "inherit" ? null : settings,
        updatedAt: new Date(),
      })
      .where(eq(schema.site.id, site.id));
    await publishSiteChange(tx, ctx.actor, site, {
      reason: "site_updated",
      action: "site.tiered_cache_update",
      metadata: { from: before.topology, to: settings.topology },
    });
    return settings;
  });
}

/** Which node is an upper tier of which for the site, and why. */
export async function tierSelection(
  db: Database,
  id: string,
  now = Date.now(),
): Promise<TierSelection> {
  const site = await findSite(db, id);
  const tierSite = (await loadTierSites(db, site.clusterId)).find((s) => s.id === site.id);
  if (!tierSite) throw new Error(`site ${id} not in its cluster`);
  const cluster = await loadTierNodes(db, site.clusterId, now);
  const [row] = await db
    .select()
    .from(schema.tierSelection)
    .where(eq(schema.tierSelection.siteId, site.id));
  const hops = new Map(((row?.hops ?? []) as TierHopModel[]).map((h) => [h.nodeId, h.uppers]));
  const names = new Map(cluster.nodes.map((n) => [n.id, n.name]));
  let idleReason: TierIdleReason | null = null;
  if (tiered(tierSite) && hops.size === 0) {
    idleReason = chooseTiers({
      topology: tierSite.settings.topology as Exclude<TierTopology, "off">,
      candidates: cluster.candidates,
      rtt: cluster.rttFor(tierSite.target?.id ?? ""),
      upperNodeIds: tierSite.settings.upperNodeIds,
      upperNodeGroupIds: tierSite.settings.upperNodeGroupIds,
    }).idleReason;
  }
  return {
    topology: tierSite.settings.topology,
    inherited: tierSite.settings.inherited,
    target: tierSite.target ? `${tierSite.target.host}:${tierSite.target.port}` : "",
    idleReason,
    chosenAt: row?.chosenAt.toISOString() ?? null,
    nodes: cluster.nodes.map((n) => ({
      nodeId: n.id,
      nodeName: n.name,
      regionName: n.regionName,
      uppers: (hops.get(n.id) ?? []).map((u) => ({
        nodeId: u.nodeId,
        nodeName: names.get(u.nodeId) ?? u.nodeId,
        reason: u.reason,
        rttMs: u.rttMs,
      })),
    })),
    unsupportedNodes: cluster.nodes.filter(
      (n) => !nodeSupportsFeature(n.features, TIERED_CACHE_FEATURE),
    ).length,
  };
}

const HIT_STATUSES: ReadonlySet<string> = new Set(TIER_HIT_STATUSES);

/** Tier fetches of the site over a range (tier_stats) and the upper tiers' hit ratio. */
export async function tierStats(
  db: Database,
  query: { id: string; range: AnalyticsRange },
  now = Date.now(),
): Promise<TierStats> {
  const site = await findSite(db, query.id);
  const stats = sourceFor(query.range);
  const window = rangeWindow(query.range, now);
  const result = await db.execute<{ key: string; value: string | number }>(
    sql`select entry.key as key, sum(entry.value::numeric)::bigint as value
      from ${stats} cross join lateral jsonb_each_text(${stats.tierStats}) as entry(key, value)
      where ${and(
        eq(stats.siteId, site.id),
        sql`${stats.minute} >= ${window.from.toISOString()}::timestamptz`,
        sql`${stats.minute} < ${window.end.toISOString()}::timestamptz`,
      )}
      group by 1`,
  );
  const fetches: Record<string, number> = {};
  const served: Record<string, number> = {};
  for (const row of result.rows) {
    const value = Number(row.value);
    const status = row.key.slice(2);
    if (row.key.startsWith("f:")) fetches[status] = value;
    else if (row.key.startsWith("v:")) served[status] = value;
  }
  let answered = 0;
  let hits = 0;
  for (const [status, n] of Object.entries(fetches)) {
    if (status === "origin") continue;
    answered += n;
    if (HIT_STATUSES.has(status)) hits += n;
  }
  return {
    fetches,
    served,
    hitRatio: answered > 0 ? hits / answered : null,
    fallbacks: fetches.origin ?? 0,
  };
}

/**
 * Stores a node's round trip times to the latency targets
 * (ReportStatusRequest.tier_latencies): the latest per target.
 */
export async function recordTierLatencies(
  tx: Tx | Executor,
  nodeId: string,
  latencies: readonly { targetId: string; rttMs: number; ok: boolean; measuredAt: Date }[],
): Promise<void> {
  const seen = new Map<string, (typeof latencies)[number]>();
  for (const l of latencies) if (/^[A-Za-z0-9_-]{1,64}$/.test(l.targetId)) seen.set(l.targetId, l);
  if (seen.size === 0) return;
  await tx
    .delete(schema.tierLatency)
    .where(
      and(
        eq(schema.tierLatency.nodeId, nodeId),
        lt(schema.tierLatency.measuredAt, new Date(Date.now() - 24 * 3600_000)),
      ),
    );
  const rows = [...seen.values()].slice(0, 1024).map((l) => ({
    nodeId,
    targetId: l.targetId,
    rttMs: Math.max(0, Math.min(Math.round(l.rttMs), 600_000)),
    ok: l.ok,
    measuredAt: l.measuredAt,
  }));
  await tx
    .insert(schema.tierLatency)
    .values(rows)
    .onConflictDoUpdate({
      target: [schema.tierLatency.nodeId, schema.tierLatency.targetId],
      set: {
        rttMs: sql`excluded.rtt_ms`,
        ok: sql`excluded.ok`,
        measuredAt: sql`excluded.measured_at`,
      },
    });
}
