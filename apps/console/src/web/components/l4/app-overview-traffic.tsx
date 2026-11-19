import { LinesChart, SeriesLegend } from "@/components/analytics/breakdown-charts";
import { ChangeIndicator } from "@/components/analytics/panel";
import { TrafficMetricRow, WorkspaceTraffic } from "@/components/analytics/workspace-traffic";
import { useL4Stats } from "@/components/l4/app-stats";
import { EmptyState, QueryView } from "@/components/states";
import { relativeChange, SERIES_COLORS } from "@/lib/analytics";
import { formatBytes, formatCompact, m } from "@/lib/i18n";
import { L4_STATS_RANGES, type L4StatsRange, l4PlotPoints } from "@/lib/l4";

const METRICS = [
  { key: "connections", label: () => m.l4_stats_connections(), color: SERIES_COLORS[0] },
  { key: "refused", label: () => m.l4_stats_refused(), color: SERIES_COLORS[0] },
  { key: "peakConcurrent", label: () => m.l4_stats_peak(), color: SERIES_COLORS[0] },
] as const;
const TRANSFER = [
  { key: "bytesReceived", label: () => m.l4_stats_received(), color: SERIES_COLORS[1] },
  { key: "bytesSent", label: () => m.l4_stats_sent(), color: SERIES_COLORS[2] },
] as const;

export function L4OverviewTraffic({
  appId,
  range,
  setRange,
  statsHref,
}: {
  appId: string;
  range: L4StatsRange;
  setRange: (range: L4StatsRange) => void;
  statsHref: string;
}) {
  const { stats, previous } = useL4Stats(appId, range, true);
  return (
    <WorkspaceTraffic
      range={range}
      ranges={L4_STATS_RANGES}
      setRange={(next) => {
        if (next !== "30d") setRange(next);
      }}
      href={statsHref}
    >
      <QueryView query={stats}>
        {(data) => {
          const { totals } = data;
          if (
            !totals.connections &&
            !totals.refused &&
            !totals.peakConcurrent &&
            !totals.bytesReceived &&
            !totals.bytesSent
          ) {
            return (
              <div className="p-5">
                <EmptyState compact title={m.analytics_no_traffic()} />
              </div>
            );
          }
          const rows = l4PlotPoints(data);
          const earlier =
            previous.isPlaceholderData || stats.isPlaceholderData
              ? undefined
              : previous.data?.totals;
          const series = TRANSFER.map((item) => ({ ...item, label: item.label() }));
          return (
            <div className="divide-y divide-border" aria-busy={stats.isPlaceholderData}>
              {METRICS.map((metric) => (
                <TrafficMetricRow
                  key={metric.key}
                  label={metric.label()}
                  value={formatCompact(totals[metric.key])}
                  change={relativeChange(totals[metric.key], earlier?.[metric.key] ?? null)}
                  better={metric.key === "refused" ? "down" : undefined}
                  testId={`l4-overview-${metric.key}`}
                >
                  <LinesChart
                    data={rows}
                    series={[{ ...metric, label: metric.label() }]}
                    format={formatCompact}
                    range={range}
                    height={140}
                    label={metric.label()}
                  />
                </TrafficMetricRow>
              ))}
              <TrafficMetricRow
                label={m.l4_stats_traffic()}
                value={
                  <div className="space-y-2 text-sm font-normal">
                    {series.map((item) => (
                      <div key={item.key} className="flex flex-col gap-1">
                        <span className="text-xs text-muted-foreground">{item.label}</span>
                        <span className="text-display font-medium readout">
                          {formatBytes(totals[item.key])}
                        </span>
                        <ChangeIndicator
                          change={relativeChange(totals[item.key], earlier?.[item.key] ?? null)}
                        />
                      </div>
                    ))}
                  </div>
                }
                change={null}
                testId="l4-overview-traffic"
              >
                <SeriesLegend
                  mark="line"
                  series={series.map((item) => ({ ...item, value: formatBytes(totals[item.key]) }))}
                />
                <LinesChart
                  data={rows}
                  series={series}
                  format={formatBytes}
                  range={range}
                  height={140}
                  label={m.l4_stats_traffic()}
                />
              </TrafficMetricRow>
            </div>
          );
        }}
      </QueryView>
    </WorkspaceTraffic>
  );
}
