import type { TrafficPoint } from "@edgeweir/contract";
import { useState } from "react";
import { MetricChart } from "@/components/analytics/metric-chart";
import { MetricCard } from "@/components/analytics/panel";
import { FlowNumber } from "@/components/effects/number-flow";
import { LiveDot } from "@/components/status-dot";
import { formatClockTime, formatCompact, m } from "@/lib/i18n";

export function RequestRateCard({
  points,
  seconds,
  title,
  live = false,
}: {
  points: TrafficPoint[];
  seconds: number;
  title: string;
  live?: boolean;
}) {
  const [reading, setReading] = useState<number | null>(null);
  const active = reading === null ? undefined : points[reading];
  const shown = active ?? points.at(-1);
  return (
    <MetricCard
      title={title}
      testId="live-requests"
      aside={live ? <LiveDot label={m.overview_live()} /> : undefined}
      value={
        shown ? (
          <>
            <FlowNumber
              value={Math.round(shown.requests / seconds)}
              suffix={m.overview_per_second()}
            />
            {active ? (
              <span className="ms-2 text-xs font-normal text-muted-foreground">
                {formatClockTime(active.time)}
              </span>
            ) : null}
          </>
        ) : (
          "—"
        )
      }
    >
      {points.some((p) => p.requests > 0) ? (
        <MetricChart
          data={points.map((p) => ({ time: p.time, value: p.requests / seconds }))}
          label={title}
          format={(n) => `${formatCompact(n)}${m.overview_per_second()}`}
          range="1h"
          onRead={live ? setReading : undefined}
        />
      ) : null}
    </MetricCard>
  );
}
