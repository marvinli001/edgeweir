/**
 * Tiered cache (ADR-0073, feature tiered-cache-v1): lower-tier nodes fetch
 * the requests they may cache from upper-tier nodes of the site's cluster,
 * which fetch from the origin. Topologies: smart (one upper tier per site,
 * the node with the lowest round trip time to the site's origin, and a
 * fallback in another region), generic (each region's upper tier), regional
 * (smart plus a regional tier in every other region) and custom (upper
 * tiers the operator names). Lower tiers fall back to the origin when no
 * upper tier answers.
 */
import { oc } from "@orpc/contract";
import * as z from "zod";
import { analyticsRange, uuid } from "./schemas";

/** Nodes take part (lower tier; an upper tier also needs TIER_UPPER_FEATURE). */
export const TIERED_CACHE_FEATURE = "tiered-cache-v1";
/** The node's certificate serves TLS: lower tiers can verify it as an upper tier. */
export const TIER_UPPER_FEATURE = "tier-upper-v1";

export const TIER_TOPOLOGIES = ["off", "smart", "generic", "regional", "custom"] as const;
export type TierTopology = (typeof TIER_TOPOLOGIES)[number];

/** Cache statuses of tier fetches (MinuteStats.tier_fetches / tier_served); "origin": none answered. */
export const TIER_STATUSES = [
  "HIT",
  "MISS",
  "EXPIRED",
  "STALE",
  "UPDATING",
  "REVALIDATED",
  "BYPASS",
  "origin",
  "-",
] as const;
/** Statuses an upper tier answered from its cache. */
export const TIER_HIT_STATUSES = ["HIT", "STALE", "UPDATING", "REVALIDATED"] as const;

/** The tier listener's default TLS port. */
const DEFAULT_TIER_PORT = 8444;
/** Upper tiers a node tries per site (TierHop.upper_node_ids). */
export const MAX_TIER_UPPERS = 3;
/** Most nodes or node groups a custom topology names. */
export const MAX_CUSTOM_TIERS = 32;

const customTiers = {
  /** Custom topology: upper-tier nodes and node groups (every node of a group). */
  upperNodeIds: z.array(uuid).max(MAX_CUSTOM_TIERS),
  upperNodeGroupIds: z.array(uuid).max(MAX_CUSTOM_TIERS),
};

/** The console-wide setting, the default of every site. */
export const tieredCacheSettings = z.object({
  topology: z.enum(TIER_TOPOLOGIES),
  /** TLS port of the upper tiers' listener (lower tiers connect to it). */
  port: z.int().min(1).max(65535),
  ...customTiers,
});

/** A site's setting: inherit follows the console-wide one. */
export const siteTieredCacheSettings = z.object({
  topology: z.enum(["inherit", ...TIER_TOPOLOGIES]),
  ...customTiers,
});

export const TIERED_CACHE_DEFAULTS = {
  topology: "off",
  port: DEFAULT_TIER_PORT,
  upperNodeIds: [],
  upperNodeGroupIds: [],
} as const satisfies z.infer<typeof tieredCacheSettings>;

export const SITE_TIERED_CACHE_DEFAULTS = {
  topology: "inherit",
  upperNodeIds: [],
  upperNodeGroupIds: [],
} as const satisfies z.infer<typeof siteTieredCacheSettings>;

/** Why a node is an upper tier of another. */
const TIER_REASONS = [
  /** smart: the lowest round trip time to the origin. */
  "lowest_latency",
  /** smart: the fallback, the fastest node of another region. */
  "fallback_region",
  /** generic: the upper tier of the node's region. */
  "region_upper",
  /** regional: the regional tier of the node's region. */
  "regional_tier",
  /** regional: the global upper tier behind the regional tier. */
  "global_upper",
  /** custom: named by the operator. */
  "custom",
] as const;

/** Why a site has no plan although its topology is on. */
const TIER_IDLE_REASONS = [
  /** No latency measurement of the site's origin yet (smart, regional). */
  "no_latency",
  /** No node of the cluster can be an upper tier (tier-upper-v1) or none has an address. */
  "no_upper",
  /** Fewer than two nodes take part. */
  "single_node",
  /** Custom topology without upper tiers. */
  "no_custom",
] as const;

const tierUpper = z.object({
  nodeId: uuid,
  nodeName: z.string(),
  reason: z.enum(TIER_REASONS),
  /** The node's round trip time to the origin (ms); null without a measurement. */
  rttMs: z.number().int().nullable(),
});

const tierHop = z.object({
  nodeId: uuid,
  nodeName: z.string(),
  regionName: z.string().nullable(),
  /** In the order the node tries them; empty: it fetches from the origin. */
  uppers: z.array(tierUpper),
});

const tierSelection = z.object({
  /** The topology in effect (the console-wide one when the site inherits it). */
  topology: z.enum(TIER_TOPOLOGIES),
  inherited: z.boolean(),
  /** The origin address the round trip times are for ("host:port"), "" when none. */
  target: z.string(),
  idleReason: z.enum(TIER_IDLE_REASONS).nullable(),
  chosenAt: z.string().nullable(),
  /** Every active node of the site's cluster. */
  nodes: z.array(tierHop),
  /** Active nodes without tiered-cache-v1: they fetch from the origin. */
  unsupportedNodes: z.number().int(),
});

const tierStats = z.object({
  /** Fetches lower tiers made from upper tiers, by the upper tier's cache status. */
  fetches: z.record(z.string(), z.number()),
  /** Requests nodes served to lower tiers, by their cache status. */
  served: z.record(z.string(), z.number()),
  /** Share of fetches from upper tiers they answered from their cache (0-1); null without fetches. */
  hitRatio: z.number().nullable(),
  /** Fetches that went to the origin because no upper tier answered. */
  fallbacks: z.number(),
});

const idParam = z.object({ id: uuid });

export const tieredCacheContract = {
  /** The console-wide setting. */
  get: oc
    .route({ method: "GET", path: "/tiered-cache", tags: ["tiered-cache"] })
    .output(tieredCacheSettings),
  /** Replaces the console-wide setting and publishes every cluster with a site that follows it. */
  update: oc
    .route({ method: "PUT", path: "/tiered-cache", tags: ["tiered-cache"] })
    .input(tieredCacheSettings)
    .output(tieredCacheSettings),
  site: {
    get: oc
      .route({ method: "GET", path: "/sites/{id}/tiered-cache", tags: ["sites"] })
      .input(idParam)
      .output(siteTieredCacheSettings),
    /** Replaces the site's setting and publishes its cluster. */
    update: oc
      .route({ method: "PUT", path: "/sites/{id}/tiered-cache", tags: ["sites"] })
      .input(siteTieredCacheSettings.extend({ id: uuid }))
      .output(siteTieredCacheSettings),
    /** Which node serves as an upper tier for which node of the site, and why. */
    selection: oc
      .route({ method: "GET", path: "/sites/{id}/tiered-cache/selection", tags: ["sites"] })
      .input(idParam)
      .output(tierSelection),
    /** Tier fetches and the upper tiers' hit ratio over a range. */
    stats: oc
      .route({ method: "GET", path: "/sites/{id}/tiered-cache/stats", tags: ["sites"] })
      .input(z.object({ id: uuid, range: analyticsRange.default("24h") }))
      .output(tierStats),
  },
};

export type TieredCacheSettings = z.infer<typeof tieredCacheSettings>;
export type SiteTieredCacheSettings = z.infer<typeof siteTieredCacheSettings>;
export type TierSelection = z.infer<typeof tierSelection>;
export type TierStats = z.infer<typeof tierStats>;
export type TierReason = (typeof TIER_REASONS)[number];
export type TierIdleReason = (typeof TIER_IDLE_REASONS)[number];
