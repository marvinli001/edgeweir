import { certificateUnloadable, type SiteLaunch } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { asc, eq } from "drizzle-orm";
import { uncoveredDomains } from "../lib/certificate-names";
import type { AppContext } from "../lib/context";
import { defaultResolver, pointing } from "../lib/dns-check";
import { formatDomain, namesHosts } from "../lib/site-domains";
import { clusterEdgeAddresses } from "./node-addresses";
import { siteDeliveries } from "./site-delivery";
import { findSite } from "./sites";

/** The label looked up under a wildcard domain ("*.example.com" → "edgeweir-check.example.com"). */
export const WILDCARD_PROBE_LABEL = "edgeweir-check";

type Domain = { name: string; kind: string };

/** Whether the site's certificate covers its domains (SiteLaunch["certificate"]). */
async function certificateCoverage(
  app: AppContext,
  certificateId: string | null,
  domains: Domain[],
  now: number,
): Promise<SiteLaunch["certificate"]> {
  const none = { id: null, name: "", uncovered: [], error: "" };
  if (!certificateId) return { state: "none", ...none };
  const [cert] = await app.db
    .select()
    .from(schema.certificate)
    .where(eq(schema.certificate.id, certificateId));
  if (!cert) return { state: "none", ...none };
  const base = { id: cert.id, name: cert.name, error: cert.lastError };
  const issuing = cert.status === "pending" || cert.status === "issuing";
  // Suffix and pattern domains are not checked: nodes complete the
  // handshake for the hosts among them the certificate covers.
  const named = domains.filter(namesHosts);
  let uncovered: Domain[];
  try {
    uncovered = cert.chainPem ? uncoveredDomains(cert.chainPem, named) : named;
  } catch {
    uncovered = named;
  }
  const names = uncovered.map(formatDomain);
  if (!cert.chainPem || uncovered.length) {
    const state =
      cert.status === "error" ? "failed" : issuing || !cert.chainPem ? "issuing" : "uncovered";
    return { state, ...base, uncovered: names };
  }
  if (cert.notAfter && cert.notAfter.getTime() <= now)
    return { state: "expired", ...base, uncovered: [] };
  // Covers every domain, but nodes cannot load it.
  if (certificateUnloadable(cert)) return { state: "failed", ...base, uncovered: [] };
  return { state: "covered", ...base, uncovered: [] };
}

/**
 * Whether a site is ready to serve (sites.launch): where each of its
 * domains points (a wildcard by a fixed label under it; suffix and pattern
 * domains name no host to look up: unchecked) compared with the
 * addresses of its cluster's active nodes, the cluster's edge addresses,
 * its certificate's coverage and its delivery. The lookups run now and in
 * parallel, a few seconds at most (lib/dns-check).
 */
export async function siteLaunch(app: AppContext, siteId: string): Promise<SiteLaunch> {
  const now = Date.now();
  const site = await findSite(app.db, siteId);
  const domains = await app.db
    .select({ name: schema.siteDomain.name, kind: schema.siteDomain.kind })
    .from(schema.siteDomain)
    .where(eq(schema.siteDomain.siteId, site.id))
    .orderBy(asc(schema.siteDomain.createdAt), asc(schema.siteDomain.name));
  const edge = await clusterEdgeAddresses(app.db, site.clusterId, now);
  const certificate = await certificateCoverage(app, site.certificateId, domains, now);
  const delivery = (await siteDeliveries(app.db, [site], now)).get(site.id);
  if (!delivery) throw new Error("site delivery missing");
  const resolver = app.resolver ?? defaultResolver();
  const checked = await Promise.all(
    domains.map(async (domain) => {
      if (!namesHosts(domain))
        return { name: formatDomain(domain), probe: "", pointing: "unchecked" as const };
      const probe =
        domain.kind === "wildcard" ? `${WILDCARD_PROBE_LABEL}.${domain.name}` : domain.name;
      return {
        name: formatDomain(domain),
        probe,
        pointing: await pointing(resolver, probe, edge.known),
      };
    }),
  );
  return { addresses: edge.primary, domains: checked, certificate, delivery };
}
