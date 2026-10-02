import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { BansPage } from "@/components/bans";

export const Route = createFileRoute("/_app/bans")({
  validateSearch: z.object({
    /** The bans of one site (the site's security tab links here). */
    site: z.string().optional(),
    /** The bans of an address, and the ban dialog opened with it (and the site). */
    ip: z.string().optional(),
  }),
  component: BansRoute,
});

function BansRoute() {
  const { site, ip } = Route.useSearch();
  return <BansPage key={`${site ?? ""}|${ip ?? ""}`} initialSiteId={site} initialAddress={ip} />;
}
