import {
  NODE_DEBUG_LOGS_FEATURE,
  NODE_LOGS_FEATURE,
  type Node,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { ServerStack01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Outlet, useLocation, useMatch } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { Panel, PanelContent } from "@/components/layout/panel";
import { NodeDebugLogs } from "@/components/node-debug-logs";
import {
  NodeAddresses,
  NodeCache,
  NodeDetailActions,
  NodeOverview,
  NodeProbes,
} from "@/components/node-detail";
import { NodeLogs } from "@/components/node-logs";
import { NodeUpgradeHistory } from "@/components/node-upgrades";
import { NodeWorkspaceContext } from "@/components/node-workspace-context";
import { Page } from "@/components/page";
import {
  type ScopeOption,
  ScopeSwitcher,
  useSwitcherSearch,
} from "@/components/shell/scope-switcher";
import {
  flatScopeItems,
  useSidebarScope,
  useWorkspaceTitle,
} from "@/components/shell/sidebar-scope";
import { EmptyState, QueryView } from "@/components/states";
import { NotFoundPage } from "@/components/status-page";
import { m } from "@/lib/i18n";
import { NODE_VIEWS, type NodeView, nodeHref, nodeMainAddress } from "@/lib/node-views";
import { isNotFound, orpc } from "@/lib/orpc";
import { listReturnTo } from "@/lib/workspace-nav";

export const Route = createFileRoute("/_app/clusters/nodes/$nodeId")({
  validateSearch: z.object({ returnTo: z.string().optional() }),
  component: NodeDetailPage,
});

function canOpen(node: Node | undefined, view: NodeView) {
  if (view === "logs")
    return !!node && nodeSupportsFeature(node.supportedFeatures, NODE_LOGS_FEATURE);
  if (view === "debug-logs")
    return !!node && nodeSupportsFeature(node.supportedFeatures, NODE_DEBUG_LOGS_FEATURE);
  return true;
}

function NodeDetailPage() {
  const { nodeId } = Route.useParams();
  const { returnTo } = Route.useSearch();
  const path = useLocation({ select: (location) => location.href });
  const selected = useMatch({
    from: "/_app/clusters/nodes/$nodeId/$view",
    shouldThrow: false,
    select: (match) => match.params.view,
  });
  const view =
    selected && Object.hasOwn(NODE_VIEWS, selected) ? (selected as NodeView) : "overview";
  const query = useQuery({
    ...orpc.nodes.get.queryOptions({ input: { id: nodeId } }),
    refetchInterval: ({ state }) =>
      isNotFound(state.error) ? false : state.data?.decommissionRequestedAt ? 2_000 : 5_000,
    meta: { background: true },
  });
  const missing = isNotFound(query.error);
  const node = missing ? undefined : query.data;
  const name = node?.name;
  const label = NODE_VIEWS[view].label();
  const back = { href: listReturnTo("/clusters", returnTo), label: m.nav_clusters() };
  const href = (next: NodeView, id = nodeId) =>
    nodeHref(id, next, { returnTo: back.href === "/clusters" ? undefined : back.href });

  useSidebarScope({
    kind: "node",
    back,
    switcher: (rail) => (
      <NodeSwitcher node={node} rail={rail} view={view} href={href} back={back} />
    ),
    items: flatScopeItems(NODE_VIEWS, view, href, (next) => canOpen(node, next)),
    commandGroup: name ? m.scope_current_node({ name }) : m.nodes_title(),
  });
  useWorkspaceTitle(label, name);
  const notFound = (
    <NotFoundPage
      path={path}
      surface="inline"
      record={{ title: m.scope_node_missing(), to: "/clusters", label: m.nav_clusters() }}
    />
  );
  return (
    <Page
      title={view === "overview" ? (name ?? label) : label}
      actions={node ? <NodeDetailActions node={node} /> : undefined}
    >
      {missing ? (
        notFound
      ) : (
        <QueryView query={query} notFound={notFound}>
          {(node) => (
            <NodeWorkspaceContext.Provider value={node}>
              <Outlet key={node.id} />
            </NodeWorkspaceContext.Provider>
          )}
        </QueryView>
      )}
    </Page>
  );
}

export function NodeWorkspaceView({ view }: { view: NodeView }) {
  const node = React.useContext(NodeWorkspaceContext);
  if (!node) throw new Error("Node view must be rendered inside its detail route");
  switch (view) {
    case "overview":
      return <NodeOverview node={node} />;
    case "probes":
      return <NodeProbes node={node} />;
    case "addresses":
      return (
        <Panel>
          <PanelContent>
            <NodeAddresses node={node} />
          </PanelContent>
        </Panel>
      );
    case "cache":
      return (
        <Panel>
          <PanelContent>
            <NodeCache node={node} />
          </PanelContent>
        </Panel>
      );
    case "upgrades":
      return <NodeUpgradeHistory clusterId={node.clusterId} nodeId={node.id} />;
    case "logs":
      return <NodeLogs node={node} />;
    case "debug-logs":
      return canOpen(node, view) ? (
        <NodeDebugLogs node={node} />
      ) : (
        <EmptyState compact title={m.node_logs_unsupported()} />
      );
  }
}

function nodeOption(node: Node): ScopeOption {
  const state = node.decommissionRequestedAt
    ? ({ tone: "warn", state: m.node_decommissioning() } as const)
    : node.status === "disabled"
      ? ({ tone: "idle", state: m.nodes_disabled() } as const)
      : node.online
        ? ({ tone: "good", state: m.nodes_online() } as const)
        : ({ tone: "bad", state: m.nodes_offline() } as const);
  return { id: node.id, name: node.name, detail: nodeMainAddress(node), ...state };
}

function NodeSwitcher({
  node,
  rail,
  view,
  href,
  back,
}: {
  node: Node | undefined;
  rail: boolean;
  view: NodeView;
  href: (view: NodeView, id: string) => string;
  back: { href: string; label: string };
}) {
  const search = useSwitcherSearch();
  const list = useQuery({
    ...orpc.nodes.list.queryOptions({ input: {} }),
    enabled: search.open,
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const term = search.query.toLowerCase();
  const options = (list.data ?? [])
    .map(nodeOption)
    .filter((option) =>
      [option.name, option.detail ?? ""].some((value) => value.toLowerCase().includes(term)),
    );
  return (
    <ScopeSwitcher
      kind="node"
      rail={rail}
      icon={ServerStack01Icon}
      current={node ? nodeOption(node) : undefined}
      label={m.scope_switch_node()}
      searchLabel={m.scope_search_nodes()}
      search={search}
      groups={[{ label: m.scope_all_nodes(), items: options }]}
      pending={list.isPending}
      retry={list.isLoadingError ? () => void list.refetch() : undefined}
      href={(id) =>
        href(
          canOpen(
            list.data?.find((node) => node.id === id),
            view,
          )
            ? view
            : "overview",
          id,
        )
      }
      back={{ ...back, label: m.scope_all_nodes() }}
    />
  );
}
