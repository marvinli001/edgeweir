import type { Site } from "@edgeweir/contract";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page } from "@/components/page";
import { CacheTab } from "@/components/site/cache-tab";
import { OriginsTab } from "@/components/site/origins-tab";
import { SaveBar, useSaveSite } from "@/components/site/save-site";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const TABS = ["overview", "domains", "origins", "cache"] as const;
type Tab = (typeof TABS)[number];

export const Route = createFileRoute("/_app/sites/$id")({
  validateSearch: z.object({ tab: z.enum(TABS).optional() }),
  component: SiteDetailPage,
});

function SiteDetailPage() {
  const { id } = Route.useParams();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const site = useQuery(orpc.sites.get.queryOptions({ input: { id } }));
  const tab: Tab = search.tab ?? "overview";

  return (
    <Page
      title={site.data?.name ?? m.site_detail_title()}
      actions={
        <Link to="/sites" className="text-sm text-muted-foreground hover:text-foreground">
          {m.site_back()}
        </Link>
      }
    >
      {site.isPending ? (
        <LoadingState />
      ) : site.isError ? (
        <ErrorState error={site.error} onRetry={() => site.refetch()} />
      ) : (
        <Tabs
          value={tab}
          onValueChange={(value) =>
            navigate({
              search: { tab: value === "overview" ? undefined : (value as Tab) },
              replace: true,
            })
          }
        >
          <TabsList className="max-w-full overflow-x-auto">
            <TabsTrigger value="overview" data-testid="tab-overview">
              {m.site_tab_overview()}
            </TabsTrigger>
            <TabsTrigger value="domains" data-testid="tab-domains">
              {m.site_tab_domains()}
            </TabsTrigger>
            <TabsTrigger value="origins" data-testid="tab-origins">
              {m.site_tab_origins()}
            </TabsTrigger>
            <TabsTrigger value="cache" data-testid="tab-cache">
              {m.site_tab_cache()}
            </TabsTrigger>
          </TabsList>
          <TabsContent value="overview" className="animate-enter">
            <OverviewTab key={site.data.updatedAt} site={site.data} />
          </TabsContent>
          <TabsContent value="domains" className="animate-enter">
            <DomainsTab key={site.data.updatedAt} site={site.data} />
          </TabsContent>
          <TabsContent value="origins" className="animate-enter">
            <OriginsTab site={site.data} />
          </TabsContent>
          <TabsContent value="cache" className="animate-enter">
            <CacheTab site={site.data} />
          </TabsContent>
        </Tabs>
      )}
    </Page>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[10rem_1fr] sm:items-center sm:gap-4">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm">{children}</dd>
    </div>
  );
}

function OverviewTab({ site }: { site: Site }) {
  const { isAdmin } = Route.useRouteContext();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const [name, setName] = React.useState(site.name);
  const { save, error, pending } = useSaveSite(site.id);
  const purge = useMutation(orpc.sites.purgeAll.mutationOptions());
  const remove = useMutation(orpc.sites.delete.mutationOptions());

  return (
    <div className="flex flex-col gap-4">
      <Card>
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
            <Field className="max-w-sm pb-2">
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
            <dl className="divide-y">
              <InfoRow label={m.sites_col_domains()}>
                {site.domains.map((d) => (
                  <Badge key={d} variant="outline" className="font-mono">
                    {d}
                  </Badge>
                ))}
              </InfoRow>
              {isAdmin ? (
                <>
                  <InfoRow label={m.sites_col_organization()}>{site.organizationName}</InfoRow>
                  <InfoRow label={m.sites_col_cluster()}>
                    <Badge variant="secondary">{site.clusterName}</Badge>
                  </InfoRow>
                </>
              ) : null}
              <InfoRow label={m.site_cache_generation()}>
                <span className="font-mono">{formatNumber(site.cacheGeneration)}</span>
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
            description={site.domains.join(", ")}
            onConfirm={async () => {
              try {
                const result = await purge.mutateAsync({ id: site.id });
                toast.success(m.sites_purged({ revision: result.revision.revision }));
                await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
              } catch (err) {
                toast.error(errorMessage(err));
              }
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
              try {
                const result = await remove.mutateAsync({ id: site.id });
                toast.success(m.sites_deleted({ revision: result.revision.revision }));
                await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
                await navigate({ to: "/sites" });
              } catch (err) {
                toast.error(errorMessage(err));
              }
            }}
          />
        </CardContent>
      </Card>
    </div>
  );
}

function DomainsTab({ site }: { site: Site }) {
  const [domains, setDomains] = React.useState(site.domains);
  const [draft, setDraft] = React.useState("");
  const { save, error, pending } = useSaveSite(site.id);
  const dirty = domains.join("\n") !== site.domains.join("\n");
  const add = () => {
    const values = draft
      .split(/[\s,]+/)
      .map((d) => d.trim().toLowerCase())
      .filter((d) => d && !domains.includes(d));
    if (values.length) setDomains([...domains, ...values]);
    setDraft("");
  };

  return (
    <Card>
      <form
        className="flex flex-col gap-(--card-spacing)"
        onSubmit={(event) => {
          event.preventDefault();
          void save({ domains });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_tab_domains()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <ul className="divide-y rounded-2xl border" data-testid="domain-list">
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
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
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
        <SaveBar dirty={dirty} pending={pending} error={error} testId="domains-save" />
      </form>
    </Card>
  );
}
