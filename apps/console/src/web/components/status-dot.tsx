import type * as React from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "good" | "warn" | "bad" | "idle";

const TONE: Record<StatusTone, string> = {
  good: "bg-state-good",
  warn: "bg-state-warn",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/50",
};

/** The glow of a live dot is its own color. */
const LIT: Record<StatusTone, string> = {
  good: "[--lit:var(--state-good)]",
  warn: "[--lit:var(--state-warn)]",
  bad: "[--lit:var(--destructive)]",
  idle: "[--lit:var(--muted-foreground)]",
};

/**
 * A state dot; `pulse` marks live states (something running now), which also glow and pulse (a
 * pseudo-element; not under reduced motion). `glow` lights a live state without the pulse, for
 * polled lists and pages where nothing loops (a node online in the node list). Always pair it
 * with a text label. The transparent border shows as a ring in forced colors, where the fill is
 * dropped.
 */
export function Dot({
  tone,
  pulse,
  glow,
  small,
}: {
  tone: StatusTone;
  pulse?: boolean;
  glow?: boolean;
  small?: boolean;
}) {
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 rounded-full border border-transparent",
        small ? "size-1.5" : "size-2",
        TONE[tone],
        (pulse || glow) && cn("lit-glow", LIT[tone]),
        pulse && "dot-pulse",
      )}
    />
  );
}

/** The signal light of a live view (data that refreshes by itself), with its word. */
export function LiveDot({ label, className }: { label: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground",
        className,
      )}
    >
      <span className="lit-glow dot-pulse relative inline-flex size-1.5 shrink-0 rounded-full border border-transparent bg-signal" />
      {label}
    </span>
  );
}

/** Dot plus label, e.g. a node's online state in a table. */
export function StatusDot({
  tone,
  pulse,
  glow,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone: StatusTone; pulse?: boolean; glow?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap" {...props}>
      <Dot tone={tone} pulse={pulse} glow={glow} />
      {children}
    </span>
  );
}
