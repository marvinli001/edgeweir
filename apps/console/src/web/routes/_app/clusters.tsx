import type {
  Cluster,
  EnrollmentTokenResult,
  Node,
  NodeGroup,
  Region,
  Revision,
} from "@edgeweir/contract";
import {
  Add01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { Countdown } from "@/components/appica/countdown";
import { ClusterRolloutCard } from "@/components/cluster-rollout";
import { ConfirmDialog, ControlledConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { type Columns, DataTable } from "@/components/data-table";
import { ClusterDns } from "@/components/dns/cluster-dns";
import { FormDialog } from "@/components/form-dialog";
import { PortPoolsSection } from "@/components/l4/port-pools";
import { NodeDetailDialog, NodeLoad } from "@/components/node-detail";
import { NodeUpgrades } from "@/components/node-upgrades";
import { Page } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { ClusterScheduling } from "@/components/scheduling";
import { SwitchField } from "@/components/site/fields";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Dot, StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatDateTime, formatNumber, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { revisionReason } from "@/lib/revisions";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_app/clusters")({
  validateSearch: z.object({
    cluster: z.string().optional(),
    enroll: z.boolean().optional(),
    tab: z.enum(["overview", "dns", "scheduling", "ports"]).optional(),
    node: z.string().optional(),
  }),
  component: ClustersPage,
});

const NO_REGION = "__none__";

function ClustersPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [createOpen, setCreateOpen] = React.useState(false);
  const clusters = useQuery({
    ...orpc.clusters.list.queryOptions(),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const selected = clusters.data?.find((c) => c.id === search.cluster) ?? clusters.data?.[0];

  const setEnrollOpen = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, enroll: open || undefined }), replace: true });

  return (
    <Page
      title={m.clusters_title()}
      actions={
        <>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setCreateOpen(true)}
            data-testid="create-cluster"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.clusters_create()}
          </Button>
          {selected ? (
            <Button size="sm" onClick={() => setEnrollOpen(true)} data-testid="add-node">
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.nav_add_node()}
            </Button>
          ) : null}
        </>
      }
    >
      {clusters.isPending ? (
        <LoadingState />
      ) : clusters.isError ? (
        <ErrorState error={clusters.error} onRetry={() => clusters.refetch()} />
      ) : !selected ? (
        <EmptyState icon={ServerStack01Icon} title={m.clusters_empty_title()}>
          <Button onClick={() => setCreateOpen(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.clusters_create()}
          </Button>
        </EmptyState>
      ) : (
        <>
          <ClusterSummary
            clusters={clusters.data}
            selected={selected}
            onSelect={(id) => navigate({ search: (prev) => ({ ...prev, cluster: id }) })}
          />
          <Tabs
            value={search.tab ?? "overview"}
            onValueChange={(value) =>
              navigate({
                search: (prev) => ({
                  ...prev,
                  tab:
                    value === "dns" || value === "scheduling" || value === "ports"
                      ? value
                      : undefined,
                }),
                replace: true,
              })
            }
          >
            <TabsList className="max-w-full justify-start overflow-x-auto">
              <TabsTrigger value="overview" data-testid="cluster-tab-overview">
                {m.dns_tab_overview()}
              </TabsTrigger>
              <TabsTrigger value="dns" data-testid="cluster-tab-dns">
                {m.dns_tab_dns()}
              </TabsTrigger>
              <TabsTrigger value="scheduling" data-testid="cluster-tab-scheduling">
                {m.scheduling_tab()}
              </TabsTrigger>
              <TabsTrigger value="ports" data-testid="cluster-tab-ports">
                {m.l4_pools_title()}
              </TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="flex flex-col gap-4 animate-enter">
              <NodeGroupsSection cluster={selected} />
              <NodesSection cluster={selected} onEnroll={() => setEnrollOpen(true)} />
              <ClusterRolloutCard key={`rollout-${selected.id}`} clusterId={selected.id} />
              <NodeUpgrades key={selected.id} clusterId={selected.id} />
              <RevisionsSection cluster={selected} />
            </TabsContent>
            <TabsContent value="dns" className="animate-enter">
              <ClusterDns key={selected.id} clusterId={selected.id} />
            </TabsContent>
            <TabsContent value="scheduling" className="animate-enter">
              <ClusterScheduling key={selected.id} clusterId={selected.id} />
            </TabsContent>
            <TabsContent value="ports" className="animate-enter">
              <PortPoolsSection
                key={selected.id}
                clusterId={selected.id}
                clusterName={selected.name}
              />
            </TabsContent>
          </Tabs>
          <EnrollDialog
            cluster={selected}
            open={search.enroll === true}
            onOpenChange={setEnrollOpen}
          />
        </>
      )}
      <ClusterDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSaved={(cluster) => navigate({ search: (prev) => ({ ...prev, cluster: cluster.id }) })}
      />
    </Page>
  );
}

/** Create a cluster, or rename one when `cluster` is given. */
function ClusterDialog({
  cluster,
  open,
  onOpenChange,
  onSaved,
}: {
  cluster?: Cluster;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (cluster: Cluster) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.clusters.create.mutationOptions());
  const update = useMutation(orpc.clusters.update.mutationOptions());
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={cluster ? m.clusters_edit() : m.clusters_create()}
      submitLabel={cluster ? m.common_save() : m.common_create()}
      submitTestId="cluster-submit"
      onSubmit={async (data) => {
        const input = {
          name: String(data.get("clusterName") ?? "").trim(),
          description: String(data.get("clusterDescription") ?? "").trim(),
        };
        const saved = cluster
          ? await update.mutateAsync({ id: cluster.id, ...input })
          : await create.mutateAsync(input);
        await queryClient.invalidateQueries();
        toast.success(m.common_saved());
        onSaved?.(saved);
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="clusterName">{m.clusters_name()}</FieldLabel>
        <Input
          id="clusterName"
          name="clusterName"
          required
          maxLength={64}
          pattern="[a-z0-9][a-z0-9\-]*"
          defaultValue={cluster?.name}
          placeholder="edge-cn"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="clusterDescription">{m.clusters_description()}</FieldLabel>
        <Input
          id="clusterDescription"
          name="clusterDescription"
          maxLength={500}
          defaultValue={cluster?.description}
        />
      </Field>
    </FormDialog>
  );
}

/** One labeled figure of the cluster summary strip. */
function SummaryStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 px-4 py-3">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="flex items-center gap-2 text-xl font-semibold tracking-tight">{children}</dd>
    </div>
  );
}

function ClusterSummary({
  clusters,
  selected,
  onSelect,
}: {
  clusters: Cluster[];
  selected: Cluster;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const remove = useMutation(orpc.clusters.delete.mutationOptions());
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="flex-1" data-testid="cluster-name">
          {selected.name}
        </CardTitle>
        <div className="flex items-center gap-2">
          {clusters.length > 1 ? (
            <Select
              value={selected.id}
              onValueChange={(value) => value && onSelect(String(value))}
              items={clusters.map((c) => ({ label: c.name, value: c.id }))}
            >
              <SelectTrigger
                className="w-48"
                aria-label={m.clusters_select()}
                data-testid="cluster-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {clusters.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.common_actions()}
                  data-testid="cluster-actions"
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                {m.clusters_edit()}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
                data-testid="cluster-delete"
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                {m.common_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent>
        <dl className="grid grid-cols-3 divide-x overflow-hidden rounded-xl border">
          <SummaryStat label={m.clusters_nodes_online()}>
            <Dot
              tone={
                selected.nodeCount === 0
                  ? "idle"
                  : selected.onlineNodeCount < selected.nodeCount
                    ? "bad"
                    : "good"
              }
            />
            <span data-testid="cluster-nodes-online">
              {selected.onlineNodeCount}/{selected.nodeCount}
            </span>
          </SummaryStat>
          <SummaryStat label={m.clusters_sites()}>{formatNumber(selected.siteCount)}</SummaryStat>
          <SummaryStat label={m.clusters_latest_revision()}>
            <span
              className={cn(selected.latestRevision && "font-mono")}
              data-testid="cluster-latest-revision"
            >
              {selected.latestRevision
                ? `#${selected.latestRevision.revision}`
                : m.clusters_no_revision()}
            </span>
          </SummaryStat>
        </dl>
      </CardContent>
      <ClusterDialog
        key={selected.id}
        cluster={selected}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <ControlledConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={m.clusters_delete_confirm({ name: selected.name })}
        onConfirm={async () => {
          await remove.mutateAsync({ id: selected.id });
          toast.success(m.common_deleted());
          await queryClient.invalidateQueries();
          const next = clusters.find((c) => c.id !== selected.id);
          if (next) onSelect(next.id);
        }}
      />
    </Card>
  );
}

function RegionSelect({
  regions,
  value,
  onChange,
}: {
  regions: Region[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const items = [
    { label: m.node_groups_no_region(), value: NO_REGION },
    ...regions.map((r) => ({ label: `${r.name} (${r.code})`, value: r.id })),
  ];
  return (
    <Select
      value={value ?? NO_REGION}
      onValueChange={(v) => onChange(!v || v === NO_REGION ? null : String(v))}
      items={items}
    >
      <SelectTrigger
        className="w-full"
        aria-label={m.node_groups_region()}
        data-testid="region-select"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function NodeGroupDialog({
  cluster,
  group,
  open,
  onOpenChange,
}: {
  cluster: Cluster;
  group?: NodeGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const regions = useQuery({ ...orpc.regions.list.queryOptions(), enabled: open });
  const create = useMutation(orpc.nodeGroups.create.mutationOptions());
  const update = useMutation(orpc.nodeGroups.update.mutationOptions());
  const [regionId, setRegionId] = React.useState<string | null>(group?.regionId ?? null);
  const [isCanary, setIsCanary] = React.useState(group?.isCanary ?? false);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={group ? m.node_groups_edit() : m.node_groups_create()}
      submitLabel={group ? m.common_save() : m.common_create()}
      submitTestId="node-group-submit"
      onSubmit={async (data) => {
        const name = String(data.get("groupName") ?? "").trim();
        if (group) await update.mutateAsync({ id: group.id, name, regionId, isCanary });
        else await create.mutateAsync({ clusterId: cluster.id, name, regionId, isCanary });
        await queryClient.invalidateQueries();
        toast.success(m.common_saved());
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="groupName">{m.node_groups_name()}</FieldLabel>
        <Input
          id="groupName"
          name="groupName"
          required
          maxLength={64}
          defaultValue={group?.name}
          placeholder="shanghai"
        />
      </Field>
      <Field>
        <FieldLabel>{m.node_groups_region()}</FieldLabel>
        <RegionSelect regions={regions.data ?? []} value={regionId} onChange={setRegionId} />
      </Field>
      <SwitchField
        id="groupCanary"
        label={m.node_groups_canary_label()}
        checked={isCanary}
        onCheckedChange={setIsCanary}
        className="self-start"
        testId="node-group-canary"
      />
    </FormDialog>
  );
}

/**
 * Delete with confirmation. The row actions of the tables below are components
 * of their own so that the table's cell renderers keep their identity: a new
 * renderer per render would remount the cell and close an open dialog or menu
 * whenever the section re-renders (the node list polls).
 */
function DeleteNodeGroupAction({ group }: { group: NodeGroup }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.nodeGroups.delete.mutationOptions());
  return (
    <ConfirmDialog
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label={m.common_delete()}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      }
      destructive
      title={m.node_groups_delete_confirm({ name: group.name })}
      confirmLabel={m.common_delete()}
      onConfirm={async () => {
        try {
          await remove.mutateAsync({ id: group.id });
          await queryClient.invalidateQueries();
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }}
    />
  );
}

function NodeGroupsSection({ cluster }: { cluster: Cluster }) {
  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: { clusterId: cluster.id } }));
  const [createOpen, setCreateOpen] = React.useState(false);
  const [editing, setEditing] = React.useState<NodeGroup | null>(null);
  const columns = React.useMemo<Columns<NodeGroup>>(
    () => [
      {
        id: "name",
        header: () => m.node_groups_name(),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium" data-testid="node-group-name">
              {row.original.name}
            </span>
            {row.original.isDefault ? (
              <Badge variant="outline">{m.node_groups_default()}</Badge>
            ) : null}
            {row.original.isCanary ? (
              <Badge variant="secondary" data-testid="node-group-canary-badge">
                {m.node_groups_canary()}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: "region",
        header: () => m.node_groups_region(),
        cell: ({ row }) =>
          row.original.regionName ? (
            <Badge variant="secondary">
              {row.original.regionName} · {row.original.regionCode}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "nodes",
        header: () => m.node_groups_nodes(),
        cell: ({ row }) => <span className="tabular-nums">{row.original.nodeCount}</span>,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.node_groups_edit()}
              onClick={() => setEditing(row.original)}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            </Button>
            {row.original.isDefault ? null : <DeleteNodeGroupAction group={row.original} />}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">{m.node_groups_title()}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCreateOpen(true)}
          data-testid="create-node-group"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.node_groups_create()}
        </Button>
      </div>
      {groups.isPending ? (
        <LoadingState />
      ) : groups.isError ? (
        <ErrorState error={groups.error} onRetry={() => groups.refetch()} />
      ) : (
        <DataTable
          data={groups.data}
          columns={columns}
          getRowId={(g) => g.id}
          testId="node-groups-table"
        />
      )}
      <NodeGroupDialog
        key={`create-${cluster.id}`}
        cluster={cluster}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      {editing ? (
        <NodeGroupDialog
          key={editing.id}
          cluster={cluster}
          group={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
    </section>
  );
}

function RevisionBadge({ node, latest }: { node: Node; latest: number }) {
  if (node.upgradeRequired) {
    return (
      <Badge variant="outline" data-testid="node-upgrade-required">
        {m.node_upgrade_required()}
      </Badge>
    );
  }
  if (node.applyState === "failed") {
    return (
      <Badge variant="destructive" title={node.applyMessage}>
        {m.nodes_apply_failed()}
      </Badge>
    );
  }
  if (node.appliedRevision === 0) return null;
  // A canary rollout gives each node its own target revision.
  return node.appliedRevision >= (node.targetRevision ?? latest) ? (
    <Badge variant="secondary" data-testid="node-up-to-date">
      {m.nodes_up_to_date()}
    </Badge>
  ) : (
    <Badge variant="outline">{m.nodes_behind()}</Badge>
  );
}

type NodeAction = { kind: "rename" | "move" | "delete"; node: Node };

function NodeActions({
  node,
  onAction,
  onDetail,
}: {
  node: Node;
  onAction: (action: NodeAction) => void;
  onDetail: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const disable = useMutation(orpc.nodes.disable.mutationOptions());
  const enable = useMutation(orpc.nodes.enable.mutationOptions());
  const toggle = async () => {
    try {
      if (node.status === "disabled") await enable.mutateAsync({ id: node.id });
      else await disable.mutateAsync({ id: node.id });
      await queryClient.invalidateQueries();
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={m.common_actions()}
            data-testid="node-actions"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => onDetail(node.id)} data-testid="node-details">
          {m.nodes_details()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction({ kind: "rename", node })}>
          {m.nodes_rename()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => onAction({ kind: "move", node })} data-testid="node-move">
          {m.nodes_move()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={toggle} data-testid="node-toggle">
          {node.status === "disabled" ? m.nodes_enable() : m.nodes_disable()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" onClick={() => onAction({ kind: "delete", node })}>
          {m.common_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function NodesSection({ cluster, onEnroll }: { cluster: Cluster; onEnroll: () => void }) {
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: { clusterId: cluster.id } }),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const [action, setAction] = React.useState<NodeAction | null>(null);
  const latest = cluster.latestRevision?.revision ?? 0;
  // The node whose details are open (?node=), from the polling list so they stay current.
  const detailId = Route.useSearch({ select: (search) => search.node });
  const navigate = Route.useNavigate();
  const showDetail = React.useCallback(
    (id: string | null) =>
      navigate({ search: (prev) => ({ ...prev, node: id ?? undefined }), replace: true }),
    [navigate],
  );
  const detail = detailId ? nodes.data?.find((n) => n.id === detailId) : undefined;
  const columns = React.useMemo<Columns<Node>>(
    () => [
      {
        id: "name",
        header: () => m.nodes_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <button
              type="button"
              className="flex w-fit items-center gap-1.5 text-left font-medium underline-offset-4 hover:underline"
              onClick={() => showDetail(row.original.id)}
              data-testid="node-open"
            >
              <span data-testid="node-name">{row.original.name}</span>
              {row.original.probeEnabled ? (
                <Badge variant="outline" data-testid="node-probe-badge">
                  {m.node_probe_switch()}
                </Badge>
              ) : null}
            </button>
            <span className="text-xs text-muted-foreground">{row.original.hostname}</span>
          </div>
        ),
      },
      {
        id: "status",
        header: () => m.nodes_col_status(),
        cell: ({ row }) =>
          row.original.status === "disabled" ? (
            <StatusDot tone="idle" data-testid="node-disabled">
              {m.nodes_disabled()}
            </StatusDot>
          ) : row.original.online ? (
            <StatusDot tone="good" pulse data-testid="node-online">
              {m.nodes_online()}
            </StatusDot>
          ) : (
            <StatusDot tone="bad" data-testid="node-offline">
              {m.nodes_offline()}
            </StatusDot>
          ),
      },
      {
        id: "group",
        header: () => m.nodes_col_group(),
        cell: ({ row }) => (
          <div className="flex flex-col text-xs">
            <span data-testid="node-group">{row.original.nodeGroupName ?? "—"}</span>
            {row.original.regionName ? (
              <span className="text-muted-foreground">{row.original.regionName}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: "ips",
        header: () => m.nodes_col_ips(),
        cell: ({ row }) => (
          <div className="flex flex-col font-mono text-xs">
            {row.original.ipAddresses.length
              ? row.original.ipAddresses.map((ip) => <span key={ip}>{ip}</span>)
              : "—"}
          </div>
        ),
      },
      {
        id: "metrics",
        header: () => m.node_metrics_title(),
        cell: ({ row }) => <NodeLoad node={row.original} />,
      },
      {
        id: "revision",
        header: () => m.nodes_col_revision(),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-mono" data-testid="node-applied-revision">
              #{row.original.appliedRevision}
            </span>
            <RevisionBadge node={row.original} latest={latest} />
          </div>
        ),
      },
      {
        id: "agent",
        header: () => m.nodes_col_agent(),
        cell: ({ row }) => (
          <div className="flex flex-col text-xs text-muted-foreground">
            <span>{row.original.agentVersion || "—"}</span>
            <span>
              {row.original.engine} {row.original.engineVersion}
            </span>
          </div>
        ),
      },
      {
        id: "lastSeen",
        header: () => m.nodes_col_last_seen(),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{timeAgo(row.original.lastSeenAt)}</span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <NodeActions node={row.original} onAction={setAction} onDetail={showDetail} />
          </div>
        ),
      },
    ],
    [latest, showDetail],
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{m.nodes_title()}</h2>
      {nodes.isPending ? (
        <LoadingState />
      ) : nodes.isError ? (
        <ErrorState error={nodes.error} onRetry={() => nodes.refetch()} />
      ) : nodes.data.length === 0 ? (
        <EmptyState icon={ServerStack01Icon} title={m.nodes_empty_title()}>
          <Button onClick={onEnroll}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_add_node()}
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          data={nodes.data}
          columns={columns}
          getRowId={(n) => n.id}
          testId="nodes-table"
        />
      )}
      {action?.kind === "rename" ? (
        <RenameNodeDialog node={action.node} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === "move" ? (
        <MoveNodeDialog node={action.node} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === "delete" ? (
        <DeleteNodeDialog node={action.node} onClose={() => setAction(null)} />
      ) : null}
      {detail ? <NodeDetailDialog node={detail} onClose={() => showDetail(null)} /> : null}
    </section>
  );
}

function RenameNodeDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.nodes.update.mutationOptions());
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.nodes_rename()}
      submitLabel={m.common_save()}
      onSubmit={async (data) => {
        await update.mutateAsync({
          id: node.id,
          name: String(data.get("nodeNewName") ?? "").trim(),
        });
        await queryClient.invalidateQueries();
        onClose();
      }}
    >
      <Field>
        <FieldLabel htmlFor="nodeNewName">{m.nodes_col_name()}</FieldLabel>
        <Input
          id="nodeNewName"
          name="nodeNewName"
          required
          maxLength={64}
          defaultValue={node.name}
        />
      </Field>
    </FormDialog>
  );
}

function MoveNodeDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const queryClient = useQueryClient();
  const groups = useQuery(
    orpc.nodeGroups.list.queryOptions({ input: { clusterId: node.clusterId } }),
  );
  const update = useMutation(orpc.nodes.update.mutationOptions());
  const [groupId, setGroupId] = React.useState(node.nodeGroupId ?? "");
  const items = (groups.data ?? []).map((g) => ({
    label: g.regionName ? `${g.name} · ${g.regionName}` : g.name,
    value: g.id,
  }));
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.nodes_move_title({ name: node.name })}
      submitLabel={m.nodes_move()}
      submitTestId="move-submit"
      onSubmit={async () => {
        await update.mutateAsync({ id: node.id, nodeGroupId: groupId });
        await queryClient.invalidateQueries();
        toast.success(m.nodes_moved({ name: node.name }));
        onClose();
      }}
    >
      <Field>
        <FieldLabel>{m.nodes_col_group()}</FieldLabel>
        <Select value={groupId} onValueChange={(v) => v && setGroupId(String(v))} items={items}>
          <SelectTrigger className="w-full" data-testid="move-group-select">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {items.map((item) => (
              <SelectItem key={item.value} value={item.value}>
                {item.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FormDialog>
  );
}

function DeleteNodeDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.nodes.delete.mutationOptions());
  return (
    <ControlledConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.nodes_delete_confirm({ name: node.name })}
      onConfirm={async () => {
        await remove.mutateAsync({ id: node.id });
        await queryClient.invalidateQueries();
        toast.success(m.common_deleted());
      }}
    />
  );
}

function RollbackAction({ clusterId, revision }: { clusterId: string; revision: number }) {
  const queryClient = useQueryClient();
  const rollback = useMutation(orpc.clusters.rollback.mutationOptions());
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="ghost">
          {m.revisions_rollback()}
        </Button>
      }
      title={m.revisions_rollback()}
      note={m.revisions_rollback_confirm({ revision })}
      onConfirm={async () => {
        try {
          const result = await rollback.mutateAsync({ id: clusterId, revision });
          toast.success(m.revisions_rolled_back({ revision: result.revision }));
          await queryClient.invalidateQueries();
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }}
    />
  );
}

function RevisionsSection({ cluster }: { cluster: Cluster }) {
  const revisions = useQuery(orpc.clusters.revisions.queryOptions({ input: { id: cluster.id } }));
  const latest = cluster.latestRevision?.revision ?? 0;
  const columns = React.useMemo<Columns<Revision>>(
    () => [
      {
        id: "revision",
        header: () => m.revisions_col_revision(),
        cell: ({ row }) => <span className="font-mono">#{row.original.revision}</span>,
      },
      {
        id: "hash",
        header: () => m.revisions_col_hash(),
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground">
            {row.original.contentHash.slice(0, 16)}
          </code>
        ),
      },
      {
        id: "sites",
        header: () => m.revisions_col_sites(),
        cell: ({ row }) => row.original.siteCount,
      },
      {
        id: "reason",
        header: () => m.revisions_col_reason(),
        cell: ({ row }) => (
          <span className="text-sm" data-testid="revision-reason">
            {revisionReason(row.original)}
          </span>
        ),
      },
      {
        id: "time",
        header: () => m.revisions_col_time(),
        cell: ({ row }) => (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(row.original.createdAt)}
          >
            {timeAgo(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) =>
          row.original.revision === latest ? null : (
            <RollbackAction clusterId={cluster.id} revision={row.original.revision} />
          ),
      },
    ],
    [cluster.id, latest],
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{m.revisions_title()}</h2>
      {revisions.isPending ? (
        <LoadingState />
      ) : revisions.isError ? (
        <ErrorState error={revisions.error} onRetry={() => revisions.refetch()} />
      ) : revisions.data.length === 0 ? (
        <EmptyState title={m.revisions_empty()} />
      ) : (
        <DataTable
          data={revisions.data.slice(0, 20)}
          columns={columns}
          getRowId={(r) => String(r.revision)}
          testId="revisions-table"
        />
      )}
    </section>
  );
}

const TTL_OPTIONS = [15, 60, 24 * 60];

function EnrollDialog({
  cluster,
  open,
  onOpenChange,
}: {
  cluster: Cluster;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [ttl, setTtl] = React.useState(60);
  const [groupId, setGroupId] = React.useState<string>("");
  const [result, setResult] = React.useState<EnrollmentTokenResult | null>(null);
  const groups = useQuery({
    ...orpc.nodeGroups.list.queryOptions({ input: { clusterId: cluster.id } }),
    enabled: open,
  });
  const create = useMutation(orpc.clusters.createEnrollmentToken.mutationOptions());
  const ttlLabel = (minutes: number) =>
    minutes < 60
      ? m.enroll_ttl_minutes({ count: minutes })
      : m.enroll_ttl_hours({ count: minutes / 60 });
  const groupItems = (groups.data ?? []).map((g) => ({ label: g.name, value: g.id }));
  const selectedGroup = groupId || groups.data?.find((g) => g.isDefault)?.id || "";
  // Closing forgets the token: it is shown once.
  const setOpen = (next: boolean) => {
    if (!next) {
      setResult(null);
      create.reset();
    }
    onOpenChange(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.enroll_title()}</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <FieldLabel>{m.enroll_command()}</FieldLabel>
                <CodeBlock value={result.installCommand} testId="install-command" />
                {/* The countdown renders a <div>, which a SafetyNote <p> cannot hold. */}
                <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  <span title={formatDateTime(result.expiresAt)}>{m.enroll_expires_in()}</span>
                  <Countdown target={result.expiresAt} className="text-foreground" />
                  <span aria-hidden="true">·</span>
                  <SafetyNote data-testid="enroll-token-once">{m.enroll_shown_once()}</SafetyNote>
                </div>
              </Field>
              <Field>
                <FieldLabel>{m.enroll_ca_fingerprint()}</FieldLabel>
                <code className="rounded-xl bg-muted p-2 font-mono text-xs break-all">
                  {result.caSha256}
                </code>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button onClick={() => setOpen(false)} data-testid="enroll-close">
                {m.common_close()}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const data = new FormData(event.currentTarget);
              try {
                setResult(
                  await create.mutateAsync({
                    clusterId: cluster.id,
                    nodeGroupId: selectedGroup || undefined,
                    nodeName: String(data.get("enrollNodeName") ?? ""),
                    ttlMinutes: ttl,
                  }),
                );
              } catch {
                // rendered below via create.error
              }
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="enrollNodeName">{m.enroll_node_name()}</FieldLabel>
                {/* Not "nodeName": that would clobber HTMLFormElement.nodeName and break React events. */}
                <Input
                  id="enrollNodeName"
                  name="enrollNodeName"
                  maxLength={64}
                  placeholder="edge-sh-01"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel>{m.nodes_col_group()}</FieldLabel>
                  <Select
                    value={selectedGroup}
                    onValueChange={(value) => value && setGroupId(String(value))}
                    items={groupItems}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {groupItems.map((g) => (
                        <SelectItem key={g.value} value={g.value}>
                          {g.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel>{m.enroll_ttl()}</FieldLabel>
                  <Select
                    value={String(ttl)}
                    onValueChange={(value) => value && setTtl(Number(value))}
                    items={TTL_OPTIONS.map((v) => ({ label: ttlLabel(v), value: String(v) }))}
                  >
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {TTL_OPTIONS.map((v) => (
                        <SelectItem key={v} value={String(v)}>
                          {ttlLabel(v)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
              </div>
              {create.isError ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
              <DialogFooter>
                <Button
                  type="submit"
                  disabled={create.isPending}
                  data-testid="generate-install-command"
                >
                  {create.isPending ? <Spinner /> : null}
                  {m.enroll_generate()}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
