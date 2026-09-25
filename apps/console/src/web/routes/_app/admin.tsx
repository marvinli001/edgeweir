import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

/** Admin area: platform administrators only. */
export const Route = createFileRoute("/_app/admin")({
  beforeLoad: ({ context }) => {
    if (!context.isAdmin) throw redirect({ to: "/" });
  },
  component: Outlet,
});
