import { DEFAULT_SITE_PORTS, type SitePorts, type TlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { fail } from "../lib/errors";
import { formatDomain, namesHosts } from "../lib/site-domains";
import type { Executor } from "./revisions";

const HTTP_PORT = 80;
const HTTPS_PORT = 443;

/**
 * Checks a site's listener ports against its cluster: HTTP ports among 80
 * and the extra HTTP ports, HTTPS ports among 443 and the extra HTTPS ports
 * (SITE_PORT_UNAVAILABLE); without a certificate no HTTPS port but 443
 * (SITE_HTTPS_PORT_NEEDS_CERTIFICATE); the site served on at least one port
 * (SITE_PORTS_EMPTY). With TLS settings, their redirect port is 443 or one
 * of the site's HTTPS ports (HTTPS_REDIRECT_PORT_INVALID) and the excluded
 * domains are the site's (HTTPS_REDIRECT_DOMAIN_INVALID).
 */
export async function assertSitePorts(
  tx: Executor,
  site: { id?: string; clusterId: string; certificateId: string | null },
  ports: SitePorts,
  opts: {
    checkPorts?: boolean;
    tls?: Pick<TlsSettings, "redirectPort" | "redirectExcludedDomains">;
  } = {},
): Promise<void> {
  const [cluster] = await tx
    .select({ http: schema.cluster.extraHttpPorts, https: schema.cluster.extraHttpsPorts })
    .from(schema.cluster)
    .where(eq(schema.cluster.id, site.clusterId));
  if (!cluster) fail("CLUSTER_NOT_FOUND", "cluster not found");
  if (opts.checkPorts !== false) {
    const http = new Set([HTTP_PORT, ...cluster.http]);
    const https = new Set([HTTPS_PORT, ...cluster.https]);
    const unknown =
      ports.http.find((port) => !http.has(port)) ?? ports.https.find((port) => !https.has(port));
    if (unknown !== undefined)
      fail("SITE_PORT_UNAVAILABLE", `port ${unknown} is not a listener port of the cluster`, {
        port: unknown,
      });
    const extra = ports.https.find((port) => port !== HTTPS_PORT);
    if (!site.certificateId && extra !== undefined)
      fail("SITE_HTTPS_PORT_NEEDS_CERTIFICATE", `HTTPS port ${extra} needs a certificate`, {
        port: extra,
      });
  }
  if (ports.http.length === 0 && (!site.certificateId || ports.https.length === 0))
    fail("SITE_PORTS_EMPTY", "the site would be served on no port");
  if (!opts.tls) return;
  const port = opts.tls.redirectPort;
  if (port !== HTTPS_PORT && !ports.https.includes(port))
    fail("HTTPS_REDIRECT_PORT_INVALID", `port ${port} is not an HTTPS port of the site`, { port });
  if (opts.tls.redirectExcludedDomains.length) {
    const domains = site.id
      ? await tx
          .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
          .from(schema.siteDomain)
          .where(eq(schema.siteDomain.siteId, site.id))
      : [];
    // Only exact and `*.` domains: the redirect excludes host names.
    const names = new Set(domains.filter(namesHosts).map(formatDomain));
    const missing = opts.tls.redirectExcludedDomains.filter((name) => !names.has(name));
    if (missing.length)
      fail("HTTPS_REDIRECT_DOMAIN_INVALID", "excluded domains the site does not have", {
        domains: missing.join(", "),
      });
  }
}

/** A site row's ports (the defaults for rows saved before the columns existed). */
export const portsOf = (row: {
  httpPorts: number[] | null;
  httpsPorts: number[] | null;
}): SitePorts => ({
  http: [...(row.httpPorts ?? DEFAULT_SITE_PORTS.http)],
  https: [...(row.httpsPorts ?? DEFAULT_SITE_PORTS.https)],
});
