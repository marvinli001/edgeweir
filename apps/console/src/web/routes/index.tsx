import { createFileRoute, redirect } from "@tanstack/react-router";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/lib/orpc";

/** `/` has no page of its own: setup on first run, the console when signed in, else sign-in. */
export const Route = createFileRoute("/")({
  beforeLoad: async ({ context }) => {
    const status = await context.queryClient.fetchQuery(orpc.system.status.queryOptions());
    if (!status.initialized) throw redirect({ to: "/setup" });
    const { data } = await authClient.getSession();
    throw redirect({ to: data ? "/overview" : "/login" });
  },
});
