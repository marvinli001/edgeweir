import { type DomainKind, formatSiteDomain, MAX_REGEX_DOMAINS } from "@edgeweir/contract";
import { DomainMatch } from "@edgeweir/proto";
import { toASCII } from "tr46";
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

/** The Punycode form of a search term with Unicode letters (lenient: parts of names too); null otherwise. */
export function asciiSearch(term: string): string | null {
  if (/^[\x20-\x7e]*$/.test(term)) return null;
  const ascii = toASCII(term.toLowerCase(), { transitionalProcessing: false });
  return ascii && ascii !== term ? ascii : null;
}
