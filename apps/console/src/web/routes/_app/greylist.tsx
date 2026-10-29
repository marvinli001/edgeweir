import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { GreylistPage } from "@/components/greylist";

export const Route = createFileRoute("/_app/greylist")({
  validateSearch: z.object({
    site: z.string().optional(),
    /** The entries of an address. */
    ip: z.string().optional(),
    scope: z.enum(["platform", "site"]).optional(),
    page: z.number().int().min(1).optional(),
  }),
  component: GreylistRoute,
});

function GreylistRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <GreylistPage
      search={search}
      onSearch={(patch) => navigate({ search: (prev) => ({ ...prev, ...patch }), replace: true })}
    />
  );
}
