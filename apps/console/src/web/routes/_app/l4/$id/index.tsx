import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacyL4Href } from "@/lib/l4-views";
import { L4WorkspaceView } from "../$id";

export const Route = createFileRoute("/_app/l4/$id/")({
  beforeLoad: ({ params, location }) => {
    const href = legacyL4Href(params.id, location.searchStr);
    if (href) throw redirect({ href, replace: true });
  },
  component: () => <L4WorkspaceView view="overview" />,
});
