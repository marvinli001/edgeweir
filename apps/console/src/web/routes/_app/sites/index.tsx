import { type Site, type SiteCreateInput, siteCreateInput } from "@edgeweir/contract";
import { MAX_HOST_HEADER_LENGTH, validHostHeader } from "@edgeweir/rule-engine";
import { Add01Icon, GlobeIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { Sparkline } from "@/components/appica/sparkline";
import { type Columns, DataTable } from "@/components/data-table";
import { FilterSelect, FormSelect, OptionSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { SearchBox } from "@/components/search-box";
import { followSiteDelivery } from "@/components/site/delivery-toast";
import { StarButton, useSiteStars } from "@/components/site-star";
import { SiteStatus, untilLive } from "@/components/site-status";
import { SitesTabs } from "@/components/sites-tabs";
import { EmptyState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useOpenKey } from "@/hooks/use-open-key";
import { domainList, fillOrigin, replacesField } from "@/lib/address-input";
import { formatCompact, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const PAGE_SIZE = 20;

/** Sums neighbouring buckets so a long series draws as `points` points. */
function coarse(series: number[], points: number): number[] {
  const step = Math.max(1, Math.ceil(series.length / points));
  const out: number[] = [];
  for (let i = 0; i < series.length; i += step) {
    out.push(series.slice(i, i + step).reduce((sum, value) => sum + value, 0));
  }
  return out;
}

export const Route = createFileRoute("/_app/sites/")({
  validateSearch: z.object({
    create: z.boolean().optional(),
    q: z.string().optional(),
    cluster: z.string().optional(),
    page: z.number().int().min(1).optional(),
  }),
  component: SitesPage,
});

function SitesPage() {
  const search = Route.useSearch();
  const createKey = useOpenKey(search.create === true);
  const navigate = Route.useNavigate();
  const page = search.page ?? 1;
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({
      input: {
        search: search.q || undefined,
        clusterId: search.cluster,
        page,
        pageSize: PAGE_SIZE,
      },
    }),
    placeholderData: keepPreviousData,
    refetchInterval: (query) => untilLive(query.state.data?.items),
    meta: { background: true },
  });
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const setCreateOpen = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, create: open || undefined }), replace: true });
  const filtered = !!search.q || !!search.cluster;

  // Each site's requests over the last day, for the trend column.
  const trends = useQuery({
    ...orpc.analytics.breakdown.queryOptions({
      input: { by: "site", range: "24h", limit: PAGE_SIZE },
    }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    meta: { background: true },
  });
  const trendById = React.useMemo(
    () =>
      new Map(
        (trends.data?.items ?? []).map((item) => [
          item.id,
          { total: item.total, series: coarse(item.series, 48) },
        ]),
      ),
    [trends.data],
  );

  const stars = useSiteStars();
  const { ids: starredIds, pendingId, toggle } = stars;
  const columns = React.useMemo<Columns<Site>>(
    () => [
      {
        id: "star",
        header: () => <span className="sr-only">{m.site_star()}</span>,
        cell: ({ row }) => (
          <StarButton
            starred={starredIds.has(row.original.id)}
            pending={pendingId === row.original.id}
            onToggle={() => void toggle(row.original.id)}
            className="-my-1 -ml-1"
          />
        ),
      },
      {
        id: "name",
        header: () => m.sites_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <Link
              to="/sites/$id"
              params={{ id: row.original.id }}
              className="font-medium underline-offset-4 hover:underline"
              data-testid="site-link"
            >
              {row.original.name}
            </Link>
            <span className="text-xs text-muted-foreground">{timeAgo(row.original.createdAt)}</span>
          </div>
        ),
      },
      {
        id: "status",
        header: () => m.sites_col_status(),
        cell: ({ row }) => <SiteStatus site={row.original} />,
      },
      {
        id: "traffic",
        header: () => m.sites_col_traffic(),
        cell: ({ row }) => {
          const trend = trendById.get(row.original.id);
          if (!trend) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex w-36 items-center gap-3">
              <Sparkline data={trend.series} height={24} fill={false} className="w-20" />
              <span className="text-xs font-medium tabular-nums">{formatCompact(trend.total)}</span>
            </div>
          );
        },
      },
      {
        id: "domains",
        header: () => m.sites_col_domains(),
        cell: ({ row }) => (
          <div className="flex flex-wrap gap-1">
            {row.original.domains.map((d) => (
              <Badge key={d} variant="outline" className="font-mono">
                {d}
              </Badge>
            ))}
          </div>
        ),
      },
      {
        id: "origins",
        header: () => m.sites_col_origins(),
        cell: ({ row }) => (
          <div className="flex flex-col font-mono text-xs">
            {row.original.origins.map((o) => (
              <span key={o.id}>
                {o.scheme}://{o.address}:{o.port}
              </span>
            ))}
          </div>
        ),
      },
      {
        id: "cluster",
        header: () => m.sites_col_cluster(),
        cell: ({ row }) => <Badge variant="secondary">{row.original.clusterName}</Badge>,
      },
    ],
    [starredIds, pendingId, toggle, trendById],
  );

  return (
    <Page
      title={m.sites_title()}
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="new-site">
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.nav_new_site()}
        </Button>
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <SitesTabs value="sites" />
        <SearchBox
          value={search.q ?? ""}
          onChange={(q) =>
            navigate({
              search: (prev) => ({ ...prev, q: q || undefined, page: undefined }),
              replace: true,
            })
          }
        />
        {clusters.data && clusters.data.length > 1 ? (
          <FilterSelect
            value={search.cluster}
            onChange={(cluster) =>
              navigate({
                search: (prev) => ({ ...prev, cluster, page: undefined }),
                replace: true,
              })
            }
            allLabel={m.sites_all_clusters()}
            options={clusters.data.map((c) => ({ label: c.name, value: c.id }))}
            label={m.sites_col_cluster()}
            testId="cluster-filter"
            className="w-44"
          />
        ) : null}
      </div>
      <QueryView
        query={sites}
        isEmpty={(data) => data.total === 0}
        empty={
          filtered ? (
            <EmptyState icon={Search01Icon} title={m.sites_no_match()} />
          ) : (
            <EmptyState icon={GlobeIcon} title={m.sites_empty_title()}>
              <Button onClick={() => setCreateOpen(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.nav_new_site()}
              </Button>
            </EmptyState>
          )
        }
      >
        {({ items, total }) => (
          <>
            <DataTable data={items} columns={columns} getRowId={(s) => s.id} testId="sites-table" />
            <Pager
              page={page}
              pageSize={PAGE_SIZE}
              total={total}
              onPageChange={(next) => navigate({ search: (prev) => ({ ...prev, page: next }) })}
            />
          </>
        )}
      </QueryView>
      <CreateSiteDialog
        key={createKey}
        open={search.create === true}
        onOpenChange={setCreateOpen}
        clusters={clusters.data ?? []}
        initialClusterId={search.cluster}
      />
    </Page>
  );
}

const SCHEMES = [
  { label: "HTTP", value: "http" },
  { label: "HTTPS", value: "https" },
] as const;

function CreateSiteDialog({
  open,
  onOpenChange,
  clusters,
  initialClusterId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Oldest first: a new site goes to the oldest cluster unless another is chosen. */
  clusters: { id: string; name: string }[];
  initialClusterId?: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const create = useMutation(orpc.sites.create.mutationOptions());
  const [scheme, setScheme] = React.useState<"http" | "https">("http");
  // The address, port and protocol fields; a pasted URL or "host:port" fills all three.
  const [address, setAddress] = React.useState("");
  const [port, setPort] = React.useState("");
  // The name defaults to the first domain.
  const [firstDomain, setFirstDomain] = React.useState("");
  const [cacheEnabled, setCacheEnabled] = React.useState(true);
  const [respectOrigin, setRespectOrigin] = React.useState(true);
  const [navigating, setNavigating] = React.useState(false);
  const [clusterId, setClusterId] = React.useState(initialClusterId);
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const [hostInvalid, setHostInvalid] = React.useState(false);
  const cluster = clusters.some((c) => c.id === clusterId) ? clusterId : clusters[0]?.id;
  const pending = create.isPending || navigating;
  /** Puts an origin into the fields (a URL's protocol and port into theirs) and returns it. */
  const fill = (value: string) => {
    const next = fillOrigin(value, { scheme, port }, () => "");
    setAddress(next.address);
    setScheme(next.scheme);
    setPort(next.port);
    return next;
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          create.reset();
          setInvalid(null);
          setHostInvalid(false);
        }
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{m.site_form_title()}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const text = (key: string) => String(data.get(key) ?? "").trim();
            // A URL typed without leaving the field fills the fields now, visibly.
            const origin = fill(address);
            const input: SiteCreateInput = {
              name: text("siteName") || undefined,
              clusterId: clusters.length > 1 ? cluster : undefined,
              domains: domainList(text("domains")),
              origins: [
                {
                  address: origin.address,
                  port: Number(origin.port || (origin.scheme === "https" ? 443 : 80)),
                  scheme: origin.scheme,
                  hostHeader: text("hostHeader"),
                },
              ],
              cacheRules: cacheEnabled
                ? [
                    {
                      pathPrefixes: [text("cachePrefix") || "/"],
                      edgeTtlSeconds: Number(text("cacheTtl") || 3600),
                      originCacheControl: respectOrigin ? "respect" : "override",
                    },
                  ]
                : [],
            };
            const checked = siteCreateInput.safeParse(input);
            setInvalid(checked.success ? null : errorMessage(checked.error));
            if (!checked.success) return;
            // Nodes would skip the origin: its Host header is checked as they check it.
            const host = text("hostHeader");
            const badHost = host !== "" && !validHostHeader(host);
            setHostInvalid(badHost);
            if (badHost) return;
            let siteId: string;
            try {
              const result = await create.mutateAsync(input);
              siteId = result.site.id;
              followSiteDelivery(queryClient, siteId, m.site_created_toast(), result.site.delivery);
            } catch {
              return; // rendered below via create.error
            }
            setNavigating(true);
            try {
              await queryClient.invalidateQueries();
              await navigate({ to: "/sites/$id", params: { id: siteId } });
            } finally {
              setNavigating(false);
            }
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="siteName">{m.site_form_name()}</FieldLabel>
              <Input
                id="siteName"
                name="siteName"
                maxLength={100}
                placeholder={firstDomain || "demo.test"}
              />
            </Field>
            {clusters.length > 1 && cluster ? (
              <FormSelect
                id="site-cluster"
                label={m.site_form_cluster()}
                value={cluster}
                options={clusters.map((c) => ({ value: c.id, label: c.name }))}
                onChange={setClusterId}
                testId="site-cluster"
              />
            ) : null}
            <Field>
              <FieldLabel htmlFor="domains">{m.site_form_domains()}</FieldLabel>
              <Textarea
                id="domains"
                name="domains"
                required
                rows={2}
                placeholder={"demo.test\n*.demo.test"}
                onChange={(event) => setFirstDomain(domainList(event.target.value)[0] ?? "")}
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem_8rem]">
              <Field>
                <FieldLabel htmlFor="origin">{m.site_form_origin()}</FieldLabel>
                <Input
                  id="origin"
                  name="origin"
                  required
                  placeholder="origin.example.com"
                  value={address}
                  onChange={(event) => setAddress(event.target.value)}
                  onPaste={(event) => {
                    if (!replacesField(event.currentTarget)) return;
                    event.preventDefault();
                    fill(event.clipboardData.getData("text"));
                  }}
                  onBlur={() => fill(address)}
                  data-testid="site-origin-address"
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="port">{m.site_form_port()}</FieldLabel>
                <Input
                  id="port"
                  name="port"
                  type="number"
                  min={1}
                  max={65535}
                  placeholder={scheme === "https" ? "443" : "80"}
                  value={port}
                  onChange={(event) => setPort(event.target.value)}
                  data-testid="site-origin-port"
                />
              </Field>
              <Field>
                <FieldLabel>{m.site_form_scheme()}</FieldLabel>
                <OptionSelect
                  value={scheme}
                  options={SCHEMES}
                  onChange={(next) => {
                    setScheme(next);
                    // A port set to the other protocol's default follows the protocol.
                    if (port === (next === "https" ? "80" : "443")) setPort("");
                  }}
                  testId="site-origin-scheme"
                />
              </Field>
            </div>
            <Field data-invalid={hostInvalid || undefined}>
              <FieldLabel htmlFor="hostHeader">{m.site_form_host_header()}</FieldLabel>
              <Input
                id="hostHeader"
                name="hostHeader"
                maxLength={MAX_HOST_HEADER_LENGTH}
                placeholder={m.site_form_host_header_placeholder()}
                aria-invalid={hostInvalid || undefined}
                onChange={() => setHostInvalid(false)}
                data-testid="site-host-header"
              />
              {hostInvalid ? (
                <FieldError className="animate-in fade-in" data-testid="site-host-header-invalid">
                  {m.site_form_host_header_invalid()}
                </FieldError>
              ) : null}
            </Field>
            <FieldSeparator />
            <Field orientation="horizontal">
              <Switch id="cacheEnabled" checked={cacheEnabled} onCheckedChange={setCacheEnabled} />
              <FieldLabel htmlFor="cacheEnabled">{m.site_form_cache_enabled()}</FieldLabel>
            </Field>
            {cacheEnabled ? (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field>
                    <FieldLabel htmlFor="cachePrefix">{m.site_form_cache_prefix()}</FieldLabel>
                    <Input id="cachePrefix" name="cachePrefix" defaultValue="/" />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="cacheTtl">{m.site_form_cache_ttl()}</FieldLabel>
                    <Input
                      id="cacheTtl"
                      name="cacheTtl"
                      type="number"
                      min={0}
                      defaultValue={3600}
                    />
                  </Field>
                </div>
                <Field orientation="horizontal">
                  <Switch
                    id="respectOrigin"
                    checked={respectOrigin}
                    onCheckedChange={setRespectOrigin}
                  />
                  <FieldLabel htmlFor="respectOrigin">{m.site_form_respect_origin()}</FieldLabel>
                </Field>
              </>
            ) : null}
            {invalid || create.isError ? (
              <FieldError data-testid="site-form-error">
                {invalid ?? errorMessage(create.error)}
              </FieldError>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={pending} data-testid="create-site-submit">
                {pending ? <Spinner /> : null}
                {m.site_form_submit()}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
