import { analyticsRange, type Cluster, type Node, type Revision } from "@edgeweir/contract";
import { Add01Icon, GitCommitIcon, GlobeIcon, HistoryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { Page } from "@/components/page";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { StarMark, useSiteStars } from "@/components/site-star";
import { ErrorState, LoadingState } from "@/components/states";
import { Dot, type StatusTone } from "@/components/status-dot";
import { buttonVariants } from "@/components/ui/button";
import { DEFAULT_RANGE } from "@/lib/analytics";
import { formatNumber, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { RECENT_PAGES, readRecents } from "@/lib/recents";
import { revisionReason } from "@/lib/revisions";
import { siteTabLabel } from "@/lib/site-tabs";

const LIST_SIZE = 5;
const live = { refetchInterval: 10_000, meta: { background: true } } as const;

export const Route = createFileRoute("/_app/overview")({
  validateSearch: z.object({ range: analyticsRange.optional() }),
  component: OverviewPage,
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

function OverviewPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({ input: { pageSize: LIST_SIZE } }),
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const { starred } = useSiteStars();
  const overview = useQuery({ ...orpc.overview.get.queryOptions(), ...live });
  const clusters = useQuery({ ...orpc.clusters.list.queryOptions(), ...live });
  const nodes = useQuery({ ...orpc.nodes.list.queryOptions({ input: {} }), ...live });
  const queries = [sites, starred, overview, clusters, nodes];
  const failed = queries.find((q) => q.isLoadingError);

  return (
    <Page title={m.overview_title()}>
      {queries.some((q) => q.isPending) ? (
        <LoadingState />
      ) : failed ? (
        <ErrorState error={failed.error} onRetry={() => failed.refetch()} />
      ) : (
        <>
          <div className="grid gap-x-10 gap-y-6 @3xl/main:grid-cols-2">
            <SitesList
              total={sites.data?.total ?? 0}
              starred={starred.data ?? []}
              recent={sites.data?.items ?? []}
            />
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
            <RecentsList />
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
                  <Link to="/clusters" search={{ cluster: item.parentId }} {...props} />
                ),
              },
            ]}
            delay={240}
          />
        </>
      )}
    </Page>
  );
}

/** Starred sites first, then the oldest sites, like the zone list of a CDN dashboard. */
function SitesList({
  total,
  starred,
  recent,
}: {
  total: number;
  starred: { id: string; name: string; domains: string[] }[];
  recent: { id: string; name: string; domains: string[] }[];
}) {
  const starredIds = new Set(starred.map((s) => s.id));
  const rows = [
    ...starred.map((s) => ({ ...s, starred: true })),
    ...recent.filter((s) => !starredIds.has(s.id)).map((s) => ({ ...s, starred: false })),
  ].slice(0, LIST_SIZE);
  return (
    <ResourceList
      title={m.nav_sites()}
      count={formatNumber(total)}
      link={{ to: "/sites" }}
      testId="home-sites"
      className="animate-enter"
    >
      {rows.length === 0 ? (
        <ResourceEmpty>
          <span>{m.sites_empty_title()}</span>
          <Link
            to="/sites"
            search={{ create: true }}
            className={buttonVariants({ size: "xs", variant: "outline" })}
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_new_site()}
          </Link>
        </ResourceEmpty>
      ) : null}
      {rows.map((site) => (
        <ResourceRow
          key={site.id}
          icon={<HugeiconsIcon icon={GlobeIcon} strokeWidth={2} />}
          link={{ to: "/sites/$id", params: { id: site.id } }}
          trailing={site.starred ? <StarMark /> : null}
          testId="home-site"
        >
          <span className="truncate font-medium">{site.name}</span>
          {site.domains[0] && site.domains[0] !== site.name ? (
            <span className="truncate text-xs text-muted-foreground">{site.domains[0]}</span>
          ) : null}
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
      link={{ to: "/clusters" }}
      testId="home-nodes"
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
    >
      {rows.length === 0 ? (
        <ResourceEmpty>
          <span>{m.nodes_empty_title()}</span>
          <Link
            to="/clusters"
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
            link={{ to: "/clusters", search: { cluster: node.clusterId } }}
            trailing={
              <span className="shrink-0 text-xs text-muted-foreground">{stateLabel(state)}</span>
            }
            testId="home-node"
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
      title={m.revisions_recent()}
      testId="home-revisions"
      className="animate-enter"
      style={{ animationDelay: "120ms" }}
    >
      {revisions.length === 0 ? (
        <ResourceEmpty>{m.revisions_empty()}</ResourceEmpty>
      ) : (
        revisions.slice(0, LIST_SIZE).map((r) => (
          <ResourceRow
            key={`${r.clusterId}-${r.revision}`}
            icon={<HugeiconsIcon icon={GitCommitIcon} strokeWidth={2} />}
            link={{ to: "/clusters", search: { cluster: r.clusterId } }}
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

function RecentsList() {
  const { session } = Route.useRouteContext();
  // Read once per visit; this page never records itself.
  const [recents] = React.useState(() => readRecents(session.user.id));
  return (
    <ResourceList
      title={m.home_recents()}
      testId="home-recents"
      className="animate-enter"
      style={{ animationDelay: "180ms" }}
    >
      {recents.length === 0 ? (
        <ResourceEmpty>{m.home_recents_empty()}</ResourceEmpty>
      ) : (
        recents.map((recent) => {
          const [parent, title] =
            recent.kind === "page"
              ? [null, RECENT_PAGES[recent.path]()]
              : recent.tab
                ? [recent.name, siteTabLabel(recent.tab)]
                : [m.nav_sites(), recent.name];
          return (
            <ResourceRow
              key={recent.kind === "page" ? recent.path : `${recent.id}-${recent.tab ?? ""}`}
              icon={<HugeiconsIcon icon={HistoryIcon} strokeWidth={2} />}
              link={
                recent.kind === "page"
                  ? { to: recent.path }
                  : {
                      to: "/sites/$id",
                      params: { id: recent.id },
                      search: recent.tab ? { tab: recent.tab } : {},
                    }
              }
              testId="home-recent"
            >
              <span className="truncate">
                {parent ? <span className="text-muted-foreground">{parent} / </span> : null}
                <span className="font-medium">{title}</span>
              </span>
            </ResourceRow>
          );
        })
      )}
    </ResourceList>
  );
}
