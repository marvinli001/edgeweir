import {
  type AttentionItem,
  type AttentionKind,
  analyticsRange,
  type Cluster,
  displaySiteDomain,
  type Node,
  type Revision,
} from "@edgeweir/contract";
import { Add01Icon, GitCommitIcon, GlobeIcon, HistoryIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { AnalyticsSection } from "@/components/analytics/analytics-section";
import { Countdown } from "@/components/appica/countdown";
import { EdgeNetworkCard } from "@/components/overview/edge-network";
import { LiveKpis } from "@/components/overview/live-kpis";
import { Page } from "@/components/page";
import { ResourceEmpty, ResourceList, ResourceRow } from "@/components/resource-list";
import { StarMark, useSiteStars } from "@/components/site-star";
import { combineQueries, QueryView } from "@/components/states";
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

type NodeState =
  | "disabled"
  | "waiting"
  | "offline"
  | "failed"
  | "unhealthy"
  | "behind"
  | "synced"
  | "pending";

function nodeState(node: Node, latest: number): NodeState {
  if (node.status === "disabled") return "disabled";
  // Enrolled and never connected since.
  if (!node.lastSeenAt) return "waiting";
  if (!node.online) return "offline";
  if (node.applyState === "failed") return "failed";
  if (node.appliedRevision === 0) return "pending";
  // Online and configured, but its data plane does not serve.
  if (!node.dataPlaneHealthy) return "unhealthy";
  // During a canary rollout the other nodes' target is the stable revision, not the latest.
  return node.appliedRevision < (node.targetRevision ?? latest) ? "behind" : "synced";
}

/** Nodes that need a look come first. */
const STATE_ORDER: NodeState[] = [
  "offline",
  "failed",
  "unhealthy",
  "behind",
  "pending",
  "waiting",
  "disabled",
  "synced",
];

const STATE_TONE: Record<NodeState, StatusTone> = {
  offline: "bad",
  failed: "bad",
  unhealthy: "bad",
  behind: "warn",
  pending: "idle",
  waiting: "idle",
  disabled: "idle",
  synced: "good",
};

function stateLabel(state: NodeState): string {
  return {
    offline: m.nodes_offline,
    failed: m.nodes_apply_failed,
    unhealthy: m.nodes_unhealthy,
    behind: m.nodes_behind,
    pending: m.nodes_pending,
    waiting: m.nodes_awaiting_heartbeat,
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

  return (
    <Page title={m.overview_title()}>
      <QueryView query={combineQueries(sites, starred, overview, clusters, nodes)}>
        {([recent, starredSites, summary, clusterList, nodeList]) => (
          <>
            <AttentionList items={summary.attention} />
            <LiveKpis online={summary.onlineNodes} total={summary.nodes} />
            <AnalyticsSection
              range={search.range ?? DEFAULT_RANGE}
              onRangeChange={(range) =>
                navigate({ search: { range: range === DEFAULT_RANGE ? undefined : range } })
              }
              aside={<EdgeNetworkCard nodes={nodeList} clusters={clusterList} />}
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
              delay={200}
            />
            <div className="grid gap-3 @3xl/main:grid-cols-2">
              <RevisionsList revisions={summary.revisions} clusters={clusterList} />
              <RecentsList />
              <SitesList total={recent.total} starred={starredSites} recent={recent.items} />
              <NodesList
                nodes={nodeList}
                clusters={clusterList}
                online={summary.onlineNodes}
                total={summary.nodes}
              />
            </div>
          </>
        )}
      </QueryView>
    </Page>
  );
}

const ATTENTION_TONE: Record<AttentionKind, StatusTone> = {
  nodes_unhealthy: "bad",
  dns_failed: "bad",
  dns_blocked: "bad",
  upgrade_failed: "bad",
  canary_rolled_back: "bad",
  canary_awaiting_promotion: "warn",
  canary_running: "warn",
  nodes_lagging: "warn",
  nodes_no_address: "warn",
};

function attentionText(item: AttentionItem): string {
  const revision = item.revision ?? 0;
  switch (item.kind) {
    case "nodes_unhealthy":
      return m.attention_nodes_unhealthy({ count: item.count });
    case "nodes_lagging":
      return m.attention_nodes_lagging({ count: item.count });
    case "nodes_no_address":
      return m.attention_nodes_no_address({ count: item.count });
    case "dns_failed":
      return m.attention_dns_failed({ revision });
    case "dns_blocked":
      return m.attention_dns_blocked();
    case "upgrade_failed":
      return m.attention_upgrade_failed({ version: item.version });
    case "canary_rolled_back":
      return m.attention_canary_rolled_back({ revision });
    case "canary_awaiting_promotion":
      return m.attention_canary_awaiting_promotion({ revision });
    case "canary_running":
      return m.attention_canary_running({ revision });
  }
}

/**
 * What needs the operator, each row leading to where to act (the cluster,
 * its DNS tab). Nothing when all is well.
 */
function AttentionList({ items }: { items: AttentionItem[] }) {
  if (items.length === 0) return null;
  return (
    <ResourceList
      title={m.attention_title()}
      count={formatNumber(items.length)}
      testId="attention"
      className="animate-enter"
    >
      {items.map((item) => (
        <ResourceRow
          key={`${item.kind}-${item.clusterId}`}
          icon={<Dot tone={ATTENTION_TONE[item.kind]} pulse={item.kind === "canary_running"} />}
          link={{
            to: "/clusters",
            search: {
              cluster: item.clusterId,
              tab: item.kind === "dns_failed" || item.kind === "dns_blocked" ? "dns" : undefined,
            },
          }}
          trailing={
            <span className="max-w-32 shrink-0 truncate text-xs text-muted-foreground">
              {item.clusterName}
            </span>
          }
          testId="attention-item"
        >
          <span className="truncate" data-kind={item.kind}>
            {attentionText(item)}
          </span>
          {item.kind === "canary_running" && item.at ? (
            <Countdown target={item.at} className="shrink-0 text-xs text-muted-foreground" />
          ) : item.kind === "canary_rolled_back" && item.at ? (
            <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(item.at)}</span>
          ) : null}
        </ResourceRow>
      ))}
    </ResourceList>
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
      style={{ animationDelay: "120ms" }}
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
          {site.domains[0] && displaySiteDomain(site.domains[0]) !== site.name ? (
            <span className="truncate text-xs text-muted-foreground">
              {displaySiteDomain(site.domains[0])}
            </span>
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
      style={{ animationDelay: "180ms" }}
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
    <ResourceList title={m.revisions_recent()} testId="home-revisions" className="animate-enter">
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
      style={{ animationDelay: "60ms" }}
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
