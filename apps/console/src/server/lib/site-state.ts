import { fail } from "./errors";

/**
 * A site is shipped to nodes only while its organization enables it and the
 * platform does not suspend it.
 */
export const isServing = (site: { enabled: boolean; suspended: boolean }) =>
  site.enabled && !site.suspended;

/** Purges and prefetches need a site that nodes serve. */
export function assertServing(site: { enabled: boolean; suspended: boolean }) {
  if (site.suspended) fail("SITE_SUSPENDED", "the site is suspended by the platform");
  if (!site.enabled) fail("SITE_DISABLED", "the site is disabled");
}
