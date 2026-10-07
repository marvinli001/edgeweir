import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { enterDelay } from "@/components/page";
import { ErrorState, QueryView } from "@/components/states";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * Checkbox list of sites with a search box. Selections made under another
 * search stay selected; without a search, sites selected beyond the first
 * page are listed first.
 */
export function SiteMultiSelect({
  id,
  label,
  searchLabel,
  selected,
  onChange,
}: {
  id: string;
  label: string;
  searchLabel: string;
  /** Site id to name. */
  selected: ReadonlyMap<string, string>;
  onChange: (selected: ReadonlyMap<string, string>) => void;
}) {
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  // Sites listed even when the first page lacks them: the initial selection
  // and those picked under a search. Unticking keeps the row in place.
  const [pinned, setPinned] = React.useState<ReadonlyMap<string, string>>(() => new Map(selected));
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const all = useQuery(orpc.sites.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const filtered = useQuery({
    ...orpc.sites.list.queryOptions({ input: { search: query, page: 1, pageSize: 100 } }),
    enabled: query !== "",
    placeholderData: keepPreviousData,
  });
  // Until a search answers, the unfiltered list stays.
  const searching = query !== "" && !filtered.isPending;
  const list = searching ? filtered : all;
  const toggle = (site: { id: string; name: string }, checked: boolean) => {
    const next = new Map(selected);
    if (checked) {
      next.set(site.id, site.name);
      if (!pinned.has(site.id)) setPinned(new Map(pinned).set(site.id, site.name));
    } else next.delete(site.id);
    onChange(next);
  };
  const items = list.data?.items ?? [];
  const rows = searching
    ? items.map((site) => ({ id: site.id, name: site.name, domains: site.domains }))
    : [
        ...[...pinned]
          .filter(([siteId]) => !items.some((site) => site.id === siteId))
          .map(([siteId, name]) => ({ id: siteId, name, domains: [] as string[] })),
        ...items.map((site) => ({ id: site.id, name: site.name, domains: site.domains })),
      ];

  return (
    <QueryView query={all} loadingClassName="min-h-36">
      {() => (
        <Field>
          <div className="flex items-center justify-between gap-2">
            <FieldLabel id={`${id}-label`}>{label}</FieldLabel>
            <span
              className="text-xs tabular-nums text-muted-foreground"
              data-testid={`${id}-selected`}
            >
              {m.sites_selected({ count: selected.size })}
            </span>
          </div>
          <Input
            id={`${id}-search`}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={m.sites_search_placeholder()}
            aria-label={searchLabel}
          />
          <fieldset
            aria-labelledby={`${id}-label`}
            className="max-h-64 min-w-0 divide-y divide-border/70 overflow-y-auto rounded-2xl sunk-well"
          >
            {list.isLoadingError ? (
              <div className="p-3">
                <ErrorState error={list.error} onRetry={() => list.refetch()} />
              </div>
            ) : rows.length === 0 ? (
              <p className="px-3 py-4 text-center text-sm text-muted-foreground">
                {searching ? m.sites_no_match() : m.sites_empty_title()}
              </p>
            ) : (
              rows.map((site, index) => (
                // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control
                <label
                  key={site.id}
                  className="flex cursor-pointer items-center gap-3 px-3 py-2.5 transition-colors animate-enter hover:bg-wash has-data-checked:bg-tint-primary"
                  style={enterDelay(index)}
                  data-testid="site-option"
                >
                  <Checkbox
                    checked={selected.has(site.id)}
                    onCheckedChange={(checked) => toggle(site, checked)}
                  />
                  <span className="shrink-0 text-sm font-medium">{site.name}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">
                    {site.domains.join(", ")}
                  </span>
                </label>
              ))
            )}
          </fieldset>
        </Field>
      )}
    </QueryView>
  );
}
