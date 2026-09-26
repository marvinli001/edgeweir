import { createFileRoute } from "@tanstack/react-router";
import { IpListsPage } from "@/components/ip-lists";
export const Route = createFileRoute("/_app/admin/ip-lists")({
  component: () => <IpListsPage platform />,
});
