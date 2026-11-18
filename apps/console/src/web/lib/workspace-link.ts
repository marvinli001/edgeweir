import { defaultParseSearch } from "@tanstack/react-router";

/** Give the router a pathname and search separately so in-app links go through navigation guards. */
export function workspaceLink(href: string, keepViewContext = false) {
  const [to = "", query] = href.split("?", 2);
  const search = query ? defaultParseSearch(`?${query}`) : {};
  return {
    to,
    search: keepViewContext
      ? (previous: Record<string, unknown>) => ({
          range: previous.range,
          returnTo: previous.returnTo,
          ...search,
        })
      : search,
  };
}
