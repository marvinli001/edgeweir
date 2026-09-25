import { analyticsRange, type Site, type SiteUpdateInput } from "@edgeweir/contract";
import { Add01Icon, Delete02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Page } from "@/components/page";
import { StarButton, useSiteStars } from "@/components/site-star";
import { ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DEFAULT_RANGE } from "@/lib/analytics";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
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
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const { session } = Route.useRouteContext();
  const site = useQuery(orpc.sites.get.queryOptions({ input: { id } }));
  const stars = useSiteStars();
  const tab: SiteTab = search.tab ?? "overview";
  const name = site.data?.name;

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
      {site.isPending ? (
        <LoadingState />
      ) : site.isError ? (
        <ErrorState error={site.error} onRetry={() => site.refetch()} />
      ) : (
        <Tabs
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
          <TabsList className="max-w-full overflow-x-auto">
            {SITE_TABS.map((value) => (
              <TabsTrigger key={value} value={value} data-testid={`tab-${value}`}>
                {siteTabLabel(value)}
              </TabsTrigger>
            ))}
          </TabsList>
          <TabsContent value="overview" className="animate-enter">
            <OverviewTab key={site.data.updatedAt} site={site.data} />
          </TabsContent>
          <TabsContent value="analytics" className="animate-enter">
            <AnalyticsSection
              siteId={site.data.id}
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
            <DomainsTab key={site.data.updatedAt} site={site.data} />
          </TabsContent>
          <TabsContent value="origins" className="animate-enter">
            <OriginsTab key={site.data.updatedAt} site={site.data} />
          </TabsContent>
          <TabsContent value="cache" className="animate-enter">
            <CacheTab key={site.data.updatedAt} site={site.data} />
          </TabsContent>
        </Tabs>
      )}
    </Page>
  );
}

/** Saves part of a site; every save publishes a configuration revision and says which one. */
function useSaveSite(siteId: string) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.sites.update.mutationOptions());
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState(false);
  const save = async (patch: Omit<SiteUpdateInput, "id">) => {
    setPending(true);
    setError(null);
    try {
      const result = await update.mutateAsync({ id: siteId, ...patch });
      queryClient.setQueryData(orpc.sites.get.queryKey({ input: { id: siteId } }), result.site);
      await queryClient.invalidateQueries({ queryKey: orpc.sites.key() });
      toast.success(m.site_saved({ revision: result.revision.revision }), {
        id: "site-saved",
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(false);
    }
  };
  return { save, error, pending };
}

function SaveBar({
  dirty,
  pending,
  error,
  testId,
}: {
  dirty: boolean;
  pending: boolean;
  error: string | null;
  testId: string;
}) {
  return (
    <CardFooter className="flex-wrap justify-end gap-3 border-t">
      {error ? (
        <FieldError className="mr-auto animate-in fade-in" data-testid="site-save-error">
          {error}
        </FieldError>
      ) : null}
      <Button type="submit" disabled={!dirty || pending} data-testid={testId}>
        {pending ? <Spinner /> : null}
        {m.common_save()}
      </Button>
    </CardFooter>
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

interface OriginDraft {
  key: number;
  address: string;
  port: string;
  scheme: "http" | "https";
  weight: string;
  backup: boolean;
  hostHeader: string;
}

let draftKeys = 0;

function OriginsTab({ site }: { site: Site }) {
  const initial = React.useMemo(
    () =>
      site.origins.map<OriginDraft>((o) => ({
        key: ++draftKeys,
        address: o.address,
        port: String(o.port),
        scheme: o.scheme,
        weight: String(o.weight),
        backup: o.backup,
        hostHeader: o.hostHeader,
      })),
    [site.origins],
  );
  const [rows, setRows] = React.useState(initial);
  const { save, error, pending } = useSaveSite(site.id);
  const serialize = (list: OriginDraft[]) =>
    JSON.stringify(list.map(({ key: _key, ...rest }) => rest));
  const dirty = serialize(rows) !== serialize(initial);
  const patch = (key: number, change: Partial<OriginDraft>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            origins: rows.map((r) => ({
              address: r.address.trim(),
              port: Number(r.port) || (r.scheme === "https" ? 443 : 80),
              scheme: r.scheme,
              weight: Number(r.weight) || 1,
              backup: r.backup,
              hostHeader: r.hostHeader.trim(),
            })),
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_tab_origins()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rows.map((row, index) => (
            <fieldset
              key={row.key}
              className="grid gap-3 rounded-2xl border p-3 animate-enter sm:grid-cols-[1fr_6rem_7rem_5rem] lg:grid-cols-[1fr_6rem_7rem_5rem_1fr_auto_auto]"
              style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
              data-testid="origin-row"
            >
              <Field>
                <FieldLabel htmlFor={`origin-address-${row.key}`}>
                  {m.site_form_origin()}
                </FieldLabel>
                <Input
                  id={`origin-address-${row.key}`}
                  value={row.address}
                  required
                  onChange={(event) => patch(row.key, { address: event.target.value })}
                  placeholder="10.0.0.10"
                  data-testid="origin-address"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`origin-port-${row.key}`}>{m.site_form_port()}</FieldLabel>
                <Input
                  id={`origin-port-${row.key}`}
                  type="number"
                  min={1}
                  max={65535}
                  value={row.port}
                  onChange={(event) => patch(row.key, { port: event.target.value })}
                  data-testid="origin-port"
                />
              </Field>
              <Field>
                <FieldLabel>{m.site_form_scheme()}</FieldLabel>
                <Select
                  value={row.scheme}
                  onValueChange={(v) => v && patch(row.key, { scheme: v as "http" | "https" })}
                  items={[
                    { label: "HTTP", value: "http" },
                    { label: "HTTPS", value: "https" },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="http">HTTP</SelectItem>
                    <SelectItem value="https">HTTPS</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`origin-weight-${row.key}`}>
                  {m.site_origin_weight()}
                </FieldLabel>
                <Input
                  id={`origin-weight-${row.key}`}
                  type="number"
                  min={1}
                  max={100}
                  value={row.weight}
                  onChange={(event) => patch(row.key, { weight: event.target.value })}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`origin-host-${row.key}`}>
                  {m.site_form_host_header()}
                </FieldLabel>
                <Input
                  id={`origin-host-${row.key}`}
                  value={row.hostHeader}
                  maxLength={253}
                  onChange={(event) => patch(row.key, { hostHeader: event.target.value })}
                  placeholder={m.site_form_host_header_placeholder()}
                />
              </Field>
              <Field orientation="horizontal" className="self-end pb-2">
                <Switch
                  id={`origin-backup-${row.key}`}
                  checked={row.backup}
                  onCheckedChange={(backup) => patch(row.key, { backup })}
                />
                <FieldLabel htmlFor={`origin-backup-${row.key}`}>
                  {m.site_origin_backup()}
                </FieldLabel>
              </Field>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="self-end justify-self-end"
                aria-label={m.common_remove()}
                disabled={rows.length === 1}
                onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: ++draftKeys,
                  address: "",
                  port: "80",
                  scheme: "http",
                  weight: "1",
                  backup: false,
                  hostHeader: "",
                },
              ])
            }
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.site_origin_add()}
          </Button>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="origins-save" />
      </form>
    </Card>
  );
}

interface RuleDraft {
  key: number;
  prefixes: string;
  extensions: string;
  action: "cache" | "bypass";
  ttl: string;
  respect: boolean;
}

const splitList = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((v) => v.trim())
    .filter(Boolean);

function CacheTab({ site }: { site: Site }) {
  const initial = React.useMemo(
    () =>
      site.cacheRules.map<RuleDraft>((r) => ({
        key: ++draftKeys,
        prefixes: r.pathPrefixes.join(", "),
        extensions: r.extensions.join(", "),
        action: r.action,
        ttl: String(r.edgeTtlSeconds),
        respect: r.originCacheControl === "respect",
      })),
    [site.cacheRules],
  );
  const [rows, setRows] = React.useState(initial);
  const { save, error, pending } = useSaveSite(site.id);
  const serialize = (list: RuleDraft[]) =>
    JSON.stringify(list.map(({ key: _key, ...rest }) => rest));
  const dirty = serialize(rows) !== serialize(initial);
  const patch = (key: number, change: Partial<RuleDraft>) =>
    setRows(rows.map((r) => (r.key === key ? { ...r, ...change } : r)));

  return (
    <Card>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void save({
            cacheRules: rows.map((r, index) => ({
              // Rules match in list order.
              priority: (index + 1) * 10,
              pathPrefixes: splitList(r.prefixes),
              extensions: splitList(r.extensions),
              action: r.action,
              edgeTtlSeconds: Number(r.ttl) || 0,
              originCacheControl: r.respect ? "respect" : "override",
            })),
          });
        }}
      >
        <CardHeader>
          <CardTitle>{m.site_tab_cache()}</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">{m.sites_no_cache_rules()}</p>
          ) : null}
          {rows.map((row, index) => (
            <fieldset
              key={row.key}
              className="grid gap-3 rounded-2xl border p-3 animate-enter sm:grid-cols-2 lg:grid-cols-[1fr_1fr_8rem_7rem_auto_auto]"
              style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
              data-testid="cache-rule-row"
            >
              <Field>
                <FieldLabel htmlFor={`rule-prefix-${row.key}`}>
                  {m.site_form_cache_prefix()}
                </FieldLabel>
                <Input
                  id={`rule-prefix-${row.key}`}
                  value={row.prefixes}
                  onChange={(event) => patch(row.key, { prefixes: event.target.value })}
                  placeholder="/static/, /img/"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor={`rule-ext-${row.key}`}>{m.site_rule_extensions()}</FieldLabel>
                <Input
                  id={`rule-ext-${row.key}`}
                  value={row.extensions}
                  onChange={(event) => patch(row.key, { extensions: event.target.value })}
                  placeholder="css, js, png"
                />
              </Field>
              <Field>
                <FieldLabel>{m.site_rule_action()}</FieldLabel>
                <Select
                  value={row.action}
                  onValueChange={(v) => v && patch(row.key, { action: v as "cache" | "bypass" })}
                  items={[
                    { label: m.site_rule_cache(), value: "cache" },
                    { label: m.site_rule_bypass(), value: "bypass" },
                  ]}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cache">{m.site_rule_cache()}</SelectItem>
                    <SelectItem value="bypass">{m.site_rule_bypass()}</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`rule-ttl-${row.key}`}>{m.site_form_cache_ttl()}</FieldLabel>
                <Input
                  id={`rule-ttl-${row.key}`}
                  type="number"
                  min={0}
                  value={row.ttl}
                  disabled={row.action === "bypass"}
                  onChange={(event) => patch(row.key, { ttl: event.target.value })}
                />
              </Field>
              <Field orientation="horizontal" className="self-end pb-2">
                <Switch
                  id={`rule-respect-${row.key}`}
                  checked={row.respect}
                  disabled={row.action === "bypass"}
                  onCheckedChange={(respect) => patch(row.key, { respect })}
                />
                <FieldLabel htmlFor={`rule-respect-${row.key}`}>{m.site_rule_respect()}</FieldLabel>
              </Field>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                className="self-end justify-self-end"
                aria-label={m.common_remove()}
                onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
              </Button>
            </fieldset>
          ))}
          <Button
            type="button"
            variant="outline"
            className="self-start"
            onClick={() =>
              setRows([
                ...rows,
                {
                  key: ++draftKeys,
                  prefixes: "/",
                  extensions: "",
                  action: "cache",
                  ttl: "3600",
                  respect: false,
                },
              ])
            }
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.site_rule_add()}
          </Button>
        </CardContent>
        <SaveBar dirty={dirty} pending={pending} error={error} testId="cache-save" />
      </form>
    </Card>
  );
}
