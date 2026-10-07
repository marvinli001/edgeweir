import { analyticsRange, domainName, type Site } from "@edgeweir/contract";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useLocation } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page } from "@/components/page";
import { BulkRedirectsTab } from "@/components/site/bulk-redirects-tab";
import { CacheTab } from "@/components/site/cache-tab";
import { DnsSetupCard } from "@/components/site/cname-target";
import { followSiteDelivery } from "@/components/site/delivery-toast";
import { ErrorPagesTab } from "@/components/site/error-pages-tab";
import { HttpsTab } from "@/components/site/https-tab";
import { LaunchCheck } from "@/components/site/launch-check";
import { LiveRequests } from "@/components/site/live-requests";
import { LogsTab } from "@/components/site/logs-tab";
import { OriginsTab } from "@/components/site/origins-tab";
import { RulesTab } from "@/components/site/rules-tab";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { SecurityTab } from "@/components/site/security-tab";
import { StarButton, useSiteStars } from "@/components/site-star";
import { SiteStatus, untilLive } from "@/components/site-status";
import { QueryView } from "@/components/states";
import { NotFoundPage } from "@/components/status-page";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useDraft } from "@/hooks/use-draft";
import { domainList } from "@/lib/address-input";
import { DEFAULT_RANGE } from "@/lib/analytics";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { recordRecent } from "@/lib/recents";
import { SITE_TABS, type SiteTab, siteTabLabel } from "@/lib/site-tabs";

export const Route = createFileRoute("/_app/sites/$id")({
  validateSearch: z.object({
    tab: z.enum(SITE_TABS).optional(),
    range: analyticsRange.optional(),
  }),
  component: SiteDetailPage,
});

function SiteDetailPage() {
  const { id } = Route.useParams();
  const href = useLocation({ select: (location) => location.href });
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { session } = Route.useRouteContext();
  const site = useQuery({
    ...orpc.sites.get.queryOptions({ input: { id } }),
    refetchInterval: (query) => untilLive(query.state.data ? [query.state.data] : undefined),
    meta: { background: true },
  });
  const stars = useSiteStars();
  const tab: SiteTab = search.tab ?? "overview";
  const name = site.data?.name;
  const tabsList = React.useRef<HTMLDivElement>(null);
  // The tab bar's ref: the edges that hide more tabs fade out (scroll-fade), so a phone shows that
  // the bar scrolls; a tab that takes keyboard focus scrolls clear of the fades.
  const tabBar = React.useCallback((list: HTMLDivElement | null) => {
    tabsList.current = list;
    if (!list) return;
    const mark = () => {
      const start = list.scrollLeft > 1;
      const end = list.scrollLeft + list.clientWidth < list.scrollWidth - 1;
      if (start || end) list.dataset.fade = start && end ? "both" : start ? "start" : "end";
      else delete list.dataset.fade;
    };
    const focus = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== list)
        revealTab(list, event.target);
    };
    mark();
    list.addEventListener("scroll", mark, { passive: true });
    list.addEventListener("focusin", focus);
    const observer = new ResizeObserver(mark);
    observer.observe(list);
    return () => {
      tabsList.current = null;
      list.removeEventListener("scroll", mark);
      list.removeEventListener("focusin", focus);
      observer.disconnect();
    };
  }, []);
  React.useEffect(() => {
    const list = tabsList.current;
    if (!list || !site.isSuccess) return;
    const reveal = () => {
      const active = list.querySelector<HTMLElement>(`[data-testid="tab-${tab}"]`);
      if (active) revealTab(list, active);
    };
    reveal();
    const observer = new ResizeObserver(reveal);
    observer.observe(list);
    return () => observer.disconnect();
  }, [tab, site.isSuccess]);

  React.useEffect(() => {
    if (name) {
      recordRecent(session.user.id, {
        kind: "site",
        id,
        name,
        ...(tab === "overview" ? {} : { tab }),
      });
    }
  }, [session.user.id, id, name, tab]);

  return (
    <Page
      title={site.data?.name ?? m.site_detail_title()}
      actions={
        <>
          {site.data ? (
            <StarButton
              starred={stars.ids.has(id)}
              pending={stars.pendingId === id || stars.starred.isPending}
              onToggle={() => void stars.toggle(id)}
            />
          ) : null}
          <Link to="/sites" className="text-sm text-muted-foreground hover:text-foreground">
            {m.site_back()}
          </Link>
        </>
      }
    >
      <QueryView query={site} notFound={<NotFoundPage path={href} surface="inline" />}>
        {(data) => (
          <Tabs
            key={data.id}
            className="gap-4"
            value={tab}
            onValueChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  tab: value === "overview" ? undefined : (value as SiteTab),
                }),
                replace: true,
              })
            }
          >
            {/* The page's tab bar: line tabs over a hairline, scrolling sideways on phones. */}
            <TabsList
              ref={tabBar}
              variant="line"
              className="h-11 w-full max-w-full justify-start gap-0.5 overflow-x-auto overflow-y-hidden border-b px-0 pt-1 pb-[5px] scroll-fade [scrollbar-width:none]"
            >
              {SITE_TABS.map((value) => (
                <TabsTrigger
                  key={value}
                  value={value}
                  className="flex-none px-2.5"
                  data-testid={`tab-${value}`}
                >
                  {siteTabLabel(value)}
                </TabsTrigger>
              ))}
            </TabsList>
            <TabsContent value="overview" className="animate-enter">
              <OverviewTab site={data} />
            </TabsContent>
            <TabsContent value="analytics" className="animate-enter">
              <AnalyticsSection
                siteId={data.id}
                range={search.range ?? DEFAULT_RANGE}
                onRangeChange={(range) =>
                  navigate({
                    search: (prev) => ({
                      ...prev,
                      range: range === DEFAULT_RANGE ? undefined : range,
                    }),
                    replace: true,
                  })
                }
              />
            </TabsContent>
            <TabsContent value="domains" className="animate-enter">
              <DomainsTab site={data} />
            </TabsContent>
            <TabsContent value="origins" className="animate-enter">
              <OriginsTab site={data} />
            </TabsContent>
            <TabsContent value="https" className="animate-enter">
              <HttpsTab site={data} />
            </TabsContent>
            <TabsContent value="rules" className="animate-enter">
              <RulesTab siteId={data.id} originGroups={originGroups(data)} />
            </TabsContent>
            <TabsContent value="redirects" className="animate-enter">
              <BulkRedirectsTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="security" className="animate-enter">
              <SecurityTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="errors" className="animate-enter">
              <ErrorPagesTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="logs" className="animate-enter">
              <LogsTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="cache" className="animate-enter">
              <CacheTab site={data} />
            </TabsContent>
          </Tabs>
        )}
      </QueryView>
    </Page>
  );
}

/**
 * Scrolls a tab of the tab bar into view with the bar's scroll padding (the scroll-fade width)
 * between it and either edge, so the active or focused tab never sits under a faded edge: its
 * label keeps full contrast and its indicator stays whole. At the ends of the bar the scroll
 * stops short of the padding, and an edge with nothing beyond it does not fade.
 */
function revealTab(list: HTMLElement, tab: HTMLElement) {
  const style = getComputedStyle(list);
  const start = Number.parseFloat(style.scrollPaddingInlineStart) || 0;
  const end = Number.parseFloat(style.scrollPaddingInlineEnd) || 0;
  const bounds = list.getBoundingClientRect(),
    item = tab.getBoundingClientRect();
  if (item.left < bounds.left + start) list.scrollLeft += item.left - bounds.left - start;
  else if (item.right > bounds.right - end) list.scrollLeft += item.right - bounds.right + end;
}

/** The site's origin groups besides the default one, for origin rules. */
const originGroups = (site: Site) =>
  [...new Set(site.origins.flatMap((origin) => (origin.group ? [origin.group] : [])))].sort();

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 @xs/facts:grid-cols-[6.5rem_minmax(0,1fr)] @xs/facts:items-center @xs/facts:gap-3">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm">{children}</dd>
    </div>
  );
}

function OverviewTab({ site }: { site: Site }) {
  const setEnabled = useMutation(orpc.sites.setEnabled.mutationOptions());
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  // A draft: enabling the site or a refetch keeps a name being edited.
  const { draft: name, setDraft: setName } = useDraft(site.name);
  const { save, error, pending } = useSaveSite(site.id);
  const purge = useMutation(orpc.sites.purgeAll.mutationOptions());
  const remove = useMutation(orpc.sites.delete.mutationOptions());

  return (
    <div className="grid items-start gap-4 @4xl/main:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-4">
        {site.enabled ? <LiveRequests siteId={site.id} /> : null}
        <LaunchCheck site={site} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Card className="@container/facts">
          <form
            className="flex flex-col gap-(--card-spacing)"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ name: name.trim() });
            }}
          >
            <CardHeader>
              <CardTitle>{m.site_tab_overview()}</CardTitle>
            </CardHeader>
            <CardContent>
              <Field className="pb-2">
                <FieldLabel htmlFor="site-name">{m.site_form_name()}</FieldLabel>
                <Input
                  id="site-name"
                  value={name}
                  required
                  maxLength={100}
                  onChange={(event) => setName(event.target.value)}
                  data-testid="site-name-input"
                />
              </Field>
              <dl className="divide-y border-t">
                <InfoRow label={m.sites_col_status()}>
                  <SiteStatus site={site} />
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="outline" data-testid="site-toggle-enabled">
                        {site.enabled ? m.site_disable() : m.site_enable()}
                      </Button>
                    }
                    destructive={site.enabled}
                    title={
                      site.enabled
                        ? m.site_disable_confirm({ name: site.name })
                        : m.site_enable_confirm({ name: site.name })
                    }
                    note={site.enabled ? m.site_disable_note() : undefined}
                    confirmLabel={site.enabled ? m.site_disable() : m.site_enable()}
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
                      await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
                    }}
                  />
                </InfoRow>
                <InfoRow label={m.sites_col_domains()}>
                  <span className="flex min-w-0 flex-col font-mono text-xs leading-5">
                    {site.domains.map((d) => (
                      <span key={d} className="break-all">
                        {d}
                      </span>
                    ))}
                  </span>
                </InfoRow>
                <InfoRow label={m.sites_col_cluster()}>
                  <Badge variant="secondary">{site.clusterName}</Badge>
                </InfoRow>
                <InfoRow label={m.site_updated_at()}>
                  <span title={formatDateTime(site.updatedAt)}>{timeAgo(site.updatedAt)}</span>
                </InfoRow>
              </dl>
            </CardContent>
            <SaveBar
              dirty={name.trim() !== site.name && name.trim() !== ""}
              pending={pending}
              error={error}
              testId="site-name-save"
            />
          </form>
        </Card>
        <Card>
          <CardContent className="flex flex-wrap gap-2">
            <ConfirmDialog
              trigger={<Button variant="outline">{m.sites_purge()}</Button>}
              title={m.sites_purge()}
              note={site.domains.join(", ")}
              onConfirm={async () => {
                await purge.mutateAsync({ id: site.id });
                toast.success(m.sites_purged(), {
                  action: {
                    label: m.purge_view_tasks(),
                    onClick: () => void navigate({ to: "/purge", search: { site: site.id } }),
                  },
                });
                await queryClient.invalidateQueries({ queryKey: orpc.cacheTasks.key() });
              }}
            />
            <ConfirmDialog
              trigger={
                <Button variant="destructive" data-testid="site-delete">
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                  {m.common_delete()}
                </Button>
              }
              destructive
              title={m.sites_delete_confirm({ name: site.name })}
              confirmLabel={m.common_delete()}
              onConfirm={async () => {
                const result = await remove.mutateAsync({ id: site.id });
                toast.success(m.sites_deleted({ revision: result.revision.revision }));
                // Leave first and drop what was read about the site: refreshing its queries while
                // they are on screen fails (404, retried for seconds) and flashes an error.
                await navigate({ to: "/sites" });
                queryClient.removeQueries({
                  predicate: (query) => JSON.stringify(query.queryKey).includes(site.id),
                });
                await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
              }}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function DomainsTab({ site }: { site: Site }) {
  const { draft: domains, setDraft: setDomains, dirty: listChanged } = useDraft(site.domains);
  const [input, setInput] = React.useState("");
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const { save, error, pending } = useSaveSite(site.id);
  // Domains typed but not added yet count as changes and are saved with the list.
  const typed = domainList(input).filter((d) => !domains.includes(d));
  const dirty = listChanged || typed.length > 0;
  /** The typed domains, or null (and the first invalid one shown) when one is invalid. */
  const take = () => {
    const bad = typed.find((d) => !domainName.safeParse(d).success);
    setInvalid(bad ? m.site_domain_invalid({ domain: bad }) : null);
    return bad ? null : typed;
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
      <Card>
        <form
          className="flex flex-col gap-(--card-spacing)"
          onSubmit={(event) => {
            event.preventDefault();
            const values = take();
            if (!values) return;
            const next = [...domains, ...values];
            setDomains(next);
            setInput("");
            void save({ domains: next });
          }}
        >
          <CardHeader>
            <CardTitle>{m.site_tab_domains()}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <ul className="divide-y rounded-2xl sunk-well" data-testid="domain-list">
              {domains.map((domain, index) => (
                <li
                  key={domain}
                  className="flex items-center gap-2 px-3 py-2 animate-enter"
                  style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                >
                  <span className="flex-1 font-mono text-sm break-all">{domain}</span>
                  {domain.startsWith("*.") ? (
                    <Badge variant="secondary">{m.site_domain_wildcard()}</Badge>
                  ) : null}
                  <Button
                    type="button"
                    size="icon-sm"
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
                placeholder="www.example.com, *.example.com"
                aria-label={m.site_domain_add()}
                data-testid="domain-input"
              />
              <Button type="button" variant="outline" onClick={add} data-testid="domain-add">
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.site_domain_add()}
              </Button>
            </div>
          </CardContent>
          <SaveBar dirty={dirty} pending={pending} error={invalid ?? error} testId="domains-save" />
        </form>
      </Card>
    </div>
  );
}
