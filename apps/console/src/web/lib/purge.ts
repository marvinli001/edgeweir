import { siteDomainKind } from "@edgeweir/contract";

/** What a purge entry list of a site turns into: absolute URLs, and the entries that are neither. */
export interface PurgeTargets {
  urls: string[];
  invalid: string[];
}

/** One entry per line; blank lines are skipped. */
export const purgeLines = (text: string) =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/** Purges match host, path and query: the scheme of the URLs this module builds is arbitrary. */
const SCHEME = "https";

/** The URL of a request the nodes logged (host and path). */
export const requestUrl = (host: string, path: string) => `${SCHEME}://${host}${path}`;

/**
 * Paths ("/app.js") become a URL on each of the site's exact domains (not wildcards, suffixes
 * or patterns, which name no single host); http(s) URLs stay as they are. Duplicates are
 * dropped and the order kept. Anything else is invalid.
 */
export function expandPurgeTargets(
  entries: readonly string[],
  domains: readonly string[],
): PurgeTargets {
  const hosts = domains.filter((domain) => siteDomainKind(domain) === "exact");
  const urls = new Set<string>();
  const invalid: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith("/") && !entry.startsWith("//")) {
      for (const host of hosts) urls.add(requestUrl(host, entry));
    } else if (/^https?:\/\/[^/?#]/i.test(entry)) urls.add(entry);
    else invalid.push(entry);
  }
  return { urls: [...urls], invalid };
}
