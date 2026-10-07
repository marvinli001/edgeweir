/**
 * Lab entry: src/web/main.tsx with hash history (memory history in the static build; no server
 * routes needed) and the lab panel.
 * Keep the providers and router options in step with it; the one difference is that failed
 * queries are not retried in the lab's error state, so ErrorState shows at once.
 */
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createHashHistory,
  createMemoryHistory,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/index.css";
import { LoadingState } from "@/components/states";
import { NotFoundPage, RouteErrorPage } from "@/components/status-page";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "@/components/ui/sonner";
import { TooltipProvider } from "@/components/ui/tooltip";
import { getLocale } from "@/lib/i18n";
import { isNotFound, isUnauthorized } from "@/lib/orpc";
import { readRecents, recordRecent } from "@/lib/recents";
import { routeTree } from "@/routeTree.gen";
import { sites } from "./fixtures/world";
import { LabPanel } from "./panel";
import { labState } from "./state";

function onUnauthorized(error: unknown) {
  if (!isUnauthorized(error)) return;
  void router.navigate({ to: "/login", replace: true });
}

const queryClient = new QueryClient({
  queryCache: new QueryCache({ onError: onUnauthorized }),
  mutationCache: new MutationCache({ onError: onUnauthorized }),
  defaultOptions: {
    queries: {
      staleTime: 5_000,
      retry: (count, error) =>
        labState() !== "error" && !isUnauthorized(error) && !isNotFound(error) && count < 2,
    },
  },
});

const router = createRouter({
  routeTree,
  // The dev server keeps the page in the hash (links, screenshots); the static build may run in a
  // sandboxed frame that refuses history changes, so it keeps the route in memory.
  history: import.meta.env.DEV
    ? createHashHistory()
    : createMemoryHistory({ initialEntries: [window.location.hash.slice(1) || "/"] }),
  context: { queryClient },
  defaultPreload: "intent",
  scrollRestoration: true,
  defaultPendingComponent: () => <LoadingState className="min-h-svh" />,
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

// A few places visited before, for the overview's recent list.
if (readRecents("lab-operator").length === 0) {
  const [, shop, api] = sites;
  recordRecent("lab-operator", { kind: "page", path: "/certificates" });
  if (api) recordRecent("lab-operator", { kind: "site", id: api.id, name: api.name, tab: "rules" });
  recordRecent("lab-operator", { kind: "page", path: "/clusters" });
  if (shop) {
    recordRecent("lab-operator", { kind: "site", id: shop.id, name: shop.name, tab: "origins" });
  }
}

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
        <LabPanel router={router} queryClient={queryClient} />
      </QueryClientProvider>
    </ThemeProvider>
  </StrictMode>,
);
