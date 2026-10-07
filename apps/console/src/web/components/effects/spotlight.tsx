/*
 * Spotlight: adapted from Motion Primitives (MIT, ibelick; THIRD-PARTY-NOTICES.md). Changes: the
 * light is the --spotlight token, it only runs for a fine hovering pointer without reduced motion,
 * and it no longer restyles its parent (the parent is positioned and clips).
 */
import { type SpringOptions, useSpring, useTransform } from "motion/react";
import * as motion from "motion/react-m";
import * as React from "react";
import { useReducedMotion } from "@/hooks/use-reduced-motion";
import { cn } from "@/lib/utils";
import { useFinePointer } from "./use-live";

export function Spotlight({
  className,
  size = 360,
  springOptions = { bounce: 0, duration: 0.25 },
}: {
  className?: string;
  size?: number;
  springOptions?: SpringOptions;
}) {
  const fine = useFinePointer();
  const reduced = useReducedMotion();
  if (!fine || reduced) return null;
  return <Light className={className} size={size} springOptions={springOptions} />;
}

function Light({
  className,
  size,
  springOptions,
}: {
  className?: string;
  size: number;
  springOptions: SpringOptions;
}) {
  const ref = React.useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = React.useState(false);
  const x = useSpring(0, springOptions);
  const y = useSpring(0, springOptions);
  const left = useTransform(x, (value) => `${value - size / 2}px`);
  const top = useTransform(y, (value) => `${value - size / 2}px`);

  React.useEffect(() => {
    const parent = ref.current?.parentElement;
    if (!parent) return;
    const controller = new AbortController();
    const { signal } = controller;
    parent.addEventListener(
      "pointermove",
      (event) => {
        const bounds = parent.getBoundingClientRect();
        x.set(event.clientX - bounds.left);
        y.set(event.clientY - bounds.top);
      },
      { signal },
    );
    parent.addEventListener("pointerenter", () => setHovered(true), { signal });
    parent.addEventListener("pointerleave", () => setHovered(false), { signal });
    return () => controller.abort();
  }, [x, y]);

  return (
    <motion.div
      ref={ref}
      aria-hidden
      className={cn(
        "pointer-events-none absolute z-0 rounded-full bg-[radial-gradient(circle_at_center,var(--spotlight),transparent_68%)] transition-opacity duration-300",
        hovered ? "opacity-100" : "opacity-0",
        className,
      )}
      style={{ width: size, height: size, left, top }}
    />
  );
}
