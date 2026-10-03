import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { LoadingState } from "@/components/states";
import { NotFoundPage, RouteErrorPage } from "@/components/status-page";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getLocale } from "@/lib/i18n";
import { isNotFound, isUnauthorized } from "@/lib/orpc";
import { routeTree } from "./routeTree.gen";

/**
 * An expired or revoked session answers 401 to every call: go to the sign-in page, which brings
 * the user back here, instead of leaving "Please sign in" with a retry that cannot work.
 */
function onUnauthorized(error: unknown) {
  if (!isUnauthorized(error)) return;
  const { pathname, href } = router.state.location;
  if (pathname === "/login" || pathname === "/setup") return;
  void router.navigate({ to: "/login", search: { redirect: href }, replace: true });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onUnauthorized }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      // Asking again cannot sign in or bring back a deleted record.
      retry: (count, error) => !isUnauthorized(error) && !isNotFound(error) && count < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
  // Until a route resolves nothing of it is on screen (not even TopProgress on a first load); one
  // slower than `defaultPendingMs` (session check, code chunk) shows the loader instead of a blank page.
  defaultPendingComponent: () => <LoadingState className="min-h-svh" />,
  // A route that fails shows its status page (inside the console once the console has loaded);
  // unknown paths are the console's catch-all route, this covers `notFound()` outside it.
  defaultErrorComponent: ({ error }) => <RouteErrorPage error={error} />,
  defaultNotFoundComponent: () => (
    <NotFoundPage path={router.state.location.href} surface="screen" />
  ),
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

document.documentElement.lang = getLocale();

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

createRoot(root).render(
  <StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <RouterProvider router={router} />
          <Toaster />
        </TooltipProvider>
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
