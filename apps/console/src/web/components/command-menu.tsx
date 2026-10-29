import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { displaySiteDomain } from "@edgeweir/contract";
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
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMatch, useNavigate, useRouteContext } from "@tanstack/react-router";
import * as React from "react";
import { type CommandItem, CommandPalette } from "@/components/arc/command-palette/command-palette";
import { accountNav, moreNav, navGroups } from "@/components/nav-items";
import { useQuickActions } from "@/components/quick-actions";
import { useSiteTags } from "@/components/site-tags";
import { useTheme } from "@/components/theme-provider";
import { getLocale, m, setLocale } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { readRecents } from "@/lib/recents";

const OPEN_EVENT = "edgeweir:command-menu";

/** Opens the ⌘K palette from anywhere (the top bar's search field). */
export function openCommandMenu() {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

/** Sites listed without a search (starred, then recent) and found by one. */
const MAX_SITES = 6;
/** Found sites that also list their actions. */
const MAX_SITE_ACTIONS = 3;
/** Tags listed for a search (each opens the site list filtered by it). */
const MAX_TAGS = 4;
type SiteEntry = { id: string; name: string; domains: string[] };

const icon = (glyph: typeof GlobeIcon) => <HugeiconsIcon icon={glyph} strokeWidth={2} />;

/**
 * ⌘K / Ctrl+K command palette (Arc's command palette in a dialog): sites by name, domain or tag (starred and
 * recent ones before a search), tags (the site list filtered by one), the sites' Under Attack and
 * purge, pages, and console-wide actions.
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
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener(OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener(OPEN_EVENT, onOpen);
    };
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
  const tags = useSiteTags(open);
  const foundTags = query
    ? (tags.data ?? [])
        .filter((tag) => tag.name.toLowerCase().includes(query.toLowerCase()))
        .slice(0, MAX_TAGS)
    : [];
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
  // Unicode and Punycode forms of the domains both find the site.
  const keywords = (site: SiteEntry, ...extra: string[]) => [
    site.name,
    ...site.domains,
    ...site.domains.map(displaySiteDomain),
    ...extra,
  ];

  const actions = new Map<string, () => void>();
  const items: CommandItem[] = [];
  const add = (item: CommandItem, run: () => void) => {
    items.push(item);
    actions.set(item.id, run);
  };
  for (const site of sites) {
    const domain = site.domains[0] ? displaySiteDomain(site.domains[0]) : undefined;
    add(
      {
        id: `site:${site.id}`,
        label: site.name,
        description: domain && domain !== site.name ? domain : undefined,
        group: m.command_group_sites(),
        keywords: keywords(site),
        icon: icon(GlobeIcon),
        testId: "command-site",
      },
      () => navigate({ to: "/sites/$id", params: { id: site.id } }),
    );
  }
  for (const tag of foundTags)
    add(
      {
        id: `tag:${tag.id}`,
        label: m.command_tag({ name: tag.name }),
        description: m.tags_sites_count({ count: tag.sites }),
        group: m.command_group_tags(),
        keywords: [tag.name],
        icon: icon(Tag01Icon),
        testId: "command-tag",
      },
      () => navigate({ to: "/sites", search: { tags: [tag.id] } }),
    );
  if (query)
    for (const site of sites.slice(0, MAX_SITE_ACTIONS)) {
      add(
        {
          id: `under-attack:${site.id}`,
          label: m.command_site_under_attack({ name: site.name }),
          group: m.command_group_site_actions(),
          keywords: keywords(site, m.protection_under_attack()),
          icon: icon(Shield01Icon),
        },
        () => runAction({ kind: "under-attack", siteId: site.id, siteName: site.name }),
      );
      add(
        {
          id: `purge:${site.id}`,
          label: m.command_site_purge({ name: site.name }),
          group: m.command_group_site_actions(),
          keywords: keywords(site, m.sites_purge()),
          icon: icon(DatabaseSync01Icon),
        },
        () => runAction({ kind: "purge-site", siteId: site.id, siteName: site.name }),
      );
    }
  for (const item of [
    ...navGroups().flatMap((group) => group.items),
    ...moreNav(),
    ...accountNav(),
  ])
    add(
      {
        id: `page:${String(item.to)}`,
        label: item.title,
        group: m.command_group_navigation(),
        icon: item.icon,
      },
      () => navigate({ to: item.to }),
    );
  add(
    {
      id: "page:probes",
      label: m.system_tab_probes(),
      group: m.command_group_navigation(),
      icon: icon(Activity01Icon),
    },
    () => navigate({ to: "/system", search: { tab: "probes" } }),
  );
  const group = m.command_group_actions();
  add({ id: "new-site", label: m.nav_new_site(), group, icon: icon(Add01Icon) }, () =>
    navigate({ to: "/sites", search: { create: true } }),
  );
  add({ id: "add-node", label: m.nav_add_node(), group, icon: icon(ServerStack01Icon) }, () =>
    navigate({ to: "/clusters", search: { enroll: true } }),
  );
  add(
    { id: "ban", label: m.command_ban_ip(), group, icon: icon(BlockedIcon), testId: "command-ban" },
    () => runAction({ kind: "ban", siteId: currentSiteId }),
  );
  add(
    { id: "purge-urls", label: m.command_purge_urls(), group, icon: icon(DatabaseSync01Icon) },
    () => navigate({ to: "/purge", search: currentSiteId ? { site: currentSiteId } : {} }),
  );
  add(
    {
      id: "platform-under-attack",
      label: m.command_platform_under_attack(),
      group,
      icon: icon(Shield01Icon),
    },
    () => runAction({ kind: "platform-under-attack" }),
  );
  add(
    { id: "language", label: m.command_toggle_language(), group, icon: icon(LanguageSkillIcon) },
    () => setLocale(getLocale() === "zh-CN" ? "en" : "zh-CN"),
  );
  add({ id: "theme", label: m.command_toggle_theme(), group, icon: icon(Moon02Icon) }, () =>
    setTheme(resolvedTheme === "dark" ? "light" : "dark"),
  );

  return (
    <DialogPrimitive.Root open={open} onOpenChange={setOpenState}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop className="fixed inset-0 z-50 bg-scrim transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0" />
        <DialogPrimitive.Popup
          className="fixed top-[12vh] left-1/2 z-51 w-[min(40rem,calc(100vw-2rem))] -translate-x-1/2 outline-none"
          data-testid="command-menu"
        >
          <DialogPrimitive.Title className="sr-only">{m.command_label()}</DialogPrimitive.Title>
          <CommandPalette
            items={items}
            autoFocus
            onQueryChange={setSearch}
            onClose={() => setOpenState(false)}
            onSelect={(item) => {
              const run = actions.get(item.id);
              setOpenState(false);
              run?.();
            }}
          />
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
