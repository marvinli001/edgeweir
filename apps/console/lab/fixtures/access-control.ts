/**
 * A site's access control and the IP check. shop.example.com uses most parts: $bad_bots as its
 * block list and $payment_webhooks as its allow list, hotlink protection for its media, user agent
 * rules, CORS for its API, WebSocket origins with a shorter idle timeout and every security
 * header; its geo access is saved but off. Other sites start from the defaults. Saves are kept
 * in this page's memory and checked like the API does (schema, conflicts, list names).
 * 203.0.113.150 is on $bad_bots and was banned on the shop during the burst.
 */
import {
  accessControlSettings,
  cidrContains,
  corsSettings,
  formatIp,
  geoSettings,
  hotlinkSettings,
  type IpCheckResult,
  parseCidr,
  parseIp,
  type Site,
  type SiteAccessControl,
  siteAccessControlUpdate,
  userAgentSettings,
  websocketSettings,
} from "@edgeweir/contract";
import { bans, ipLists } from "./access";
import { type Fixtures, notFound } from "./define";
import { ago, clientIpOf, clusters, DAY, nodes, sites } from "./world";

const SHOP = "shop.example.com";

function siteOf(siteId: string): Site {
  const site = sites.find((s) => s.id === siteId);
  if (!site) throw notFound();
  return site;
}

const listId = (name: string) => ipLists.find((list) => list.name === name)?.id ?? "";

/** An API error with its code, as the console's client gets it. */
function apiError(code: string, status: number, data: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), { code, status, data });
}

function seed(site: Site): SiteAccessControl {
  const defaults = accessControlSettings.parse({});
  if (site.name !== SHOP) return { siteId: site.id, ...defaults, updatedAt: null };
  return {
    siteId: site.id,
    siteLists: { blockListIds: [listId("bad_bots")], allowListIds: [listId("payment_webhooks")] },
    hotlink: hotlinkSettings.parse({
      enabled: true,
      allowed: ["*.example.org", "partner.example.com"],
      denied: [".example.net"],
      pathPrefixes: ["/media/"],
      excludePathPrefixes: ["/media/press/"],
      action: "redirect",
      redirectUrl: "/media/hotlink.png",
    }),
    userAgents: userAgentSettings.parse({
      rules: [
        { pattern: "*Googlebot*", action: "allow" },
        { pattern: "*bingbot*", action: "allow" },
        { pattern: "", action: "deny" },
        { pattern: "*python-requests*", action: "deny" },
        { pattern: "curl/*", action: "deny" },
      ],
      excludePathPrefixes: ["/robots.txt", "/healthz"],
    }),
    cors: corsSettings.parse({
      enabled: true,
      allowedOrigins: ["https://app.example.com", "https://*.example.com"],
      allowCredentials: true,
      allowedHeaders: ["authorization", "content-type", "x-requested-with"],
      exposedHeaders: ["x-request-id"],
      maxAgeSeconds: 3600,
      pathPrefixes: ["/api/"],
    }),
    geo: geoSettings.parse({
      enabled: false,
      mode: "allow",
      countries: ["AU", "JP", "NZ", "SG"],
      subdivisions: ["US-CA"],
      asns: [64500],
      exceptPathPrefixes: ["/api/v2/payments/callback"],
    }),
    websocket: websocketSettings.parse({
      allowAllOrigins: false,
      origins: ["https://shop.example.com", "https://app.example.com"],
      idleTimeoutSeconds: 900,
    }),
    securityHeaders: {
      nosniff: true,
      frameOptions: "SAMEORIGIN",
      referrerPolicy: "strict-origin-when-cross-origin",
      permissionsPolicy: "camera=(), microphone=(), geolocation=()",
      hideServer: true,
      removePoweredBy: true,
    },
    updatedAt: ago(2 * DAY),
  };
}

/** Every site from the defaults: the lab's empty state. */
const blank = (site: Site): SiteAccessControl => ({
  siteId: site.id,
  ...accessControlSettings.parse({}),
  updatedAt: null,
});

/** One in-memory store of settings, starting from `initial`, with get and update over it. */
function accessControlApi(initial: (site: Site) => SiteAccessControl) {
  const store = new Map<string, SiteAccessControl>();
  const read = (site: Site) => store.get(site.id) ?? initial(site);
  const fixtures: Fixtures["accessControl"] = {
    get: ({ id }) => read(siteOf(id)),
    update: (input) => {
      const parsed = siteAccessControlUpdate.safeParse(input);
      if (!parsed.success) throw apiError("BAD_REQUEST", 400, { issues: parsed.error.issues });
      const { id, expectedUpdatedAt, ...parts } = parsed.data;
      const site = siteOf(id);
      const current = read(site);
      if (
        expectedUpdatedAt !== undefined &&
        (!current.updatedAt || Date.parse(current.updatedAt) !== Date.parse(expectedUpdatedAt))
      )
        throw apiError("UPDATED_AT_MISMATCH", 409);
      if (parts.cors?.allowCredentials && parts.cors.allowedOrigins.includes("*"))
        throw apiError("CORS_CREDENTIALS_WILDCARD", 400);
      if (parts.siteLists) {
        const { blockListIds, allowListIds } = parts.siteLists;
        const names = new Map(ipLists.map((list) => [list.id, list.name]));
        if ([...blockListIds, ...allowListIds].some((listId) => !names.has(listId)))
          throw apiError("IP_LIST_NOT_FOUND", 404);
        const both = blockListIds.filter((listId) => allowListIds.includes(listId));
        if (both.length)
          throw apiError("SITE_LIST_CONFLICT", 400, {
            lists: both.map((listId) => names.get(listId)).join(", "),
          });
      }
      const previous = current.updatedAt ? Date.parse(current.updatedAt) : 0;
      const next: SiteAccessControl = {
        ...current,
        ...Object.fromEntries(Object.entries(parts).filter(([, value]) => value !== undefined)),
        updatedAt: new Date(Math.max(Date.now(), previous + 1)).toISOString(),
      };
      store.set(site.id, next);
      return next;
    },
  };
  return { read, fixtures };
}

/**
 * The IP check as the API answers it (no GeoIP), over the lab's lists, bans and clusters (none in
 * the empty state) and the site's settings as `read` has them.
 */
function ipCheck(
  input: { ip: string; siteId?: string },
  read: (site: Site) => SiteAccessControl,
  withData: boolean,
): IpCheckResult {
  const ip = input.ip.includes("/") ? null : parseIp(input.ip.trim());
  if (!ip) throw apiError("IP_ADDRESS_INVALID", 400);
  const text = formatIp(ip);
  const contains = (cidr: string) => {
    const range = parseCidr(cidr);
    return range !== null && cidrContains(range, ip);
  };
  const site = input.siteId ? siteOf(input.siteId) : null;
  const settings = site ? read(site) : null;
  const lists = (withData ? ipLists : [])
    .map((list) => ({
      id: list.id,
      name: list.name,
      kind: list.kind,
      entries: list.entries.filter(contains),
      siteRole: settings?.siteLists.blockListIds.includes(list.id)
        ? ("block" as const)
        : settings?.siteLists.allowListIds.includes(list.id)
          ? ("allow" as const)
          : null,
    }))
    .filter((list) => list.entries.length > 0);
  const matching = (withData ? bans : []).filter(
    (ban) => contains(ban.cidr) && (!site || ban.scope === "platform" || ban.siteId === site.id),
  );
  const clusterViews = (withData ? clusters : [])
    .filter((cluster) => !site || cluster.id === site.clusterId)
    .map((cluster) => {
      const clientIp = clientIpOf(cluster.id).settings;
      return {
        id: cluster.id,
        name: cluster.name,
        clientIp: clientIp.mode,
        trustedProxy: clientIp.mode === "header" && clientIp.trustedCidrs.some(contains),
        nodeAddress: nodes.some((n) => n.clusterId === cluster.id && n.ipAddresses.includes(text)),
      };
    });
  let verdict: IpCheckResult["verdict"] = null;
  if (site) {
    const platformAllowed = lists.some((list) => list.kind === "allow");
    const siteAllowed = lists.some((list) => list.siteRole === "allow");
    const exempt = platformAllowed || clusterViews.some((cluster) => cluster.trustedProxy);
    const outcome =
      !exempt && matching.some((ban) => ban.scope === "platform")
        ? "platform_banned"
        : !exempt && !siteAllowed && matching.some((ban) => ban.scope === "site")
          ? "site_banned"
          : !platformAllowed && lists.some((list) => list.kind === "block")
            ? "platform_blocked"
            : !platformAllowed && !siteAllowed && lists.some((list) => list.siteRole === "block")
              ? "site_blocked"
              : platformAllowed || siteAllowed
                ? "allowed"
                : "none";
    verdict = { outcome, platformAllowed, siteAllowed };
  }
  return {
    ip: text,
    site: site ? { id: site.id, name: site.name } : null,
    lists,
    bans: matching,
    clusters: clusterViews,
    verdict,
  };
}

const full = accessControlApi(seed);

export const accessControlFixtures: Fixtures = {
  accessControl: full.fixtures,
  ipCheck: { check: (input) => ipCheck(input, full.read, true) },
};

const empty = accessControlApi(blank);

/** The empty state: no settings, lists, bans or clusters; saves still work. */
export const emptyAccessControlFixtures: Fixtures = {
  accessControl: empty.fixtures,
  ipCheck: { check: (input) => ipCheck(input, empty.read, false) },
};
