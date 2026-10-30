import {
  analyticsRange,
  BLOCK_REASONS,
  displaySiteDomain,
  type Site,
  siteDomain,
} from "@edgeweir/contract";
import {
  Add01Icon,
  ArrowLeft01Icon,
  Copy01Icon,
  DatabaseSync01Icon,
  Delete02Icon,
  Edit02Icon,
  Layers01Icon,
  MoreHorizontalIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { Input } from "@/components/arc/input/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { ConfirmDialog, ControlledConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { Field, FieldLabel } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { LinkButton } from "@/components/link-button";
import { Page, PageTabs } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { AccessTab } from "@/components/site/access-tab";
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
import { LaunchCheck } from "@/components/site/launch-check";
import { LiveRequests } from "@/components/site/live-requests";
import { LogsTab } from "@/components/site/logs-tab";
import { OriginsTab } from "@/components/site/origins-tab";
import { SitePortsCard } from "@/components/site/ports-card";
import { RulesTab } from "@/components/site/rules-tab";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { SecurityTab } from "@/components/site/security-tab";
import { UsageGuardCard } from "@/components/site/usage-guard-card";
import { StarButton, useSiteStars } from "@/components/site-star";
import { SiteStatus, untilLive } from "@/components/site-status";
import { TagBadges, TagPicker } from "@/components/site-tags";
import { QueryView } from "@/components/states";
import { NotFoundPage } from "@/components/status-page";
import { TimeAgo } from "@/components/time-ago";
import { useDraft } from "@/hooks/use-draft";
import { useTabBar } from "@/hooks/use-tab-bar";
import { DEFAULT_RANGE } from "@/lib/analytics";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import { recordRecent } from "@/lib/recents";
import { needsDomainForms, newDomains } from "@/lib/site-domains";
import { SITE_TABS, type SiteTab, siteTabLabel } from "@/lib/site-tabs";
import { toast } from "@/lib/toast";

export const Route = createFileRoute("/_app/sites/$id")({
  validateSearch: z.object({
    tab: z.enum(SITE_TABS).optional(),
    range: analyticsRange.optional(),
    // A jump into the logs tab: the filters and the time window of the search.
    blockReason: z.enum([...BLOCK_REASONS, "any"]).optional(),
    ip: z.string().max(64).optional(),
    cidr: z.string().max(64).optional(),
    path: z.string().max(2048).optional(),
    from: z.iso.datetime().optional(),
    to: z.iso.datetime().optional(),
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
  // The Extensions tab shows once an extension is installed.
  const extensions = useQuery(orpc.extensions.list.queryOptions());
  const hasExtensions = (extensions.data?.length ?? 0) > 0 || tab === "extensions";
  const name = site.data?.name;
  const tabBar = useTabBar(`tab-${tab}`);

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
          {site.data ? <SiteMenu site={site.data} /> : null}
        </>
      }
      back={
        <LinkButton
          to="/sites"
          size="sm"
          variant="ghost"
          className="icon-button"
          aria-label={m.site_back()}
          data-testid="back-link"
        >
          <HugeiconsIcon icon={ArrowLeft01Icon} strokeWidth={2} />
        </LinkButton>
      }
    >
      <QueryView
        query={site}
        notFound={
          <NotFoundPage
            path={href}
            surface="inline"
            record={{ title: m.status_site_missing(), to: "/sites", label: m.status_back_sites() }}
          />
        }
      >
        {(data) => (
          <Tabs
            key={data.id}
            className="gap-4"
            value={tab}
            onValueChange={(value) =>
              navigate({
                // A jump's filters belong to the tab it opened.
                search: (prev) => ({
                  ...prev,
                  tab: value === "overview" ? undefined : (value as SiteTab),
                  blockReason: undefined,
                  ip: undefined,
                  cidr: undefined,
                  path: undefined,
                  from: undefined,
                  to: undefined,
                }),
                replace: true,
              })
            }
          >
            {/* The page's tab bar, in the header band. */}
            <PageTabs>
              <TabsList
                ref={tabBar}
                variant="line"
                className="w-full max-w-full justify-start overflow-x-auto overflow-y-hidden scroll-fade [scrollbar-width:none]"
              >
                {SITE_TABS.filter((value) => value !== "extensions" || hasExtensions).map(
                  (value) => (
                    <TabsTrigger
                      key={value}
                      value={value}
                      className="flex-none"
                      data-testid={`tab-${value}`}
                    >
                      {siteTabLabel(value)}
                    </TabsTrigger>
                  ),
                )}
              </TabsList>
            </PageTabs>
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
              <OriginsTab
                site={data}
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
            <TabsContent value="https" className="animate-enter">
              <HttpsTab site={data} />
            </TabsContent>
            <TabsContent value="rules" className="animate-enter">
              <RulesTab siteId={data.id} originGroups={originGroups(data)} site={data} />
            </TabsContent>
            <TabsContent value="redirects" className="animate-enter">
              <BulkRedirectsTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="access" className="animate-enter">
              <AccessTab site={data} />
            </TabsContent>
            <TabsContent value="security" className="animate-enter">
              <SecurityTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="attacks" className="animate-enter">
              <AttacksTab
                siteId={data.id}
                siteName={data.name}
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
            <TabsContent value="errors" className="animate-enter">
              <ErrorPagesTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="extensions" className="animate-enter">
              <ExtensionsTab siteId={data.id} />
            </TabsContent>
            <TabsContent value="logs" className="animate-enter">
              <LogsTab
                siteId={data.id}
                jump={
                  search.blockReason ||
                  search.ip ||
                  search.cidr ||
                  search.path ||
                  search.from ||
                  search.to
                    ? {
                        blockReason: search.blockReason,
                        ip: search.ip,
                        cidr: search.cidr,
                        path: search.path,
                        from: search.from,
                        to: search.to,
                      }
                    : undefined
                }
              />
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

/**
 * The site's actions in the page header (every tab): copy its settings to other sites, clone it,
 * purge its cache, delete it.
 */
function SiteMenu({ site }: { site: Site }) {
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
          await navigate({ to: "/sites" });
          queryClient.removeQueries({
            predicate: (query) => JSON.stringify(query.queryKey).includes(site.id),
          });
          await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
        }}
      />
    </>
  );
}

function OverviewTab({ site }: { site: Site }) {
  const setEnabled = useMutation({
    ...orpc.sites.setEnabled.mutationOptions(),
    meta: { invalidates: [orpc.sites.key()] },
  });
  const queryClient = useQueryClient();
  // A draft: enabling the site or a refetch keeps a name being edited.
  const { draft: name, setDraft: setName } = useDraft(site.name);
  const { save, error, pending } = useSaveSite(site.id);

  return (
    <div className="grid items-start gap-4 @4xl/main:grid-cols-[minmax(0,1fr)_minmax(0,22rem)]">
      <div className="flex min-w-0 flex-col gap-4">
        {site.enabled ? <LiveRequests siteId={site.id} /> : null}
        <LaunchCheck site={site} />
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <Panel className="@container/facts">
          <form
            className="flex flex-col gap-(--panel-pad)"
            onSubmit={(event) => {
              event.preventDefault();
              void save({ name: name.trim() });
            }}
          >
            <PanelHeader>
              <PanelTitle>{m.site_tab_overview()}</PanelTitle>
            </PanelHeader>
            <PanelContent>
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
                      <Button size="sm" variant="secondary" data-testid="site-toggle-enabled">
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
                    }}
                  />
                </InfoRow>
                <InfoRow label={m.sites_col_domains()}>
                  <span className="flex min-w-0 flex-col font-mono text-xs leading-5">
                    {site.domains.map((d) => (
                      <DomainName key={d} domain={d} className="break-all" />
                    ))}
                  </span>
                </InfoRow>
                <InfoRow label={m.sites_col_cluster()}>
                  <Badge size="sm" tone="neutral">
                    {site.clusterName}
                  </Badge>
                </InfoRow>
                <InfoRow label={m.tags_label()}>
                  <SiteTagsRow site={site} />
                </InfoRow>
                <InfoRow label={m.site_updated_at()}>
                  <TimeAgo at={site.updatedAt} />
                </InfoRow>
              </dl>
            </PanelContent>
            <SaveBar
              dirty={name.trim() !== site.name && name.trim() !== ""}
              pending={pending}
              error={error}
              testId="site-name-save"
            />
          </form>
        </Panel>
        <UsageGuardCard site={site} />
      </div>
    </div>
  );
}

/** The site's tags, and a dialog that edits them (saved at once: tags are not published). */
function SiteTagsRow({ site }: { site: Site }) {
  const queryClient = useQueryClient();
  const navigate = Route.useNavigate();
  const [open, setOpen] = React.useState(false);
  const [tags, setTags] = React.useState<string[]>([]);
  return (
    <>
      <TagBadges
        tags={site.tags}
        onSelect={(tag) => void navigate({ to: "/sites", search: { tags: [tag.id] } })}
      />
      <Button
        className="icon-button"
        size="sm"
        variant="ghost"
        aria-label={m.tags_label()}
        onClick={() => {
          setTags(site.tags.map((tag) => tag.name));
          setOpen(true);
        }}
        data-testid="site-tags-edit"
      >
        <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
      </Button>
      <FormDialog
        open={open}
        onOpenChange={setOpen}
        title={m.tags_label()}
        submitLabel={m.common_save()}
        submitTestId="site-tags-save"
        onSubmit={async () => {
          await client.sites.setTags({ id: site.id, tags });
          toast.success(m.tags_saved());
          setOpen(false);
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: orpc.sites.key() }),
            queryClient.invalidateQueries({ queryKey: orpc.siteTags.key() }),
          ]);
        }}
      >
        <TagPicker id="site-tags" value={tags} onChange={setTags} />
      </FormDialog>
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
