import type { AnalyticsRange } from "@edgeweir/contract";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { ChangeIndicator, OpenCardButton, OpenCardHint } from "@/components/analytics/panel";
import { RangeSelect } from "@/components/analytics/range-select";
import { Panel, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { m } from "@/lib/i18n";
import { workspaceLink } from "@/lib/workspace-link";

export function WorkspaceTraffic({
  range,
  ranges,
  setRange,
  href,
  children,
}: {
  range: AnalyticsRange;
  ranges?: readonly AnalyticsRange[];
  setRange: (range: AnalyticsRange) => void;
  href: string;
  children: ReactNode;
}) {
  return (
    <Panel className="@container/traffic pb-0" data-testid="workspace-traffic">
      <PanelHeader className="gap-2">
        <PanelTitle>{m.l4_stats_traffic()}</PanelTitle>
        <RangeSelect value={range} ranges={ranges} onChange={setRange} />
        <Link
          {...workspaceLink(href)}
          className="inline-flex min-h-7 items-center rounded-sm text-sm font-medium text-primary-ink hover:underline focus-ring pointer-coarse:min-h-11"
        >
          {m.scope_full_statistics()}
        </Link>
      </PanelHeader>
      <div className="divide-y divide-border">{children}</div>
    </Panel>
  );
}

export function TrafficMetricRow({
  label,
  value,
  change,
  better,
  note,
  onOpen,
  testId,
  children,
}: {
  label: string;
  value: ReactNode;
  change: number | null;
  better?: "up" | "down";
  note?: ReactNode;
  onOpen?: () => void;
  testId: string;
  children?: ReactNode;
}) {
  return (
    <section
      data-testid={testId}
      className="group/panel relative grid min-w-0 items-center gap-3 px-(--panel-pad) py-5 @[40rem]/traffic:grid-cols-[12rem_minmax(0,1fr)]"
    >
      {onOpen ? (
        <OpenCardButton label={m.analytics_details({ metric: label })} onOpen={onOpen} />
      ) : null}
      <div className="min-w-0 space-y-1">
        <h3 className="text-sm text-muted-foreground">{label}</h3>
        <div className="text-display font-medium readout" data-slot="metric-value">
          {value}
        </div>
        <ChangeIndicator change={change} better={better} />
        {note ? <div className="text-xs text-muted-foreground">{note}</div> : null}
      </div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: the full-row button is the keyboard target */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: the full-row button is the keyboard target */}
      <div className="relative min-w-0" onClick={onOpen}>
        {children}
      </div>
      {onOpen ? (
        <span className="pointer-events-none absolute top-4 right-4">
          <OpenCardHint />
        </span>
      ) : null}
    </section>
  );
}
