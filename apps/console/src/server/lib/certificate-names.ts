import { X509Certificate } from "node:crypto";
import { fail } from "./errors";

type Domain = { name: string; wildcard: boolean };

/** A site domain as a certificate name ("*.example.com" for a wildcard domain). */
export const certificateName = (domain: Domain) =>
  domain.wildcard ? `*.${domain.name}` : domain.name;

/**
 * Whether certificate names cover a site domain: the same name, or for a
 * plain domain a wildcard one label up. A wildcard domain needs the same
 * wildcard.
 */
export function namesCover(names: readonly string[], domain: Domain): boolean {
  if (names.includes(certificateName(domain))) return true;
  if (domain.wildcard) return false;
  const dot = domain.name.indexOf(".");
  return dot > 0 && names.includes(`*.${domain.name.slice(dot + 1)}`);
}

function leafOf(chainPem: string) {
  try {
    return new X509Certificate(chainPem);
  } catch {
    return fail("CERTIFICATE_INVALID", "invalid stored certificate");
  }
}
const dnsNames = (leaf: X509Certificate) =>
  (leaf.subjectAltName ?? "")
    .split(/,\s*/)
    .filter((part) => part.startsWith("DNS:"))
    .map((part) => part.slice(4).toLowerCase());

/** The site domains a certificate chain does not cover (as nodes check it). */
export function uncoveredDomains<T extends Domain>(chainPem: string, domains: readonly T[]): T[] {
  const leaf = leafOf(chainPem);
  const sans = dnsNames(leaf);
  return domains.filter((domain) =>
    domain.wildcard ? !sans.includes(certificateName(domain)) : !leaf.checkHost(domain.name),
  );
}

/** Fails with the domains a certificate does not cover, the first five named. */
export function failUncovered(domains: readonly Domain[]): never {
  const list = domains.slice(0, 5).map(certificateName).join(", ");
  fail("CERTIFICATE_DOMAIN_MISMATCH", `certificate does not cover ${list}`, { domains: list });
}

/** Every writer of a site's domains/TLS binding uses the same check: the chain covers every domain. */
export function assertCertificateNames(chainPem: string, domains: readonly Domain[]) {
  const uncovered = uncoveredDomains(chainPem, domains);
  if (uncovered.length) failUncovered(uncovered);
}
