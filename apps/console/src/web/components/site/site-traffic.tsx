import type { AnalyticsRange } from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { LinesChart, SeriesLegend } from "@/components/analytics/breakdown-charts";
import { type DetailTarget, MetricDetailDialog } from "@/components/analytics/detail-dialog";
import { TrafficMetricRow, WorkspaceTraffic } from "@/components/analytics/workspace-traffic";
import { EmptyState, QueryView } from "@/components/states";
import { useDialogState } from "@/hooks/use-dialog-state";
import {
  detailViews,
  METRICS,
  relativeChange,
  SERIES_COLORS,
  STATUS_CLASSES,
} from "@/lib/analytics";
import { formatBitRate, formatCompact, formatNumber, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const TRAFFIC_METRICS = METRICS.filter((metric) =>
  ["requests", "data-transfer", "hit-ratio"].includes(metric.id),
);
const ERRORS = STATUS_CLASSES.filter(
  (series) => series.key === "status4xx" || series.key === "status5xx",
);

export function SiteTraffic({
  siteId,
  range,
  setRange,
  analyticsHref,
}: {
  siteId: string;
  range: AnalyticsRange;
  setRange: (range: AnalyticsRange) => void;
  analyticsHref: string;
}) {
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { siteId, range } }),
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
    meta: { background: true },
  });
  const detail = useDialogState<DetailTarget>();
  return (
    <>
      <WorkspaceTraffic range={range} setRange={setRange} href={analyticsHref}>
        <QueryView query={traffic}>
          {({ totals, previous, points, bucketSeconds }) => {
            if (!totals.requests && !totals.bytesSent) {
              return (
                <div className="p-5">
                  <EmptyState compact title={m.analytics_no_traffic()} />
                </div>
              );
            }
            const errorCount = totals.status4xx + totals.status5xx;
            const errorTitle = m.scope_error_responses();
            return (
              <div className="divide-y divide-border" aria-busy={traffic.isPlaceholderData}>
                {TRAFFIC_METRICS.map((metric) => {
                  const total = metric.total(totals);
                  const label = metric.title();
                  const note =
                    metric.id === "data-transfer"
                      ? m.scope_peak_bandwidth({ value: formatBitRate(totals.peakBytesPerSecond) })
                      : metric.id === "hit-ratio"
                        ? m.scope_cache_hits({ count: formatNumber(totals.cacheHits) })
                        : undefined;
                  return (
                    <TrafficMetricRow
                      key={metric.id}
                      testId={`site-overview-${metric.id}`}
                      label={label}
                      value={total === null ? "—" : metric.format(total)}
                      change={relativeChange(total, metric.total(previous))}
                      better={metric.id === "hit-ratio" ? "up" : undefined}
                      note={note}
                      onOpen={() =>
                        detail.show({
                          id: metric.id,
                          title: label,
                          metric,
                          views: detailViews(metric.details, { site: false, node: true }),
                        })
                      }
                    >
                      <LinesChart
                        data={points.map((point) => ({
                          time: point.time,
                          value: metric.point(point, bucketSeconds),
                        }))}
                        series={[{ key: "value", label, color: SERIES_COLORS[0] }]}
                        format={metric.format}
                        range={range}
                        domain={metric.domain}
                        label={label}
                        height={140}
                      />
                    </TrafficMetricRow>
                  );
                })}
                <TrafficMetricRow
                  testId="site-overview-errors"
                  label={errorTitle}
                  value={formatCompact(errorCount)}
                  change={relativeChange(errorCount, previous.status4xx + previous.status5xx)}
                  better="down"
                  note={
                    totals.requests
                      ? formatPercent((errorCount * 100) / totals.requests)
                      : undefined
                  }
                  onOpen={() =>
                    detail.show({
                      id: "status-codes",
                      title: errorTitle,
                      views: [{ kind: "status" }],
                    })
                  }
                >
                  <SeriesLegend
                    mark="line"
                    series={ERRORS.map((series) => ({
                      ...series,
                      value: formatCompact(totals[series.key]),
                    }))}
                  />
                  <LinesChart
                    data={points}
                    series={[...ERRORS]}
                    format={formatCompact}
                    range={range}
                    label={errorTitle}
                    height={140}
                  />
                </TrafficMetricRow>
              </div>
            );
          }}
        </QueryView>
      </WorkspaceTraffic>
      <MetricDetailDialog
        target={detail.value ?? null}
        open={detail.open}
        onOpenChange={detail.onOpenChange}
        range={range}
        onRangeChange={setRange}
        siteId={siteId}
        traffic={traffic.data}
        showParent
      />
    </>
  );
}
