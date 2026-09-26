import { X509Certificate } from "node:crypto";
import { fail } from "./errors";

/** Every writer of a site's domains/TLS binding uses the same check. */
export function assertCertificateNames(
  chainPem: string,
  names: string[],
  domains: { name: string; wildcard: boolean }[],
) {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(chainPem);
  } catch {
    fail("CERTIFICATE_INVALID", "invalid stored certificate");
  }
  if (
    domains.some((domain) =>
      domain.wildcard ? !names.includes(`*.${domain.name}`) : !leaf.checkHost(domain.name),
    )
  ) {
    fail("CERTIFICATE_DOMAIN_MISMATCH", "certificate does not cover every site domain");
  }
}
