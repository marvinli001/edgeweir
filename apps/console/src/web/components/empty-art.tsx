import * as React from "react";
import { useLive } from "@/components/effects/use-live";
import { cn } from "@/lib/utils";

/**
 * The motif behind an empty state's icon: a request's route through the gateway (sites, purges,
 * certificates and anything general), a security checkpoint that lets one lane through (rules,
 * lists, bans, protection, sign-in methods) or nodes reporting to the console (clusters, nodes,
 * regions, DNS, probes, ports).
 */
export type EmptyArtKind = "route" | "checkpoint" | "node";

/** A tick ruler along the bottom edge, every 8 units with a longer tick every 32. */
const RULER = Array.from(
  { length: 29 },
  (_, index) => `M${8 + index * 8} ${index % 4 === 0 ? 85 : 87}V90`,
).join("");

const line = "stroke-muted-foreground/45";
const faint = "stroke-muted-foreground/30";

/** A small rack unit: a rounded box with two status lights. */
function Unit({ x, y, lit }: { x: number; y: number; lit?: boolean }) {
  return (
    <g>
      <rect x={x} y={y} width="26" height="16" rx="4" className={cn(line, "fill-card")} />
      <path d={`M${x + 14} ${y + 8}h7`} className={faint} />
      {lit ? (
        <>
          <circle cx={x + 7} cy={y + 8} r="2" className="fill-signal" data-anim="halo" />
          <circle cx={x + 7} cy={y + 8} r="2" className="fill-signal" data-anim="blink" />
        </>
      ) : (
        <circle cx={x + 7} cy={y + 8} r="2" className="fill-muted-foreground/45" />
      )}
    </g>
  );
}

/** The signal travelling along a straight lane: a dot with a short trail. */
function Pulse({ x, y, travel }: { x: number; y: number; travel: number }) {
  return (
    <g data-anim="travel" style={{ "--travel": `${travel}px` } as React.CSSProperties}>
      <path d={`M${x - 12} ${y}h10`} className="stroke-signal/45" />
      <circle cx={x} cy={y} r="2.5" className="fill-signal" />
    </g>
  );
}

const ART: Record<EmptyArtKind, React.ReactNode> = {
  // You → the gateway (the icon tile) → three origins behind it.
  route: (
    <>
      <circle cx="22" cy="48" r="6" className={line} />
      <circle cx="22" cy="48" r="2" className="fill-muted-foreground/60" />
      <path d="M28 48H98" className={line} />
      <path
        d="M142 48C166 48 170 26 192 26M142 48H192M142 48C166 48 170 70 192 70"
        className={faint}
      />
      {[20, 42, 64].map((y) => (
        <g key={y}>
          <rect x="192" y={y} width="26" height="12" rx="3" className={cn(line, "fill-card")} />
          <path d={`M198 ${y + 6}h2M203 ${y + 6}h2`} className={line} />
        </g>
      ))}
      <Pulse x={36} y={48} travel={56} />
    </>
  ),
  // Three lanes reach the checkpoint (the icon tile in a scanning ring); one goes through.
  checkpoint: (
    <>
      <path d="M8 26C44 26 52 30 76 33M8 70C44 70 52 66 76 63" className={faint} />
      <path d="M77 28v10M77 58v10" className={line} />
      <path d="M8 48H98M142 48H232" className={line} />
      <circle cx="120" cy="48" r="30" strokeDasharray="2 5" className={line} data-anim="spin" />
      <circle cx="120" cy="48" r="38" className="stroke-edge" />
      <Pulse x={156} y={48} travel={64} />
    </>
  ),
  // Four nodes report to the console (the icon tile); one is running now.
  node: (
    <>
      <path
        d="M42 22C72 22 70 48 98 48M42 74C72 74 70 48 98 48M198 22C168 22 170 48 142 48M198 74C168 74 170 48 142 48"
        className={faint}
      />
      <Unit x={16} y={14} />
      <Unit x={16} y={66} />
      <Unit x={198} y={14} lit />
      <Unit x={198} y={66} />
    </>
  ),
};

/**
 * An empty state's illustration: token strokes, one signal accent, a gentle loop that runs only
 * while it is on screen in a visible tab without reduced motion (styles: `.empty-art` in
 * index.css). Decorative; the empty state's title says what is missing.
 */
export function EmptyArt({ kind, className }: { kind: EmptyArtKind; className?: string }) {
  const ref = React.useRef<SVGSVGElement>(null);
  const live = useLive(ref);
  return (
    <svg
      ref={ref}
      viewBox="0 0 240 96"
      fill="none"
      aria-hidden="true"
      className={cn("empty-art", className)}
      data-kind={kind}
      data-live={live || undefined}
    >
      <path d={RULER} className="stroke-edge" />
      {ART[kind]}
    </svg>
  );
}
