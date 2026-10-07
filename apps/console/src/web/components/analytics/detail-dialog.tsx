import type { AnalyticsRange, Traffic, TrafficBreakdown } from "@edgeweir/contract";
import { keepPreviousData, type UseQueryResult, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import {
  type ChartRow,
  LinesChart,
  type Series,
  SeriesLegend,
  StackedBarsChart,
  seriesColor,
  useSeriesSlots,
} from "@/components/analytics/breakdown-charts";
import { Panel, PanelHeader } from "@/components/analytics/panel";
import { RangeSelect } from "@/components/analytics/range-select";
import { LoadingState, QueryView } from "@/components/states";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { DialogProps } from "@/hooks/use-dialog-state";
import {
  type DetailView,
  detailViewId,
  groupBuckets,
  type Metric,
  OTHER_COLOR,
} from "@/lib/analytics";
import { formatBitRate, formatBytes, formatCompact, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;
/** Lines or stacked segments per chart; the list below goes further. */
const CHART_SERIES = 5;
const LIST_SIZE = 10;

export interface DetailTarget {
  /** Metric id, or "status-codes" for the status card. */
  id: string;
  title: string;
  views: DetailView[];
  /** The metric behind the card (for the trend view). */
  metric?: Metric;
}

function NoTraffic() {
  return (
    <p className="flex h-64 items-center justify-center text-sm text-muted-foreground">
      {m.analytics_no_traffic()}
    </p>
  );
}

interface RankedItem {
  id: string;
  name: string;
  parentId?: string | null;
  parentName?: string | null;
  value: number;
}

/** Name, a bar for the item's share of `whole`, and the figure — the chart's table view. */
function RankedList({
  title,
  items,
  whole,
  format,
  link,
  showParent,
  mono,
  testId,
}: {
  title: string;
  items: RankedItem[];
  whole: number;
  format: (value: number) => string;
  link?: "site" | "node";
  showParent?: boolean;
  /** Names are codes. */
  mono?: boolean;
  testId?: string;
}) {
  return (
    <Panel data-testid={testId}>
      <PanelHeader title={title} />
      <ol className="flex flex-col py-2">
        {items.map((item) => {
          const share = whole > 0 ? (item.value / whole) * 100 : 0;
          const name = (
            <>
              <span className="truncate">{item.name}</span>
              {showParent && item.parentName ? (
                <span className="truncate text-xs text-muted-foreground">{item.parentName}</span>
              ) : null}
            </>
          );
          const nameClass = "flex min-w-0 items-baseline gap-2";
          return (
            <li
              key={item.id}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1.5 px-4 py-1.5 text-sm sm:grid-cols-[minmax(0,1fr)_minmax(8rem,38%)_6rem]"
              data-testid="ranked-item"
            >
              {link === "site" ? (
                <Link
                  to="/sites/$id"
                  params={{ id: item.id }}
                  className={cn(nameClass, "hover:underline hover:underline-offset-4")}
                >
                  {name}
                </Link>
              ) : link === "node" && item.parentId ? (
                <Link
                  to="/clusters"
                  search={{ cluster: item.parentId }}
                  className={cn(nameClass, "hover:underline hover:underline-offset-4")}
                >
                  {name}
                </Link>
              ) : (
                <span className={cn(nameClass, mono && "font-mono text-[13px]")}>{name}</span>
              )}
              <span
                className="text-right tabular-nums sm:col-start-3 sm:row-start-1"
                title={formatPercent(share)}
              >
                {format(item.value)}
              </span>
              <span
                className="col-span-2 h-1.5 overflow-hidden rounded-full bg-wash sm:col-span-1 sm:col-start-2 sm:row-start-1"
                aria-hidden
              >
                <span
                  data-slot="bar-fill"
                  className="block h-full rounded-full bg-metric transition-[width] duration-500 motion-reduce:transition-none"
                  style={{ width: `${Math.min(100, share)}%` }}
                />
              </span>
            </li>
          );
        })}
      </ol>
    </Panel>
  );
}

function useBreakdown(input: {
  range: AnalyticsRange;
  siteId?: string;
  by: "site" | "node" | "status";
  metric?: "requests" | "bytesSent";
  statusClass?: number;
}) {
  return useQuery({
    ...orpc.analytics.breakdown.queryOptions({ input: { ...input, limit: LIST_SIZE } }),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    meta: { background: true },
  });
}

/** Wraps a view's query states; a refetch dims the previous figures instead of blanking them. */
function Loaded({
  query,
  children,
}: {
  query: UseQueryResult<TrafficBreakdown>;
  children: (data: TrafficBreakdown) => React.ReactNode;
}) {
  return (
    <QueryView query={query}>
      {(data) => (
        <div
          className={cn(
            "flex flex-col gap-3 transition-opacity duration-300",
            query.isPlaceholderData && "opacity-60",
          )}
          aria-busy={query.isPlaceholderData}
        >
          {children(data)}
        </div>
      )}
    </QueryView>
  );
}

/** Sites or nodes: one line per leader and the ranked list. */
function EntityView({
  view,
  range,
  siteId,
  metricTitle,
  showParent,
}: {
  view: Extract<DetailView, { kind: "entities" }>;
  range: AnalyticsRange;
  siteId?: string;
  metricTitle: string;
  showParent: boolean;
}) {
  const query = useBreakdown({ range, siteId, by: view.by, metric: view.metric });
  return (
    <Loaded query={query}>
      {(data) => (
        <EntityCharts
          data={data}
          view={view}
          range={range}
          metricTitle={metricTitle}
          showParent={showParent}
        />
      )}
    </Loaded>
  );
}

function EntityCharts({
  data,
  view,
  range,
  metricTitle,
  showParent,
}: {
  data: TrafficBreakdown;
  view: Extract<DetailView, { kind: "entities" }>;
  range: AnalyticsRange;
  metricTitle: string;
  showParent: boolean;
}) {
  const scale = view.perSecond ? 1 / data.bucketSeconds : 1;
  const format = view.perSecond
    ? formatBitRate
    : view.metric === "bytesSent"
      ? formatBytes
      : formatCompact;
  // Bandwidth ranks by each item's busiest bucket; volumes by their total.
  const figure = (series: number[], total: number) =>
    view.perSecond ? Math.max(0, ...series) * scale : total;
  const items = data.items
    .map((item) => ({ ...item, value: figure(item.series, item.total) }))
    .sort((a, b) => b.value - a.value);
  const leaders = items.slice(0, CHART_SERIES);
  const slots = useSeriesSlots(leaders.map((item) => item.id));
  const series = leaders.map((item, index) => ({
    key: `s${index}`,
    label: item.name,
    color: seriesColor(slots.get(item.id)),
    value: format(item.value),
  }));
  const rows: ChartRow[] = data.times.map((time, t) => ({
    time,
    ...Object.fromEntries(leaders.map((item, i) => [`s${i}`, (item.series[t] ?? 0) * scale])),
  }));
  const whole = view.perSecond ? Math.max(0, ...data.totalSeries) * scale : data.total;
  const byTitle = view.by === "site" ? m.analytics_by_site : m.analytics_by_node;
  return (
    <>
      <Panel data-testid="detail-chart">
        <PanelHeader title={byTitle({ metric: metricTitle })} />
        {items.length === 0 ? (
          <NoTraffic />
        ) : (
          <>
            <SeriesLegend series={series} mark="line" />
            <div className="px-4 pt-3 pb-3">
              <LinesChart data={rows} series={series} format={format} range={range} />
            </div>
          </>
        )}
      </Panel>
      {items.length > 0 ? (
        <RankedList
          title={view.by === "site" ? m.analytics_top_sites() : m.analytics_top_nodes()}
          items={items}
          whole={whole}
          format={format}
          link={view.by}
          showParent={view.by === "node" || showParent}
          testId="detail-list"
        />
      ) : null}
    </>
  );
}

/** Stacked bars of named parts plus the remainder, and the ranked list of the parts. */
function PartsCharts({
  chartTitle,
  listTitle,
  times,
  bucketSeconds,
  parts,
  rest,
  range,
  mono,
}: {
  chartTitle: string;
  listTitle: string;
  times: string[];
  bucketSeconds: number;
  /** Largest first; the first few get their own segment. */
  parts: { id: string; name: string; total: number; series: number[] }[];
  /** Per bucket, whatever the parts do not cover. */
  rest: number[];
  range: AnalyticsRange;
  /** Names are codes. */
  mono?: boolean;
}) {
  const leaders = parts.slice(0, CHART_SERIES);
  const slots = useSeriesSlots(leaders.map((part) => part.id));
  const restTotal = rest.reduce((sum, value) => sum + value, 0);
  const series: (Series & { value: string })[] = leaders.map((part, index) => ({
    key: `s${index}`,
    label: part.name,
    color: seriesColor(slots.get(part.id)),
    value: formatCompact(part.total),
  }));
  const withRest = restTotal > 0;
  if (withRest) {
    series.push({
      key: "rest",
      label: m.analytics_other(),
      color: OTHER_COLOR,
      value: formatCompact(restTotal),
    });
  }
  const groups = groupBuckets(
    times,
    [...leaders.map((part) => part.series), ...(withRest ? [rest] : [])],
    bucketSeconds,
  );
  const rows: ChartRow[] = groups.map((group) => ({
    time: group.time,
    ...Object.fromEntries(series.map((s, i) => [s.key, group.values[i] ?? 0])),
  }));
  const whole = parts.reduce((sum, part) => sum + part.total, 0) + restTotal;
  return (
    <>
      <Panel data-testid="detail-chart">
        <PanelHeader title={chartTitle} />
        {whole === 0 ? (
          <NoTraffic />
        ) : (
          <>
            <SeriesLegend series={series} mark="bar" />
            <div className="px-4 pt-3 pb-3">
              <StackedBarsChart data={rows} series={series} format={formatCompact} range={range} />
            </div>
          </>
        )}
      </Panel>
      {whole > 0 ? (
        <RankedList
          title={listTitle}
          items={parts
            .slice(0, LIST_SIZE)
            .map((part) => ({ id: part.id, name: part.name, value: part.total }))}
          whole={whole}
          format={formatCompact}
          mono={mono}
          testId="detail-list"
        />
      ) : null}
    </>
  );
}

function StatusView({
  view,
  range,
  siteId,
}: {
  view: Extract<DetailView, { kind: "status" }>;
  range: AnalyticsRange;
  siteId?: string;
}) {
  const query = useBreakdown({ range, siteId, by: "status", statusClass: view.statusClass });
  return (
    <Loaded query={query}>
      {(data) => {
        const leaders = data.items.slice(0, CHART_SERIES);
        const rest = data.totalSeries.map(
          (total, t) => total - leaders.reduce((sum, item) => sum + (item.series[t] ?? 0), 0),
        );
        return (
          <PartsCharts
            chartTitle={m.analytics_by_status()}
            listTitle={m.analytics_top_status_codes()}
            times={data.times}
            bucketSeconds={data.bucketSeconds}
            parts={data.items}
            rest={rest}
            range={range}
            mono
          />
        );
      }}
    </Loaded>
  );
}

/** Hits, misses and uncached requests, from the section's traffic series. */
function CacheView({ traffic, range }: { traffic: Traffic; range: AnalyticsRange }) {
  const points = traffic.points;
  const parts = [
    {
      id: "hit",
      name: m.analytics_cache_hit(),
      series: points.map((p) => p.cacheHits),
    },
    {
      id: "miss",
      name: m.analytics_cache_miss(),
      series: points.map((p) => p.cacheMisses),
    },
    {
      id: "none",
      name: m.analytics_cache_none(),
      series: points.map((p) => Math.max(0, p.requests - p.cacheHits - p.cacheMisses)),
    },
  ]
    .map((part) => ({ ...part, total: part.series.reduce((sum, value) => sum + value, 0) }))
    .filter((part) => part.total > 0)
    .sort((a, b) => b.total - a.total);
  return (
    <PartsCharts
      chartTitle={m.analytics_by_cache()}
      listTitle={m.analytics_cache_status()}
      times={points.map((p) => p.time)}
      bucketSeconds={traffic.bucketSeconds}
      parts={parts}
      rest={points.map(() => 0)}
      range={range}
    />
  );
}

/** The card's own series, larger and with axes. */
function TrendView({
  traffic,
  metric,
  range,
}: {
  traffic: Traffic;
  metric: Metric;
  range: AnalyticsRange;
}) {
  const series = [{ key: "value", label: metric.title(), color: "var(--metric)" }];
  const rows: ChartRow[] = traffic.points.map((point) => ({
    time: point.time,
    value: metric.point(point, traffic.bucketSeconds),
  }));
  return (
    <Panel data-testid="detail-chart">
      <PanelHeader title={m.analytics_over_time({ metric: metric.title() })} />
      <div className="px-4 pt-3 pb-3">
        <LinesChart
          data={rows}
          series={series}
          format={metric.format}
          range={range}
          domain={metric.domain}
        />
      </div>
    </Panel>
  );
}

function viewLabel(view: DetailView): string {
  switch (view.kind) {
    case "entities":
      return view.by === "site" ? m.analytics_view_sites() : m.analytics_view_nodes();
    case "status":
      return m.analytics_status_codes();
    case "cache":
      return m.analytics_cache_status();
    case "trend":
      return "";
  }
}

/**
 * A metric's breakdown over the section's range: the leading sites, nodes, status codes or cache
 * states over time, then the ranked list. Views are tabs when there is more than one.
 */
export function MetricDetailDialog({
  target,
  open,
  onOpenChange,
  range,
  onRangeChange,
  siteId,
  traffic,
  showParent,
}: {
  /** Stays while the dialog closes, so the closing animation shows it. */
  target: DetailTarget | null;
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
  siteId?: string;
  traffic: Traffic | undefined;
  /** Show each site's cluster. */
  showParent: boolean;
} & DialogProps) {
  // The chosen tab per dialog, for this visit to the page.
  const [tabs, setTabs] = React.useState<Record<string, string>>({});
  if (!target) return null;
  const view = target.views.find((v) => detailViewId(v) === tabs[target.id]) ?? target.views[0];
  const viewId = view ? detailViewId(view) : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="top-[max(1rem,6dvh)] flex max-h-[calc(100dvh-max(2rem,12dvh))] translate-y-0 flex-col gap-0 overflow-hidden p-0 sm:max-w-5xl"
        data-testid="metric-detail"
      >
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-4 pr-14 pl-5">
          <DialogTitle className="mr-auto">{target.title}</DialogTitle>
          {target.views.length > 1 ? (
            <Tabs
              value={viewId}
              onValueChange={(value) =>
                setTabs((prev) => ({ ...prev, [target.id]: String(value) }))
              }
            >
              <TabsList className="h-8">
                {target.views.map((v) => (
                  <TabsTrigger
                    key={detailViewId(v)}
                    value={detailViewId(v)}
                    data-testid={`detail-view-${detailViewId(v)}`}
                  >
                    {viewLabel(v)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
          ) : null}
          <RangeSelect value={range} onChange={onRangeChange} />
        </div>
        <div className="flex min-h-0 flex-col gap-3 overflow-y-auto px-5 pb-5">
          {!view || !traffic ? (
            <LoadingState />
          ) : view.kind === "entities" ? (
            <EntityView
              key={viewId}
              view={view}
              range={range}
              siteId={siteId}
              metricTitle={target.title}
              showParent={showParent}
            />
          ) : view.kind === "status" ? (
            <StatusView key={viewId} view={view} range={range} siteId={siteId} />
          ) : view.kind === "cache" ? (
            <CacheView key={viewId} traffic={traffic} range={range} />
          ) : target.metric ? (
            <TrendView traffic={traffic} metric={target.metric} range={range} />
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  );
}
