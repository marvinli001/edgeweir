import { useIsFetching, useIsMutating } from "@tanstack/react-query";
import { useRouterState } from "@tanstack/react-router";
import * as React from "react";
import { cn } from "@/lib/utils";

/** Show only work that takes longer than this, so fast responses don't flicker. */
const SHOW_AFTER_MS = 150;

/**
 * 2px indeterminate bar at the top of the viewport while a route loads, a query fetches or a
 * mutation runs: a primary sweep with a glow (progress-glow), a still bar under reduced motion.
 * Background polling (`meta: { background: true }`) of already-loaded data is ignored.
 */
export function TopProgress() {
  const routing = useRouterState({ select: (s) => s.status === "pending" });
  const fetching = useIsFetching({
    predicate: (query) => !(query.meta?.background === true && query.state.data !== undefined),
  });
  const mutating = useIsMutating();
  const active = routing || fetching > 0 || mutating > 0;
  const [visible, setVisible] = React.useState(false);

  React.useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = setTimeout(() => setVisible(true), SHOW_AFTER_MS);
    return () => clearTimeout(timer);
  }, [active]);

  return (
    <div
      aria-hidden="true"
      data-testid="top-progress"
      data-active={visible || undefined}
      className={cn(
        // Taller than the bar, so its glow shows below it; the sweep stays clipped sideways.
        "pointer-events-none fixed inset-x-0 top-0 z-60 h-2 overflow-hidden opacity-0 transition-opacity duration-300",
        "data-active:opacity-100",
      )}
    >
      <div className="h-0.5 w-full origin-left animate-progress-sweep rounded-full progress-glow" />
    </div>
  );
}
