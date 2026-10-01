import { m } from "@/lib/i18n";

/** Tabs of the site detail page, in display order. */
export const SITE_TABS = [
  "overview",
  "analytics",
  "domains",
  "origins",
  "cache",
  "https",
  "rules",
  "security",
  "errors",
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
    security: m.site_tab_security,
    errors: m.site_tab_errors,
    logs: m.site_tab_logs,
  }[tab]();
}
