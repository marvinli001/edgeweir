import { createFileRoute, redirect } from "@tanstack/react-router";
import { legacySiteHref } from "@/lib/site-tabs";
import { SiteWorkspaceView } from "../$id";

export const Route = createFileRoute("/_app/sites/$id/")({
  beforeLoad: ({ params, location }) => {
    const href = legacySiteHref(params.id, location.searchStr);
    if (href) throw redirect({ href, replace: true });
  },
  component: () => <SiteWorkspaceView view="overview" />,
});
