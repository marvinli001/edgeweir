import { asciiLower, toBytes } from "./bytes.ts";
import type { Expression } from "./model.ts";

// ---- Derived request fields ----

/** http.request.uri.path.extension of a path (edgeweir-node rules.extension). */
export function pathExtension(path: string): string {
  const last = path.slice(path.lastIndexOf("/") + 1);
  const dot = last.lastIndexOf(".");
  return dot < 0 ? "" : asciiLower(last.slice(dot + 1));
}
/** http.response.content_type.media_type of a Content-Type value. */
export function mediaType(contentType: string): string {
  const match = /^[ \t]*([^; \t]+)/.exec(contentType);
  return match ? asciiLower(match[1] ?? "") : "";
}

// ---- Cache rule conditions: the structured builder and its expression ----

export interface StructuredCacheCondition {
  pathPrefixes: string[];
  paths: string[];
  extensions: string[];
}
const PATH = "http.request.uri.path";
const EXTENSION = "http.request.uri.path.extension";

/** The expression of a structured cache condition (the builder's output). */
export function cacheConditionExpression(condition: StructuredCacheCondition): string {
  const parts: string[] = [];
  const prefixes = condition.pathPrefixes.map((p) => `starts_with(${PATH}, ${JSON.stringify(p)})`);
  if (prefixes.length)
    parts.push(prefixes.length > 1 ? `(${prefixes.join(" or ")})` : (prefixes[0] as string));
  if (condition.paths.length)
    parts.push(`${PATH} in {${condition.paths.map((p) => JSON.stringify(p)).join(" ")}}`);
  if (condition.extensions.length)
    parts.push(`${EXTENSION} in {${condition.extensions.map((e) => JSON.stringify(e)).join(" ")}}`);
  return parts.join(" and ") || "true";
}

const structuredPrefix = (p: string) => p.startsWith("/") && p.length <= 1024 && !/\s/.test(p);
/**
 * The structured form of a parsed cache condition when it is one (what the builder
 * shows and what older nodes understand), else null. Lists keep the limits of the
 * structured model (32 prefixes, 32 paths, 64 extensions).
 */
export function structuredCacheCondition(expression: Expression): StructuredCacheCondition | null {
  const out: StructuredCacheCondition = { pathPrefixes: [], paths: [], extensions: [] };
  if (expression.op === "literal") return expression.value === "true" ? out : null;
  const seen = new Set<string>();
  const prefixCall = (x: Expression) =>
    x.op === "call" &&
    x.field === "starts_with" &&
    x.children[0]?.op === "field" &&
    x.children[0].field === PATH &&
    x.children[1]?.op === "const" &&
    structuredPrefix(x.children[1].value);
  const parts = expression.op === "and" ? expression.children : [expression];
  for (const part of parts) {
    if (prefixCall(part) || (part.op === "or" && part.children.every(prefixCall))) {
      if (seen.has("prefix")) return null;
      seen.add("prefix");
      const calls = part.op === "or" ? part.children : [part];
      out.pathPrefixes = calls.map((c) => c.children[1]?.value ?? "");
    } else if (part.op === "in" && part.field === PATH) {
      if (seen.has("path") || !part.values.every(structuredPrefix)) return null;
      seen.add("path");
      out.paths = [...part.values];
    } else if (part.op === "in" && part.field === EXTENSION) {
      if (seen.has("extension") || !part.values.every((v) => /^[a-z0-9]{1,16}$/.test(v)))
        return null;
      seen.add("extension");
      out.extensions = [...part.values];
    } else return null;
  }
  if (out.pathPrefixes.length > 32 || out.paths.length > 32 || out.extensions.length > 64)
    return null;
  return out;
}

/** The structured cache rule matcher of nodes without rules-v2 (edgeweir-node rules.lua). */
export function structuredCacheMatch(condition: StructuredCacheCondition, path: string): boolean {
  const p = toBytes(path);
  if (
    condition.pathPrefixes.length &&
    !condition.pathPrefixes.some((x) => p.startsWith(toBytes(x)))
  )
    return false;
  if (condition.paths.length && !condition.paths.some((x) => toBytes(x) === p)) return false;
  if (condition.extensions.length) {
    const last = path.slice(path.lastIndexOf("/") + 1);
    const ext = /\.([^.]+)$/.exec(last)?.[1];
    if (!ext || !condition.extensions.includes(asciiLower(ext))) return false;
  }
  return true;
}
