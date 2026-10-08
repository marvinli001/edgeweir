import {
  type DomainKind,
  formatSiteDomain,
  MAX_REGEX_DOMAINS,
  punycodeDecode,
} from "@edgeweir/contract";
import { DomainMatch } from "@edgeweir/proto";
import { toASCII, toUnicode } from "tr46";
import { fail } from "./errors";
import { normalizeSiteDomain } from "./idna";

/** A stored site domain (site_domain.name and kind). */
export interface DomainRow {
  name: string;
  kind: DomainKind;
}

/** The form of a compiled Domain or OfflineHost (config.proto). */
export const protoKind = (d: { wildcard: boolean; match: DomainMatch }): DomainKind =>
  d.match === DomainMatch.REGEX
    ? "regex"
    : d.match === DomainMatch.SUFFIX
      ? "suffix"
      : d.wildcard
        ? "wildcard"
        : "exact";

/** Exact and `*.` domains name hosts; `.` and `~` ones match many. */
export const namesHosts = (d: { kind: string }) => d.kind === "exact" || d.kind === "wildcard";

export const formatDomain = (d: { name: string; kind: string }) =>
  formatSiteDomain({ name: d.name, kind: d.kind as DomainKind });

/**
 * A site's domains as stored: each formatted domain (contract siteDomain)
 * with its host converted by UTS #46 (DOMAIN_INVALID when refused), without
 * duplicates, in the order given.
 */
export function normalizeDomains(domains: string[]): DomainRow[] {
  const out = new Map<string, DomainRow>();
  for (const domain of domains) {
    const parsed = normalizeSiteDomain(domain);
    if (!parsed) fail("DOMAIN_INVALID", `invalid domain name: ${domain}`, { domain });
    out.set(formatSiteDomain(parsed), parsed);
  }
  const rows = [...out.values()];
  if (rows.filter((d) => d.kind === "regex").length > MAX_REGEX_DOMAINS)
    fail("DOMAIN_INVALID", `at most ${MAX_REGEX_DOMAINS} regex domains`, {
      domain: rows.filter((d) => d.kind === "regex").map(formatDomain)[MAX_REGEX_DOMAINS] ?? "",
    });
  return rows;
}

/** ς and σ are one letter to a search: UTS #46 keeps ς, but maps a typed Σ to σ. */
const foldSigma = (text: string) => text.replaceAll("ς", "σ");

/**
 * A search term as unicodeDomainHolds compares it: mapped like a host name
 * (UTS #46 nontransitional: case, full width, ideographic full stops,
 * `xn--` labels decoded), or in NFC and lowercase with "." for the
 * ideographic full stops when the mapping refuses it (part of a label may
 * begin with a combining mark).
 */
export function unicodeSearchTerm(term: string): string {
  const { domain, error } = toUnicode(term, { transitionalProcessing: false });
  const mapped = error
    ? term
        .normalize("NFC")
        .toLowerCase()
        .replace(/[。．｡]/g, ".")
    : domain.toLowerCase();
  return foldSigma(mapped);
}

/**
 * Whether a stored domain holds a search term (unicodeSearchTerm) in its
 * Unicode form with its `*.`, `.` or `~` prefix (every `xn--` label of a
 * host decoded, look-alikes too): Punycode encodes whole labels, so part
 * of a Unicode label, or a term that runs past its end ("ui.g10" in
 * bücher-ui.g10.test), is no substring of the stored name.
 */
export function unicodeDomainHolds(domain: { name: string; kind: string }, term: string): boolean {
  if (!term) return false;
  const name =
    domain.kind === "regex"
      ? domain.name
      : domain.name
          .split(".")
          .map((label) =>
            label.startsWith("xn--") ? (punycodeDecode(label.slice(4)) ?? label) : label,
          )
          .join(".");
  return foldSigma(formatDomain({ kind: domain.kind, name })).includes(term);
}

/** The Punycode form of a search term with Unicode letters (lenient: parts of names too); null otherwise. */
export function asciiSearch(term: string): string | null {
  if (/^[\x20-\x7e]*$/.test(term)) return null;
  const ascii = toASCII(term.toLowerCase(), { transitionalProcessing: false });
  return ascii && ascii !== term ? ascii : null;
}
