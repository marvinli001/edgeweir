import {
  Activity01Icon,
  DashboardSquare01Icon,
  SlidersHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { m } from "../paraglide/messages.js";
import { legacyViewHref, viewHref } from "./workspace-nav";

export const L4_VIEWS = {
  overview: { label: () => m.site_tab_overview(), icon: DashboardSquare01Icon },
  stats: { label: () => m.analytics_title(), icon: Activity01Icon },
  settings: { label: () => m.scope_l4_settings(), icon: SlidersHorizontalIcon },
};

export type L4View = keyof typeof L4_VIEWS;

export function l4Href(
  id: string,
  view: L4View = "overview",
  search?: Parameters<typeof viewHref>[3],
) {
  return viewHref("/l4", id, view, search);
}

export function legacyL4Href(id: string, searchStr: string) {
  return legacyViewHref(searchStr, (tab, search) =>
    l4Href(id, tab === "stats" ? "stats" : "overview", search),
  );
}
