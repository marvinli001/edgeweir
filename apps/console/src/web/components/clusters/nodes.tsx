import type { Cluster, Node } from "@edgeweir/contract";
import { Add01Icon, MoreHorizontalIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type * as React from "react";
import { toast } from "sonner";
import { type NodeAction, NodeActionDialog } from "@/components/clusters/node-dialogs";
import { AuthErrorBadge, NodeDetailSheet, NodeVitals } from "@/components/node-detail";
import { enterDelay } from "@/components/page";
import { EmptyState, QueryView } from "@/components/states";
import { Dot, StatusDot } from "@/components/status-dot";
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
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
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
      <Dot tone="good" small />
      {m.nodes_up_to_date()}
    </Badge>
  ) : (
    <Badge variant="outline" data-testid="node-behind">
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

/** One labeled fact at the foot of a node card. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid min-w-0 grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-2">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs">{children}</dd>
    </div>
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
          <Badge variant="destructive" data-testid="node-unhealthy">
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
 * A node as an instrument card: name and state, its load (meters and readouts in a well), then its
 * revision, agent and addresses. `data-row-id` keys the card like a table row.
 */
function NodeCard({
  node,
  latest,
  index,
  onAction,
  onDetail,
}: {
  node: Node;
  latest: number;
  index: number;
  onAction: (action: NodeAction) => void;
  onDetail: (id: string) => void;
}) {
  return (
    <li
      data-row-id={node.id}
      className="flex min-w-0 flex-col gap-3 rounded-2xl bg-card p-4 shadow-elev-1 edge-lit animate-enter"
      style={enterDelay(index, 40)}
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <button
            type="button"
            className="flex w-fit max-w-full items-center gap-1.5 rounded-md text-left font-medium underline-offset-4 outline-none focus-lit hover:underline"
            onClick={() => onDetail(node.id)}
            data-testid="node-open"
          >
            <span className="truncate" data-testid="node-name">
              {node.name}
            </span>
            {node.probeEnabled ? (
              <Badge variant="outline" data-testid="node-probe-badge">
                {m.node_probe_switch()}
              </Badge>
            ) : null}
          </button>
          <span className="truncate text-xs text-muted-foreground" title={node.hostname}>
            {node.hostname}
          </span>
        </div>
        <NodeActions node={node} onAction={onAction} onDetail={onDetail} />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <NodeState node={node} />
        <span className="flex min-w-0 items-center gap-1 text-xs text-muted-foreground">
          <span className="truncate text-foreground" data-testid="node-group">
            {node.nodeGroupName ?? "—"}
          </span>
          {node.regionName ? <span className="truncate">· {node.regionName}</span> : null}
        </span>
        <span
          className="ml-auto shrink-0 text-xs text-muted-foreground"
          title={node.lastSeenAt ? formatDateTime(node.lastSeenAt) : undefined}
        >
          {m.nodes_col_last_seen()} {timeAgo(node.lastSeenAt)}
        </span>
      </div>
      <NodeVitals node={node} />
      <dl className="flex flex-col gap-1.5">
        <Fact label={m.nodes_col_revision()}>
          <span className="font-mono" data-testid="node-applied-revision">
            #{node.appliedRevision}
          </span>
          <RevisionBadge node={node} latest={latest} />
        </Fact>
        <Fact label={m.nodes_col_agent()}>
          <span className="font-mono">{node.agentVersion || "—"}</span>
          <span className="text-muted-foreground">
            {node.engine} {node.engineVersion}
          </span>
        </Fact>
        <Fact label={m.nodes_col_ips()}>
          {node.ipAddresses.length ? (
            node.ipAddresses.map((ip) => (
              <span key={ip} className="font-mono break-all">
                {ip}
              </span>
            ))
          ) : (
            <span>—</span>
          )}
          {node.dnsIssue === "no_public_address" ? (
            <Badge variant="outline" data-testid="node-dns-issue">
              {m.node_dns_no_public_address()}
            </Badge>
          ) : null}
        </Fact>
      </dl>
    </li>
  );
}

/**
 * The cluster's nodes, as cards. `detailId` is the node whose details are open (`onDetail` opens
 * and closes them); they come from the polling list so they stay current.
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

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        {m.nodes_title()}
        {nodes.data?.length ? (
          <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-wash px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
            {nodes.data.length}
          </span>
        ) : null}
      </h2>
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
          // The test id predates the cards (the node list was a table).
          <ul
            className="grid gap-3 @2xl/main:grid-cols-2 @5xl/main:grid-cols-3"
            data-testid="nodes-table"
          >
            {list.map((node, index) => (
              <NodeCard
                key={node.id}
                node={node}
                latest={latest}
                index={index}
                onAction={action.show}
                onDetail={showDetail}
              />
            ))}
          </ul>
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
      {detail ? <NodeDetailSheet node={detail} onClose={() => showDetail(null)} /> : null}
    </section>
  );
}
