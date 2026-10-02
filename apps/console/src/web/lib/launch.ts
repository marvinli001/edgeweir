import type { SiteLaunch } from "@edgeweir/contract";

/** A request to one edge address that bypasses DNS (`--resolve`; IPv6 in brackets). */
export function curlCheck(host: string, address: string, https: boolean): string {
  const port = https ? 443 : 80;
  const ip = address.includes(":") ? `[${address}]` : address;
  return `curl -sI --resolve ${host}:${port}:${ip} ${https ? "https" : "http"}://${host}/`;
}

/** Whether the site's certificate covers a domain, so the edge answers it over HTTPS. */
export const coversDomain = (certificate: SiteLaunch["certificate"], domain: string) =>
  certificate.state !== "none" && !certificate.uncovered.includes(domain);

/** Domains that do not point to the cluster's nodes (unresolved or elsewhere). */
export const notPointing = (launch: Pick<SiteLaunch, "domains">) =>
  launch.domains.filter((d) => d.pointing === "elsewhere" || d.pointing === "unresolved");
