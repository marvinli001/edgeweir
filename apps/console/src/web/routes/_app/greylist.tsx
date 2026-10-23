import { createFileRoute } from "@tanstack/react-router";
import * as z from "zod";
import { GreylistPage } from "@/components/greylist";

export const Route = createFileRoute("/_app/greylist")({
  validateSearch: z.object({
    /** The entries of an address. */
    ip: z.string().optional(),
  }),
  component: GreylistRoute,
});

function GreylistRoute() {
  const { ip } = Route.useSearch();
  return <GreylistPage key={ip ?? ""} initialAddress={ip} />;
}
