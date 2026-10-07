/*
 * Animated Beam: adapted from Magic UI (MIT, Magic UI; THIRD-PARTY-NOTICES.md). Changes: the
 * colors are tokens (muted hairline track, signal pulse), `dim` draws a dashed idle track instead, the
 * pulse rests between runs (`repeatDelay`), `runs` limits how often it runs (beams on polled pages
 * run once and again only when `replayKey` changes, then rest as a still line), it only runs while
 * the beam is on screen, the tab is in front and motion is allowed (otherwise a still pulse sits on
 * the track), and the path is measured in the container's own coordinates, again whenever an
 * endpoint resizes or an entrance animation inside the container ends.
 */
import * as motion from "motion/react-m";
import * as React from "react";
import { cn } from "@/lib/utils";
import { useLive } from "./use-live";

interface Geometry {
  width: number;
  height: number;
  path: string;
}

const NONE: Geometry = { width: 0, height: 0, path: "" };

export function AnimatedBeam({
  containerRef,
  fromRef,
  toRef,
  curvature = 0,
  reverse = false,
  duration = 3.2,
  delay = 0,
  repeatDelay = 2.4,
  runs = Number.POSITIVE_INFINITY,
  replayKey,
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
  /** Seconds the pulse rests before it runs again. */
  repeatDelay?: number;
  /**
   * How many times the pulse runs once the beam is live (default: for as long as it is live).
   * With a finite count the beam then rests as a still line until `replayKey` changes.
   */
  runs?: number;
  /** Runs the pulse again (`runs` times) whenever it changes, e.g. a link's state. */
  replayKey?: React.Key;
  /** An idle link: dashed, no pulse. */
  dim?: boolean;
  className?: string;
}) {
  const id = `beam${React.useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const svg = React.useRef<SVGSVGElement>(null);
  const live = useLive(svg);
  const [geometry, setGeometry] = React.useState<Geometry>(NONE);

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const update = () => {
      const from = fromRef.current;
      const to = toRef.current;
      if (!from || !to) return;
      const box = container.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return;
      // Layout size, not the painted box: an ancestor's transform (a dialog zooming in) scales
      // the rectangles, so offsets are scaled back into the container's own pixels.
      const width = container.offsetWidth;
      const height = container.offsetHeight;
      const sx = width / box.width;
      const sy = height / box.height;
      const center = (element: HTMLElement): [number, number] => {
        const rect = element.getBoundingClientRect();
        return [
          (rect.left - box.left + rect.width / 2) * sx - container.clientLeft,
          (rect.top - box.top + rect.height / 2) * sy - container.clientTop,
        ];
      };
      const [startX, startY] = center(from);
      const [endX, endY] = center(to);
      const path = `M ${startX},${startY} Q ${(startX + endX) / 2},${startY - curvature} ${endX},${endY}`;
      setGeometry((previous) =>
        previous.width === width && previous.height === height && previous.path === path
          ? previous
          : { width, height, path },
      );
    };
    const observer = new ResizeObserver(update);
    // The endpoints and their boxes too: a row that grows (a name arriving) moves its anchor.
    for (const element of [
      container,
      fromRef.current,
      toRef.current,
      fromRef.current?.parentElement,
      toRef.current?.parentElement,
    ]) {
      if (element) observer.observe(element);
    }
    // Rows entering with animate-enter are measured mid-slide; measure again once they land.
    container.addEventListener("animationend", update);
    container.addEventListener("transitionend", update);
    update();
    return () => {
      observer.disconnect();
      container.removeEventListener("animationend", update);
      container.removeEventListener("transitionend", update);
    };
  }, [containerRef, fromRef, toRef, curvature]);

  // A finite beam plays its runs once per replay key, and again when it lights up after idling.
  const finite = Number.isFinite(runs);
  const token = String(replayKey ?? "");
  const [played, setPlayed] = React.useState<string | null>(null);
  React.useEffect(() => {
    if (dim) setPlayed(null);
  }, [dim]);
  const playing = live && (!finite || played !== token);
  const travel = reverse
    ? { x1: ["90%", "-10%"], x2: ["100%", "0%"] }
    : { x1: ["10%", "110%"], x2: ["0%", "100%"] };
  // After its runs the pulse has left the track at the far end: a still line remains.
  const gone = reverse ? { x1: "-10%", x2: "0%" } : { x1: "110%", x2: "100%" };
  const still = { x1: "60%", x2: "40%" };
  const { width, height, path } = geometry;

  return (
    <svg
      ref={svg}
      aria-hidden
      fill="none"
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn("pointer-events-none absolute top-0 left-0", className)}
    >
      <path
        d={path}
        strokeWidth={dim ? 1.25 : 1.5}
        strokeLinecap="round"
        strokeDasharray={dim ? "3 5" : undefined}
        style={{
          stroke: "var(--muted-foreground)",
          opacity: dim ? 0.5 : 0.3,
        }}
      />
      {dim ? null : (
        <>
          <path d={path} strokeWidth={1.75} strokeLinecap="round" stroke={`url(#${id})`} />
          <defs>
            <motion.linearGradient
              id={id}
              gradientUnits="userSpaceOnUse"
              initial={{ x1: "10%", x2: "0%", y1: "0%", y2: "0%" }}
              animate={playing ? travel : finite && played === token ? gone : still}
              transition={
                playing
                  ? {
                      delay,
                      duration,
                      ease: [0.16, 1, 0.3, 1],
                      repeat: finite ? Math.max(0, runs - 1) : Number.POSITIVE_INFINITY,
                      repeatDelay,
                    }
                  : { duration: 0 }
              }
              onAnimationComplete={() => {
                if (playing && finite) setPlayed(token);
              }}
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
