import * as React from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";

function subscribeVisibility(onChange: () => void) {
  document.addEventListener("visibilitychange", onChange);
  return () => document.removeEventListener("visibilitychange", onChange);
}

/** Whether the tab is in front. */
export function usePageVisible(): boolean {
  return React.useSyncExternalStore(
    subscribeVisibility,
    () => document.visibilityState === "visible",
    () => true,
  );
}

/** Whether the element is (partly) in the viewport. */
export function useInViewport(ref: React.RefObject<Element | null>, margin = "64px"): boolean {
  const [visible, setVisible] = React.useState(false);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: margin },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, margin]);
  return visible;
}

/**
 * Whether a continuous animation (a canvas or WebGL loop) may run: the element is on screen, the
 * tab is in front and the user has not asked for reduced motion. Loops stop when it turns false.
 */
export function useLive(ref: React.RefObject<Element | null>): boolean {
  const reduced = useReducedMotion();
  const visible = usePageVisible();
  const inView = useInViewport(ref);
  return !reduced && visible && inView;
}

/** Device pixel ratio for canvases, capped (2 by default) so large screens stay cheap. */
export function cappedDpr(max = 2): number {
  return Math.min(max, Math.max(1, window.devicePixelRatio || 1));
}

/** Whether the device has a fine pointer that can hover (spotlight and tilt only run there). */
export function useFinePointer(): boolean {
  return React.useSyncExternalStore(
    (onChange) => {
      const query = window.matchMedia("(hover: hover) and (pointer: fine)");
      query.addEventListener("change", onChange);
      return () => query.removeEventListener("change", onChange);
    },
    () => window.matchMedia("(hover: hover) and (pointer: fine)").matches,
    () => false,
  );
}
