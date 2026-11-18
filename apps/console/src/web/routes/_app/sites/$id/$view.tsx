import { createFileRoute, notFound, redirect } from "@tanstack/react-router";
import { isSiteTab, siteHref } from "@/lib/site-tabs";
import { SiteWorkspaceView } from "../$id";

export const Route = createFileRoute("/_app/sites/$id/$view")({
  beforeLoad: ({ params, location }) => {
    if (!isSiteTab(params.view)) throw notFound();
    if (params.view === "overview")
      throw redirect({
        href: siteHref(params.id, "overview", new URLSearchParams(location.searchStr)),
        replace: true,
      });
    return { view: params.view };
  },
  component: () => <SiteWorkspaceView view={Route.useRouteContext().view} />,
});
