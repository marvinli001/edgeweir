import type { Site } from "@edgeweir/contract";
import { Add01Icon, Delete02Icon, GlobeIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldSeparator,
} from "@/components/ui/field";
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
import { m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/sites")({
  validateSearch: z.object({ create: z.boolean().optional() }),
  component: SitesPage,
});

function cacheSummary(site: Site): string[] {
  if (site.cacheRules.length === 0) return [m.sites_no_cache_rules()];
  return site.cacheRules.map((r) => {
    const prefix = [...r.pathPrefixes, ...r.extensions.map((e) => `*.${e}`)].join(", ") || "/*";
    return r.action === "bypass"
      ? m.sites_cache_bypass({ prefix })
      : m.sites_cache_ttl({ prefix, ttl: r.edgeTtlSeconds });
  });
}

function SitesPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const queryClient = useQueryClient();
  const sites = useQuery(orpc.sites.list.queryOptions());
  const purge = useMutation(orpc.sites.purgeAll.mutationOptions());
  const remove = useMutation(orpc.sites.delete.mutationOptions());
  const setCreateOpen = (open: boolean) =>
    navigate({ search: { create: open || undefined }, replace: true });

  const columns = React.useMemo<Columns<Site>>(
    () => [
      {
        id: "name",
        header: () => m.sites_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium">{row.original.name}</span>
            <span className="text-xs text-muted-foreground">{timeAgo(row.original.createdAt)}</span>
          </div>
        ),
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
        id: "cache",
        header: () => m.sites_col_cache(),
        cell: ({ row }) => (
          <div className="flex flex-col text-xs text-muted-foreground">
            {cacheSummary(row.original).map((line) => (
              <span key={line}>{line}</span>
            ))}
          </div>
        ),
      },
      {
        id: "cluster",
        header: () => m.sites_col_cluster(),
        cell: ({ row }) => <Badge variant="secondary">{row.original.clusterName}</Badge>,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <ConfirmDialog
              trigger={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.sites_purge()}
                  title={m.sites_purge()}
                >
                  <HugeiconsIcon icon={RefreshIcon} strokeWidth={2} />
                </Button>
              }
              title={m.sites_purge()}
              description={row.original.domains.join(", ")}
              onConfirm={async () => {
                try {
                  const result = await purge.mutateAsync({ id: row.original.id });
                  toast.success(m.sites_purged({ revision: result.revision.revision }));
                  await queryClient.invalidateQueries();
                } catch (error) {
                  toast.error(errorMessage(error, m.common_unknown_error()));
                }
              }}
            />
            <ConfirmDialog
              trigger={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.common_delete()}
                  title={m.common_delete()}
                >
                  <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                </Button>
              }
              destructive
              title={m.common_delete()}
              description={m.sites_delete_confirm({ name: row.original.name })}
              confirmLabel={m.common_delete()}
              onConfirm={async () => {
                try {
                  const result = await remove.mutateAsync({ id: row.original.id });
                  toast.success(m.sites_deleted({ revision: result.revision.revision }));
                  await queryClient.invalidateQueries();
                } catch (error) {
                  toast.error(errorMessage(error, m.common_unknown_error()));
                }
              }}
            />
          </div>
        ),
      },
    ],
    [purge, remove, queryClient],
  );

  return (
    <Page
      title={m.sites_title()}
      description={m.sites_description()}
      actions={
        <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="new-site">
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.nav_new_site()}
        </Button>
      }
    >
      {sites.isPending ? (
        <LoadingState />
      ) : sites.isError ? (
        <ErrorState error={sites.error} onRetry={() => sites.refetch()} />
      ) : sites.data.length === 0 ? (
        <EmptyState
          icon={GlobeIcon}
          title={m.sites_empty_title()}
          description={m.sites_empty_description()}
        >
          <Button onClick={() => setCreateOpen(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_new_site()}
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          data={sites.data}
          columns={columns}
          getRowId={(s) => s.id}
          testId="sites-table"
        />
      )}
      <CreateSiteDialog open={search.create === true} onOpenChange={setCreateOpen} />
    </Page>
  );
}

function CreateSiteDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.sites.create.mutationOptions());
  const [scheme, setScheme] = React.useState<"http" | "https">("http");
  const [cacheEnabled, setCacheEnabled] = React.useState(true);
  const [respectOrigin, setRespectOrigin] = React.useState(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) create.reset();
        onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{m.site_form_title()}</DialogTitle>
          <DialogDescription>{m.site_form_description()}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            const data = new FormData(event.currentTarget);
            const text = (key: string) => String(data.get(key) ?? "").trim();
            try {
              const result = await create.mutateAsync({
                name: text("name"),
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
              toast.success(m.site_form_created({ revision: result.revision.revision }));
              await queryClient.invalidateQueries();
              onOpenChange(false);
            } catch {
              // rendered below via create.error
            }
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="name">{m.site_form_name()}</FieldLabel>
              <Input id="name" name="name" required maxLength={100} placeholder="demo" />
            </Field>
            <Field>
              <FieldLabel htmlFor="domains">{m.site_form_domains()}</FieldLabel>
              <Textarea id="domains" name="domains" required rows={2} placeholder="demo.test" />
              <FieldDescription>{m.site_form_domains_hint()}</FieldDescription>
            </Field>
            <div className="grid gap-4 sm:grid-cols-[1fr_7rem_8rem]">
              <Field>
                <FieldLabel htmlFor="origin">{m.site_form_origin()}</FieldLabel>
                <Input id="origin" name="origin" required placeholder="10.0.0.10" />
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
              <Input id="hostHeader" name="hostHeader" maxLength={253} />
              <FieldDescription>{m.site_form_host_header_hint()}</FieldDescription>
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
              <FieldError data-testid="site-form-error">
                {errorMessage(create.error, m.common_unknown_error())}
              </FieldError>
            ) : null}
            <DialogFooter>
              <Button type="submit" disabled={create.isPending} data-testid="create-site-submit">
                {create.isPending ? <Spinner /> : null}
                {m.site_form_submit()}
              </Button>
            </DialogFooter>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
