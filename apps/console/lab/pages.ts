/**
 * Every route and tab of the console with a stable name, for the lab panel and shots.ts.
 * Plain data without imports so Node runs it as is; record ids follow fixtures/world.ts `id()`.
 */

const id = (kind: number, n: number) =>
  `00000000-0000-4000-8${kind.toString(16).padStart(3, "0")}-${n.toString(16).padStart(12, "0")}`;

/** shop.example.com (fixtures/world.ts). */
const SHOP = id(5, 2);
/** sin-edge-02, the node that lags behind (fixtures/world.ts). */
const LAGGING_NODE = id(4, 4);
/** The first layer-4 application (fixtures/infra.ts). */
const L4_APP = id(33, 1);
/** na-edge, behind a load balancer that names the client in a header (fixtures/world.ts). */
const NA_CLUSTER = id(2, 3);

export interface LabPage {
  name: string;
  group: string;
  /** The route in the hash, with its search. */
  path: string;
}

const site = (tab?: string) => `/sites/${SHOP}${tab ? `?tab=${tab}` : ""}`;

export const PAGES: LabPage[] = [
  { name: "login", group: "auth", path: "/login" },
  { name: "setup", group: "auth", path: "/setup" },

  { name: "overview", group: "sites", path: "/overview" },
  { name: "sites", group: "sites", path: "/sites" },
  { name: "site", group: "site", path: site() },
  { name: "site-analytics", group: "site", path: site("analytics") },
  { name: "site-domains", group: "site", path: site("domains") },
  { name: "site-origins", group: "site", path: site("origins") },
  { name: "site-cache", group: "site", path: site("cache") },
  { name: "site-https", group: "site", path: site("https") },
  { name: "site-rules", group: "site", path: site("rules") },
  { name: "site-redirects", group: "site", path: site("redirects") },
  { name: "site-security", group: "site", path: site("security") },
  { name: "site-errors", group: "site", path: site("errors") },
  { name: "site-logs", group: "site", path: site("logs") },
  { name: "certificates", group: "sites", path: "/certificates" },
  { name: "purge", group: "sites", path: "/purge" },

  { name: "rules", group: "access", path: "/rules" },
  { name: "ip-lists", group: "access", path: "/ip-lists" },
  { name: "bans", group: "access", path: "/bans" },
  { name: "protection", group: "access", path: "/protection" },

  { name: "clusters", group: "infrastructure", path: "/clusters" },
  { name: "clusters-node", group: "infrastructure", path: `/clusters?node=${LAGGING_NODE}` },
  { name: "clusters-dns", group: "infrastructure", path: "/clusters?tab=dns" },
  { name: "clusters-scheduling", group: "infrastructure", path: "/clusters?tab=scheduling" },
  {
    name: "clusters-network",
    group: "infrastructure",
    path: `/clusters?tab=network&cluster=${NA_CLUSTER}`,
  },
  { name: "clusters-ports", group: "infrastructure", path: "/clusters?tab=ports" },
  { name: "clusters-regions", group: "infrastructure", path: "/clusters?view=regions" },
  { name: "l4", group: "infrastructure", path: "/l4" },
  { name: "l4-app", group: "infrastructure", path: `/l4/${L4_APP}` },
  { name: "l4-app-stats", group: "infrastructure", path: `/l4/${L4_APP}?tab=stats` },
  { name: "dns", group: "infrastructure", path: "/dns" },

  { name: "alerts", group: "system", path: "/alerts" },
  { name: "audit", group: "system", path: "/audit" },
  { name: "system", group: "system", path: "/system" },
  { name: "system-probes", group: "system", path: "/system?tab=probes" },
  { name: "system-service-accounts", group: "system", path: "/system?tab=service-accounts" },
  { name: "security", group: "account", path: "/security" },
  { name: "settings", group: "account", path: "/settings" },
];
