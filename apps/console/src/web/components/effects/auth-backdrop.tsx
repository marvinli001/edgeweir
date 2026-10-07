/*
 * The sign-in and setup backdrop: a slow grain gradient (Paper Shaders, Apache-2.0) in the action
 * and signal colors over the canvas, with the land as a dot grid (generated with dotted-map, MIT).
 * Paper Shaders pauses itself off screen and in hidden tabs; under reduced motion it holds still
 * (speed 0 stops its loop). It renders at the device's pixel ratio unless a pixel budget caps it:
 * the budget is the backdrop's area at a ratio of at most 2 (cappedDpr). Lazy-loaded: only the
 * auth pages pull in WebGL.
 */
import { GrainGradient } from "@paper-design/shaders-react";
import * as React from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { tokenRgb, useTokens } from "./tokens";
import { cappedDpr } from "./use-live";
import { WORLD_DOTS } from "./world-dots";

/** Paper Shaders' own ceiling (about a 1600 × 1000 canvas). */
const MAX_PIXELS = 1600 * 1000;

/** The canvas pixel budget of an element: its CSS area at the capped pixel ratio, squared. */
function usePixelBudget(ref: React.RefObject<HTMLElement | null>): number {
  const [budget, setBudget] = React.useState(MAX_PIXELS);
  React.useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const { width, height } = element.getBoundingClientRect();
      const dpr = cappedDpr();
      setBudget(Math.max(1, Math.min(MAX_PIXELS, Math.round(width * height * dpr * dpr))));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return budget;
}

export default function AuthBackdrop() {
  const reduced = useReducedMotion();
  const ref = React.useRef<HTMLDivElement>(null);
  const budget = usePixelBudget(ref);
  const palette = useTokens(() => ({
    back: tokenRgb("--canvas"),
    colors: [
      tokenRgb("--primary", 0.5),
      tokenRgb("--signal", 0.38),
      tokenRgb("--canvas", 1),
      tokenRgb("--primary", 0.22),
    ],
  }));
  return (
    <div
      ref={ref}
      aria-hidden
      className="pointer-events-none absolute inset-0 -z-10 overflow-hidden"
    >
      <GrainGradient
        className="absolute inset-0 opacity-70 dark:opacity-90"
        colorBack={palette.back}
        colors={palette.colors}
        shape="wave"
        softness={0.9}
        intensity={0.22}
        noise={0.16}
        scale={1.4}
        rotation={18}
        speed={reduced ? 0 : 0.16}
        minPixelRatio={1}
        maxPixelCount={budget}
      />
      <svg
        aria-hidden
        viewBox={`0 0 ${WORLD_DOTS.width} ${WORLD_DOTS.height}`}
        preserveAspectRatio="xMidYMid slice"
        className="absolute inset-0 size-full [mask-image:radial-gradient(ellipse_70%_60%_at_50%_45%,black,transparent)]"
      >
        <path
          d={WORLD_DOTS.path}
          stroke="var(--foreground)"
          strokeOpacity={0.14}
          strokeWidth={0.42}
          strokeLinecap="round"
        />
      </svg>
      <div className="grain absolute inset-0 [--grain-opacity:0.06]" />
    </div>
  );
}
