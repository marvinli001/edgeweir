import { certificateUnloadable, type SiteLaunch } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { asc, eq, inArray } from "drizzle-orm";
import { uncoveredByAll } from "../lib/certificate-names";
import type { AppContext } from "../lib/context";
import { defaultResolver, pointing } from "../lib/dns-check";
import { formatDomain, namesHosts } from "../lib/site-domains";
import { additionalCertificateIds } from "./certificates";
import { clusterEdgeAddresses } from "./node-addresses";
import { siteDeliveries } from "./site-delivery";
import { findSite } from "./sites";

/** The label looked up under a wildcard domain ("*.example.com" → "edgeweir-check.example.com"). */
export const WILDCARD_PROBE_LABEL = "edgeweir-check";

type Domain = { name: string; kind: string };

/**
 * Whether the site's certificates cover its domains (SiteLaunch["certificate"]):
 * every domain one of them, as nodes check it. The first certificate names
 * the result, unless another one is expired or cannot be loaded.
 */
async function certificateCoverage(
  app: AppContext,
  site: { id: string; certificateId: string | null },
  domains: Domain[],
  now: number,
): Promise<SiteLaunch["certificate"]> {
  const none = { id: null, name: "", uncovered: [], error: "" };
  if (!site.certificateId) return { state: "none", ...none };
  const ids = [site.certificateId, ...(await additionalCertificateIds(app.db, site.id))];
  const rows = await app.db
    .select()
    .from(schema.certificate)
    .where(inArray(schema.certificate.id, ids));
  const certs = ids.flatMap((id) => rows.filter((row) => row.id === id));
  const cert = certs[0];
  if (!cert || cert.id !== site.certificateId) return { state: "none", ...none };
  const base = (c: typeof cert) => ({ id: c.id, name: c.name, error: c.lastError });
  const issuing = cert.status === "pending" || cert.status === "issuing";
  // Suffix and pattern domains are not checked: nodes complete the
  // handshake for the hosts among them a certificate covers.
  const named = domains.filter(namesHosts);
  const chains = certs.flatMap((c) => c.chainPem || []);
  let uncovered: Domain[];
  try {
    uncovered = chains.length ? uncoveredByAll(chains, named) : named;
  } catch {
    uncovered = named;
  }
  const names = uncovered.map(formatDomain);
  if (!cert.chainPem || uncovered.length) {
    const state =
      cert.status === "error" ? "failed" : issuing || !cert.chainPem ? "issuing" : "uncovered";
    return { state, ...base(cert), uncovered: names };
  }
  const expired = certs.find((c) => c.notAfter && c.notAfter.getTime() <= now);
  if (expired) return { state: "expired", ...base(expired), uncovered: [] };
  // Covers every domain, but nodes cannot load one of them.
  const unloadable = certs.find(certificateUnloadable);
  if (unloadable) return { state: "failed", ...base(unloadable), uncovered: [] };
  return { state: "covered", ...base(cert), uncovered: [] };
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
  const certificate = await certificateCoverage(app, site, domains, now);
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
