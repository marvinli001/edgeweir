import type { Site } from "@edgeweir/contract";
import { Add01Icon, GlobeIcon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { type Columns, DataTable } from "@/components/data-table";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { SearchBox } from "@/components/search-box";
import { StarButton, useSiteStars } from "@/components/site-star";
import { SiteStatus } from "@/components/site-status";
import { SitesTabs } from "@/components/sites-tabs";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useOpenKey } from "@/hooks/use-open-key";
import { m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

const PAGE_SIZE = 20;
const ALL = "__all__";

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
  });
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const setCreateOpen = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, create: open || undefined }), replace: true });
  const filtered = !!search.q || !!search.cluster;

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
    [starredIds, pendingId, toggle],
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
          <Select
            value={search.cluster ?? ALL}
            onValueChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  cluster: !value || value === ALL ? undefined : String(value),
                  page: undefined,
                }),
                replace: true,
              })
            }
            items={[
              { label: m.sites_all_clusters(), value: ALL },
              ...clusters.data.map((c) => ({ label: c.name, value: c.id })),
            ]}
          >
            <SelectTrigger
              className="w-44"
              aria-label={m.sites_col_cluster()}
              data-testid="cluster-filter"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>{m.sites_all_clusters()}</SelectItem>
              {clusters.data.map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      {sites.isPending ? (
        <LoadingState />
      ) : sites.isLoadingError ? (
        <ErrorState error={sites.error} onRetry={() => sites.refetch()} />
      ) : sites.data.total === 0 ? (
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
      ) : (
        <>
          <DataTable
            data={sites.data.items}
            columns={columns}
            getRowId={(s) => s.id}
            testId="sites-table"
          />
          <Pager
            page={page}
            pageSize={PAGE_SIZE}
            total={sites.data.total}
            onPageChange={(next) => navigate({ search: (prev) => ({ ...prev, page: next }) })}
          />
        </>
      )}
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
  const [cacheEnabled, setCacheEnabled] = React.useState(true);
  const [respectOrigin, setRespectOrigin] = React.useState(true);
  const [navigating, setNavigating] = React.useState(false);
  const [clusterId, setClusterId] = React.useState(initialClusterId);
  const cluster = clusters.some((c) => c.id === clusterId) ? clusterId : clusters[0]?.id;
  const pending = create.isPending || navigating;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
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
            let siteId: string;
            try {
              const result = await create.mutateAsync({
                name: text("siteName"),
                clusterId: clusters.length > 1 ? cluster : undefined,
                domains: text("domains")
                  .split(/[\s,]+/)
                  .filter(Boolean),
                origins: [
                  {
                    address: text("origin"),
                    port: Number(text("port") || (scheme === "https" ? 443 : 80)),
                    scheme,
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
              });
              siteId = result.site.id;
              toast.success(m.site_form_created({ revision: result.revision.revision }));
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
              <Input id="siteName" name="siteName" required maxLength={100} placeholder="demo" />
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
              />
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem_8rem]">
              <Field>
                <FieldLabel htmlFor="origin">{m.site_form_origin()}</FieldLabel>
                <Input id="origin" name="origin" required placeholder="origin.example.com" />
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
                />
              </Field>
              <Field>
                <FieldLabel>{m.site_form_scheme()}</FieldLabel>
                <Select
                  value={scheme}
                  onValueChange={(v) => v && setScheme(v as "http" | "https")}
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
            </div>
            <Field>
              <FieldLabel htmlFor="hostHeader">{m.site_form_host_header()}</FieldLabel>
              <Input
                id="hostHeader"
                name="hostHeader"
                maxLength={253}
                placeholder={m.site_form_host_header_placeholder()}
              />
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
            {create.isError ? (
              <FieldError data-testid="site-form-error">{errorMessage(create.error)}</FieldError>
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
