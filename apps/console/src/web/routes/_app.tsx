import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandMenu } from "@/components/command-menu";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { authClient } from "@/lib/auth-client";
import { orpc } from "@/lib/orpc";
import { isRecentPath, recordRecent } from "@/lib/recents";

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location }) => {
    const status = await context.queryClient.fetchQuery(orpc.system.status.queryOptions());
    if (!status.initialized) throw redirect({ to: "/setup" });
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: "/login", search: { redirect: location.href } });
    const me = await context.queryClient.fetchQuery({
      ...orpc.account.me.queryOptions(),
      staleTime: 30_000,
    });
    // An organization that requires 2FA holds its members on the security page until enabled.
    if (me.twoFactorRequired && location.pathname !== "/security") {
      throw redirect({ to: "/security" });
    }
    return { session: data, me, isAdmin: me.user.isAdmin };
  },
  component: AppLayout,
});

function AppLayout() {
  const { session, isAdmin } = Route.useRouteContext();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  // Site pages record themselves once their name is known.
  React.useEffect(() => {
    if (isRecentPath(pathname)) recordRecent(session.user.id, { kind: "page", path: pathname });
  }, [pathname, session.user.id]);
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
