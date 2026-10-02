import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { BansPage } from "@/components/bans";

export const Route = createFileRoute("/_app/bans")({
  /** `site`: the bans of one site (the site's security tab links here). */
  validateSearch: z.object({ site: z.string().optional() }),
  component: BansRoute,
});

function BansRoute() {
  const { site } = Route.useSearch();
  return <BansPage key={site ?? ""} initialSiteId={site} />;
}
