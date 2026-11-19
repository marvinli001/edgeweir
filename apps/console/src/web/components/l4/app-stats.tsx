import type { L4Stats } from "@edgeweir/contract";
import { ChartLineData01Icon, RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { LinesChart, SeriesLegend } from "@/components/analytics/breakdown-charts";
import { MetricChart } from "@/components/analytics/metric-chart";
import { MetricCard, Panel, PanelHeader } from "@/components/analytics/panel";
import { RangeSelect } from "@/components/analytics/range-select";
import { Button } from "@/components/arc/button/button";
import { type Columns, DataTable } from "@/components/data-table";
import { EmptyState, QueryView } from "@/components/states";
import { SERIES_COLORS } from "@/lib/analytics";
import { formatBytes, formatCompact, formatNumber, m } from "@/lib/i18n";
import { L4_STATS_RANGE_SECONDS, L4_STATS_RANGES, type L4StatsRange, l4PlotPoints } from "@/lib/l4";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;
const isL4StatsRange = (value: string): value is L4StatsRange =>
  (L4_STATS_RANGES as readonly string[]).includes(value);

type Counter = "connections" | "refused" | "peakConcurrent" | "bytesReceived" | "bytesSent";

const TILES: { key: Counter; title: () => string; format: (value: number) => string }[] = [
  { key: "connections", title: m.l4_stats_connections, format: formatCompact },
  { key: "refused", title: m.l4_stats_refused, format: formatCompact },
  { key: "peakConcurrent", title: m.l4_stats_peak, format: formatCompact },
  { key: "bytesReceived", title: m.l4_stats_received, format: formatBytes },
  { key: "bytesSent", title: m.l4_stats_sent, format: formatBytes },
];

/**
 * An application's counters over a range: totals, connections and traffic over time, and the
 * nodes' shares. The window ends now and moves on every minute; a refetch keeps the old numbers,
 * dimmed, until the new ones arrive.
 */
export function useL4Stats(appId: string, range: L4StatsRange, compare = false) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), REFRESH_MS);
    return () => clearInterval(timer);
  }, []);
  const duration = L4_STATS_RANGE_SECONDS[range] * 1000;
  const start = now - duration;
  const span = { from: new Date(start).toISOString(), to: new Date(now).toISOString() };
  const stats = useQuery({
    ...orpc.l4Apps.stats.queryOptions({ input: { id: appId, ...span } }),
    placeholderData: keepPreviousData,
    meta: { background: true },
  });
  const previous = useQuery({
    ...orpc.l4Apps.stats.queryOptions({
      input: { id: appId, from: new Date(start - duration).toISOString(), to: span.from },
    }),
    enabled: compare,
    placeholderData: keepPreviousData,
    meta: { background: true },
  });
  return { stats, previous, refresh: () => setNow(Date.now()) };
}

export function L4AppStats({
  appId,
  range,
  onRangeChange,
}: {
  appId: string;
  range: L4StatsRange;
  onRangeChange: (range: L4StatsRange) => void;
}) {
  const { stats, refresh } = useL4Stats(appId, range);
  return (
    <section className="flex flex-col gap-3" aria-labelledby="l4-stats-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="l4-stats-title" className="mr-auto text-base font-medium">
          {m.analytics_title()}
        </h2>
        <RangeSelect
          value={range}
          ranges={L4_STATS_RANGES}
          onChange={(next) => isL4StatsRange(next) && onRangeChange(next)}
        />
        <Button
          className="icon-button"
          size="sm"
          variant="ghost"
          aria-label={m.analytics_refresh()}
          disabled={stats.isFetching}
          onClick={refresh}
          data-testid="l4-stats-refresh"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={2}
            className={cn(stats.isFetching && "animate-spin motion-reduce:animate-none")}
          />
        </Button>
      </div>
      <QueryView query={stats}>
        {(data) => <StatsBody stats={data} range={range} stale={stats.isPlaceholderData} />}
      </QueryView>
    </section>
  );
}

function StatsBody({
  stats,
  range,
  stale,
}: {
  stats: L4Stats;
  range: L4StatsRange;
  stale: boolean;
}) {
  const enter = (index: number) => ({
    className: "animate-enter",
    style: { animationDelay: `${index * 60}ms` },
  });
  const connections = [
    { key: "connections", label: m.l4_stats_connections(), color: SERIES_COLORS[0] },
    { key: "refused", label: m.l4_stats_refused(), color: SERIES_COLORS[3] },
  ];
  const traffic = [
    { key: "bytesReceived", label: m.l4_stats_received(), color: SERIES_COLORS[1] },
    { key: "bytesSent", label: m.l4_stats_sent(), color: SERIES_COLORS[2] },
  ];
  const hasSamples = stats.nodes.length > 0 || TILES.some(({ key }) => stats.totals[key] > 0);
  const rows = hasSamples ? l4PlotPoints(stats) : [];
  return (
    <div
      className={cn("flex flex-col gap-3 transition-opacity duration-300", stale && "opacity-60")}
      aria-busy={stale}
      data-testid="l4-stats"
    >
      <div className="grid gap-3 @lg/main:grid-cols-2 @3xl/main:grid-cols-3 @[72rem]/main:grid-cols-5">
        {TILES.map((tile, index) => (
          <div key={tile.key} {...enter(index)}>
            <MetricCard
              title={tile.title()}
              value={tile.format(stats.totals[tile.key])}
              rawValue={stats.totals[tile.key]}
              testId={`l4-stat-${tile.key}`}
            >
              {rows.length > 0 ? (
                <MetricChart
                  data={rows.map((p) => ({ time: p.time, value: p[tile.key] }))}
                  label={tile.title()}
                  format={tile.format}
                  range={range}
                />
              ) : null}
            </MetricCard>
          </div>
        ))}
      </div>
      {rows.length > 0 ? (
        <div className="grid gap-3 @3xl/main:grid-cols-2">
          <div {...enter(5)}>
            <Panel className="pb-3" data-testid="l4-stats-connections-chart">
              <PanelHeader title={m.l4_stats_connections()} />
              <SeriesLegend
                mark="line"
                series={connections.map((s) => ({
                  ...s,
                  value: formatCompact(stats.totals[s.key as Counter]),
                }))}
              />
              <div className="px-2 pt-2">
                <LinesChart data={rows} series={connections} format={formatCompact} range={range} />
              </div>
            </Panel>
          </div>
          <div {...enter(6)}>
            <Panel className="pb-3" data-testid="l4-stats-traffic-chart">
              <PanelHeader title={m.l4_stats_traffic()} />
              <SeriesLegend
                mark="line"
                series={traffic.map((s) => ({
                  ...s,
                  value: formatBytes(stats.totals[s.key as Counter]),
                }))}
              />
              <div className="px-2 pt-2">
                <LinesChart data={rows} series={traffic} format={formatBytes} range={range} />
              </div>
            </Panel>
          </div>
        </div>
      ) : null}
      <NodeShares nodes={stats.nodes} />
    </div>
  );
}

type NodeShare = L4Stats["nodes"][number];

function NodeShares({ nodes }: { nodes: NodeShare[] }) {
  const columns = React.useMemo<Columns<NodeShare>>(
    () => [
      {
        id: "node",
        header: () => m.nodes_col_name(),
        cell: ({ row }) => (
          <span className="font-medium" data-testid="l4-stats-node-name">
            {row.original.nodeName}
          </span>
        ),
      },
      ...TILES.map<Columns<NodeShare>[number]>((tile) => ({
        id: tile.key,
        header: () => tile.title(),
        cell: ({ row }) => (
          <span
            className="whitespace-nowrap tabular-nums"
            title={formatNumber(row.original[tile.key])}
            data-testid={`l4-stats-node-${tile.key}`}
          >
            {tile.format(row.original[tile.key])}
          </span>
        ),
      })),
    ],
    [],
  );
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-medium">{m.nodes_title()}</h3>
      {nodes.length === 0 ? (
        <EmptyState icon={ChartLineData01Icon} title={m.analytics_no_traffic()} />
      ) : (
        <DataTable
          data={nodes}
          columns={columns}
          getRowId={(node) => node.nodeId}
          testId="l4-stats-nodes"
          pinFirstColumn
        />
      )}
    </section>
  );
}
