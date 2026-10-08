import { X509Certificate } from "node:crypto";
import { fail } from "./errors";

/** A site domain (site_domain.name and kind). */
type Domain = { name: string; kind: string };

/**
 * A site domain as a certificate name: "*.example.com" for a wildcard
 * domain and for a suffix domain (".example.com", whose deeper levels no
 * certificate name covers). A pattern names no host: it is shown as
 * "~pattern" and never issued for (callers leave patterns out).
 */
export function certificateName(domain: Domain): string {
  if (domain.kind === "regex") return `~${domain.name}`;
  return domain.kind === "exact" ? domain.name : `*.${domain.name}`;
}

/**
 * Whether certificate names cover a site domain: the same name, or for a
 * plain domain a wildcard one label up. A wildcard or suffix domain needs
 * the wildcard; a pattern is never covered.
 */
export function namesCover(names: readonly string[], domain: Domain): boolean {
  if (domain.kind === "regex") return false;
  if (names.includes(certificateName(domain))) return true;
  if (domain.kind !== "exact") return false;
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

/**
 * The site domains a certificate chain does not cover (as nodes check it).
 * Suffix and pattern domains are never listed: nodes complete the handshake
 * for the hosts among them the certificate covers and abort it for others.
 */
export function uncoveredDomains<T extends Domain>(chainPem: string, domains: readonly T[]): T[] {
  const leaf = leafOf(chainPem);
  const sans = dnsNames(leaf);
  return domains.filter((domain) =>
    domain.kind === "wildcard"
      ? !sans.includes(certificateName(domain))
      : domain.kind === "exact" && !leaf.checkHost(domain.name),
  );
}

/**
 * The site domains none of a site's certificate chains covers (as nodes
 * check them: every domain needs at least one certificate).
 */
export function uncoveredByAll<T extends Domain>(
  chainPems: readonly string[],
  domains: readonly T[],
): T[] {
  let left = [...domains];
  for (const chainPem of chainPems) {
    if (!left.length) break;
    const uncovered = new Set(uncoveredDomains(chainPem, left));
    left = left.filter((domain) => uncovered.has(domain));
  }
  return left;
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
