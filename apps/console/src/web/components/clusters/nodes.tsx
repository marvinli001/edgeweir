import type { Cluster, Node } from "@edgeweir/contract";
import { Add01Icon, MoreHorizontalIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { type NodeAction, NodeActionDialog } from "@/components/clusters/node-dialogs";
import { type Columns, DataTable } from "@/components/data-table";
import { AuthErrorBadge, NodeDetailDialog, NodeLoad } from "@/components/node-detail";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useDialogState } from "@/hooks/use-dialog-state";
import { m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

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
  if (node.appliedRevision === 0)
    return node.online && node.status === "active" ? (
      <Badge variant="outline" data-testid="node-awaiting-config">
        {m.nodes_pending()}
      </Badge>
    ) : null;
  // A canary rollout gives each node its own target revision.
  return node.appliedRevision >= (node.targetRevision ?? latest) ? (
    <Badge variant="secondary" data-testid="node-up-to-date">
      {m.nodes_up_to_date()}
    </Badge>
  ) : (
    <Badge variant="outline">{m.nodes_behind()}</Badge>
  );
}

/**
 * A healthy data plane, or none yet: before its first configuration a node
 * serves nothing ("awaiting configuration" shows beside its revision).
 */
const servesOrStarts = (node: Node) => node.dataPlaneHealthy || node.appliedRevision === 0;

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

/**
 * The cluster's nodes. `detailId` is the node whose details are open (`onDetail` opens and closes
 * them); they come from the polling list so they stay current.
 */
export function NodesSection({
  cluster,
  onEnroll,
  detailId,
  onDetail: showDetail,
}: {
  cluster: Cluster;
  onEnroll: () => void;
  detailId: string | undefined;
  onDetail: (id: string | null) => void;
}) {
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: { clusterId: cluster.id } }),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const action = useDialogState<NodeAction>();
  const latest = cluster.latestRevision?.revision ?? 0;
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
          ) : !row.original.lastSeenAt ? (
            // Enrolled, never connected since: the agent is still starting.
            <StatusDot tone="idle" pulse data-testid="node-awaiting-heartbeat">
              {m.nodes_awaiting_heartbeat()}
            </StatusDot>
          ) : row.original.online ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusDot
                tone={servesOrStarts(row.original) ? "good" : "warn"}
                pulse={servesOrStarts(row.original)}
                data-testid="node-online"
              >
                {m.nodes_online()}
              </StatusDot>
              {servesOrStarts(row.original) ? null : (
                <Badge variant="destructive" data-testid="node-unhealthy">
                  {m.nodes_unhealthy()}
                </Badge>
              )}
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-1.5">
              <StatusDot tone="bad" data-testid="node-offline">
                {m.nodes_offline()}
              </StatusDot>
              <AuthErrorBadge node={row.original} />
            </span>
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
          <div className="flex flex-col items-start gap-1 font-mono text-xs">
            {row.original.ipAddresses.length
              ? row.original.ipAddresses.map((ip) => <span key={ip}>{ip}</span>)
              : "—"}
            {row.original.dnsIssue === "no_public_address" ? (
              <Badge variant="outline" className="font-sans" data-testid="node-dns-issue">
                {m.node_dns_no_public_address()}
              </Badge>
            ) : null}
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
            <NodeActions node={row.original} onAction={action.show} onDetail={showDetail} />
          </div>
        ),
      },
    ],
    [latest, showDetail, action.show],
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{m.nodes_title()}</h2>
      <QueryView
        query={nodes}
        empty={
          <EmptyState icon={ServerStack01Icon} title={m.nodes_empty_title()}>
            <Button onClick={onEnroll}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.nav_add_node()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          <DataTable data={list} columns={columns} getRowId={(n) => n.id} testId="nodes-table" />
        )}
      </QueryView>
      {action.value ? (
        <NodeActionDialog
          key={action.key}
          action={action.value}
          open={action.open}
          onOpenChange={action.onOpenChange}
        />
      ) : null}
      {detail ? <NodeDetailDialog node={detail} onClose={() => showDetail(null)} /> : null}
    </section>
  );
}
