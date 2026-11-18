import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { NODE_VIEWS, type NodeView, nodeHref } from "@/lib/node-views";
import { NodeWorkspaceView } from "../$nodeId";

export const Route = createFileRoute("/_app/clusters/nodes/$nodeId/$view")({
  beforeLoad: ({ params, location }) => {
    if (!Object.hasOwn(NODE_VIEWS, params.view)) throw notFound();
    if (params.view === "overview")
      throw redirect({
        href: nodeHref(params.nodeId, "overview", new URLSearchParams(location.searchStr)),
        replace: true,
      });
    return { view: params.view as NodeView };
  },
  component: () => <NodeWorkspaceView view={Route.useRouteContext().view} />,
});
