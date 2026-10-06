/*
 * Animated Beam: adapted from Magic UI (MIT, Magic UI; THIRD-PARTY-NOTICES.md). Changes: the
 * colors are tokens (hairline track, signal pulse), `dim` draws a dashed idle track instead, and
 * the pulse only runs while the beam is on screen and motion is allowed (otherwise a still pulse
 * sits on the track).
 */
import { motion } from "motion/react";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useLive } from "./use-live";

export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 3.2,
  delay = 0,
  dim = false,
  className,
}: {
  containerRef: React.RefObject<HTMLElement | null>;
  fromRef: React.RefObject<HTMLElement | null>;
  toRef: React.RefObject<HTMLElement | null>;
  curvature?: number;
  reverse?: boolean;
  duration?: number;
  delay?: number;
  /** An idle link: dashed, no pulse. */
  dim?: boolean;
  className?: string;
}) {
  const id = `beam${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svg = React.useRef<SVGSVGElement>(null);
  const live = useLive(svg);
  const [path, setPath] = React.useState("");
  const [size, setSize] = React.useState({ width: 0, height: 0 });

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const from = fromRef.current;
      const to = toRef.current;
      if (!from || !to) return;
      const box = container.getBoundingClientRect();
      const a = from.getBoundingClientRect();
      const b = to.getBoundingClientRect();
      setSize({ width: box.width, height: box.height });
      const startX = a.left - box.left + a.width / 2;
      const startY = a.top - box.top + a.height / 2;
      const endX = b.left - box.left + b.width / 2;
      const endY = b.top - box.top + b.height / 2;
      setPath(
        `M ${startX},${startY} Q ${(startX + endX) / 2},${startY - curvature} ${endX},${endY}`,
      );
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    update();
    return () => observer.disconnect();
  }, [containerRef, fromRef, toRef, curvature]);

  const travel = reverse
    ? { x1: ["90%", "-10%"], x2: ["100%", "0%"] }
    : { x1: ["10%", "110%"], x2: ["0%", "100%"] };

  return (
    <svg
      ref={svg}
      aria-hidden
      fill="none"
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      className={cn("pointer-events-none absolute top-0 left-0", className)}
    >
      <path
        d={path}
        strokeWidth={dim ? 1.25 : 1.5}
        strokeLinecap="round"
        strokeDasharray={dim ? "3 5" : undefined}
        style={{
          stroke: dim ? "var(--muted-foreground)" : "var(--border)",
          opacity: dim ? 0.5 : 1,
        }}
      />
      {dim ? null : (
        <>
          <path d={path} strokeWidth={2} strokeLinecap="round" stroke={`url(#${id})`} />
          <defs>
            <motion.linearGradient
              id={id}
              gradientUnits="userSpaceOnUse"
              initial={{ x1: "10%", x2: "0%", y1: "0%", y2: "0%" }}
              animate={live ? travel : { x1: "60%", x2: "40%" }}
              transition={
                live
                  ? { delay, duration, ease: [0.16, 1, 0.3, 1], repeat: Number.POSITIVE_INFINITY }
                  : { duration: 0 }
              }
            >
              <stop style={{ stopColor: "var(--signal)", stopOpacity: 0 }} />
              <stop style={{ stopColor: "var(--signal)" }} />
              <stop offset="32.5%" style={{ stopColor: "var(--primary)" }} />
              <stop offset="100%" style={{ stopColor: "var(--primary)", stopOpacity: 0 }} />
            </motion.linearGradient>
          </defs>
        </>
      )}
    </svg>
  );
}
