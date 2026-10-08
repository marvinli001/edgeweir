import { ExpressionError, patternRegExp, validatePattern } from "@edgeweir/rule-engine";
import * as z from "zod";

/**
 * How a site domain matches the request host (without port):
 * - exact `a.com`: the host itself;
 * - wildcard `*.a.com`: one label left of `a.com` (not `x.y.a.com`, not `a.com`);
 * - suffix `.a.com`: any subdomain of `a.com` at any depth (not `a.com`);
 * - regex `~pattern`: the whole lowercase host, as `^(?:pattern)$`.
 * Precedence: exact > wildcard > suffix (longer first) > regex (site creation
 * time, then the site's domain order).
 */
export const DOMAIN_KINDS = ["exact", "wildcard", "suffix", "regex"] as const;
export type DomainKind = (typeof DOMAIN_KINDS)[number];

export const MAX_SITE_DOMAINS = 50;
/** Regex domains per site; they count towards MAX_SITE_DOMAINS. */
export const MAX_REGEX_DOMAINS = 10;
export const MAX_DOMAIN_PATTERN_LENGTH = 256;

export interface SiteDomainParts {
  kind: DomainKind;
  /** The ASCII host (exact), the suffix after `*.` or `.`, or the pattern after `~`. */
  name: string;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME_RE = new RegExp(`^(?:${LABEL}\\.)*${LABEL}$`);
/** Characters that never belong to a host name, Unicode or not: URL syntax and whitespace. */
const NOT_HOST_RE = /[\s/?#@:[\]\\%<>^|"`{}*,;=&'()!$+~]/u;

/**
 * Whether `host` is an ASCII host name by the LDH rules: labels of lowercase
 * letters, digits and inner hyphens, 1-63 characters each, 253 in all, and
 * at least two labels (or `localhost`).
 */
export function ldhHost(host: string): boolean {
  return (
    host.length <= 253 && HOSTNAME_RE.test(host) && (host.includes(".") || host === "localhost")
  );
}

/** Converts a host as typed to its ASCII form; null when it is not valid. */
export type ToAscii = (host: string) => string | null;

/**
 * The host as far as it can be checked without the IDNA tables: pure ASCII
 * without `xn--` labels is lowercased and checked by the LDH rules (what UTS
 * #46 does with it); anything else is kept for the console to convert
 * (UTS #46, nontransitional) and only refused when it holds characters no
 * host name has.
 */
export const previewAscii: ToAscii = (host) => {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are refused
  if (!host || /[\u0000-\u001f\u007f]/.test(host)) return null;
  if (/^[\x20-\x7e]*$/.test(host) && !/(?:^|\.)xn--/i.test(host)) {
    const lower = host.toLowerCase();
    return ldhHost(lower) ? lower : null;
  }
  // UTS #46 maps the ideographic full stops to ".".
  const dotted = host.replace(/[\u3002\uff0e\uff61]/g, ".");
  return NOT_HOST_RE.test(dotted) || dotted.length > 1024 ? null : dotted;
};

/** Whether the host still needs the console's UTS #46 conversion. */
export const needsIdna = (host: string) =>
  !/^[\x20-\x7e]*$/.test(host) || /(?:^|\.)xn--/i.test(host);

const BASE = 36;
const TMIN = 1;
const TMAX = 26;
const SKEW = 38;
const DAMP = 700;
const MAX_INT = 0x7fffffff;

function adapt(delta: number, points: number, first: boolean) {
  let d = first ? Math.floor(delta / DAMP) : delta >> 1;
  d += Math.floor(d / points);
  let k = 0;
  while (d > ((BASE - TMIN) * TMAX) >> 1) {
    d = Math.floor(d / (BASE - TMIN));
    k += BASE;
  }
  return k + Math.floor(((BASE - TMIN + 1) * d) / (d + SKEW));
}

function digitOf(code: number) {
  if (code >= 0x30 && code <= 0x39) return code - 22;
  if (code >= 0x61 && code <= 0x7a) return code - 0x61;
  if (code >= 0x41 && code <= 0x5a) return code - 0x41;
  return BASE;
}

/** Decodes the Punycode (RFC 3492) of one label without its `xn--` prefix; null when invalid. */
export function punycodeDecode(input: string): string | null {
  const output: number[] = [];
  const delimiter = Math.max(input.lastIndexOf("-"), 0);
  for (let j = 0; j < delimiter; j++) {
    const code = input.charCodeAt(j);
    if (code >= 0x80) return null;
    output.push(code);
  }
  let n = 0x80;
  let bias = 72;
  let i = 0;
  for (let index = delimiter > 0 ? delimiter + 1 : 0; index < input.length; ) {
    const previous = i;
    let w = 1;
    for (let k = BASE; ; k += BASE) {
      if (index >= input.length) return null;
      const digit = digitOf(input.charCodeAt(index++));
      if (digit >= BASE || digit > Math.floor((MAX_INT - i) / w)) return null;
      i += digit * w;
      const t = k <= bias ? TMIN : k >= bias + TMAX ? TMAX : k - bias;
      if (digit < t) break;
      if (w > Math.floor(MAX_INT / (BASE - t))) return null;
      w *= BASE - t;
    }
    const length = output.length + 1;
    bias = adapt(i - previous, length, previous === 0);
    if (Math.floor(i / length) > MAX_INT - n) return null;
    n += Math.floor(i / length);
    i %= length;
    output.splice(i++, 0, n);
  }
  if (output.some((code) => code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff))) return null;
  return String.fromCodePoint(...output);
}

/** Scripts told apart when deciding whether a label is shown in Unicode. */
const SCRIPTS = [
  "Latin",
  "Greek",
  "Cyrillic",
  "Armenian",
  "Hebrew",
  "Arabic",
  "Syriac",
  "Thaana",
  "Devanagari",
  "Bengali",
  "Gurmukhi",
  "Gujarati",
  "Oriya",
  "Tamil",
  "Telugu",
  "Kannada",
  "Malayalam",
  "Sinhala",
  "Thai",
  "Lao",
  "Tibetan",
  "Myanmar",
  "Georgian",
  "Hangul",
  "Ethiopic",
  "Khmer",
  "Mongolian",
  "Hiragana",
  "Katakana",
  "Bopomofo",
  "Han",
].map((name) => ({ name, re: new RegExp(`\\p{Script=${name}}`, "u") }));
/** Script combinations a label may mix (UTS #39 "highly restrictive"). */
const MIXES = [
  ["Latin", "Han", "Hiragana", "Katakana"],
  ["Latin", "Han", "Bopomofo"],
  ["Latin", "Han", "Hangul"],
];

/**
 * Whether a decoded label is shown in Unicode: no control, format or
 * space characters, and its letters in one script or a combination
 * browsers also allow (Latin with Han and Japanese kana, Bopomofo or
 * Hangul). Others (say Latin mixed with Cyrillic look-alikes) stay in
 * Punycode, as browsers show them.
 */
export function displayableLabel(label: string): boolean {
  if (/[\p{Cc}\p{Cf}\p{Z}]/u.test(label)) return false;
  const scripts = new Set<string>();
  for (const ch of label) {
    if (!/\p{L}/u.test(ch)) continue;
    const script = SCRIPTS.find((s) => s.re.test(ch));
    scripts.add(script ? script.name : `other:${ch}`);
  }
  if (scripts.size <= 1) return !(scripts.size === 1 && [...scripts][0]?.startsWith("other:"));
  return MIXES.some((mix) => [...scripts].every((script) => mix.includes(script)));
}

/**
 * A host name with its `xn--` labels decoded for display; labels that do
 * not decode, or that mix scripts (displayableLabel), stay as they are.
 */
export function unicodeHost(host: string): string {
  return host
    .split(".")
    .map((label) => {
      if (!label.startsWith("xn--")) return label;
      const decoded = punycodeDecode(label.slice(4));
      return decoded !== null && displayableLabel(decoded) ? decoded : label;
    })
    .join(".");
}

/**
 * Why a regex domain is refused (null: accepted): the shared pattern subset,
 * at most MAX_DOMAIN_PATTERN_LENGTH characters, lowercase letters only (escape
 * sequences aside: hosts are matched lowercase), and no quote, escaped
 * backslash or space (nodes render the pattern into a quoted server_name).
 */
export function domainPatternError(pattern: string): string | null {
  if (!pattern) return "empty";
  if (pattern.length > MAX_DOMAIN_PATTERN_LENGTH) return "too_long";
  if (/["\s]/.test(pattern) || pattern.includes("\\\\")) return "character";
  // A Host never holds a comma: one outside a {n,m} quantifier (say, a list
  // typed into one field) would make the pattern match nothing.
  if (pattern.replace(/\{\d+,\d*\}/g, "").includes(",")) return "character";
  // The console matches patterns with JavaScript's backtracking engine
  // (purge resolution): more than two repeating quantifiers can take
  // seconds on a long host, two stay within a fraction of a millisecond.
  if (repeatingQuantifiers(pattern) > MAX_PATTERN_REPEATS) return "too_complex";
  try {
    validatePattern(pattern);
  } catch (error) {
    if (error instanceof ExpressionError) return error.code;
    throw error;
  }
  if (/[A-Z]/.test(pattern.replace(/\\x[0-9a-fA-F]{2}|\\./g, ""))) return "uppercase";
  return null;
}

/** Repeating quantifiers (*, +, {n,} and {n,m} with m > 1) a domain pattern may hold. */
export const MAX_PATTERN_REPEATS = 2;

/** The quantifiers of a pattern that repeat (*, +, {n,}, {n,m} with m > 1), outside classes and escapes. */
export function repeatingQuantifiers(pattern: string): number {
  let count = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      continue;
    }
    if (c === "[") {
      // Skip the class (a "]" right after "[" or "[^" is a literal).
      i++;
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      continue;
    }
    if (c === "*" || c === "+") count++;
    else if (c === "{") {
      const m = /^\{(\d+)(,(\d*))?\}/.exec(pattern.slice(i));
      if (m) {
        const max = m[2] === undefined ? Number(m[1]) : m[3] === "" ? Infinity : Number(m[3]);
        if (max > 1) count++;
        i += m[0].length - 1;
      }
    }
  }
  return count;
}

/** Splits and normalizes a domain as typed; null when it is not valid. */
export function parseSiteDomain(
  value: string,
  toAscii: ToAscii = previewAscii,
): SiteDomainParts | null {
  const input = value.trim();
  if (input.startsWith("~")) {
    const pattern = input.slice(1);
    return domainPatternError(pattern) === null ? { kind: "regex", name: pattern } : null;
  }
  const kind: DomainKind = input.startsWith("*.")
    ? "wildcard"
    : input.startsWith(".")
      ? "suffix"
      : "exact";
  const host = toAscii(input.slice(kind === "wildcard" ? 2 : kind === "suffix" ? 1 : 0));
  if (host === null || (kind !== "exact" && !host.includes("."))) return null;
  return { kind, name: host };
}

const PREFIX: Record<DomainKind, string> = { exact: "", wildcard: "*.", suffix: ".", regex: "~" };

export function formatSiteDomain(domain: SiteDomainParts): string {
  return `${PREFIX[domain.kind]}${domain.name}`;
}

/** The kind of a formatted domain (the API's form). */
export function siteDomainKind(formatted: string): DomainKind {
  return formatted.startsWith("~")
    ? "regex"
    : formatted.startsWith("*.")
      ? "wildcard"
      : formatted.startsWith(".")
        ? "suffix"
        : "exact";
}

/** A formatted domain for display: Unicode labels (patterns stay as they are). */
export function displaySiteDomain(formatted: string): string {
  if (formatted.startsWith("~")) return formatted;
  const prefix = PREFIX[siteDomainKind(formatted)];
  return prefix + unicodeHost(formatted.slice(prefix.length));
}

/**
 * A site domain as typed: `a.com`, `*.a.com`, `.a.com` or `~pattern`.
 * Output: the formatted form, ASCII hosts lowercased; Unicode hosts (and
 * `xn--` labels) are converted to Punycode by the console (UTS #46), which
 * refuses them with DOMAIN_INVALID when they are not valid.
 */
export const siteDomain = z
  .string()
  .max(1024)
  .transform((value, ctx) => {
    const parsed = parseSiteDomain(value);
    if (!parsed) {
      ctx.addIssue({ code: "custom", message: "invalid domain name", input: value });
      return z.NEVER;
    }
    return formatSiteDomain(parsed);
  });

/** A site's domains: 1-50, at most MAX_REGEX_DOMAINS patterns. */
export const siteDomains = z
  .array(siteDomain)
  .min(1)
  .max(MAX_SITE_DOMAINS)
  .refine(
    (list) => list.filter((d) => d.startsWith("~")).length <= MAX_REGEX_DOMAINS,
    `at most ${MAX_REGEX_DOMAINS} regex domains`,
  );

/** Compiled host matchers by precedence; see matchHost. */
/**
 * Domain.order of a site's pattern domain, the nodes' precedence among
 * patterns: the site's creation time in milliseconds × 16 + the pattern's
 * index among the site's patterns (in the site's domain order); equal
 * orders go by site id.
 */
export function patternOrder(siteCreatedMs: number, index: number): number {
  return siteCreatedMs * 16 + index;
}

/**
 * Site domains with the nodes' pattern precedence: each site's patterns
 * numbered in the order given (patternOrder), then every pattern sorted
 * by (order, site id); the other forms come first, in the order given.
 * The input lists each site's domains in its domain order.
 */
export function inPatternOrder<
  T extends { kind: DomainKind; siteId: string; siteCreatedMs: number },
>(domains: Iterable<T>): (T & { order: number })[] {
  const next = new Map<string, number>();
  const out: (T & { order: number })[] = [];
  for (const d of domains) {
    if (d.kind !== "regex") {
      out.push({ ...d, order: 0 });
      continue;
    }
    const index = next.get(d.siteId) ?? 0;
    next.set(d.siteId, index + 1);
    out.push({ ...d, order: patternOrder(d.siteCreatedMs, index) });
  }
  const rank = (d: { kind: DomainKind }) => (d.kind === "regex" ? 1 : 0);
  return out.sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (rank(a) === 1
        ? a.order - b.order || (a.siteId < b.siteId ? -1 : a.siteId > b.siteId ? 1 : 0)
        : 0),
  );
}

export interface HostMatcher<T> {
  exact: Map<string, T>;
  wildcard: Map<string, T>;
  suffix: Map<string, T>;
  /** In precedence order. */
  regex: { re: RegExp; value: T }[];
}

/**
 * Builds a matcher from domains in precedence order for the regex ones
 * (callers sort by site creation time, then the site's domain order). The
 * first owner of a domain wins; invalid patterns are skipped.
 */
export function hostMatcher<T>(domains: Iterable<SiteDomainParts & { value: T }>): HostMatcher<T> {
  const matcher: HostMatcher<T> = {
    exact: new Map(),
    wildcard: new Map(),
    suffix: new Map(),
    regex: [],
  };
  for (const d of domains) {
    if (d.kind === "regex") {
      try {
        matcher.regex.push({ re: patternRegExp(d.name, true), value: d.value });
      } catch {
        // A pattern outside the subset never matches.
      }
      continue;
    }
    const map = matcher[d.kind];
    if (!map.has(d.name)) map.set(d.name, d.value);
  }
  return matcher;
}

/** The owner of `host` (lowercase, without port) by precedence, or undefined. */
export function matchHost<T>(matcher: HostMatcher<T>, host: string): T | undefined {
  const exact = matcher.exact.get(host);
  if (exact !== undefined) return exact;
  let dot = host.indexOf(".");
  if (dot > 0) {
    const wildcard = matcher.wildcard.get(host.slice(dot + 1));
    if (wildcard !== undefined) return wildcard;
  }
  // Longest suffix first: drop one label at a time.
  while (dot > 0) {
    const suffix = matcher.suffix.get(host.slice(dot + 1));
    if (suffix !== undefined) return suffix;
    dot = host.indexOf(".", dot + 1);
  }
  return matcher.regex.find((r) => r.re.test(host))?.value;
}
