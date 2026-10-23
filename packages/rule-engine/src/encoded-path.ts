/**
 * Raw request paths an origin may read as another path than nginx's
 * normalized $uri, and the site's encoded path exemptions
 * (Site.encoded_path_exemptions, feature encoded-path-exemptions-v1): the
 * reference of edgeweir-node's edgeweir.uripath. encoded_path_vectors.json
 * is shared with the node's test/lua/uripath.lua.
 *
 * A raw path (the request URI before "?") is ambiguous when it holds an
 * encoded "/", "\", ".", "%" or ";", a "%u" escape, a "\", a ";", a "#", a
 * dot segment, or starts with "//". An ambiguous path is in every path scope
 * that adds a check, under no exemption and outside every grant, and never
 * cached.
 *
 * An exemption lets raw paths starting with its prefix (bytes, exactly)
 * carry encoded slashes ("%2F", any case) and / or ";" path parameters.
 * Such a path is still ambiguous unless, with every "%2F" read as "/" and
 * every ";" up to the end of its segment removed, it is not ambiguous. It is
 * then compared in every way an origin may read it (its views): decoded as
 * nginx does, with "%2F" kept inside its segment, and either of those with
 * ";" parameters removed. A scope that adds a check applies when $uri or any
 * view is in it; an exemption or grant only when $uri and every view are.
 * Paths are binary strings (one character per byte), as Lua sees them.
 */

import { asciiLower } from "./bytes.ts";

/** One entry of a site's encoded path exemptions. */
export interface EncodedPathExemption {
  prefix: string;
  encodedSlash: boolean;
  semicolon: boolean;
}

/** How a request's raw path compares to path scopes. */
export interface RawPathClass {
  /** In every scope that adds a check, under no exemption, never cached. */
  ambiguous: boolean;
  /** Exemptions (excluded prefixes, allowed paths) never apply: "//" or ambiguous. */
  noExemption: boolean;
  /** For an exempt path: the ways an origin may read it, besides $uri; null otherwise. */
  views: string[] | null;
  /** For an exempt path with "%2F": the cache key's path, "%2F" kept; null: $uri. */
  keyPath: string | null;
}

/** Most exemptions a site has. */
export const ENCODED_PATH_MAX_EXEMPTIONS = 32;
/** Longest exemption prefix in bytes. */
const ENCODED_PATH_PREFIX_MAX = 256;

/** Escapes origins decode into separators, dots or parameters (lowercase). */
const MARKERS = ["%2f", "%5c", "%2e", "%25", "%3b", "%u"];
const DOT_SEGMENT = /\/\.\.?(\/|$)/;

/** Whether a raw path is ambiguous (see the module comment). */
export function rawPathAmbiguous(raw: string): boolean {
  if (/[\\;#]/.test(raw) || raw.startsWith("//")) return true;
  const p = asciiLower(raw);
  return MARKERS.some((m) => p.includes(m)) || DOT_SEGMENT.test(p);
}

/**
 * An exemption prefix: 1-256 bytes of printable ASCII starting with "/", without "%", ";", "\",
 * "#", "?", spaces, "//" or a dot segment, so a raw path starting with it starts with it in every
 * view.
 */
export function validEncodedPathPrefix(prefix: string): boolean {
  return (
    prefix.length <= ENCODED_PATH_PREFIX_MAX &&
    /^\/[\x21-\x7e]*$/.test(prefix) &&
    !/[%;\\#?]/.test(prefix) &&
    !prefix.includes("//") &&
    !DOT_SEGMENT.test(prefix)
  );
}

const decodeAll = (s: string) =>
  s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) => String.fromCharCode(Number.parseInt(h, 16)));
const decodeKeepSlash = (s: string) =>
  s.replace(/%([0-9A-Fa-f]{2})/g, (_, h: string) =>
    h.toLowerCase() === "2f" ? "%2F" : String.fromCharCode(Number.parseInt(h, 16)),
  );
const mergeSlashes = (s: string) => s.replace(/\/{2,}/g, "/");
/** Removes ";" path parameters: from each ";" to the end of its segment. */
const stripParameters = (s: string) => s.replace(/;[^/]*/g, "");
const ENCODED_SLASH = /%2f/i;

/** Classifies a raw path against a site's exemptions (see the module comment). */
export function classifyRawPath(
  raw: string,
  exemptions: readonly EncodedPathExemption[] = [],
): RawPathClass {
  const ambiguous: RawPathClass = {
    ambiguous: true,
    noExemption: true,
    views: null,
    keyPath: null,
  };
  if (!rawPathAmbiguous(raw))
    return { ambiguous: false, noExemption: raw.includes("//"), views: null, keyPath: null };
  let slash = false;
  let semicolon = false;
  for (const e of exemptions) {
    if (!raw.startsWith(e.prefix)) continue;
    slash ||= e.encodedSlash;
    semicolon ||= e.semicolon;
  }
  if (!slash && !semicolon) return ambiguous;
  let plain = raw;
  if (slash) plain = plain.replace(/%2f/gi, "/");
  if (semicolon) plain = stripParameters(plain);
  if (rawPathAmbiguous(plain)) return ambiguous;
  const decoded = mergeSlashes(decodeAll(raw));
  const kept = slash && ENCODED_SLASH.test(raw) ? mergeSlashes(decodeKeepSlash(raw)) : null;
  const views = [decoded];
  if (kept !== null) views.push(kept);
  if (semicolon && raw.includes(";")) {
    views.push(stripParameters(decoded));
    if (kept !== null) views.push(stripParameters(kept));
  }
  return {
    ambiguous: false,
    noExemption: raw.includes("//") || plain.includes("//"),
    views: [...new Set(views)],
    keyPath: kept,
  };
}

/** $uri and the views of a request: every way an origin may read its path. */
const readings = (path: string, views: readonly string[] | null | undefined) =>
  views?.length ? [path, ...views] : [path];

/** Whether `test` holds for $uri or any view (a scope that adds a check). */
export function anyView(
  path: string,
  views: readonly string[] | null | undefined,
  test: (path: string) => boolean,
): boolean {
  return readings(path, views).some(test);
}

/** Whether `test` holds for $uri and every view (an exemption or a grant). */
export function everyView(
  path: string,
  views: readonly string[] | null | undefined,
  test: (path: string) => boolean,
): boolean {
  return readings(path, views).every(test);
}
