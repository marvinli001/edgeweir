import type { SiteLaunch } from "@edgeweir/contract";

/** Domains that do not point to the cluster's nodes (unresolved or elsewhere). */
export const notPointing = (launch: Pick<SiteLaunch, "domains">) =>
  launch.domains.filter((d) => d.pointing === "elsewhere" || d.pointing === "unresolved");
