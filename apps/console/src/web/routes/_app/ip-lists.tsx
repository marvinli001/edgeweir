import { createFileRoute } from "@tanstack/react-router";
import { IpListsPage } from "@/components/ip-lists";
export const Route = createFileRoute("/_app/ip-lists")({ component: IpListsPage });
