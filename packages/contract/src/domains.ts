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

/** Scripts a label shown in Unicode may be written in. */
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
].map((name) => ({
  name,
  script: new RegExp(`\\p{Script=${name}}`, "u"),
  extensions: new RegExp(`\\p{Script_Extensions=${name}}`, "u"),
}));
/** Characters without a script of their own (Script Common or Inherited). */
const COMMON_CHARACTER = /[\p{Script=Common}\p{Script=Inherited}]/u;
/** Of those, the ones every script uses (Script_Extensions Common or Inherited: 0-9, "-", most combining marks). */
const SHARED_CHARACTER = /[\p{Script_Extensions=Common}\p{Script_Extensions=Inherited}]/u;
/** Characters that do not show: controls, format and space characters, default ignorables. */
const HIDDEN_CHARACTER = /[\p{Cc}\p{Cf}\p{Z}\p{Default_Ignorable_Code_Point}]/u;
/** Quote look-alikes browsers never show in Unicode (U+02BB, U+02BC, U+02EC). */
const QUOTE_LIKE = /[\u02bb\u02bc\u02ec]/u;
/** The prolonged sound mark ー (and its halfwidth form): shown only right after kana. */
const PROLONGED_SOUND_MARK = /[\u30fc\uff70]/u;
const KANA = /[\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/u;
/** Script mixes UTS #39 "highly restrictive" allows. */
const MIXES = [
  ["Latin", "Han", "Hiragana", "Katakana"],
  ["Latin", "Han", "Bopomofo"],
  ["Latin", "Han", "Hangul"],
];

/**
 * Whether a decoded label is shown in Unicode, by the UTS #39 rules
 * browsers apply and Chromium's rules for ー and quote look-alikes:
 * - no control, format, space or default-ignorable characters;
 * - its characters with a script of their own (letters, digits and marks
 *   alike) in one script or a mix browsers also allow (Latin with Han and
 *   Japanese kana, Bopomofo or Hangul): Latin mixed with Cyrillic
 *   look-alikes or with another script's digits (`g০০gle`) stays in
 *   Punycode;
 * - a character several scripts share (Script_Extensions: ー, 〆, the
 *   Arabic tatweel) only in a label with characters of one of them, where
 *   a letter among them never counts as Latin (`abˍcd`, `abˇcd`); letters
 *   no script claims (`abːcd`) stay in Punycode, and so does ー unless
 *   kana come right before it (`paypalーlogin`, `ーabc`).
 * A label all in one script that looks like a Latin word (Cyrillic `аре`)
 * is still shown in Unicode.
 */
export function displayableLabel(label: string): boolean {
  if (HIDDEN_CHARACTER.test(label) || QUOTE_LIKE.test(label)) return false;
  const own = new Set<string>();
  const shared: string[][] = [];
  let previous = "";
  for (const ch of label) {
    if (PROLONGED_SOUND_MARK.test(ch) && !KANA.test(previous)) return false;
    previous = ch;
    const script = SCRIPTS.find((s) => s.script.test(ch));
    if (script) own.add(script.name);
    // A script none of the sets has (or an unassigned code point).
    else if (!COMMON_CHARACTER.test(ch)) return false;
    else if (SHARED_CHARACTER.test(ch)) {
      if (/\p{L}/u.test(ch)) return false;
    } else {
      const letter = /\p{L}/u.test(ch);
      shared.push(
        SCRIPTS.filter((s) => s.extensions.test(ch) && !(letter && s.name === "Latin")).map(
          (s) => s.name,
        ),
      );
    }
  }
  const scripts = [...own];
  if (scripts.length > 1 && !MIXES.some((mix) => scripts.every((s) => mix.includes(s))))
    return false;
  return shared.every((names) => names.some((name) => own.has(name)));
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
  // Nodes match patterns with PCRE's backtracking engine on every Host no
  // exact or wildcard name takes (nginx without a match limit): its shape
  // bounds the work on a host of at most 253 characters. More than two
  // repeating quantifiers grow it by another power of the host's length,
  // and every alternative or optional part multiplies it.
  if (repeatingQuantifiers(pattern) > MAX_PATTERN_REPEATS) return "too_complex";
  if (patternBranches(pattern) > MAX_PATTERN_BRANCHES) return "too_complex";
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
/** The product of a pattern's alternatives and optional parts (patternBranches) may reach this. */
export const MAX_PATTERN_BRANCHES = 16;

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
        // A fixed count {n} never backtracks.
        const max = m[2] === undefined ? 0 : m[3] === "" ? Infinity : Number(m[3]);
        if (max > 1) count++;
        i += m[0].length - 1;
      }
    }
  }
  return count;
}

/**
 * The product of a pattern's branches: each group or the whole pattern
 * counts its alternatives, each optional part (?, {0,1}) counts 2; classes
 * and escapes count 1. It bounds how often a backtracking engine tries a
 * position again on top of the repeating quantifiers.
 */
export function patternBranches(pattern: string): number {
  let product = 1;
  const alternatives = [1];
  // Whether the previous token is a quantifier (*, +, ?, {n}, {n,}, {n,m}): a
  // "?" after one only makes it lazy. Tokens, not characters: "\+?" and
  // "[*]?" are optional parts.
  let quantified = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "\\") {
      i++;
      quantified = false;
      continue;
    }
    if (c === "[") {
      i++;
      if (pattern[i] === "^") i++;
      if (pattern[i] === "]") i++;
      while (i < pattern.length && pattern[i] !== "]") {
        if (pattern[i] === "\\") i++;
        i++;
      }
      quantified = false;
      continue;
    }
    if (c === "?") {
      if (!quantified) product *= 2;
      // A lazy "?" is no quantifier a further "?" could make lazy.
      quantified = !quantified;
      continue;
    }
    if (c === "*" || c === "+") {
      quantified = true;
      continue;
    }
    if (c === "{") {
      const m = /^\{\d+(,\d*)?\}/.exec(pattern.slice(i));
      if (m) {
        if (m[0] === "{0,1}") product *= 2;
        i += m[0].length - 1;
        quantified = true;
        continue;
      }
    }
    quantified = false;
    if (c === "(") {
      // "(?:" and other group modifiers: not an optional part.
      if (pattern[i + 1] === "?") i++;
      alternatives.push(1);
    } else if (c === "|") {
      alternatives[alternatives.length - 1] = (alternatives.at(-1) ?? 1) + 1;
    } else if (c === ")") {
      if (alternatives.length > 1) product *= alternatives.pop() ?? 1;
    }
  }
  for (const count of alternatives) product *= count;
  return product;
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

/** The longest host name patterns are tried on (a DNS name). */
export const MAX_PATTERN_HOST = 253;

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
  // Node IP access ("_", an IPv4 address, an IPv6 address in brackets) is
  // matched by exact names only.
  if (host === "_" || host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return undefined;
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
  // No pattern sees a host longer than a DNS name (nodes: a guard server).
  if (host.length > MAX_PATTERN_HOST) return undefined;
  return matcher.regex.find((r) => r.re.test(host))?.value;
}
