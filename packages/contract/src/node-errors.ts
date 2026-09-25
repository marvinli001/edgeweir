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
  /** The first failed URL; {reason} is one of prefetchFailureReasonDefs. */
  prefetch_failed: { params: ["failed", "total", "url", "reason"] },
  prefetch_timeout: { params: ["done", "total"] },
  task_unsupported: { params: ["type"] },
  purge_failed: { params: [] },
  /** Never executed within the delivery window (CACHE_TASK_TTL, 7 days). */
  task_expired: { params: [] },
  /** Not delivered: the node was disabled. */
  node_disabled: { params: [] },
} as const satisfies Record<string, { params: readonly string[] }>;

/** prefetch_failed's {reason}; "status" also carries {status}. */
export const prefetchFailureReasonDefs = {
  status: { params: ["status"] },
  connect_failed: { params: [] },
  timeout: { params: [] },
  https_unsupported: { params: [] },
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
