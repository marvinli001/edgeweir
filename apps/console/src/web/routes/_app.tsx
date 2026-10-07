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

type Session = NonNullable<Awaited<ReturnType<typeof authClient.getSession>>["data"]>;

/** The session checked on entering the console (cleared with the cache on sign-out). */
const SESSION_KEY = ["console-session"] as const;

export const Route = createFileRoute("/_app")({
  beforeLoad: async ({ context, location, cause }) => {
    // Moving within the console (another page, a tab or dialog in the search) keeps the checks
    // made on entering it: an expired or revoked session turns the next API call into a 401,
    // which goes to sign-in (main.tsx). Checking again would put two round trips in front of
    // every click, which a console behind a distant CDN shows as a dialog that does not close.
    if (cause === "stay") {
      const session = context.queryClient.getQueryData<Session>(SESSION_KEY);
      const me = context.queryClient.getQueryData(orpc.account.me.queryOptions().queryKey);
      if (session && me) return { session, me };
    }
    const status = await context.queryClient.fetchQuery(orpc.system.status.queryOptions());
    if (!status.initialized) throw redirect({ to: "/setup" });
    const { data } = await authClient.getSession();
    if (!data) throw redirect({ to: "/login", search: { redirect: location.href } });
    context.queryClient.setQueryData(SESSION_KEY, data);
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
    // The header's height (--header-height) lives on :root, where the document's scroll padding
    // reads it too (index.css).
    <SidebarProvider
      style={{ "--sidebar-width": "calc(var(--spacing) * 64)" } as React.CSSProperties}
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
