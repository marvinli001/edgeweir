import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { BansPage } from "@/components/bans";

export const Route = createFileRoute("/_app/bans")({
  validateSearch: z.object({
    /** The bans of one site (the site's security tab links here). */
    site: z.string().optional(),
    /** The bans of an address, and the ban dialog opened with it (and the site). */
    ip: z.string().optional(),
    source: z.enum(["manual", "auto", "rule"]).optional(),
    scope: z.enum(["platform", "site"]).optional(),
    page: z.number().int().min(1).optional(),
  }),
  component: BansRoute,
});

function BansRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <BansPage
      search={search}
      onSearch={(patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })}
    />
  );
}
