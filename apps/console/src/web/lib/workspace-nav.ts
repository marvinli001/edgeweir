import type { GlobeIcon } from "@hugeicons/core-free-icons";

export interface ScopeLink {
  key: string;
  label: string;
  href: string;
  current: boolean;
}

export type ScopeItem =
  | (ScopeLink & { icon: typeof GlobeIcon })
  | { key: string; label: string; icon: typeof GlobeIcon; children: readonly ScopeLink[] };

type Search = Record<string, string | undefined> | URLSearchParams;

export function viewHref(root: string, id: string, view: string, search?: Search): string {
  const path = `${root}/${encodeURIComponent(id)}${view === "overview" ? "" : `/${view}`}`;
  const params = search instanceof URLSearchParams ? search : new URLSearchParams();
  if (search && !(search instanceof URLSearchParams)) {
    for (const [key, value] of Object.entries(search)) {
      if (value !== undefined) params.set(key, value);
    }
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

export function legacyViewHref(
  searchStr: string,
  href: (tab: string, search: URLSearchParams) => string,
) {
  const search = new URLSearchParams(searchStr);
  const tab = search.get("tab");
  if (tab === null) return undefined;
  search.delete("tab");
  return href(tab, search);
}

/** A detail can only return to its own list, including the list's search parameters. */
export function listReturnTo(list: string, returnTo: string | undefined): string {
  return returnTo?.startsWith(`${list}?`) && !returnTo.includes("#") ? returnTo : list;
}

export function scopeDirection(from: string | undefined, to: string | undefined): -1 | 0 | 1 {
  if (from === to) return 0;
  return to ? 1 : -1;
}
