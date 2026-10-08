import {
  DOMAINS_V2_FEATURE,
  formatSiteDomain,
  ldhHost,
  nodeSupportsFeature,
  parseSiteDomain,
  punycodeDecode,
  siteDomain,
  siteDomainKind,
  type ToAscii,
} from "@edgeweir/contract";
import { domainList } from "./address-input";

/**
 * Hosts the browser converts as the console does: letters, marks, decimal
 * digits, hyphens and dots, the joiners ZWNJ and ZWJ, and the punctuation
 * UTS #46 keeps in labels (· ͵ ׳ ״ ・). Other characters (symbols such as
 * ⒈, which the browser maps without UseSTD3ASCIIRules) are left to the
 * console.
 */
const COMPARABLE_HOST = /^(?:[\p{L}\p{M}\p{Nd}\u00b7\u0375\u05f3\u05f4\u30fb.-]|\u200c|\u200d)+$/u;
const PARSE_SCHEME = "http";

/** The host as the browser's URL parser converts it (domain to ASCII); null when refused. */
function urlHostname(host: string): string | null {
  try {
    // Parsed here, never fetched: a special scheme's host goes through domain to ASCII.
    return new URL(`${PARSE_SCHEME}://${host}/`).hostname;
  } catch {
    return null;
  }
}

/**
 * Characters browsers have converted differently over time, each with hosts
 * the browser has to convert as the console does (the same ASCII, or null:
 * refused) before names holding them are compared: ß and ς (transitional
 * processing in older browsers maps them to "ss" and "σ"), ẞ (mapped to
 * "ss" before Unicode 15.1, to ß since) and the joiners ZWNJ and ZWJ
 * (dropped by transitional processing, refused by CheckJoiners outside the
 * contexts that allow them).
 */
export const BROWSER_PROBES: readonly {
  chars: RegExp;
  hosts: Readonly<Record<string, string | null>>;
}[] = [
  { chars: /[ßς]/u, hosts: { "faß.de": "xn--fa-hia.de", "ας.gr": "xn--mxa8a.gr" } },
  { chars: /ẞ/u, hosts: { "ẞ.de": "xn--zca.de" } },
  {
    chars: /\u200c|\u200d/u,
    hosts: {
      "a\u200cb.de": null,
      "a\u200db.de": null,
      "\u0647\u200c\u0627.de": "xn--mgb7d545h.de",
      "\u0915\u094d\u200d\u0937.de": "xn--11b2ezcw70k.de",
    },
  },
];

/**
 * A ToAscii by a browser's host conversion (`hostname`, the URL host
 * parser's: UTS #46 ToASCII, nontransitional, CheckBidi, CheckJoiners in
 * current browsers), checked by the console's LDH rules; null when the
 * host is not valid or only the console can tell: characters outside
 * COMPARABLE_HOST, or of a probe (BROWSER_PROBES) the browser fails.
 */
export function hostnameAscii(hostname: (host: string) => string | null): ToAscii {
  const passed = new Map<RegExp, boolean>();
  const converts = (probe: (typeof BROWSER_PROBES)[number]) => {
    let ok = passed.get(probe.chars);
    if (ok === undefined) {
      ok = Object.entries(probe.hosts).every(([host, ascii]) => hostname(host) === ascii);
      passed.set(probe.chars, ok);
    }
    return ok;
  };
  return (host) => {
    if (/^[\x20-\x7e]*$/.test(host)) {
      const lower = host.toLowerCase();
      return ldhHost(lower) ? lower : null;
    }
    if (!COMPARABLE_HOST.test(host)) return null;
    if (BROWSER_PROBES.some((probe) => probe.chars.test(host) && !converts(probe))) return null;
    const ascii = hostname(host);
    if (ascii === null || !ldhHost(ascii)) return null;
    for (const label of ascii.split(".")) {
      if (!label.startsWith("xn--")) continue;
      const unicode = punycodeDecode(label.slice(4));
      if (unicode === null || unicode.startsWith("-") || unicode.endsWith("-")) return null;
    }
    return ascii;
  };
}

/** The host's ASCII form as the console stores it, converted by this browser (hostnameAscii). */
export const browserAscii: ToAscii = hostnameAscii(urlHostname);

/**
 * A domain as typed in the form the console stores it: the contract's
 * siteDomain form (a leading 。 or ． is a suffix's dot), its host in ASCII
 * when the browser can tell (Unicode, full-width and upper-case names alike;
 * `toAscii`, browserAscii by default); patterns stay exactly as typed. Null
 * when the domain is not valid.
 */
export function storedDomain(typed: string, toAscii: ToAscii = browserAscii): string | null {
  const formatted = siteDomain.safeParse(typed);
  if (!formatted.success) return null;
  const parsed = parseSiteDomain(formatted.data, toAscii);
  return parsed ? formatSiteDomain(parsed) : formatted.data;
}

/**
 * The domains typed into `input` that `listed` does not hold yet, compared
 * in their stored form (storedDomain with `toAscii`), each in that form;
 * one that is not valid stays as typed (for the error message).
 */
export function newDomains(
  input: string,
  listed: readonly string[],
  toAscii: ToAscii = browserAscii,
): string[] {
  const known = new Set(listed.map((domain) => storedDomain(domain, toAscii) ?? domain));
  const out: string[] = [];
  for (const typed of domainList(input)) {
    const value = storedDomain(typed, toAscii) ?? typed;
    if (known.has(value)) continue;
    known.add(value);
    out.push(value);
  }
  return out;
}

/** Whether a domain is a suffix (`.a.com`) or a pattern (`~…`) once stored: they need domains-v2. */
export function needsDomainForms(domains: readonly string[]): boolean {
  return domains.some((domain) => {
    const kind = siteDomainKind(storedDomain(domain) ?? domain);
    return kind === "suffix" || kind === "regex";
  });
}

/** Whether every active node of a cluster supports suffix and pattern domains (domains-v2). */
export function domainFormsAvailable(
  nodes: readonly { status: string; supportedFeatures: readonly string[] }[],
): boolean {
  return nodes
    .filter((node) => node.status === "active")
    .every((node) => nodeSupportsFeature(node.supportedFeatures, DOMAINS_V2_FEATURE));
}
