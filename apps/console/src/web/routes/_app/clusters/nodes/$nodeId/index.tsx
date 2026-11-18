import { createFileRoute } from "@tanstack/react-router";
import { NodeWorkspaceView } from "../$nodeId";

export const Route = createFileRoute("/_app/clusters/nodes/$nodeId/")({
  component: () => <NodeWorkspaceView view="overview" />,
});
