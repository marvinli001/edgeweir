import { m } from "@/lib/i18n";
import { isSiteTab, type SiteTab } from "@/lib/site-tabs";

/**
 * Recently visited pages for the console home, kept per user in this browser only (a
 * convenience, like a history list). Storage may be unavailable; then the list is just empty.
 */

/**
 * Pages worth returning to, with the title they are listed under: the
 * sidebar's pages (the overview is where the list shows) and the user menu's.
 */
export const RECENT_PAGES = {
  "/sites": () => m.nav_sites(),
  "/l4": () => m.l4_title(),
  "/certificates": () => m.cert_title(),
  "/purge": () => m.nav_purge(),
  "/rules": () => m.rules_platform(),
  "/ip-lists": () => m.ip_lists_title(),
  "/bans": () => m.bans_title(),
  "/protection": () => m.protection_page_title(),
  "/clusters": () => m.nav_clusters(),
  "/dns": () => m.dns_title(),
  "/alerts": () => m.alert_title(),
  "/audit": () => m.nav_audit(),
  "/system": () => m.nav_system(),
  "/security": () => m.nav_security(),
  "/settings": () => m.nav_settings(),
} as const satisfies Record<string, () => string>;

export type RecentPath = keyof typeof RECENT_PAGES;

export type Recent =
  | { kind: "page"; path: RecentPath }
  | { kind: "site"; id: string; name: string; tab?: SiteTab };

const MAX = 5;
const storageKey = (userId: string) => `edgeweir.recents.${userId}`;
const identity = (r: Recent) => (r.kind === "page" ? r.path : `site:${r.id}:${r.tab ?? ""}`);

export function isRecentPath(path: string): path is RecentPath {
  return Object.hasOwn(RECENT_PAGES, path);
}

function valid(value: unknown): value is Recent {
  if (!value || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (r.kind === "page") return typeof r.path === "string" && isRecentPath(r.path);
  return (
    r.kind === "site" &&
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    (r.tab === undefined || isSiteTab(r.tab))
  );
}

export function readRecents(userId: string): Recent[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(storageKey(userId)) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter(valid).slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function recordRecent(userId: string, entry: Recent): void {
  try {
    const rest = readRecents(userId).filter((r) => identity(r) !== identity(entry));
    localStorage.setItem(storageKey(userId), JSON.stringify([entry, ...rest].slice(0, MAX)));
  } catch {
    // Storage blocked or full: recents are optional.
  }
}
