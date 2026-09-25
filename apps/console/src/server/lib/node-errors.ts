/**
 * Error codes and parameters nodes report (proto v0.2.1): what is stored of
 * them, and the codes read from the text of older nodes that send none.
 */

const CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const PARAM_RE = /^[a-z][a-z0-9_]{0,31}$/;
const MAX_PARAMS = 16;
const MAX_PARAM_VALUE = 500;

export interface NodeError {
  code: string;
  params: Record<string, string>;
}

/** A well-formed code, or "" (unknown codes are kept: newer nodes may know more). */
export function cleanErrorCode(code: string | undefined): string {
  return code && CODE_RE.test(code) ? code : "";
}

/** At most 16 parameters with identifier names and bounded values. */
export function cleanErrorParams(
  params: Record<string, string> | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(params ?? {})) {
    if (Object.keys(out).length >= MAX_PARAMS) break;
    if (!PARAM_RE.test(key) || typeof value !== "string") continue;
    out[key] = value.slice(0, MAX_PARAM_VALUE);
  }
  return out;
}

/** Origin health texts of nodes before v0.2.1 that map to one code without guessing. */
const legacyOrigin: [RegExp, (m: RegExpExecArray) => NodeError][] = [
  [/^HTTP (50[234])$/, (m) => ({ code: "upstream_status", params: { status: m[1] ?? "" } })],
  [/^dns (\S+): /, (m) => ({ code: "dns_failed", params: { host: m[1] ?? "" } })],
  [
    /^address (\S+) is a special-purpose address/,
    (m) => ({ code: "address_forbidden", params: { address: m[1] ?? "" } }),
  ],
];

/** Task result texts of nodes before v0.2.1 (and of this console) that map to one code. */
const legacyTask: [RegExp, (m: RegExpExecArray) => NodeError][] = [
  [/^expired: the node did not report a result$/, () => ({ code: "task_expired", params: {} })],
  [/^unsupported task type/, () => ({ code: "task_unsupported", params: { type: "unknown" } })],
  [/^data plane unavailable/, () => ({ code: "purge_failed", params: {} })],
  [
    /^prefetch time budget exhausted: (\d+) of (\d+) URLs done/,
    (m) => ({ code: "prefetch_timeout", params: { done: m[1] ?? "", total: m[2] ?? "" } }),
  ],
];

function resolve(
  table: [RegExp, (m: RegExpExecArray) => NodeError][],
  code: string,
  params: Record<string, string>,
  text: string,
): NodeError {
  if (code) return { code, params };
  for (const [re, map] of table) {
    const m = re.exec(text);
    if (m) return map(m);
  }
  return { code: "", params: {} };
}

/** The code of an origin failure: the reported one, or one read from an older node's text. */
export function originError(code: string, params: Record<string, string>, text: string) {
  return resolve(legacyOrigin, code, params, text);
}

/** The code of a task outcome: the reported one, or one read from an older node's text. */
export function taskError(code: string, params: Record<string, string>, text: string) {
  return resolve(legacyTask, code, params, text);
}
