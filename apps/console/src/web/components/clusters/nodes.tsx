import { type Cluster, type Node, nodeUpgradeRecommended } from "@edgeweir/contract";
import { Add01Icon, MoreHorizontalIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { type NodeAction, NodeActionDialog } from "@/components/clusters/node-dialogs";
import { type Columns, DataTable } from "@/components/data-table";
import { NodeChannelBadge } from "@/components/node-channel-state";
import {
  AuthErrorBadge,
  CertificateFailuresBadge,
  LOAD_BAD,
  LOAD_WARN,
  memoryPercent,
  NodeDetailSheet,
  type NodeDetailTab,
} from "@/components/node-detail";
import { EmptyState, QueryView } from "@/components/states";
import { Dot, StatusDot } from "@/components/status-dot";
import { useDialogState } from "@/hooks/use-dialog-state";
import { formatBitRate, formatDateTime, formatPercent, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { rowLink, rowLinkButton } from "@/lib/row-link";
import { cn } from "@/lib/utils";

function RevisionBadge({ node, latest }: { node: Node; latest: number }) {
  if (node.upgradeRequired) {
    return (
      <Badge size="sm" tone="neutral" data-testid="node-upgrade-required">
        {m.node_upgrade_required()}
      </Badge>
    );
  }
  if (node.applyState === "failed") {
    return (
      <Badge size="sm" tone="danger" title={node.applyMessage}>
        {m.nodes_apply_failed()}
      </Badge>
    );
  }
  if (node.appliedRevision === 0)
    return node.online && node.status === "active" ? (
      <Badge size="sm" tone="neutral" data-testid="node-awaiting-config">
        {m.nodes_pending()}
      </Badge>
    ) : null;
  // A canary rollout gives each node its own target revision.
  return node.appliedRevision >= (node.targetRevision ?? latest) ? (
    <Badge size="sm" tone="neutral" data-testid="node-up-to-date">
      <Dot tone="good" small />
      {m.nodes_up_to_date()}
    </Badge>
  ) : (
    <Badge size="sm" tone="neutral" data-testid="node-behind">
      <Dot tone="warn" small />
      {m.nodes_behind()}
    </Badge>
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
  const meta = { invalidates: "all", toastError: true } as const;
  const disable = useMutation({ ...orpc.nodes.disable.mutationOptions(), meta });
  const enable = useMutation({ ...orpc.nodes.enable.mutationOptions(), meta });
  const toggle = () =>
    node.status === "disabled" ? enable.mutate({ id: node.id }) : disable.mutate({ id: node.id });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="icon-button"
            size="sm"
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

/** CPU or memory use, in words; a light from 75 % (warning) and 90 % (error), as on the meters. */
function LoadFigure({ label, value }: { label: string; value: number | null }) {
  const high = value !== null && value >= LOAD_WARN;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <span className="text-muted-foreground">{label}</span>
      {high ? <Dot tone={value >= LOAD_BAD ? "bad" : "warn"} small /> : null}
      <span className={cn("tabular-nums", high && "font-medium")}>
        {value === null ? "—" : formatPercent(value)}
      </span>
    </span>
  );
}

/** A node's CPU and memory use (its details carry the gauges, load and connections). */
function NodeLoad({ node }: { node: Node }) {
  const metrics = node.metrics;
  if (!metrics || !node.online) return <span className="text-muted-foreground">—</span>;
  return (
    <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs" data-testid="node-load">
      <LoadFigure label={m.node_metrics_cpu()} value={metrics.cpuPercent} />
      <LoadFigure label={m.node_metrics_memory()} value={memoryPercent(metrics)} />
    </span>
  );
}

/** The node's applied revision and how it stands against the cluster's. */
function NodeRevision({ node, latest }: { node: Node; latest: number }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-xs" data-testid="node-applied-revision">
        #{node.appliedRevision}
      </span>
      <RevisionBadge node={node} latest={latest} />
      <CertificateFailuresBadge node={node} />
    </span>
  );
}

/** The agent's version, whether it should be upgraded, and its channel. */
function NodeAgent({ node }: { node: Node }) {
  return (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span className="font-mono text-xs">{node.agentVersion || "—"}</span>
      {node.agentVersion &&
      !node.upgradeRequired &&
      nodeUpgradeRecommended(node.supportedFeatures) ? (
        <Badge
          size="sm"
          tone="neutral"
          title={m.node_upgrade_recommended_title()}
          data-testid="node-upgrade-recommended"
        >
          {m.node_upgrade_recommended()}
        </Badge>
      ) : null}
      <NodeChannelBadge status={node.channel} testId="node-channel-badge" />
    </span>
  );
}

/** A node's state in words, with its light (lit while it serves) and what is wrong with it. */
function NodeState({ node }: { node: Node }) {
  if (node.status === "disabled")
    return (
      <StatusDot tone="idle" data-testid="node-disabled">
        {m.nodes_disabled()}
      </StatusDot>
    );
  // Enrolled, never connected since: the agent is still starting.
  if (!node.lastSeenAt)
    return (
      <StatusDot tone="idle" pulse data-testid="node-awaiting-heartbeat">
        {m.nodes_awaiting_heartbeat()}
      </StatusDot>
    );
  if (node.online)
    return (
      <span className="flex flex-wrap items-center gap-1.5">
        <StatusDot
          tone={servesOrStarts(node) ? "good" : "warn"}
          glow={servesOrStarts(node)}
          data-testid="node-online"
        >
          {m.nodes_online()}
        </StatusDot>
        {servesOrStarts(node) ? null : (
          <Badge size="sm" tone="danger" data-testid="node-unhealthy">
            {m.nodes_unhealthy()}
          </Badge>
        )}
      </span>
    );
  return (
    <span className="flex flex-wrap items-center gap-1.5">
      <StatusDot tone="bad" data-testid="node-offline">
        {m.nodes_offline()}
      </StatusDot>
      <AuthErrorBadge node={node} />
    </span>
  );
}

/**
 * The cluster's nodes, one row each: name, state, group, load, revision and agent; a click
 * anywhere in a row opens the node's details (everything else about it). `detailId` is the node
 * whose details are open (`onDetail` opens and closes them) and `detailTab` their tab; they come
 * from the polling list so they stay current.
 */
export function NodesSection({
  cluster,
  heading = true,
  onEnroll,
  detailId,
  detailTab,
  onDetail: showDetail,
  onDetailTab,
}: {
  cluster: Cluster;
  /** The section's heading with the node count (off where a tab names it). */
  heading?: boolean;
  onEnroll: () => void;
  detailId: string | undefined;
  detailTab: NodeDetailTab | undefined;
  onDetail: (id: string | null) => void;
  onDetailTab: (tab: NodeDetailTab) => void;
}) {
  const nodes = useQuery({
    ...orpc.nodes.list.queryOptions({ input: { clusterId: cluster.id } }),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const action = useDialogState<NodeAction>();
  const latest = cluster.latestRevision?.revision ?? 0;
  const detail = detailId ? nodes.data?.find((n) => n.id === detailId) : undefined;
  const { show } = action;
  const columns = React.useMemo<Columns<Node>>(
    () => [
      {
        id: "name",
        stack: "lead",
        header: () => m.nodes_col_name(),
        cell: ({ row }) => (
          <div className="flex min-w-0 flex-col">
            <span className="flex min-w-0 items-center gap-1.5">
              <button
                type="button"
                className={cn(rowLinkButton, "truncate font-medium")}
                onClick={() => showDetail(row.original.id)}
                data-testid="node-open"
                {...rowLink}
              >
                <span data-testid="node-name">{row.original.name}</span>
              </button>
              {row.original.probeEnabled ? (
                <Badge size="sm" tone="neutral" data-testid="node-probe-badge">
                  {m.node_probe_switch()}
                </Badge>
              ) : null}
            </span>
            <span
              className="max-w-56 truncate font-mono text-xs text-muted-foreground"
              title={row.original.hostname}
            >
              {row.original.ipAddresses[0] ?? row.original.hostname}
            </span>
          </div>
        ),
      },
      {
        id: "state",
        stack: "aside",
        header: () => m.nodes_col_status(),
        cell: ({ row }) => (
          <span className="flex flex-col items-start gap-1">
            <NodeState node={row.original} />
            {row.original.dnsIssue === "no_public_address" ? (
              <Badge size="sm" tone="neutral" data-testid="node-dns-issue">
                {m.node_dns_no_public_address()}
              </Badge>
            ) : null}
          </span>
        ),
      },
      {
        id: "group",
        header: () => m.nodes_col_group(),
        cell: ({ row }) => (
          <span className="flex min-w-0 flex-col text-xs">
            <span className="truncate" data-testid="node-group">
              {row.original.nodeGroupName ?? "—"}
            </span>
            {row.original.regionName ? (
              <span className="truncate text-muted-foreground">{row.original.regionName}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: "load",
        header: () => m.nodes_col_load(),
        cell: ({ row }) => <NodeLoad node={row.original} />,
      },
      {
        id: "egress",
        hideBelow: "lg",
        header: () => m.node_metrics_egress(),
        cell: ({ row }) =>
          row.original.online && row.original.metrics ? (
            <span className="text-xs tabular-nums">
              {formatBitRate(row.original.metrics.egressBps / 8)}
            </span>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "revision",
        header: () => m.nodes_col_revision(),
        cell: ({ row }) => <NodeRevision node={row.original} latest={latest} />,
      },
      {
        id: "agent",
        hideBelow: "xl",
        header: () => m.nodes_col_agent(),
        cell: ({ row }) => <NodeAgent node={row.original} />,
      },
      {
        id: "seen",
        hideBelow: "xl",
        stack: "hide",
        header: () => m.nodes_col_last_seen(),
        cell: ({ row }) => (
          <span
            className="text-xs text-muted-foreground"
            title={row.original.lastSeenAt ? formatDateTime(row.original.lastSeenAt) : undefined}
          >
            {timeAgo(row.original.lastSeenAt)}
          </span>
        ),
      },
      {
        id: "actions",
        stack: "end",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <NodeActions node={row.original} onAction={show} onDetail={showDetail} />
          </div>
        ),
      },
    ],
    [latest, show, showDetail],
  );

  return (
    <section className="flex flex-col gap-3">
      {heading ? (
        <h2 className="flex items-center gap-2 text-sm font-medium">
          {m.nodes_title()}
          {nodes.data?.length ? (
            <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-wash px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
              {nodes.data.length}
            </span>
          ) : null}
        </h2>
      ) : null}
      <QueryView
        query={nodes}
        empty={
          <EmptyState icon={ServerStack01Icon} art="node" title={m.nodes_empty_title()}>
            <Button onClick={onEnroll}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.nav_add_node()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          <DataTable
            data={list}
            columns={columns}
            getRowId={(node) => node.id}
            testId="nodes-table"
            pinFirstColumn
          />
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
      {detail ? (
        <NodeDetailSheet
          node={detail}
          tab={detailTab}
          onTabChange={onDetailTab}
          onClose={() => showDetail(null)}
        />
      ) : null}
    </section>
  );
}
