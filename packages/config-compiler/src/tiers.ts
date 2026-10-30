/**
 * Tiered cache (ADR-0073): which nodes of a cluster are upper tiers of
 * which for a site (chooseTiers), and the compiled TieredCache with each
 * site's plan (compileTieredCache).
 */
import { createHash } from "node:crypto";
import { create } from "@bufbuild/protobuf";
import {
  MAX_TIER_UPPERS,
  type TierIdleReason,
  type TierReason,
  type TierTopology,
} from "@edgeweir/contract";
import {
  type Site,
  type TieredCache,
  TieredCacheSchema,
  TierHopSchema,
  TierLatencyTargetSchema,
  TierNodeSchema,
  TierPlanSchema,
} from "@edgeweir/proto";
import { byString } from "./sort";

/** A node taking part in the tiered cache (it reports tiered-cache-v1). */
export interface TierCandidate {
  id: string;
  /** null: the node has no region. */
  regionId: string | null;
  /** It can serve lower tiers: it reports tier-upper-v1 and has a tier address. */
  upper: boolean;
  groupIds: readonly string[];
}

export interface TierUpperModel {
  nodeId: string;
  reason: TierReason;
  rttMs: number | null;
}

/** A node's upper tiers, in the order it tries them. */
export interface TierHopModel {
  nodeId: string;
  uppers: TierUpperModel[];
}

export interface TierChoice {
  /** Nodes with upper tiers, sorted by node id; the others fetch from the origin. */
  hops: TierHopModel[];
  idleReason: TierIdleReason | null;
}

export interface ChooseTiersInput {
  topology: Exclude<TierTopology, "off">;
  candidates: readonly TierCandidate[];
  /** The node's round trip time to the site's origin (ms); null without a fresh measurement. */
  rtt: (nodeId: string) => number | null;
  /** Custom topology: named nodes and node groups. */
  upperNodeIds?: readonly string[];
  upperNodeGroupIds?: readonly string[];
  /** The hops chosen last time: an upper tier stays while it is not clearly slower. */
  previous?: readonly TierHopModel[] | null;
}

/**
 * The chosen upper tier stays while its round trip time is at most this
 * factor of the fastest plus TIER_HYSTERESIS_MS, so that measurement noise
 * does not move a site's cache between nodes.
 */
export const TIER_HYSTERESIS_FACTOR = 1.2;
export const TIER_HYSTERESIS_MS = 5;

const idle = (idleReason: TierIdleReason): TierChoice => ({ hops: [], idleReason });

/** Fastest first (nodes without a measurement last), then by id. */
function byLatency(rtt: (id: string) => number | null) {
  return (a: TierCandidate, b: TierCandidate) => {
    const ra = rtt(a.id);
    const rb = rtt(b.id);
    if (ra !== rb) {
      if (ra === null) return 1;
      if (rb === null) return -1;
      return ra - rb;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  };
}

/**
 * The fastest of `nodes`, or `previous` while it is among them and not
 * clearly slower (hysteresis); undefined when `nodes` is empty.
 */
function pick(
  nodes: readonly TierCandidate[],
  rtt: (id: string) => number | null,
  previous: string | undefined,
) {
  const best = [...nodes].sort(byLatency(rtt))[0];
  if (!best || previous === undefined || previous === best.id) return best;
  const kept = nodes.find((n) => n.id === previous);
  const bestRtt = rtt(best.id);
  const keptRtt = kept ? rtt(kept.id) : null;
  if (!kept) return best;
  if (bestRtt === null) return kept;
  if (keptRtt !== null && keptRtt <= bestRtt * TIER_HYSTERESIS_FACTOR + TIER_HYSTERESIS_MS)
    return kept;
  return best;
}

/** The previous upper tier with one of `reasons` (of any hop, or of hops of `lowers`). */
function previousUpper(
  previous: readonly TierHopModel[] | null | undefined,
  reasons: readonly TierReason[],
  lowers?: ReadonlySet<string>,
) {
  for (const hop of previous ?? []) {
    if (lowers && !lowers.has(hop.nodeId)) continue;
    const upper = hop.uppers.find((u) => reasons.includes(u.reason));
    if (upper) return upper.nodeId;
  }
  return undefined;
}

const regionKey = (n: TierCandidate) => n.regionId ?? "";

/**
 * Chooses a site's upper tiers among the nodes of its cluster:
 * - smart: the capable node with the lowest round trip time to the origin is
 *   every other node's upper tier, the fastest capable node of another
 *   region the fallback;
 * - generic: in each region the capable node with the lowest round trip
 *   time (by id without measurements) is the upper tier of the others; a
 *   region without one uses the fastest region's;
 * - regional: smart, and in every other region the fastest capable node is
 *   a regional tier between the region's nodes and the upper tier (at most
 *   two hops: lower, regional, upper);
 * - custom: the named capable nodes are upper tiers of every other node,
 *   at most three each, those of the node's region first, then by latency.
 */
export function chooseTiers(input: ChooseTiersInput): TierChoice {
  const { candidates, rtt, previous } = input;
  if (candidates.length < 2) return idle("single_node");
  const capable = candidates.filter((n) => n.upper);
  const upper = (n: TierCandidate, reason: TierReason): TierUpperModel => ({
    nodeId: n.id,
    reason,
    rttMs: rtt(n.id),
  });
  const hops = new Map<string, TierUpperModel[]>();
  const done = (): TierChoice => ({
    hops: [...hops]
      .filter(([, uppers]) => uppers.length > 0)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([nodeId, uppers]) => ({ nodeId, uppers: uppers.slice(0, MAX_TIER_UPPERS) })),
    idleReason: null,
  });

  if (input.topology === "custom") {
    const ids = new Set(input.upperNodeIds ?? []);
    const groups = new Set(input.upperNodeGroupIds ?? []);
    if (ids.size === 0 && groups.size === 0) return idle("no_custom");
    const named = capable.filter((n) => ids.has(n.id) || n.groupIds.some((g) => groups.has(g)));
    if (named.length === 0) return idle("no_upper");
    const namedIds = new Set(named.map((n) => n.id));
    for (const node of candidates) {
      if (namedIds.has(node.id)) continue;
      const order = byLatency(rtt);
      const sorted = [...named].sort((a, b) => {
        const sa = regionKey(a) === regionKey(node) && node.regionId !== null ? 0 : 1;
        const sb = regionKey(b) === regionKey(node) && node.regionId !== null ? 0 : 1;
        return sa - sb || order(a, b);
      });
      hops.set(
        node.id,
        sorted.map((n) => upper(n, "custom")),
      );
    }
    return done();
  }

  if (capable.length === 0) return idle("no_upper");

  if (input.topology === "generic") {
    const regions = new Map<string, TierCandidate[]>();
    for (const n of candidates)
      regions.set(regionKey(n), [...(regions.get(regionKey(n)) ?? []), n]);
    const chosen = new Map<string, TierCandidate>();
    for (const [region, members] of regions) {
      const prev = previousUpper(previous, ["region_upper"], new Set(members.map((m) => m.id)));
      const prevInRegion = members.some((m) => m.id === prev) ? prev : undefined;
      const u = pick(
        members.filter((m) => m.upper),
        rtt,
        prevInRegion,
      );
      if (u) chosen.set(region, u);
    }
    const fastest = pick([...chosen.values()], rtt, undefined);
    for (const node of candidates) {
      const u = chosen.get(regionKey(node)) ?? fastest;
      if (u && u.id !== node.id) hops.set(node.id, [upper(u, "region_upper")]);
    }
    return done();
  }

  // smart and regional need the round trip times to the origin.
  const measured = capable.filter((n) => rtt(n.id) !== null);
  if (measured.length === 0) return idle("no_latency");
  const primary = pick(
    measured,
    rtt,
    previousUpper(previous, ["lowest_latency", "global_upper"]),
  ) as TierCandidate;
  const others = measured.filter((n) => n.id !== primary.id);
  const elsewhere =
    primary.regionId === null
      ? others.filter((n) => n.regionId !== null)
      : others.filter((n) => n.regionId !== primary.regionId);
  const fallback = pick(elsewhere, rtt, previousUpper(previous, ["fallback_region"]));

  if (input.topology === "smart") {
    for (const node of candidates) {
      if (node.id === primary.id) continue;
      const uppers = [upper(primary, "lowest_latency")];
      if (fallback && fallback.id !== node.id) uppers.push(upper(fallback, "fallback_region"));
      hops.set(node.id, uppers);
    }
    return done();
  }

  // regional: one regional tier per region besides the upper tier's.
  const hubs = new Map<string, TierCandidate>();
  for (const n of candidates) {
    const region = regionKey(n);
    if (n.regionId === null || region === regionKey(primary) || hubs.has(region)) continue;
    const members = candidates.filter((m) => regionKey(m) === region);
    const prev = previousUpper(previous, ["regional_tier"], new Set(members.map((m) => m.id)));
    const hub = pick(
      members.filter((m) => m.upper),
      rtt,
      members.some((m) => m.id === prev) ? prev : undefined,
    );
    if (hub) hubs.set(region, hub);
  }
  const hubIds = new Set([...hubs.values()].map((h) => h.id));
  for (const node of candidates) {
    if (node.id === primary.id) continue;
    const hub = node.regionId === null ? undefined : hubs.get(regionKey(node));
    if (hubIds.has(node.id) || (fallback && node.id === fallback.id)) {
      // Regional tiers and the fallback fetch from the upper tier only (two hops at most).
      hops.set(node.id, [upper(primary, hub ? "global_upper" : "lowest_latency")]);
    } else if (hub) {
      hops.set(node.id, [upper(hub, "regional_tier"), upper(primary, "global_upper")]);
    } else {
      const uppers = [upper(primary, "lowest_latency")];
      if (fallback) uppers.push(upper(fallback, "fallback_region"));
      hops.set(node.id, uppers);
    }
  }
  return done();
}

/** The tiered cache of a cluster as the console chose it. */
export interface TieredCacheModel {
  /** TLS port of the upper tiers' listener. */
  port: number;
  /** Tier addresses of the nodes (an upper tier needs one); any order. */
  addresses: Readonly<Record<string, string>>;
  /** Each site's hops (sites without hops fetch from the origin); any order. */
  sites: readonly { siteId: string; hops: readonly TierHopModel[] }[];
  /** Origin addresses the nodes measure round trip times to; any order. */
  latencyTargets: readonly { id: string; host: string; port: number }[];
}

const hashId = (prefix: string, text: string) =>
  prefix + createHash("sha256").update(text).digest("base64url").slice(0, 22);

/** A latency target's id: stable for the same host and port. */
export const tierTargetId = (host: string, port: number) =>
  hashId("t", `${host.toLowerCase()}:${port}`);

/**
 * Compiles the tiered cache and sets Site.tier_plan_id of `sites` (compiled,
 * enabled ones): sites with the same hops share a plan, named by a hash of
 * them. Undefined when no site has hops and nothing is measured.
 */
export function compileTieredCache(
  model: TieredCacheModel | undefined,
  sites: Site[],
): TieredCache | undefined {
  if (!model) return undefined;
  const served = new Map(sites.map((s) => [s.id, s]));
  const plans = new Map<string, { id: string; hops: TierHopModel[] }>();
  const used = new Set<string>();
  for (const { siteId, hops } of model.sites) {
    const site = served.get(siteId);
    const active = hops
      .filter((h) => h.uppers.length > 0)
      .sort(byString((h) => h.nodeId))
      .map((h) => ({ nodeId: h.nodeId, uppers: h.uppers.slice(0, MAX_TIER_UPPERS) }));
    if (!site || active.length === 0) continue;
    const text = active
      .map((h) => `${h.nodeId}>${h.uppers.map((u) => u.nodeId).join(",")}`)
      .join(";");
    const id = hashId("p", text);
    plans.set(id, { id, hops: active });
    site.tierPlanId = id;
    for (const h of active) {
      used.add(h.nodeId);
      for (const u of h.uppers) used.add(u.nodeId);
    }
  }
  const targets = [...new Map(model.latencyTargets.map((t) => [t.id, t])).values()].sort(
    byString((t) => t.id),
  );
  if (plans.size === 0 && targets.length === 0) return undefined;
  const uppers = new Set(
    [...plans.values()].flatMap((p) => p.hops.flatMap((h) => h.uppers.map((u) => u.nodeId))),
  );
  return create(TieredCacheSchema, {
    port: model.port,
    nodes: [...used]
      .sort()
      .map((id) =>
        create(TierNodeSchema, { id, address: uppers.has(id) ? (model.addresses[id] ?? "") : "" }),
      ),
    plans: [...plans.values()].sort(byString((p) => p.id)).map((p) =>
      create(TierPlanSchema, {
        id: p.id,
        hops: p.hops.map((h) =>
          create(TierHopSchema, { nodeId: h.nodeId, upperNodeIds: h.uppers.map((u) => u.nodeId) }),
        ),
      }),
    ),
    latencyTargets: targets.map((t) => create(TierLatencyTargetSchema, t)),
  });
}
