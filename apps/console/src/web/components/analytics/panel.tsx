import {
  ArrowDownRight01Icon,
  ArrowExpandDiagonal01Icon,
  ArrowUpRight01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { AnimatedValue } from "@/components/appica/effects";
import { formatPercent, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The lit card every analytics panel sits on (ring, soft shadow, top-lit edge in dark mode). */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-2xl bg-card text-card-foreground shadow-elev-1 edge-lit",
        className,
      )}
      {...props}
    />
  );
}

export function PanelHeader({
  title,
  aside,
  className,
}: {
  title: React.ReactNode;
  aside?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-h-5 items-center justify-between gap-2 px-4 pt-3.5", className)}>
      <h3 className="truncate text-[13px] text-muted-foreground">{title}</h3>
      {aside}
    </div>
  );
}

/** "↗ 50.3%" against the previous period, green or red by whether that direction is good. */
export function ChangeIndicator({
  change,
  better,
}: {
  change: number | null;
  better: "up" | "down";
}) {
  if (change === null || !Number.isFinite(change)) return null;
  const text = formatPercent(Math.abs(change) * 100);
  if (text === formatPercent(0)) {
    return (
      <span
        className="text-xs font-medium tabular-nums text-muted-foreground"
        title={m.analytics_change({ change: text })}
      >
        {text}
      </span>
    );
  }
  const up = change > 0;
  const signed = `${up ? "+" : "−"}${text}`;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-0.5 text-xs font-medium tabular-nums",
        up === (better === "up") ? "text-delta-good" : "text-delta-bad",
      )}
      title={m.analytics_change({ change: signed })}
    >
      <HugeiconsIcon
        icon={up ? ArrowUpRight01Icon : ArrowDownRight01Icon}
        strokeWidth={2}
        className="size-3.5"
      />
      <span className="sr-only">{m.analytics_change({ change: signed })}</span>
      <span aria-hidden>{text}</span>
    </span>
  );
}

/**
 * The whole card opens `onOpen` (its breakdown dialog), through a button stretched under the
 * chart: the chart stays above it for its tooltip and forwards clicks itself.
 */
export function OpenCardButton({ label, onOpen }: { label: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onOpen}
      className="absolute inset-0 cursor-pointer rounded-[inherit] outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      data-slot="card-open"
    />
  );
}

/** Shown on hover, so the card reads as something that opens. */
export function OpenCardHint() {
  return (
    <HugeiconsIcon
      icon={ArrowExpandDiagonal01Icon}
      strokeWidth={2}
      className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/panel:opacity-100 group-has-focus-visible/panel:opacity-100"
      aria-hidden
    />
  );
}

/** Title, headline value with its change, and a chart underneath. */
export function MetricCard({
  title,
  value,
  change,
  better,
  size,
  onOpen,
  children,
  testId,
}: {
  title: string;
  value: string;
  change: number | null;
  better: "up" | "down";
  size: "lg" | "sm";
  onOpen?: () => void;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Panel
      data-testid={testId}
      className={cn(
        size === "lg" ? "h-64" : "h-52 @3xl/main:h-60",
        onOpen &&
          "group/panel transition-shadow duration-200 ease-lit hover:shadow-elev-2 motion-reduce:transition-none",
      )}
    >
      {onOpen ? (
        <OpenCardButton label={m.analytics_details({ metric: title })} onOpen={onOpen} />
      ) : null}
      <PanelHeader title={title} aside={onOpen ? <OpenCardHint /> : undefined} />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 pt-1">
        <span className="text-2xl font-semibold tracking-tight" data-slot="metric-value">
          <AnimatedValue value={value} />
        </span>
        <ChangeIndicator change={change} better={better} />
      </div>
      <div
        className={cn(
          "relative min-h-0 flex-1",
          size === "lg" ? "px-4 pt-3 pb-3" : "pt-3",
          onOpen && "cursor-pointer",
        )}
      >
        {children}
      </div>
    </Panel>
  );
}
