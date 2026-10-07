import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, Outlet } from "@tanstack/react-router";
import { MotionSettings } from "@/components/effects/motion-config";
import { TopProgress } from "@/components/top-progress";

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: () => (
    <MotionSettings>
      <TopProgress />
      <Outlet />
    </MotionSettings>
  ),
});
