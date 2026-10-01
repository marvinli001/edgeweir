import { analyticsRange, type Cluster, type Node, type Revision } from "@edgeweir/contract";
import { Add01Icon, GitCommitIcon, ServerStack01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as z from "zod";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { Page } from "@/components/page";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { ErrorState, LoadingState } from "@/components/states";
import { Dot, type StatusTone } from "@/components/status-dot";
import { buttonVariants } from "@/components/ui/button";
import { DEFAULT_RANGE } from "@/lib/analytics";
import { formatNumber, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { revisionReason } from "@/lib/revisions";

const LIST_SIZE = 5;
const live = { refetchInterval: 10_000, meta: { background: true } } as const;

export const Route = createFileRoute("/_app/admin/")({
  validateSearch: z.object({ range: analyticsRange.optional() }),
  component: AdminOverviewPage,
});

type NodeState = "disabled" | "offline" | "failed" | "behind" | "synced" | "pending";

function nodeState(node: Node, latest: number): NodeState {
  if (node.status === "disabled") return "disabled";
  if (!node.online) return "offline";
  if (node.applyState === "failed") return "failed";
  if (node.appliedRevision === 0) return "pending";
  return node.appliedRevision < latest ? "behind" : "synced";
}

/** Nodes that need a look come first. */
const STATE_ORDER: NodeState[] = ["offline", "failed", "behind", "pending", "disabled", "synced"];

const STATE_TONE: Record<NodeState, StatusTone> = {
  offline: "bad",
  failed: "bad",
  behind: "warn",
  pending: "idle",
  disabled: "idle",
  synced: "good",
};

function stateLabel(state: NodeState): string {
  return {
    offline: m.nodes_offline,
    failed: m.nodes_apply_failed,
    behind: m.nodes_behind,
    pending: m.nodes_pending,
    disabled: m.nodes_disabled,
    synced: m.nodes_up_to_date,
  }[state]();
}

function AdminOverviewPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const overview = useQuery({ ...orpc.overview.get.queryOptions(), ...live });
  const clusters = useQuery({ ...orpc.clusters.list.queryOptions(), ...live });
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions({ input: {} }), ...live });
  const failed = [overview, clusters, nodes].find((q) => q.isError);

  return (
    <Page title={m.admin_overview_title()}>
      {overview.isPending || clusters.isPending || nodes.isPending ? (
        <LoadingState />
      ) : failed ? (
        <ErrorState error={failed.error} onRetry={() => failed.refetch()} />
      ) : (
        <>
          <div className="grid gap-x-8 gap-y-6 @3xl/main:grid-cols-2 @4xl/main:grid-cols-3">
            <ClustersList clusters={clusters.data ?? []} />
            <NodesList
              nodes={nodes.data ?? []}
              clusters={clusters.data ?? []}
              online={overview.data?.onlineNodes ?? 0}
              total={overview.data?.nodes ?? 0}
            />
            <RevisionsList
              revisions={overview.data?.revisions ?? []}
              clusters={clusters.data ?? []}
            />
          </div>
          <AnalyticsSection
            range={search.range ?? DEFAULT_RANGE}
            onRangeChange={(range) =>
              navigate({ search: { range: range === DEFAULT_RANGE ? undefined : range } })
            }
            topLists={[
              {
                id: "sites",
                title: m.analytics_top_sites(),
                renderLink: (item, props) => (
                  <Link to="/sites/$id" params={{ id: item.id }} {...props} />
                ),
              },
              {
                id: "nodes",
                title: m.analytics_top_nodes(),
                renderLink: (item, props) => (
                  <Link to="/admin/clusters" search={{ cluster: item.parentId }} {...props} />
                ),
              },
            ]}
            delay={180}
          />
        </>
      )}
    </Page>
  );
}

function ClustersList({ clusters }: { clusters: Cluster[] }) {
  return (
    <ResourceList
      title={m.admin_clusters()}
      count={formatNumber(clusters.length)}
      link={{ to: "/admin/clusters" }}
      testId="admin-clusters"
      className="animate-enter"
    >
      {clusters.slice(0, LIST_SIZE).map((cluster) => (
        <ResourceRow
          key={cluster.id}
          icon={<HugeiconsIcon icon={ServerStack01Icon} strokeWidth={2} />}
          link={{ to: "/admin/clusters", search: { cluster: cluster.id } }}
          trailing={
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
              {m.clusters_nodes_count({
                online: cluster.onlineNodeCount,
                total: cluster.nodeCount,
              })}
            </span>
          }
        >
          <span className="truncate font-medium">{cluster.name}</span>
        </ResourceRow>
      ))}
    </ResourceList>
  );
}

function NodesList({
  nodes,
  clusters,
  online,
  total,
}: {
  nodes: Node[];
  clusters: Cluster[];
  online: number;
  total: number;
}) {
  const latest = new Map(clusters.map((c) => [c.id, c.latestRevision?.revision ?? 0]));
  const rows = nodes
    .map((node) => ({ node, state: nodeState(node, latest.get(node.clusterId) ?? 0) }))
    .sort(
      (a, b) =>
        STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state) ||
        a.node.name.localeCompare(b.node.name),
    )
    .slice(0, LIST_SIZE);
  return (
    <ResourceList
      title={m.nodes_title()}
      count={
        total === 0 ? (
          "0"
        ) : (
          <>
            <Dot tone={online < total ? "bad" : "good"} small />
            {m.clusters_nodes_count({ online, total })}
          </>
        )
      }
      link={{ to: "/admin/clusters" }}
      testId="stat-nodes"
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
    >
      {rows.length === 0 ? (
        <ResourceEmpty>
          <span>{m.nodes_empty_title()}</span>
          <Link
            to="/admin/clusters"
            search={{ enroll: true }}
            className={buttonVariants({ size: "xs", variant: "outline" })}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_add_node()}
          </Link>
        </ResourceEmpty>
      ) : (
        rows.map(({ node, state }) => (
          <ResourceRow
            key={node.id}
            icon={<Dot tone={STATE_TONE[state]} />}
            link={{ to: "/admin/clusters", search: { cluster: node.clusterId } }}
            trailing={
              <span className="shrink-0 text-xs text-muted-foreground">{stateLabel(state)}</span>
            }
            testId="admin-node"
          >
            <span className="truncate font-medium">{node.name}</span>
            <span className="truncate font-mono text-xs text-muted-foreground">
              #{node.appliedRevision}
            </span>
          </ResourceRow>
        ))
      )}
    </ResourceList>
  );
}

function RevisionsList({ revisions, clusters }: { revisions: Revision[]; clusters: Cluster[] }) {
  const names = new Map(clusters.map((c) => [c.id, c.name]));
  return (
    <ResourceList
      title={m.admin_revisions_title()}
      testId="admin-revisions"
      className="animate-enter"
      style={{ animationDelay: "120ms" }}
    >
      {revisions.length === 0 ? (
        <ResourceEmpty>{m.admin_revisions_empty()}</ResourceEmpty>
      ) : (
        revisions.slice(0, LIST_SIZE).map((r) => (
          <ResourceRow
            key={`${r.clusterId}-${r.revision}`}
            icon={<HugeiconsIcon icon={GitCommitIcon} strokeWidth={2} />}
            link={{ to: "/admin/clusters", search: { cluster: r.clusterId } }}
            trailing={
              <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
            }
          >
            <span className="shrink-0 font-mono text-xs text-muted-foreground">#{r.revision}</span>
            <span className="truncate" title={names.get(r.clusterId)}>
              {revisionReason(r)}
            </span>
          </ResourceRow>
        ))
      )}
    </ResourceList>
  );
}
