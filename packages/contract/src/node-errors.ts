/**
 * Stable codes nodes report for failures (proto v0.2.1), plus the console's
 * own task outcomes. `params` name the parameters each code's message
 * interpolates; the UI localizes known codes and shows the node's text for
 * unknown or empty ones.
 */

/** OriginHealth.last_error_code: why the last attempt at an origin failed. */
export const nodeErrorDefs = {
  connect_failed: { params: [] },
  timeout: { params: [] },
  /** The origin itself answered 502/503/504. */
  upstream_status: { params: ["status"] },
  dns_failed: { params: ["host"] },
  /** The origin (or what it resolves to) is a special-purpose address outside the allow list. */
  address_forbidden: { params: ["address"] },
  tls_failed: { params: [] },
} as const satisfies Record<string, { params: readonly string[] }>;

/**
 * A cache task's outcome on one node: ReportTaskResultRequest.error_code, or
 * set by the console (task_expired, node_disabled).
 */
export const taskErrorDefs = {
  upgrade_interrupted: { params: ["version"] },
  upgrade_rejected: { params: ["version"] },
  upgrade_rolled_back: { params: ["version"] },
  upgrade_expired: { params: [] },
  upgrade_cancelled: { params: [] },
  upgrade_node_removed: { params: [] },
  /** The first failed URL; {reason} is one of prefetchFailureReasonDefs. */
  prefetch_failed: { params: ["failed", "total", "url", "reason"] },
  prefetch_timeout: { params: ["done", "total"] },
  task_unsupported: { params: ["type"] },
  purge_failed: { params: [] },
  /**
   * The sitemap, or a sitemap of its index, could not be fetched or parsed;
   * {reason} is one of prefetchFailureReasonDefs.
   */
  sitemap_failed: { params: ["url", "reason"] },
  /** The sitemap lists no URL of the site. */
  sitemap_empty: { params: ["url"] },
  /** Never executed within the delivery window (CACHE_TASK_TTL, 7 days). */
  task_expired: { params: [] },
  /** Not delivered: the node was disabled. */
  node_disabled: { params: [] },
} as const satisfies Record<string, { params: readonly string[] }>;

/**
 * The {reason} of prefetch_failed and sitemap_failed; "status" also carries
 * {status}. invalid and too_large (a sitemap that is not XML, or over 50 MiB
 * unpacked) only occur with sitemap_failed.
 */
export const prefetchFailureReasonDefs = {
  status: { params: ["status"] },
  connect_failed: { params: [] },
  timeout: { params: [] },
  https_unsupported: { params: [] },
  invalid: { params: [] },
  too_large: { params: [] },
  other: { params: [] },
} as const satisfies Record<string, { params: readonly string[] }>;

export type NodeErrorCode = keyof typeof nodeErrorDefs;
export type TaskErrorCode = keyof typeof taskErrorDefs;
export type PrefetchFailureReason = keyof typeof prefetchFailureReasonDefs;

export const nodeErrorCodes = Object.keys(nodeErrorDefs) as NodeErrorCode[];
export const taskErrorCodes = Object.keys(taskErrorDefs) as TaskErrorCode[];
export const prefetchFailureReasons = Object.keys(
  prefetchFailureReasonDefs,
) as PrefetchFailureReason[];

export function isNodeErrorCode(code: unknown): code is NodeErrorCode {
  return typeof code === "string" && Object.hasOwn(nodeErrorDefs, code);
}

export function isTaskErrorCode(code: unknown): code is TaskErrorCode {
  return typeof code === "string" && Object.hasOwn(taskErrorDefs, code);
}

export function isPrefetchFailureReason(reason: unknown): reason is PrefetchFailureReason {
  return typeof reason === "string" && Object.hasOwn(prefetchFailureReasonDefs, reason);
}
