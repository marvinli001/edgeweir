import { getDomain } from "tldts";
import { fail } from "./errors";
/** Includes the PSL private section: one github.io tenant cannot claim another. */
export function domainRoot(name: string): string {
  const hostname = name.replace(/^\*\./, "").toLowerCase();
  const domain = getDomain(hostname, { allowPrivateDomains: true, validateHostname: true });
  if (!domain) fail("DOMAIN_ROOT_INVALID", "domain must be below a registrable suffix");
  return domain;
}
