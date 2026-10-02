import { createFileRoute, Outlet, redirect, useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { AppSidebar } from "@/components/app-sidebar";
import { CommandMenu } from "@/components/command-menu";
import { QuickActionsProvider } from "@/components/quick-actions";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { UnsavedChangesGuard } from "@/components/unsaved-changes";
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
    return { session: data, me };
  },
  component: AppLayout,
});

function AppLayout() {
  const { session } = Route.useRouteContext();
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
      <QuickActionsProvider>
        <AppSidebar variant="inset" user={{ name: session.user.name, email: session.user.email }} />
        <SidebarInset>
          <Outlet />
        </SidebarInset>
        <CommandMenu />
      </QuickActionsProvider>
      <UnsavedChangesGuard />
    </SidebarProvider>
  );
}
