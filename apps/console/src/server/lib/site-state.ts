import { fail } from "./errors";

/** Purges and prefetches need a site that nodes serve: disabled sites are not shipped. */
export function assertServing(site: { enabled: boolean }) {
  if (!site.enabled) fail("SITE_DISABLED", "the site is disabled");
}
