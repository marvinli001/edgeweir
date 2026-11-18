import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { type L4View, l4Href } from "@/lib/l4-views";
import { L4WorkspaceView } from "../$id";

export const Route = createFileRoute("/_app/l4/$id/$view")({
  beforeLoad: ({ params, location }) => {
    if (params.view === "overview")
      throw redirect({
        href: l4Href(params.id, "overview", new URLSearchParams(location.searchStr)),
        replace: true,
      });
    if (params.view !== "stats" && params.view !== "settings") throw notFound();
    return { view: params.view } satisfies { view: L4View };
  },
  component: () => <L4WorkspaceView view={Route.useRouteContext().view} />,
});
