import type { OverviewCard, Traffic } from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { MetricChart } from "@/components/analytics/metric-chart";
import { MetricCard } from "@/components/analytics/panel";
import { RequestRateCard } from "@/components/analytics/request-rate-card";
import { FlowNumber } from "@/components/effects/number-flow";
import { Meter } from "@/components/meter";
import { QueryView } from "@/components/states";
import { LiveDot } from "@/components/status-dot";
import { cacheHitRatio } from "@/lib/analytics";
import { formatBitRate, formatNumber, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

export function LiveKpis({
  online,
  total,
  hidden,
}: {
  online: number;
  total: number;
  hidden: ReadonlySet<OverviewCard>;
}) {
  const tiles = TRAFFIC_TILES.filter((tile) => !hidden.has(tile));
  const nodes = !hidden.has("live-nodes");
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range: "1h" } }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    meta: { background: true },
    enabled: tiles.length > 0,
  });
  const count = tiles.length + (nodes ? 1 : 0);
  if (count === 0) return null;
  return (
    <section className="flex flex-col gap-3" aria-labelledby="live-title">
      <div className="flex items-center gap-3">
        <h2 id="live-title" className="text-section font-medium">
          {m.overview_live_title()}
        </h2>
        {tiles.length > 0 && traffic.isSuccess ? <LiveDot label={m.overview_live()} /> : null}
      </div>
      <div className={cn("grid gap-3", GRID[count])}>
        {tiles.length > 0 ? (
          // The loader or the error in the traffic tiles' place; the tiles are cells of the row.
          <div
            className={
              traffic.data
                ? "contents"
                : cn("col-span-full flex flex-col justify-center", nodes && SPAN[tiles.length])
            }
          >
            <QueryView query={traffic} loadingClassName="min-h-36">
              {(data) => <TrafficTiles traffic={data} tiles={tiles} />}
            </QueryView>
          </div>
        ) : null}
        {nodes ? <NodesTile online={online} total={total} /> : null}
      </div>
    </section>
  );
}

const TRAFFIC_TILES = ["live-requests", "live-egress", "live-hit-ratio"] as const;
type TrafficTile = (typeof TRAFFIC_TILES)[number];

/** Columns of `count` tiles: four side by side, two by two below @3xl. */
const GRID = [
  "",
  "",
  "@sm/main:grid-cols-2",
  "@sm/main:grid-cols-2 @3xl/main:grid-cols-3",
  "@sm/main:grid-cols-2 @3xl/main:grid-cols-4",
];

/** Columns the traffic tiles take beside the nodes tile, from @3xl. */
const SPAN = ["", "@3xl/main:col-span-1", "@3xl/main:col-span-2", "@3xl/main:col-span-3"];

function TrafficTiles({ traffic, tiles }: { traffic: Traffic; tiles: readonly TrafficTile[] }) {
  // The newest minute is still filling. Use the same closed buckets for readings and trends.
  const points = traffic.points.slice(0, -1);
  const last = points.at(-1);
  const seconds = traffic.bucketSeconds;
  const bandwidth = last ? formatBitRate(last.bytesSent / seconds) : "—";
  const hit = cacheHitRatio({
    cacheHits: points.reduce((sum, p) => sum + p.cacheHits, 0),
    cacheMisses: points.reduce((sum, p) => sum + p.cacheMisses, 0),
  });
  return (
    <>
      {tiles.includes("live-requests") ? (
        <RequestRateCard points={points} seconds={seconds} title={m.overview_request_rate()} />
      ) : null}
      {tiles.includes("live-egress") ? (
        <MetricCard title={m.overview_egress()} value={bandwidth} testId="live-egress">
          {points.some((p) => p.bytesSent > 0 || p.requests > 0) ? (
            <MetricChart
              data={points.map((p) => ({ time: p.time, value: p.bytesSent / seconds }))}
              label={m.overview_egress()}
              format={formatBitRate}
              range="1h"
            />
          ) : null}
        </MetricCard>
      ) : null}
      {tiles.includes("live-hit-ratio") ? (
        <MetricCard
          title={m.analytics_hit_ratio()}
          value={hit === null ? "—" : formatPercent(hit)}
          aside={
            <span className="shrink-0 text-xs text-muted-foreground">{m.analytics_range_1h()}</span>
          }
          testId="live-hit-ratio"
        >
          {hit !== null ? (
            <MetricChart
              data={points.map((p) => ({ time: p.time, value: cacheHitRatio(p) }))}
              label={m.analytics_hit_ratio()}
              format={formatPercent}
              domain={[0, 100]}
              range="1h"
            />
          ) : null}
        </MetricCard>
      ) : null}
    </>
  );
}

function NodesTile({ online, total }: { online: number; total: number }) {
  return (
    <MetricCard
      title={m.clusters_nodes_online()}
      testId="live-nodes"
      value={<FlowNumber value={online} suffix={` / ${formatNumber(total)}`} />}
      footer={
        total > 0 ? (
          <Meter
            value={(online / total) * 100}
            high={99.9}
            optimum={100}
            label={m.clusters_nodes_count({ online, total })}
          />
        ) : null
      }
    />
  );
}
