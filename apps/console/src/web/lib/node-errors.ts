import {
  isNodeErrorCode,
  isPrefetchFailureReason,
  isTaskErrorCode,
  nodeErrorDefs,
  prefetchFailureReasonDefs,
  taskErrorDefs,
} from "@edgeweir/contract";
// Relative on purpose: the module is unit-tested outside Vite's "@" alias.
import { m } from "../paraglide/messages.js";

type MessageFn = (params?: Record<string, string>) => string;
const messages = m as unknown as Record<string, MessageFn | undefined>;

function render(
  key: string,
  names: readonly string[],
  params: Record<string, string>,
): string | undefined {
  const fn = messages[key];
  if (!fn) return undefined;
  const values: Record<string, string> = {};
  for (const name of names) values[name] = params[name] ?? "";
  return fn(values);
}

/**
 * The localized text of an origin failure a node reported; unknown or empty
 * codes (older nodes, newer codes) fall back to the node's own text.
 */
export function originErrorText(
  code: string,
  params: Record<string, string>,
  text: string,
): string {
  if (isNodeErrorCode(code)) {
    const out = render(`node_error_${code}`, nodeErrorDefs[code].params, params);
    if (out) return out;
  }
  return text;
}

/**
 * The localized text of a cache task outcome on a node; unknown or empty
 * codes fall back to the node's text (empty for a plain success).
 */
export function taskErrorText(code: string, params: Record<string, string>, text: string): string {
  if (!isTaskErrorCode(code)) return text;
  const values = { ...params };
  if (code === "prefetch_failed" || code === "sitemap_failed") {
    const reason = isPrefetchFailureReason(params.reason) ? params.reason : "other";
    values.reason =
      render(`task_error_reason_${reason}`, prefetchFailureReasonDefs[reason].params, params) ??
      params.reason ??
      "";
  }
  return render(`task_error_${code}`, taskErrorDefs[code].params, values) ?? text;
}
