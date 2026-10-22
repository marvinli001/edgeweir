import { ARG_FIELD, ARG_NAME_RE, COOKIE_FIELD, COOKIE_NAME_RE, fields } from "./fields.ts";
import { ExpressionError, type ExpressionErrorCode, type ValueType } from "./model.ts";

/** Functions of the expression language (rules-v2, rules-v3), all over byte strings. */
interface FunctionSpec {
  /**
   * Argument kinds: "string" a string value, "any" a value of any type; "pattern", "wildcard",
   * "replacement", "flags", "formname" and "jsonpath" are string literals, "start" and
   * "length" integer literals.
   */
  args: readonly string[];
  /** Extra trailing optional arguments of the last listed kind... see variadic. */
  optional?: number;
  variadic?: [min: number, max: number];
  returns: ValueType;
  /** Only in value expressions (redirect targets, rewrite paths), at most once each. */
  valueOnly?: boolean;
}
export const functions: Record<string, FunctionSpec> = {
  lower: { args: ["string"], returns: "string" },
  upper: { args: ["string"], returns: "string" },
  len: { args: ["string"], returns: "number" },
  starts_with: { args: ["string", "string"], returns: "boolean" },
  ends_with: { args: ["string", "string"], returns: "boolean" },
  url_decode: { args: ["string"], returns: "string" },
  concat: { args: [], variadic: [2, 8], returns: "string" },
  regex_replace: { args: ["string", "pattern", "replacement"], returns: "string", valueOnly: true },
  wildcard_replace: {
    args: ["string", "wildcard", "replacement", "flags"],
    optional: 1,
    returns: "string",
    valueOnly: true,
  },
  // rules-v3
  url_encode: { args: ["string"], returns: "string" },
  base64_encode: { args: ["string"], returns: "string" },
  base64_decode: { args: ["string"], returns: "string" },
  md5: { args: ["string"], returns: "string" },
  sha1: { args: ["string"], returns: "string" },
  sha256: { args: ["string"], returns: "string" },
  substring: { args: ["string", "start", "length"], optional: 1, returns: "string" },
  to_string: { args: ["any"], returns: "string" },
  // rules-body-v1: request phases only (requestPhases)
  form_value: { args: ["formname"], returns: "string" },
  json_value: { args: ["jsonpath"], returns: "string" },
};
/** Functions only nodes with rules-v3 run. */
export const rulesV3Functions: ReadonlySet<string> = new Set([
  "url_encode",
  "base64_encode",
  "base64_decode",
  "md5",
  "sha1",
  "sha256",
  "substring",
  "to_string",
]);
/** Bounds of substring's integer arguments: start (negative counts from the end) and length. */
export const SUBSTRING_BOUNDS: Record<string, readonly [number, number]> = {
  start: [-65536, 65536],
  length: [0, 65536],
};
export const MAX_CALL_DEPTH = 4;
/** Longest value an expression computes on the node; longer results fail the request. */
export const MAX_VALUE_BYTES = 8192;

export const byteLength = (value: string) => new TextEncoder().encode(value).length;
export const controlCharacter = (value: string) =>
  [...value].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);

/** Number of capturing groups of a pattern that validatePattern accepted. */
export function patternGroups(pattern: string): number {
  let groups = 0;
  let inClass = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") i++;
    else if (inClass) inClass = c !== "]";
    else if (c === "[") inClass = true;
    else if (c === "(") groups++;
  }
  return groups;
}

/**
 * Splits a wildcard_replace pattern into its literal segments (one more than the
 * number of `*`). `\*` and `\\` are literals; any other backslash, control
 * characters, more than 8 wildcards or more than 1024 bytes are rejected.
 */
export function wildcardSegments(pattern: string): string[] {
  if (byteLength(pattern) > 1024)
    throw new ExpressionError("wildcard_too_long", 0, { max: "1024" });
  if (controlCharacter(pattern)) throw new ExpressionError("wildcard_invalid", 0);
  const segments = [""];
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] ?? "";
    if (c === "\\") {
      const next = pattern[i + 1];
      if (next !== "*" && next !== "\\") throw new ExpressionError("wildcard_escape", i);
      segments[segments.length - 1] += next;
      i++;
    } else if (c === "*") {
      segments.push("");
      if (segments.length > 9) throw new ExpressionError("wildcard_too_many", i, { max: "8" });
    } else segments[segments.length - 1] += c;
  }
  return segments;
}

/** Checks a replacement literal: `${1}`-`${8}` up to `captures`, other `$` literal. */
export function checkReplacement(replacement: string, captures: number): void {
  if (byteLength(replacement) > 1024 || controlCharacter(replacement))
    throw new ExpressionError("replacement_invalid", 0);
  for (const m of replacement.matchAll(/\$\{([1-8])\}/g))
    if (Number(m[1]) > captures) throw new ExpressionError("replacement_capture", m.index ?? 0);
}

export type Field = { name: string; type: ValueType; position: number };

/** Comparison operators; wildcard and strict_wildcard (`strict wildcard`) since rules-v3. */
export const comparisonOps: ReadonlySet<string> = new Set([
  "eq",
  "ne",
  "lt",
  "le",
  "gt",
  "ge",
  "contains",
  "matches",
  "in",
  "wildcard",
  "strict_wildcard",
]);
/** Operators of string values only. */
export const stringOps: ReadonlySet<string> = new Set([
  "contains",
  "matches",
  "wildcard",
  "strict_wildcard",
]);
/** Fields of a cookie and a query parameter by name, with the parse error of a bad name. */
export const namedFields: Record<string, { re: RegExp; code: ExpressionErrorCode }> = {
  [COOKIE_FIELD]: { re: COOKIE_NAME_RE, code: "cookie_name" },
  [ARG_FIELD]: { re: ARG_NAME_RE, code: "argument_name" },
};

/** The type of a field name (headers, cookies and query parameters included), undefined if unknown. */
export function irFieldType(field: string): ValueType | undefined {
  for (const prefix of ["http.request.headers.", "http.response.headers."])
    if (
      field.startsWith(prefix) &&
      /^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/.test(field.slice(prefix.length))
    )
      return "string";
  for (const [prefix, { re }] of Object.entries(namedFields))
    if (field.startsWith(`${prefix}.`) && re.test(field.slice(prefix.length + 1))) return "string";
  return Object.hasOwn(fields, field) ? fields[field] : undefined;
}
