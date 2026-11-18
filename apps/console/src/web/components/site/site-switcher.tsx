import { displaySiteDomain, type Site } from "@edgeweir/contract";
import { GlobeIcon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import {
  type ScopeOption,
  ScopeSwitcher,
  useSwitcherSearch,
} from "@/components/shell/scope-switcher";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

function option(site: { id: string; name: string; enabled?: boolean }): ScopeOption {
  return {
    id: site.id,
    name: site.name,
    tone: site.enabled ? "good" : "idle",
    state:
      site.enabled === undefined
        ? m.scope_status_unknown()
        : site.enabled
          ? m.site_state_active()
          : m.site_state_disabled(),
  };
}

export function SiteSwitcher({
  site,
  rail,
  href,
  back,
}: {
  site: Site | undefined;
  rail: boolean;
  href: (id: string) => string;
  back: { href: string; label: string };
}) {
  const search = useSwitcherSearch(250);
  const list = useQuery({
    ...orpc.sites.list.queryOptions({ input: { search: search.query, page: 1, pageSize: 30 } }),
    enabled: search.open,
  });
  const stars = useQuery({ ...orpc.sites.starred.queryOptions(), enabled: search.open });
  const results = list.data?.items ?? [];
  const byId = new Map(results.map((row) => [row.id, row]));
  const term = search.query.toLowerCase();
  const starred = (stars.data ?? [])
    .filter(
      (row) =>
        !term ||
        byId.has(row.id) ||
        [row.name, ...row.domains.map(displaySiteDomain)].some((value) =>
          value.toLowerCase().includes(term),
        ),
    )
    .map((row) => option(byId.get(row.id) ?? (row.id === site?.id ? site : row)));
  const ids = new Set(starred.map((row) => row.id));
  const all = results.filter((row) => !ids.has(row.id)).map(option);
  return (
    <ScopeSwitcher
      kind="site"
      rail={rail}
      icon={GlobeIcon}
      current={site ? option(site) : undefined}
      label={m.scope_switch_site()}
      searchLabel={m.sites_search_placeholder()}
      search={search}
      groups={[
        { label: m.scope_starred(), items: starred },
        { label: m.scope_all(), items: all },
      ]}
      pending={list.isPending || stars.isPending}
      retry={
        list.isLoadingError || stars.isLoadingError
          ? () => {
              if (list.isLoadingError) void list.refetch();
              if (stars.isLoadingError) void stars.refetch();
            }
          : undefined
      }
      href={href}
      back={{ ...back, label: m.site_back() }}
    />
  );
}
