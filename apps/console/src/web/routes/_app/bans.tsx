import { createFileRoute } from "@tanstack/react-router";
import { BansPage } from "@/components/bans";

export const Route = createFileRoute("/_app/bans")({ component: () => <BansPage /> });
