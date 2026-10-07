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

/** A host name with its `xn--` labels decoded for display; labels that do not decode stay as they are. */
export function unicodeHost(host: string): string {
  return host
    .split(".")
    .map((label) => (label.startsWith("xn--") ? (punycodeDecode(label.slice(4)) ?? label) : label))
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
  try {
    validatePattern(pattern);
  } catch (error) {
    if (error instanceof ExpressionError) return error.code;
    throw error;
  }
  if (/[A-Z]/.test(pattern.replace(/\\x[0-9a-fA-F]{2}|\\./g, ""))) return "uppercase";
  return null;
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
