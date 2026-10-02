import { createFileRoute, redirect } from "@tanstack/react-router";

/** Service accounts are a tab of the system settings; old links keep working. */
export const Route = createFileRoute("/_app/service-accounts")({
  beforeLoad: () => {
    throw redirect({ to: "/system", search: { tab: "service-accounts" }, replace: true });
  },
});
