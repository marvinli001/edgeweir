import { type AnalyticsRange, displaySiteDomain, type Site, siteDomain } from "@edgeweir/contract";
import {
  Add01Icon,
  Copy01Icon,
  DatabaseSync01Icon,
  Delete02Icon,
  Layers01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Outlet, useLocation, useMatch } from "@tanstack/react-router";
import * as React from "react";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { Input } from "@/components/arc/input/input";
import { ConfirmDialog, ControlledConfirmDialog } from "@/components/confirm-dialog";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { Page } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { useSidebarScope, useWorkspaceTitle } from "@/components/shell/sidebar-scope";
import { AccessTab } from "@/components/site/access-tab";
import { AiCrawlTab } from "@/components/site/ai-crawl-tab";
import { AttacksTab } from "@/components/site/attacks-tab";
import { BulkRedirectsTab } from "@/components/site/bulk-redirects-tab";
import { CacheTab } from "@/components/site/cache-tab";
import { CloneSiteDialog } from "@/components/site/clone-site-dialog";
import { DnsSetupCard } from "@/components/site/cname-target";
import { CopySettingsDialog } from "@/components/site/copy-settings-dialog";
import { followSiteDelivery } from "@/components/site/delivery-toast";
import { DomainKindBadge, DomainName } from "@/components/site/domain-name";
import { ErrorPagesTab } from "@/components/site/error-pages-tab";
import { ExtensionsTab } from "@/components/site/extensions-tab";
import { HttpsTab } from "@/components/site/https-tab";
import { LogsTab } from "@/components/site/logs-tab";
import { OriginsTab } from "@/components/site/origins-tab";
import { SitePortsCard } from "@/components/site/ports-card";
import { RulesTab } from "@/components/site/rules-tab";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { SecurityTab } from "@/components/site/security-tab";
import { SiteOverview } from "@/components/site/site-overview";
import { SiteSwitcher } from "@/components/site/site-switcher";
import {
  SiteWorkspaceContext,
  siteWorkspaceSearch,
} from "@/components/site/site-workspace-context";
import { TierStatsCard } from "@/components/site/tiered-cache-card";
import { StarButton, useSiteStars } from "@/components/site-star";
import { DevelopmentModeBadge, untilLive } from "@/components/site-status";
import { QueryView } from "@/components/states";
import { NotFoundPage } from "@/components/status-page";
import { useDraft } from "@/hooks/use-draft";
import { DEFAULT_RANGE } from "@/lib/analytics";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { recordRecent } from "@/lib/recents";
import { needsDomainForms, newDomains } from "@/lib/site-domains";
import { isSiteTab, type SiteTab, siteDirectory, siteHref, siteTabLabel } from "@/lib/site-tabs";
import { toast } from "@/lib/toast";
import { workspaceLink } from "@/lib/workspace-link";
import { listReturnTo } from "@/lib/workspace-nav";

export const Route = createFileRoute("/_app/sites/$id")({
  validateSearch: siteWorkspaceSearch,
  component: SiteDetailPage,
});

function SiteDetailPage() {
  const { id } = Route.useParams();
  const href = useLocation({ select: (location) => location.href });
  const viewParam = useMatch({
    from: "/_app/sites/$id/$view",
    shouldThrow: false,
    select: (match) => match.params.view,
  });
  const view = isSiteTab(viewParam) ? viewParam : "overview";
  const viewName = siteTabLabel(view);
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { session } = Route.useRouteContext();
  const query = useQuery({
    ...orpc.sites.get.queryOptions({ input: { id } }),
    refetchInterval: (query) => untilLive(query.state.data ? [query.state.data] : undefined),
    meta: { background: true },
  });
  const extensions = useQuery(orpc.extensions.list.queryOptions());
  const hasExtensions = (extensions.data?.length ?? 0) > 0;
  const site = query.data;
  const name = site?.name;
  const stars = useSiteStars();
  const back = listReturnTo("/sites", search.returnTo);
  const viewHref = (tab: SiteTab, siteId = id, range = search.range) =>
    siteHref(siteId, tab, {
      ...(tab === "logs" && view === "logs" ? search : {}),
      range,
      returnTo: back === "/sites" ? undefined : back,
    });
  const setRange = (range: AnalyticsRange) =>
    void navigate({
      ...workspaceLink(
        siteHref(id, view, {
          ...search,
          range: range === DEFAULT_RANGE ? undefined : range,
        }),
      ),
      replace: true,
    });

  const backLink = { href: back, label: m.nav_sites() };
  useSidebarScope({
    kind: "site",
    back: backLink,
    switcher: (rail) => (
      <SiteSwitcher site={site} rail={rail} back={backLink} href={(next) => viewHref(view, next)} />
    ),
    items: siteDirectory(view, viewHref, hasExtensions),
    commandGroup: name ? m.scope_current_site({ name }) : m.site_detail_title(),
  });
  useWorkspaceTitle(viewName, name);

  React.useEffect(() => {
    if (name) {
      recordRecent(session.user.id, {
        kind: "site",
        id,
        name,
        ...(view === "overview" ? {} : { tab: view }),
      });
    }
  }, [session.user.id, id, name, view]);

  return (
    <Page
      title={view === "overview" ? (name ?? viewName) : viewName}
      actions={
        site ? (
          <>
            {site.developmentModeUntil ? (
              <DevelopmentModeBadge
                until={site.developmentModeUntil}
                testId="site-header-dev-mode"
              />
            ) : null}
            <StarButton
              starred={stars.ids.has(id)}
              pending={stars.pendingId === id || stars.starred.isPending}
              onToggle={() => void stars.toggle(id)}
            />
            <SiteEnabled site={site} />
            <SiteMenu site={site} back={back} />
          </>
        ) : undefined
      }
    >
      <QueryView
        query={query}
        notFound={
          <NotFoundPage
            path={href}
            surface="inline"
            record={{ title: m.status_site_missing(), to: "/sites", label: m.status_back_sites() }}
          />
        }
      >
        {(site) => (
          <SiteWorkspaceContext.Provider
            value={{
              site,
              search,
              setRange,
              analyticsHref: viewHref("analytics"),
            }}
          >
            <Outlet key={site.id} />
          </SiteWorkspaceContext.Provider>
        )}
      </QueryView>
    </Page>
  );
}

export function SiteWorkspaceView({ view }: { view: SiteTab }) {
  const workspace = React.useContext(SiteWorkspaceContext);
  if (!workspace) throw new Error("Site view must be rendered inside its detail route");
  const { site, setRange, search, analyticsHref } = workspace;
  const range = search.range ?? DEFAULT_RANGE;
  switch (view) {
    case "overview":
      return (
        <SiteOverview site={site} range={range} setRange={setRange} analyticsHref={analyticsHref} />
      );
    case "analytics":
      return (
        <div className="flex flex-col gap-4 animate-enter">
          <AnalyticsSection siteId={site.id} range={range} onRangeChange={setRange} />
          <TierStatsCard siteId={site.id} range={range} />
        </div>
      );
    case "domains":
      return <DomainsTab site={site} />;
    case "origins":
      return <OriginsTab site={site} range={range} onRangeChange={setRange} />;
    case "https":
      return <HttpsTab site={site} />;
    case "rules":
      return <RulesTab siteId={site.id} originGroups={originGroups(site)} site={site} />;
    case "redirects":
      return <BulkRedirectsTab siteId={site.id} />;
    case "access":
      return <AccessTab site={site} />;
    case "security":
      return <SecurityTab siteId={site.id} />;
    case "attacks":
      return (
        <AttacksTab siteId={site.id} siteName={site.name} range={range} onRangeChange={setRange} />
      );
    case "crawlers":
      return <AiCrawlTab siteId={site.id} range={range} onRangeChange={setRange} />;
    case "errors":
      return <ErrorPagesTab siteId={site.id} />;
    case "extensions":
      return <ExtensionsTab siteId={site.id} />;
    case "logs": {
      const { blockReason, ip, cidr, path, crawler, from, to } = search;
      return (
        <LogsTab
          siteId={site.id}
          jump={
            blockReason || ip || cidr || path || crawler || from || to
              ? { blockReason, ip, cidr, path, crawler, from, to }
              : undefined
          }
        />
      );
    }
    case "cache":
      return <CacheTab site={site} />;
  }
}

/** The site's named origin groups, for origin rules. */
const originGroups = (site: Site) =>
  [...new Set(site.origins.flatMap((origin) => (origin.group ? [origin.group] : [])))].sort();

function SiteEnabled({ site }: { site: Site }) {
  const setEnabled = useMutation({
    ...orpc.sites.setEnabled.mutationOptions(),
    meta: { invalidates: [orpc.sites.key()] },
  });
  const queryClient = useQueryClient();
  const label = site.enabled ? m.site_disable() : m.site_enable();
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary" data-testid="site-toggle-enabled">
          {label}
        </Button>
      }
      destructive={site.enabled}
      title={
        site.enabled
          ? m.site_disable_confirm({ name: site.name })
          : m.site_enable_confirm({ name: site.name })
      }
      note={site.enabled ? m.site_disable_note() : undefined}
      confirmLabel={label}
      onConfirm={async () => {
        const result = await setEnabled.mutateAsync({
          id: site.id,
          enabled: !site.enabled,
          expectedUpdatedAt: site.updatedAt,
        });
        followSiteDelivery(
          queryClient,
          site.id,
          result.site.enabled ? m.site_enabled_toast() : m.site_disabled_toast(),
          result.site.delivery,
        );
      }}
    />
  );
}

/**
 * The site's actions in the page header (every view): copy its settings to other sites, clone it,
 * purge its cache, delete it.
 */
function SiteMenu({ site, back }: { site: Site; back: string }) {
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const purge = useMutation({
    ...orpc.sites.purgeAll.mutationOptions(),
    meta: { invalidates: [orpc.cacheTasks.key()] },
  });
  const remove = useMutation(orpc.sites.delete.mutationOptions());
  const [open, setOpen] = React.useState<"copy" | "clone" | "purge" | "delete" | null>(null);
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              className="icon-button"
              size="sm"
              variant="ghost"
              aria-label={m.common_actions()}
              data-testid="site-actions"
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => setOpen("copy")} data-testid="site-copy">
            <HugeiconsIcon icon={Copy01Icon} strokeWidth={2} />
            {m.copy_title()}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setOpen("clone")} data-testid="site-clone">
            <HugeiconsIcon icon={Layers01Icon} strokeWidth={2} />
            {m.clone_action()}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setOpen("purge")} data-testid="site-purge">
            <HugeiconsIcon icon={DatabaseSync01Icon} strokeWidth={2} />
            {m.sites_purge()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setOpen("delete")}
            data-testid="site-delete"
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {m.common_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {open === "copy" ? (
        <CopySettingsDialog open onOpenChange={close} source={{ id: site.id, name: site.name }} />
      ) : null}
      {open === "clone" ? <CloneSiteDialog open onOpenChange={close} site={site} /> : null}
      <ControlledConfirmDialog
        open={open === "purge"}
        onOpenChange={close}
        destructive={false}
        title={m.sites_purge()}
        note={site.domains.map(displaySiteDomain).join(", ")}
        onConfirm={async () => {
          await purge.mutateAsync({ id: site.id });
          toast.success(m.sites_purged(), {
            action: {
              label: m.purge_view_tasks(),
              onClick: () => void navigate({ to: "/purge", search: { site: site.id } }),
            },
          });
        }}
      />
      <ControlledConfirmDialog
        open={open === "delete"}
        onOpenChange={close}
        title={m.sites_delete_confirm({ name: site.name })}
        confirmLabel={m.common_delete()}
        onConfirm={async () => {
          const result = await remove.mutateAsync({ id: site.id });
          toast.success(m.sites_deleted({ revision: result.revision.revision }));
          // Leave first and drop what was read about the site: refreshing its queries while
          // they are on screen fails (404, retried for seconds) and flashes an error.
          await navigate(workspaceLink(back));
          queryClient.removeQueries({
            predicate: (query) => JSON.stringify(query.queryKey).includes(site.id),
          });
          await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
        }}
      />
    </>
  );
}

function DomainsTab({ site }: { site: Site }) {
  const queryClient = useQueryClient();
  const { draft: domains, setDraft: setDomains, dirty: listChanged } = useDraft(site.domains);
  // The draft as last rendered: a save that answers after it changed leaves it alone.
  const latest = React.useRef(domains);
  React.useEffect(() => {
    latest.current = domains;
  });
  const [input, setInput] = React.useState("");
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const { save, error, pending } = useSaveSite(site.id);
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: site.id } }));
  // `.a.com` and `~pattern` need domains-v2 on every node of the cluster.
  const formsAvailable = features.data?.domainsV2.available ?? true;
  const formsUnavailable = m.site_domain_forms_unavailable();
  // Domains typed but not added yet count as changes and are saved with the list. They compare
  // with the listed ones in their stored form: Unicode names are stored as Punycode.
  const typed = newDomains(input, domains);
  const dirty = listChanged || typed.length > 0;
  /**
   * The typed domains, or null (and the reason shown) when one cannot be added. `added` are the
   * other domains not saved yet, checked with them.
   */
  const take = (added: readonly string[] = []) => {
    const bad = typed.find((d) => !siteDomain.safeParse(d).success);
    if (bad) {
      setInvalid(m.site_domain_invalid({ domain: bad }));
      return null;
    }
    if (!formsAvailable && needsDomainForms([...added, ...typed])) {
      setInvalid(formsUnavailable);
      return null;
    }
    setInvalid(null);
    return typed;
  };
  const add = () => {
    const values = take();
    if (!values) return;
    if (values.length) setDomains([...domains, ...values]);
    setInput("");
  };

  return (
    <div className="flex flex-col gap-4">
      <DnsSetupCard siteId={site.id} />
      <Panel>
        <form
          className="flex flex-col gap-(--panel-pad)"
          onSubmit={async (event) => {
            event.preventDefault();
            const values = take(domains.filter((d) => !site.domains.includes(d)));
            if (!values) return;
            const next = [...domains, ...values];
            setDomains(next);
            setInput("");
            if (!(await save({ domains: next }))) return;
            // The stored list (Punycode, without duplicates) replaces the draft it was saved from.
            const stored = queryClient.getQueryData(
              orpc.sites.get.queryKey({ input: { id: site.id } }),
            );
            if (stored && JSON.stringify(latest.current) === JSON.stringify(next))
              setDomains(stored.domains);
          }}
        >
          <PanelHeader>
            <PanelTitle>{m.site_tab_domains()}</PanelTitle>
          </PanelHeader>
          <PanelContent className="flex flex-col gap-3">
            <ul className="divide-y rounded-lg faint-well" data-testid="domain-list">
              {domains.map((domain, index) => (
                <li
                  key={domain}
                  className="flex items-center gap-2 px-3 py-2 animate-enter"
                  style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                >
                  <DomainName domain={domain} className="flex-1 font-mono text-sm break-all" />
                  <DomainKindBadge domain={domain} />
                  <Button
                    className="icon-button"
                    type="button"
                    size="sm"
                    variant="ghost"
                    aria-label={m.common_remove()}
                    disabled={domains.length === 1}
                    onClick={() => setDomains(domains.filter((d) => d !== domain))}
                  >
                    <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  </Button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input
                value={input}
                onChange={(event) => {
                  setInput(event.target.value);
                  setInvalid(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    add();
                  }
                }}
                placeholder="www.example.com, *.example.com, .example.com, ~(www|m)\.example\.com"
                aria-label={m.site_domain_add()}
                data-testid="domain-input"
              />
              <Button type="button" variant="secondary" onClick={add} data-testid="domain-add">
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.site_domain_add()}
              </Button>
            </div>
            {formsAvailable || invalid === formsUnavailable ? null : (
              <SafetyNote data-testid="domain-forms-unavailable">{formsUnavailable}</SafetyNote>
            )}
          </PanelContent>
          <SaveBar dirty={dirty} pending={pending} error={invalid ?? error} testId="domains-save" />
        </form>
      </Panel>
      <SitePortsCard site={site} />
    </div>
  );
}
