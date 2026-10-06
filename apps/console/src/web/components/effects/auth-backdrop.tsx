/*
 * The sign-in and setup backdrop: a slow grain gradient (Paper Shaders, Apache-2.0) in the action
 * and signal colors over the canvas, with the land as a dot grid (generated with dotted-map, MIT).
 * Paper Shaders pauses itself off screen and in hidden tabs; under reduced motion it holds still
 * (speed 0 stops its loop). Lazy-loaded: only the auth pages pull in WebGL.
 */
import { GrainGradient } from "@paper-design/shaders-react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { tokenRgb, useTokens } from "./tokens";
import { WORLD_DOTS } from "./world-dots";

export default function AuthBackdrop() {
  const reduced = useReducedMotion();
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
    <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
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
        maxPixelCount={1600 * 1000}
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
