import { createFileRoute, redirect } from "@tanstack/react-router";
import * as z from "zod";

/**
 * Regions are a view of the clusters page and probes a tab of the system
 * settings; old links keep working.
 */
export const Route = createFileRoute("/_app/regions")({
  validateSearch: z.object({
    tab: z.enum(["regions", "probes"]).optional(),
    addProbe: z.boolean().optional(),
  }),
  beforeLoad: ({ search }) => {
    if (search.tab === "probes")
      throw redirect({
        to: "/system",
        search: { tab: "probes", addProbe: search.addProbe },
        replace: true,
      });
    throw redirect({ to: "/clusters", search: { view: "regions" }, replace: true });
  },
});
