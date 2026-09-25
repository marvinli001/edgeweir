import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import type * as React from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandMenu } from "@/components/command-menu";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery(orpc.system.status.queryOptions());
    if (!status.initialized) throw redirect({ to: "/setup" });
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: "/login", search: { redirect: location.href } });
    const role = (data.user as { role?: string | null }).role ?? "";
    return { session: data, isAdmin: role.split(",").includes("admin") };
  },
  component: AppLayout,
});

function AppLayout() {
  const { session, isAdmin } = Route.useRouteContext();
  return (
    <SidebarProvider
      style={
        {
          "--sidebar-width": "calc(var(--spacing) * 64)",
          "--header-height": "calc(var(--spacing) * 12)",
        } as React.CSSProperties
      }
    >
      <AppSidebar variant="inset" user={{ name: session.user.name, email: session.user.email }} />
      <SidebarInset>
        <Outlet />
      </SidebarInset>
      <CommandMenu isAdmin={isAdmin} />
    </SidebarProvider>
  );
}
