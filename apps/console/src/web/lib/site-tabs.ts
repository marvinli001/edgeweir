import {
  Activity01Icon,
  Alert02Icon,
  DashboardSquare01Icon,
  GlobeIcon,
  Layers01Icon,
  type Link01Icon,
  LockPasswordIcon,
  Plug01Icon,
  Route01Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { m } from "../paraglide/messages.js";
import { legacyViewHref, type ScopeItem, type ScopeLink, viewHref } from "./workspace-nav";

/** Stable tab values for site detail URLs. */
export const SITE_TABS = [
  "overview",
  "analytics",
  "domains",
  "origins",
  "cache",
  "https",
  "rules",
  "redirects",
  "access",
  "security",
  "attacks",
  "crawlers",
  "errors",
  "extensions",
  "logs",
] as const;

export type SiteTab = (typeof SITE_TABS)[number];

export function isSiteTab(value: unknown): value is SiteTab {
  return typeof value === "string" && (SITE_TABS as readonly string[]).includes(value);
}

export function siteTabLabel(tab: SiteTab): string {
  return {
    overview: m.site_tab_overview,
    analytics: m.site_tab_analytics,
    domains: m.site_tab_domains,
    origins: m.site_tab_origins,
    cache: m.site_tab_cache,
    https: m.site_tab_https,
    rules: m.site_tab_rules,
    redirects: m.site_tab_redirects,
    access: m.site_tab_access,
    security: m.scope_site_protection,
    attacks: m.site_tab_attacks,
    crawlers: m.site_tab_crawlers,
    errors: m.site_tab_errors,
    extensions: m.site_tab_extensions,
    logs: m.scope_site_access_logs,
  }[tab]();
}

const SITE_DIRECTORY = [
  { key: "overview", icon: DashboardSquare01Icon },
  {
    key: "observability",
    label: () => m.scope_site_observability(),
    icon: Activity01Icon,
    children: ["analytics", "attacks", "logs"],
  },
  {
    key: "connection",
    label: () => m.scope_site_connection(),
    icon: GlobeIcon,
    children: ["domains", "origins"],
  },
  { key: "https", icon: LockPasswordIcon },
  { key: "cache", icon: Layers01Icon },
  {
    key: "rule-group",
    label: () => m.site_tab_rules(),
    icon: Route01Icon,
    children: ["rules", "redirects"],
  },
  {
    key: "security-group",
    label: () => m.site_tab_security(),
    icon: Shield01Icon,
    children: ["security", "access", "crawlers"],
  },
  { key: "errors", icon: Alert02Icon },
  { key: "extensions", icon: Plug01Icon },
] as const satisfies readonly (
  | { key: SiteTab; icon: typeof Link01Icon }
  | { key: string; label: () => string; icon: typeof Link01Icon; children: readonly SiteTab[] }
)[];

export function siteDirectory(
  current: SiteTab,
  href: (view: SiteTab) => string,
  hasExtensions: boolean,
): ScopeItem[] {
  const link = (key: SiteTab): ScopeLink => ({
    key,
    label: siteTabLabel(key),
    href: href(key),
    current: key === current,
  });
  return SITE_DIRECTORY.filter((item) => item.key !== "extensions" || hasExtensions).map((item) =>
    "children" in item
      ? { ...item, label: item.label(), children: item.children.map(link) }
      : { ...link(item.key), icon: item.icon },
  );
}

export function siteHref(
  id: string,
  view: SiteTab = "overview",
  search?: Parameters<typeof viewHref>[3],
) {
  return viewHref("/sites", id, view, search);
}

export function legacySiteHref(id: string, searchStr: string) {
  return legacyViewHref(searchStr, (tab, search) =>
    siteHref(id, isSiteTab(tab) ? tab : "overview", search),
  );
}
