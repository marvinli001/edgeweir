import type * as React from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "good" | "warn" | "bad" | "idle";

const TONE: Record<StatusTone, string> = {
  good: "bg-state-good",
  warn: "bg-state-warn",
  bad: "bg-destructive",
  idle: "bg-muted-foreground/50",
};

/** A state dot; `pulse` marks live states. Always pair it with a text label. */
export function Dot({
  tone,
  pulse,
  small,
}: {
  tone: StatusTone;
  pulse?: boolean;
  small?: boolean;
}) {
  const size = small ? "size-1.5" : "size-2";
  return (
    <span className={cn("relative flex shrink-0", size)}>
      {pulse ? (
        <span
          className={cn(
            "absolute inline-flex size-full animate-ping rounded-full opacity-60 motion-reduce:hidden",
            TONE[tone],
          )}
        />
      ) : null}
      <span className={cn("relative inline-flex rounded-full", size, TONE[tone])} />
    </span>
  );
}

/** Dot plus label, e.g. a node's online state in a table. */
export function StatusDot({
  tone,
  pulse,
  children,
  ...props
}: React.ComponentProps<"span"> & { tone: StatusTone; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm whitespace-nowrap" {...props}>
      <Dot tone={tone} pulse={pulse} />
      {children}
    </span>
  );
}
