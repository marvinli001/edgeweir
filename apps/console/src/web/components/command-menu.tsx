import {
  Activity01Icon,
  Add01Icon,
  BlockedIcon,
  DatabaseSync01Icon,
  GlobeIcon,
  LanguageSkillIcon,
  Moon02Icon,
  ServerStack01Icon,
  Shield01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMatch, useNavigate, useRouteContext } from "@tanstack/react-router";
import { defaultFilter } from "cmdk";
import * as React from "react";
import { accountNav, moreNav, navGroups } from "@/components/nav-items";
import { useQuickActions } from "@/components/quick-actions";
import { useTheme } from "@/components/theme-provider";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { getLocale, m, setLocale } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { readRecents } from "@/lib/recents";

/** Sites listed without a search (starred, then recent) and found by one. */
const MAX_SITES = 6;
/** Found sites that also list their actions. */
const MAX_SITE_ACTIONS = 3;
/** Items whose value is an id: only their keywords (names, domains) are matched. */
const BY_KEYWORDS = "#";

/** Matches the items keyed by id on their keywords only, everything else as cmdk does. */
const filter = (value: string, search: string, keywords?: string[]) =>
  value.startsWith(BY_KEYWORDS)
    ? defaultFilter((keywords ?? []).join(" "), search)
    : defaultFilter(value, search, keywords);

type SiteEntry = { id: string; name: string; domains: string[] };

/**
 * ⌘K / Ctrl+K command palette (shadcn command block): sites by name or domain (starred and recent
 * ones before a search), their Under Attack and purge, pages, and console-wide actions.
 */
export function CommandMenu() {
  const [open, setOpen] = React.useState(false);
  const [search, setSearch] = React.useState("");
  const [query, setQuery] = React.useState("");
  const navigate = useNavigate();
  const runAction = useQuickActions();
  const { resolvedTheme, setTheme } = useTheme();
  const { session } = useRouteContext({ from: "/_app" });
  // The site page the palette was opened on: "Ban an IP…" and "Purge URLs…" start with it.
  const current = useMatch({ from: "/_app/sites/$id", shouldThrow: false });
  const currentSiteId = current?.params.id;

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  React.useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 200);
    return () => clearTimeout(timer);
  }, [search]);

  const found = useQuery({
    ...orpc.sites.list.queryOptions({ input: { search: query, page: 1, pageSize: MAX_SITES } }),
    enabled: open && query !== "",
    placeholderData: keepPreviousData,
  });
  const starred = useQuery({ ...orpc.sites.starred.queryOptions(), enabled: open });
  const sites: SiteEntry[] = React.useMemo(() => {
    if (query) return found.data?.items ?? [];
    if (!open) return [];
    const list: SiteEntry[] = [...(starred.data ?? [])];
    for (const recent of readRecents(session.user.id))
      if (recent.kind === "site" && !list.some((site) => site.id === recent.id))
        list.push({ id: recent.id, name: recent.name, domains: [] });
    return list.slice(0, MAX_SITES);
  }, [query, open, found.data, starred.data, session.user.id]);

  const setOpenState = (next: boolean) => {
    setOpen(next);
    if (!next) setSearch("");
  };
  const run = (fn: () => void) => () => {
    setOpenState(false);
    fn();
  };
  const keywords = (site: SiteEntry, ...extra: string[]) => [site.name, ...site.domains, ...extra];

  return (
    <CommandDialog open={open} onOpenChange={setOpenState}>
      {/* cmdk items need their Command root inside the dialog. */}
      <Command filter={filter}>
        <CommandInput
          placeholder={m.command_placeholder()}
          value={search}
          onValueChange={setSearch}
        />
        <CommandList>
          <CommandEmpty>{m.command_empty()}</CommandEmpty>
          {sites.length ? (
            <CommandGroup heading={m.command_group_sites()}>
              {sites.map((site) => (
                <CommandItem
                  key={site.id}
                  value={`${BY_KEYWORDS}site:${site.id}`}
                  keywords={keywords(site)}
                  onSelect={run(() => navigate({ to: "/sites/$id", params: { id: site.id } }))}
                  data-testid="command-site"
                >
                  <HugeiconsIcon icon={GlobeIcon} strokeWidth={2} />
                  <span className="truncate">{site.name}</span>
                  {site.domains[0] && site.domains[0] !== site.name ? (
                    <span className="ml-auto truncate font-mono text-xs text-muted-foreground">
                      {site.domains[0]}
                    </span>
                  ) : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
          {query && sites.length ? (
            <CommandGroup heading={m.command_group_site_actions()}>
              {sites.slice(0, MAX_SITE_ACTIONS).flatMap((site) => [
                <CommandItem
                  key={`${site.id}:under-attack`}
                  value={`${BY_KEYWORDS}under-attack:${site.id}`}
                  keywords={keywords(site, m.protection_under_attack())}
                  onSelect={run(() =>
                    runAction({ kind: "under-attack", siteId: site.id, siteName: site.name }),
                  )}
                  data-testid="command-site-under-attack"
                >
                  <HugeiconsIcon icon={Shield01Icon} strokeWidth={2} />
                  {m.command_site_under_attack({ name: site.name })}
                </CommandItem>,
                <CommandItem
                  key={`${site.id}:purge`}
                  value={`${BY_KEYWORDS}purge:${site.id}`}
                  keywords={keywords(site, m.sites_purge())}
                  onSelect={run(() =>
                    runAction({ kind: "purge-site", siteId: site.id, siteName: site.name }),
                  )}
                  data-testid="command-site-purge"
                >
                  <HugeiconsIcon icon={DatabaseSync01Icon} strokeWidth={2} />
                  {m.command_site_purge({ name: site.name })}
                </CommandItem>,
              ])}
            </CommandGroup>
          ) : null}
          <CommandGroup heading={m.command_group_navigation()}>
            {[...navGroups().flatMap((group) => group.items), ...moreNav(), ...accountNav()].map(
              (item) => (
                <CommandItem key={String(item.to)} onSelect={run(() => navigate({ to: item.to }))}>
                  {item.icon}
                  {item.title}
                </CommandItem>
              ),
            )}
            <CommandItem
              onSelect={run(() => navigate({ to: "/system", search: { tab: "probes" } }))}
            >
              <HugeiconsIcon icon={Activity01Icon} strokeWidth={2} />
              {m.system_tab_probes()}
            </CommandItem>
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading={m.command_group_actions()}>
            <CommandItem onSelect={run(() => navigate({ to: "/sites", search: { create: true } }))}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.nav_new_site()}
            </CommandItem>
            <CommandItem
              onSelect={run(() => navigate({ to: "/clusters", search: { enroll: true } }))}
            >
              <HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />
              {m.nav_add_node()}
            </CommandItem>
            <CommandItem
              onSelect={run(() => runAction({ kind: "ban", siteId: currentSiteId }))}
              data-testid="command-ban"
            >
              <HugeiconsIcon icon={BlockedIcon} strokeWidth={2} />
              {m.command_ban_ip()}
            </CommandItem>
            <CommandItem
              onSelect={run(() =>
                navigate({
                  to: "/purge",
                  search: currentSiteId ? { site: currentSiteId } : {},
                }),
              )}
              data-testid="command-purge"
            >
              <HugeiconsIcon icon={DatabaseSync01Icon} strokeWidth={2} />
              {m.command_purge_urls()}
            </CommandItem>
            <CommandItem
              onSelect={run(() => runAction({ kind: "platform-under-attack" }))}
              data-testid="command-platform-under-attack"
            >
              <HugeiconsIcon icon={Shield01Icon} strokeWidth={2} />
              {m.command_platform_under_attack()}
            </CommandItem>
            <CommandItem onSelect={run(() => setLocale(getLocale() === "zh-CN" ? "en" : "zh-CN"))}>
              <HugeiconsIcon icon={LanguageSkillIcon} strokeWidth={2} />
              {m.command_toggle_language()}
            </CommandItem>
            <CommandItem
              onSelect={run(() => setTheme(resolvedTheme === "dark" ? "light" : "dark"))}
            >
              <HugeiconsIcon icon={Moon02Icon} strokeWidth={2} />
              {m.command_toggle_theme()}
            </CommandItem>
          </CommandGroup>
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
