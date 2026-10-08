/** A site as the default-site picker lists it. */
export interface DefaultSiteCandidate {
  id: string;
  name: string;
  enabled: boolean;
}

export interface DefaultSiteChoice {
  value: string;
  label: string;
}

/** Matching sites the picker loads at a time (sites.list pages). */
export const SITE_PAGE_SIZE = 100;

/**
 * The sites.list page after `pages` (getNextPageParam): undefined once they
 * hold every match the last page counted, or when the last page came back
 * empty (sites deleted meanwhile).
 */
export function nextSitePage(
  last: { items: readonly unknown[]; total: number },
  pages: readonly { items: readonly unknown[] }[],
): number | undefined {
  const loaded = pages.reduce((n, page) => n + page.items.length, 0);
  return last.items.length > 0 && loaded < last.total ? pages.length + 1 : undefined;
}

/**
 * The loaded pages of matching sites as one, each site once (a site that
 * starts matching between two pages moves the later ones down a place),
 * with the last page's count.
 */
export function loadedSites<T extends { id: string }>(
  pages: readonly { items: readonly T[]; total: number }[] | undefined,
): { items: T[]; total: number } | undefined {
  if (!pages?.length) return undefined;
  const items = new Map<string, T>();
  for (const page of pages) for (const site of page.items) items.set(site.id, site);
  return { items: [...items.values()], total: pages.at(-1)?.total ?? 0 };
}

/**
 * The choices of a cluster's default-site picker from the loaded matching
 * sites (loadedSites): the enabled ones (and the saved default, enabled or
 * not), with the picked site kept while the search hides it. `more` says
 * more sites match than are loaded: the next page can be loaded.
 */
export function defaultSiteChoices(
  page: { items: readonly DefaultSiteCandidate[]; total: number } | undefined,
  picked: { siteId: string; chosen: DefaultSiteChoice | null; savedId: string | null },
): { options: DefaultSiteChoice[]; more: boolean } {
  const items = page?.items ?? [];
  const { siteId, chosen, savedId } = picked;
  const options = [
    ...(chosen && chosen.value === siteId && !items.some((site) => site.id === chosen.value)
      ? [chosen]
      : []),
    ...items
      .filter((site) => site.enabled || site.id === savedId)
      .map((site) => ({ value: site.id, label: site.name })),
  ];
  return { options, more: page !== undefined && page.total > page.items.length };
}
