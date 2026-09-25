import { ArrowDownRight01Icon, ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import type * as React from "react";
import { AnimatedValue } from "@/components/appica/effects";
import { formatPercent, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** The flat, hairline-bordered surface every analytics card sits on. */
export function Panel({ className, ...props }: React.ComponentProps<"section">) {
  return (
    <section
      className={cn(
        "relative flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card text-card-foreground",
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

/** Title, headline value with its change, and a chart underneath. */
export function MetricCard({
  title,
  value,
  change,
  better,
  size,
  children,
  testId,
}: {
  title: string;
  value: string;
  change: number | null;
  better: "up" | "down";
  size: "lg" | "sm";
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <Panel data-testid={testId} className={size === "lg" ? "h-64" : "h-52 @3xl/main:h-60"}>
      <PanelHeader title={title} />
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 pt-1">
        <span className="text-2xl font-semibold tracking-tight" data-slot="metric-value">
          <AnimatedValue value={value} />
        </span>
        <ChangeIndicator change={change} better={better} />
      </div>
      <div className={cn("min-h-0 flex-1", size === "lg" ? "px-4 pt-3 pb-3" : "pt-3")}>
        {children}
      </div>
    </Panel>
  );
}
