/*
 * The edge network on a globe (cobe 2, MIT, Shu Ding): a marker per edge location colored by its
 * health, sized by its share of the nodes. Colors come from tokens and follow the theme. The globe turns only while it is on screen, the tab is in front and motion is allowed;
 * otherwise it holds one frame. Lazy-loaded with the overview.
 */
import createGlobe, { type COBEOptions, type Globe } from "cobe";
import * as React from "react";
import { cn } from "@/lib/utils";
import { tokenVec3, useThemeKey } from "./tokens";
import { cappedDpr, useLive } from "./use-live";

export type GlobeTone = "good" | "warn" | "bad";

export interface GlobeMarker {
  id: string;
  location: [number, number];
  tone: GlobeTone;
  /** 0–1: how much of the network sits here (marker size). */
  weight: number;
  label: string;
}

const TONE_TOKEN: Record<GlobeTone, `--${string}`> = {
  good: "--state-good",
  warn: "--state-warn",
  bad: "--destructive",
};

/** Turns a longitude into the globe's rotation that faces it. */
const facing = (longitude: number) => Math.PI - ((longitude * Math.PI) / 180 - Math.PI / 2);

const SPIN = 0.0024;

const scale = (rgb: [number, number, number], k: number): [number, number, number] => [
  rgb[0] * k,
  rgb[1] * k,
  rgb[2] * k,
];

export default function EdgeGlobe({
  markers,
  focus = 105,
  className,
}: {
  markers: GlobeMarker[];
  /** Longitude facing the viewer at first. */
  focus?: number;
  className?: string;
}) {
  const wrap = React.useRef<HTMLDivElement>(null);
  // cobe wraps its canvas in a div of its own (for the marker anchors), so the canvas lives in a
  // host that React leaves alone.
  const host = React.useRef<HTMLDivElement>(null);
  const globe = React.useRef<Globe | null>(null);
  const phi = React.useRef(facing(focus));
  const drag = React.useRef<{ x: number; phi: number } | null>(null);
  const live = useLive(wrap);
  const theme = useThemeKey();
  const [size, setSize] = React.useState(0);

  React.useEffect(() => {
    const element = wrap.current;
    if (!element) return;
    const observer = new ResizeObserver(([entry]) => {
      setSize(Math.round(entry?.contentRect.width ?? 0));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // (Re)create the globe for a size and theme; the markers are updated in place below.
  React.useEffect(() => {
    const parent = host.current;
    if (!parent || size === 0) return;
    const element = document.createElement("canvas");
    element.setAttribute("aria-hidden", "true");
    element.className = "globe-canvas";
    parent.append(element);
    const dark = theme === "dark";
    // cobe multiplies width and height by devicePixelRatio itself: pass CSS pixels, so the
    // backing store is size × the capped ratio (not its square).
    const options: COBEOptions = {
      devicePixelRatio: cappedDpr(),
      width: size,
      height: size,
      phi: phi.current,
      theta: 0.28,
      dark: dark ? 1 : 0,
      diffuse: dark ? 1.6 : 1.15,
      mapSamples: 14000,
      mapBrightness: dark ? 7 : 7,
      mapBaseBrightness: dark ? 0.04 : 0,
      baseColor: dark ? scale(tokenVec3("--muted-foreground"), 0.42) : tokenVec3("--card"),
      markerColor: tokenVec3("--signal"),
      glowColor: dark ? tokenVec3("--primary") : tokenVec3("--canvas"),
      markerElevation: 0.015,
      opacity: dark ? 0.92 : 1,
      markers: [],
    };
    globe.current = createGlobe(element, options);
    const shown = requestAnimationFrame(() => element.setAttribute("data-ready", ""));
    // The land texture decodes after the first frame; a still globe (reduced motion, off screen)
    // draws a few more frames so it does not stay blank.
    const settle = [120, 400, 1000].map((delay) =>
      setTimeout(() => globe.current?.update({ phi: phi.current }), delay),
    );
    return () => {
      cancelAnimationFrame(shown);
      for (const timer of settle) clearTimeout(timer);
      globe.current?.destroy();
      globe.current = null;
      parent.replaceChildren();
    };
  }, [size, theme]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: theme re-reads the tone tokens.
  React.useEffect(() => {
    globe.current?.update({
      markers: markers.map((marker) => ({
        id: marker.id,
        location: marker.location,
        size: 0.035 + marker.weight * 0.05,
        color: tokenVec3(TONE_TOKEN[marker.tone]),
      })),
      phi: phi.current,
    });
  }, [markers, size, theme]);

  // The turn: only while live; a drag turns it by hand either way.
  React.useEffect(() => {
    if (!live) return;
    let frame = 0;
    const tick = () => {
      if (!drag.current) phi.current += SPIN;
      globe.current?.update({ phi: phi.current });
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [live]);

  return (
    <div
      ref={wrap}
      className={cn("relative aspect-square w-full touch-none select-none", className)}
    >
      <div
        ref={host}
        className="size-full cursor-grab active:cursor-grabbing"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, phi: phi.current };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current || size === 0) return;
          phi.current = drag.current.phi + ((event.clientX - drag.current.x) / size) * Math.PI;
          if (!live) globe.current?.update({ phi: phi.current });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      />
      {/* Labels pinned to the markers by CSS anchor positioning (browsers without it skip them). */}
      {markers.map((marker) => (
        <span
          key={marker.id}
          className="globe-label"
          style={
            {
              positionAnchor: `--cobe-${marker.id}`,
              "--visible": `var(--cobe-visible-${marker.id}, 0)`,
            } as React.CSSProperties
          }
        >
          {marker.label}
        </span>
      ))}
    </div>
  );
}
