/**
 * Whether a node that reports `supported` provides `feature`. Nodes report
 * geoip-city-v1 for country data; newer ones add geoip-country-v1 and report
 * subdivisions (a City MMDB) separately as geoip-subdivision-v1. Before that,
 * geoip-city-v1 always came from a City MMDB, so it implies subdivisions.
 */
export function nodeSupportsFeature(supported: readonly string[], feature: string): boolean {
  if (feature === "geoip-subdivision-v1" && !supported.includes("geoip-country-v1"))
    return supported.includes("geoip-city-v1");
  return supported.includes(feature);
}

/**
 * Task features: a node without them cannot run the task at all, so the
 * console refuses such tasks while an active node of an affected cluster
 * lacks the feature (they never enter a configuration's requiredFeatures).
 * purge-tag-v1: PurgeType HOST and TAG, and the Cache-Tag index.
 */
export const PURGE_TAG_FEATURE = "purge-tag-v1";
/** prefetch-v2: prefetch device variants (PrefetchTarget.variant) and sitemap tasks. */
export const PREFETCH_V2_FEATURE = "prefetch-v2";
/**
 * probe-health-v1: the edge listeners answer GET /.edgeweir/health before
 * any site lookup (HTTPS with SNI health.edgeweir.invalid). Probes request
 * it (HTTP/HTTPS probe targets) only when every active node of a cluster
 * reports the feature; otherwise they open TCP connections.
 */
export const PROBE_HEALTH_FEATURE = "probe-health-v1";
/** metrics-v1: ReportStatusRequest.metrics (CPU, load, memory, egress, connections). */
export const METRICS_FEATURE = "metrics-v1";
/**
 * rule-log-v1: MinuteStats.logged_rules, the matches of rules with the log
 * action per rule and minute. Nodes without it only write their own error
 * log, so a cluster's counts are partial while one of them is active.
 */
export const RULE_LOG_FEATURE = "rule-log-v1";
/**
 * stats-dims-v1: MinuteStats countries, networks, referring hosts, user
 * agent classes, HTTP and TLS versions, block reasons and challenges
 * (ADR-0041). A cluster's dimensions are partial while an active node
 * lacks it.
 */
export const STATS_DIMS_FEATURE = "stats-dims-v1";
/**
 * l4-v1: layer-4 applications (NodeConfig.l4_apps, required by
 * configurations with applications) and their statistics
 * (ReportStatsV2Request.l4_stats).
 */
export const L4_FEATURE = "l4-v1";
/**
 * cache-zone-v1: per-node cache zone sizes (CacheZone.node_sizes, required
 * by configurations where a node has its own size) and the cache usage in
 * heartbeats. A node's own size waits until every active node of its
 * cluster reports it.
 */
export const CACHE_ZONE_FEATURE = "cache-zone-v1";
/**
 * auth-identity-headers-v1: Site.auth_identity_headers, the identity
 * headers of disabled and former access authentication rules removed from
 * every request (proto v1.1.0). Never required: older nodes remove those of
 * the enabled rules only.
 */
export const AUTH_IDENTITY_HEADERS_FEATURE = "auth-identity-headers-v1";
/**
 * certificate-isolation-v1: a certificate a node cannot load is left out of
 * the revision, which applies otherwise, and reported
 * (ReportStatusRequest.certificate_failures, proto v1.1.0). Never required:
 * older nodes fail the whole revision.
 */
export const CERTIFICATE_ISOLATION_FEATURE = "certificate-isolation-v1";
/**
 * Features of the node release with security fixes no configuration
 * requires (path scopes ignoring ASCII case, identity headers of former
 * rules, body limits without Content-Length, certificate isolation): an
 * online node without one of them is recommended for an upgrade.
 */
export const RECOMMENDED_NODE_FEATURES = [
  AUTH_IDENTITY_HEADERS_FEATURE,
  CERTIFICATE_ISOLATION_FEATURE,
] as const;

/** Whether a node that reports `supported` lacks a recommended feature (needs an upgrade soon). */
export function nodeUpgradeRecommended(supported: readonly string[]): boolean {
  return RECOMMENDED_NODE_FEATURES.some((feature) => !supported.includes(feature));
}
