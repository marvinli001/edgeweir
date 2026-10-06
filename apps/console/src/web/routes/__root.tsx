import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { MotionConfig } from "motion/react";
import { TopProgress } from "@/components/top-progress";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  // Motion components follow the OS "reduce motion" setting (transforms and layout off).
  component: () => (
    <MotionConfig reducedMotion="user">
      <TopProgress />
      <Outlet />
    </MotionConfig>
  ),
});
