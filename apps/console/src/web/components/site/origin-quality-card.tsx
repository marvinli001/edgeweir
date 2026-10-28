import type { AnalyticsRange, OriginQuality, OriginQualityItem } from "@edgeweir/contract";
import { ORIGIN_HEADER_TIME_BOUNDS_MS } from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  type ChartRow,
  LinesChart,
  type Series,
  SeriesLegend,
  seriesColor,
  useSeriesSlots,
} from "@/components/analytics/breakdown-charts";
import { RangeSelect } from "@/components/analytics/range-select";
import { Badge } from "@/components/arc/badge/badge";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, QueryView } from "@/components/states";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatNumber, formatPercent, m } from "@/lib/i18n";
import { originLabel } from "@/lib/l4";
import { orpc } from "@/lib/orpc";

/** Error rates from 1% on stand out. */
const WARN_RATE = 0.01;
const LONGEST = ORIGIN_HEADER_TIME_BOUNDS_MS[ORIGIN_HEADER_TIME_BOUNDS_MS.length - 1] ?? 10_000;

/** A time to the response header: "38 ms", "1.2 s", or "> 10 s" in the last bucket. */
function formatHeaderTime(ms: number | null): string {
  if (ms === null) return "–";
  if (ms >= LONGEST) return m.origin_quality_over({ value: formatNumber(LONGEST / 1000) });
  if (ms < 1000) return m.origin_quality_ms({ value: formatNumber(Math.round(ms)) });
  return m.origin_quality_s({ value: formatNumber(Math.round(ms / 100) / 10) });
}

const rate = (value: number) =>
  formatPercent(
    Math.round(value * 1000) / 10 === 0 && value > 0 ? 0.1 : Math.round(value * 1000) / 10,
  );

/** Fetches from each origin over the range (origin-stats-v1): errors and time to the header. */
export function OriginQualityCard({
  siteId,
  range,
  onRangeChange,
}: {
  siteId: string;
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
}) {
  const quality = useQuery({
    ...orpc.sites.originQuality.queryOptions({ input: { id: siteId, range } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "30ms" }} data-testid="origin-quality">
      <CardHeader>
        <CardTitle>{m.origin_quality_title()}</CardTitle>
        <CardAction>
          <RangeSelect value={range} onChange={onRangeChange} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-w-0 flex-col gap-4">
        <QueryView
          query={quality}
          isEmpty={(data) => data.items.every((item) => item.requests === 0)}
          empty={
            <div className="flex flex-col gap-3">
              <EmptyState compact title={m.origin_quality_empty()} />
              {quality.data && quality.data.unsupportedNodes > 0 ? (
                <SafetyNote data-testid="origin-quality-partial">
                  {m.origin_quality_partial()}
                </SafetyNote>
              ) : null}
            </div>
          }
        >
          {(data) => <QualityView data={data} range={range} />}
        </QueryView>
      </CardContent>
    </Card>
  );
}

function QualityView({ data, range }: { data: OriginQuality; range: AnalyticsRange }) {
  const plotted = data.items.filter((item) => item.requests > 0);
  const slots = useSeriesSlots(plotted.map((item) => item.originId));
  const series: (Series & { value: string })[] = plotted.map((item, index) => ({
    key: `o${index}`,
    label: originLabel(item),
    color: seriesColor(slots.get(item.originId)),
    value: formatNumber(item.requests),
  }));
  const latency: ChartRow[] = data.times.map((time, t) => ({
    time,
    ...Object.fromEntries(plotted.map((item, i) => [`o${i}`, item.series.p95Ms[t] ?? null])),
  }));
  const errors: ChartRow[] = data.times.map((time, t) => ({
    time,
    ...Object.fromEntries(
      plotted.map((item, i) => {
        const n = item.series.requests[t] ?? 0;
        return [`o${i}`, n > 0 ? ((item.series.errors[t] ?? 0) / n) * 100 : null];
      }),
    ),
  }));
  return (
    <>
      <div className="flex flex-col rounded-2xl sunk-well">
        <div
          aria-hidden
          className="hidden grid-cols-[minmax(0,1fr)_repeat(4,6rem)] gap-x-4 px-3 pt-2.5 pb-1 text-xs text-muted-foreground sm:grid"
        >
          <span>{m.origin_quality_origin()}</span>
          <span className="text-right">{m.origin_quality_requests()}</span>
          <span className="text-right">{m.origin_quality_error_rate()}</span>
          <span className="text-right">{m.origin_quality_p50()}</span>
          <span className="text-right">{m.origin_quality_p95()}</span>
        </div>
        <ul className="divide-y" data-testid="origin-quality-rows">
          {data.items.map((item) => (
            <QualityRow key={item.originId} item={item} />
          ))}
        </ul>
      </div>
      {series.length ? (
        <div className="min-w-0 rounded-2xl sunk-well pb-3" data-testid="origin-quality-charts">
          <SeriesLegend series={series} mark="line" />
          <div className="grid min-w-0 gap-4 px-4 pt-3 xl:grid-cols-2">
            <div className="flex min-w-0 flex-col gap-2" data-testid="origin-quality-latency">
              <h3 className="text-sm font-medium text-muted-foreground">
                {m.origin_quality_latency_chart()}
              </h3>
              <LinesChart data={latency} series={series} format={formatHeaderTime} range={range} />
            </div>
            <div className="flex min-w-0 flex-col gap-2" data-testid="origin-quality-errors">
              <h3 className="text-sm font-medium text-muted-foreground">
                {m.origin_quality_error_rate()}
              </h3>
              <LinesChart
                data={errors}
                series={series}
                format={(value) => formatPercent(Math.round(value * 10) / 10)}
                range={range}
              />
            </div>
          </div>
        </div>
      ) : null}
      {data.unsupportedNodes > 0 ? (
        <SafetyNote data-testid="origin-quality-partial">{m.origin_quality_partial()}</SafetyNote>
      ) : null}
    </>
  );
}

function QualityRow({ item }: { item: OriginQualityItem }) {
  const f = item.failures;
  return (
    <li
      className="grid grid-cols-2 gap-x-4 gap-y-2 px-3 py-2.5 text-sm sm:grid-cols-[minmax(0,1fr)_repeat(4,6rem)] sm:items-center"
      data-testid="origin-quality-row"
      data-origin={item.originId}
    >
      <span className="col-span-2 flex min-w-0 items-center gap-2 sm:col-span-1">
        <span className="min-w-0 break-all font-mono text-xs">{originLabel(item)}</span>
        {item.backup ? (
          <Badge size="sm" tone="neutral">
            {m.site_origin_backup()}
          </Badge>
        ) : null}
        {item.group ? (
          <Badge size="sm" tone="neutral">
            {item.group}
          </Badge>
        ) : null}
      </span>
      <Metric label={m.origin_quality_requests()} value={formatNumber(item.requests)} />
      <Metric
        label={m.origin_quality_error_rate()}
        value={item.requests > 0 ? rate(item.errorRate) : "–"}
        title={m.origin_quality_errors_detail({
          connect: formatNumber(f.connect),
          timeout: formatNumber(f.timeout),
          tls: formatNumber(f.tls),
          invalid: formatNumber(f.invalid),
          server: formatNumber(f.server),
        })}
        testId="origin-quality-error-rate"
        warn={item.errorRate >= WARN_RATE}
      />
      <Metric label={m.origin_quality_p50()} value={formatHeaderTime(item.p50Ms)} />
      <Metric
        label={m.origin_quality_p95()}
        value={formatHeaderTime(item.p95Ms)}
        testId="origin-quality-p95"
      />
    </li>
  );
}

function Metric({
  label,
  value,
  title,
  testId,
  warn,
}: {
  label: string;
  value: string;
  title?: string;
  testId?: string;
  warn?: boolean;
}) {
  return (
    <span className="flex min-w-0 flex-col gap-0.5 sm:items-end" title={title}>
      <span className="text-xs text-muted-foreground sm:sr-only">{label}</span>
      <span
        className={warn ? "tabular-nums text-destructive" : "tabular-nums"}
        data-testid={testId}
      >
        {value}
      </span>
    </span>
  );
}
