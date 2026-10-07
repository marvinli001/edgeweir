import type { L4App } from "@edgeweir/contract";
import { Add01Icon, ArrowDataTransferHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQueries, useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { type Columns, DataTable } from "@/components/data-table";
import { FilterSelect } from "@/components/form-select";
import { L4AppActions, L4EnabledSwitch } from "@/components/l4/app-actions";
import { L4AppDialog } from "@/components/l4/app-dialog";
import { DnsTarget, L4NodesWarning, ProtocolBadge } from "@/components/l4/common";
import { Page } from "@/components/page";
import { SitesTabs } from "@/components/sites-tabs";
import { EmptyState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDialogState } from "@/hooks/use-dialog-state";
import { m } from "@/lib/i18n";
import { originLabel, portsLabel } from "@/lib/l4";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/l4/")({
  validateSearch: z.object({
    cluster: z.string().optional(),
    create: z.boolean().optional(),
  }),
  component: L4AppsPage,
});

function L4AppsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const apps = useQuery({
    ...orpc.l4Apps.list.queryOptions({ input: { clusterId: search.cluster } }),
    placeholderData: keepPreviousData,
  });
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const edit = useDialogState<L4App>();
  const setCreateOpen = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, create: open || undefined }), replace: true });

  // Clusters whose nodes cannot forward layer 4 yet, among those the list shows.
  const clusterIds = [
    ...new Set([
      ...(search.cluster ? [search.cluster] : []),
      ...(apps.data ?? []).map((app) => app.clusterId),
    ]),
  ];
  const pools = useQueries({
    queries: clusterIds.map((clusterId) => ({
      ...orpc.clusters.portPools.queryOptions({ input: { clusterId } }),
      meta: { background: true },
    })),
  });
  const clusterName = (id: string) =>
    clusters.data?.find((c) => c.id === id)?.name ??
    apps.data?.find((app) => app.clusterId === id)?.clusterName ??
    "";

  const columns = React.useMemo<Columns<L4App>>(
    () => [
      {
        id: "name",
        header: () => m.site_form_name(),
        cell: ({ row }) => (
          <div className="flex max-w-56 min-w-0 flex-col">
            <Link
              to="/l4/$id"
              params={{ id: row.original.id }}
              className="truncate font-medium underline-offset-4 hover:underline"
              title={row.original.name}
              data-testid="l4-app-link"
            >
              {row.original.name}
            </Link>
            <span className="truncate text-xs text-muted-foreground" data-testid="l4-app-cluster">
              {row.original.clusterName}
            </span>
          </div>
        ),
      },
      {
        id: "protocol",
        header: () => m.l4_protocol(),
        cell: ({ row }) => <ProtocolBadge protocol={row.original.protocol} />,
      },
      {
        id: "port",
        header: () => m.l4_port(),
        cell: ({ row }) => (
          <span className="font-mono tabular-nums" data-testid="l4-app-port">
            {portsLabel(row.original)}
          </span>
        ),
      },
      {
        id: "origins",
        header: () => m.sites_col_origins(),
        cell: ({ row }) => {
          const origins = row.original.origins;
          const [first] = origins;
          return (
            <span
              className="flex min-w-0 items-center gap-1.5"
              title={origins.map(originLabel).join("\n")}
              data-testid="l4-app-origins"
              data-count={origins.length}
            >
              <Badge variant="outline" className="tabular-nums">
                {origins.length}
              </Badge>
              {first ? (
                <span className="max-w-40 truncate font-mono text-xs text-muted-foreground">
                  {originLabel(first)}
                </span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: "dns",
        header: () => m.dns_cname_target(),
        cell: ({ row }) => (
          <div className="max-w-56">
            <DnsTarget target={row.original.dnsTarget} testId="l4-app-dns" />
          </div>
        ),
      },
      {
        id: "enabled",
        header: () => m.l4_enabled(),
        cell: ({ row }) => <L4EnabledSwitch app={row.original} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <L4AppActions app={row.original} onEdit={edit.show} />
          </div>
        ),
      },
    ],
    [edit.show],
  );

  const create = (
    <Button
      size="sm"
      onClick={() => setCreateOpen(true)}
      disabled={!clusters.data?.length}
      data-testid="l4-create"
    >
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {m.l4_create()}
    </Button>
  );

  return (
    <Page title={m.l4_title()} actions={create}>
      <div className="flex flex-wrap items-center gap-2">
        <SitesTabs value="l4" />
        {clusters.data && clusters.data.length > 1 ? (
          <FilterSelect
            value={search.cluster}
            onChange={(cluster) =>
              navigate({ search: (prev) => ({ ...prev, cluster }), replace: true })
            }
            allLabel={m.sites_all_clusters()}
            options={clusters.data.map((c) => ({ label: c.name, value: c.id }))}
            label={m.sites_col_cluster()}
            testId="l4-cluster-filter"
            className="w-44 sm:ml-auto"
          />
        ) : null}
      </div>
      {pools.map((query, index) =>
        query.data ? (
          <L4NodesWarning
            key={clusterIds[index]}
            cluster={clusterName(query.data.clusterId)}
            nodes={query.data.nodesWithoutL4}
          />
        ) : null,
      )}
      <QueryView
        query={apps}
        empty={
          <EmptyState icon={ArrowDataTransferHorizontalIcon} title={m.l4_empty_title()}>
            <Button onClick={() => setCreateOpen(true)} disabled={!clusters.data?.length}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.l4_create()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          <DataTable
            data={list}
            columns={columns}
            getRowId={(app) => app.id}
            testId="l4-apps-table"
          />
        )}
      </QueryView>
      <L4AppDialog
        open={search.create === true}
        onOpenChange={setCreateOpen}
        clusters={clusters.data ?? []}
        clusterId={search.cluster}
      />
      {edit.value ? (
        <L4AppDialog
          key={edit.key}
          open={edit.open}
          onOpenChange={edit.onOpenChange}
          app={edit.value}
          clusters={clusters.data ?? []}
        />
      ) : null}
    </Page>
  );
}
