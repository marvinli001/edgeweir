import { wildcardSegments } from "./language.ts";
import { compilePattern } from "./patterns.ts";

// ---- Reference evaluation over byte strings (one char per UTF-8 byte) ----

/** The UTF-8 bytes of `value`, one character per byte. */
export function toBytes(value: string): string {
  return Array.from(new TextEncoder().encode(value), (b) => String.fromCharCode(b)).join("");
}
/** Decodes a byte string (one character per byte) as UTF-8. */
export function fromBytes(value: string): string {
  return new TextDecoder().decode(Uint8Array.from(value, (c) => c.charCodeAt(0)));
}
export const asciiLower = (value: string) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const asciiUpper = (value: string) => value.replace(/[a-z]/g, (c) => c.toUpperCase());

/** url_decode over a byte string: one pass, %XX to a byte, "+" to a space. */
export function urlDecodeBytes(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    const hex = value.slice(i + 1, i + 3);
    if (c === "%" && /^[0-9a-fA-F]{2}$/.test(hex)) {
      out += String.fromCharCode(Number.parseInt(hex, 16));
      i += 2;
    } else out += c === "+" ? " " : c;
  }
  return out;
}

/** url_encode over a byte string: every byte but the RFC 3986 unreserved ones as %XX. */
export function urlEncodeBytes(value: string): string {
  return value.replace(
    /[^A-Za-z0-9._~-]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`,
  );
}
/** base64_encode over a byte string: the standard alphabet with padding. */
export function base64EncodeBytes(value: string): string {
  return btoa(value);
}
/**
 * base64_decode over a byte string: the standard or the URL-safe alphabet (they may mix), with
 * or without padding; unused trailing bits are ignored. Anything else (other characters,
 * whitespace, misplaced or excess padding, a length that leaves one character) decodes to "".
 */
export function base64DecodeBytes(value: string): string {
  const text = value.replace(/-/g, "+").replace(/_/g, "/");
  const body = text.replace(/={1,2}$/, "");
  if (body !== text && text.length % 4 !== 0) return "";
  if (!/^[A-Za-z0-9+/]*$/.test(body) || body.length % 4 === 1) return "";
  return atob(body);
}
/**
 * substring over a byte string: `length` bytes (all when omitted) from byte `start`, counted
 * from the end when negative (clamped to the first byte); "" past the end.
 */
export function substringBytes(value: string, start: number, length?: number): string {
  const from = start < 0 ? Math.max(value.length + start, 0) : start;
  if (from >= value.length) return "";
  return value.slice(from, length === undefined ? value.length : from + length);
}

/**
 * The first cookie named `name` (case-sensitive) in a Cookie header value, as sent (not
 * decoded, quotes kept); "" without one. Several Cookie headers join with "; ". Pairs are
 * separated by ";"; spaces and tabs around a pair, its name and its value are ignored; a
 * pair without "=" is skipped.
 */
export function cookieValue(header: string, name: string): string {
  for (const pair of header.split(";")) {
    const eq = pair.indexOf("=");
    if (eq < 0) continue;
    if (pair.slice(0, eq).replace(/^[ \t]+|[ \t]+$/g, "") === name)
      return pair.slice(eq + 1).replace(/^[ \t]+|[ \t]+$/g, "");
  }
  return "";
}
/**
 * The first query parameter named `name` in a query string, as sent (neither name nor value
 * decoded); "" without one. Parameters are separated by "&"; the name is the text before the
 * first "=" (all of it without one, the value then being "").
 */
export function queryArgValue(query: string, name: string): string {
  for (const element of query.split("&")) {
    const eq = element.indexOf("=");
    if ((eq < 0 ? element : element.slice(0, eq)) === name)
      return eq < 0 ? "" : element.slice(eq + 1);
  }
  return "";
}

function expandReplacement(replacement: string, captures: (string | undefined)[]): string {
  return replacement.replace(/\$\{([1-8])\}/g, (_, n: string) => captures[Number(n)] ?? "");
}

/**
 * wildcard_replace over byte strings: full match of the literal segments with
 * leftmost placement (the lazy reading of every `*`), ASCII case-insensitive unless
 * `caseSensitive`. Returns the source unchanged without a match.
 */
export function wildcardReplaceBytes(
  source: string,
  pattern: string,
  replacement: string,
  caseSensitive = false,
): string {
  const captures = wildcardCaptures(source, pattern, caseSensitive);
  return captures ? expandReplacement(replacement, captures) : source;
}

/**
 * The captures (index 1 up) of a full wildcard match of a byte string, leftmost placement,
 * ASCII case-insensitive unless `caseSensitive`; null without a match. `pattern` is bytes.
 */
function wildcardCaptures(
  source: string,
  pattern: string,
  caseSensitive: boolean,
): (string | undefined)[] | null {
  const segments = wildcardSegments(fromBytes(pattern)).map(toBytes);
  const fold = caseSensitive ? (x: string) => x : asciiLower;
  const subject = fold(source);
  const parts = segments.map(fold);
  const first = parts[0] ?? "";
  if (parts.length === 1) return subject === first ? [undefined] : null;
  if (!subject.startsWith(first)) return null;
  let pos = first.length;
  const captures: (string | undefined)[] = [undefined];
  for (let i = 1; i < parts.length - 1; i++) {
    const at = subject.indexOf(parts[i] ?? "", pos);
    if (at < 0) return null;
    captures.push(source.slice(pos, at));
    pos = at + (parts[i] ?? "").length;
  }
  const last = parts[parts.length - 1] ?? "";
  if (subject.length - last.length < pos || !subject.endsWith(last)) return null;
  captures.push(source.slice(pos, subject.length - last.length));
  return captures;
}

/** `wildcard` (strict: `strict wildcard`) over byte strings: a full match of the pattern. */
export function wildcardMatchBytes(source: string, pattern: string, strict = false): boolean {
  return wildcardCaptures(source, pattern, strict) !== null;
}

/** regex_replace over byte strings: replaces the first match of a validated pattern. */
export function regexReplaceBytes(source: string, pattern: string, replacement: string): string {
  const match = new RegExp(compilePattern(fromBytes(pattern))).exec(source);
  if (!match) return source;
  return (
    source.slice(0, match.index) +
    expandReplacement(replacement, [...match]) +
    source.slice(match.index + match[0].length)
  );
}
