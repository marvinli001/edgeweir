import { displaySiteDomain } from "@edgeweir/contract";

/** "xn--bcher-kva.example, *.a.test" → "bücher.example, *.a.test" (Unicode labels, patterns as they are). */
export const displayDomainList = (list: string) =>
  list
    .split(", ")
    .map((domain) => displaySiteDomain(domain))
    .join(", ");

/**
 * Domains as stored (Punycode) for a one-line detail: shown in Unicode,
 * with the Punycode forms on a second line of the hover text when they differ.
 */
export function domainsDetail(domains: readonly string[]): { detail: string; title: string } {
  const ascii = domains.join(", ");
  const detail = displayDomainList(ascii);
  return { detail, title: detail === ascii ? detail : `${detail}\n${ascii}` };
}
