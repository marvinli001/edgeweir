import type { OverviewCard, Traffic } from "@edgeweir/contract";
import {
  ArrowDataTransferVerticalIcon,
  DatabaseLightningIcon,
  PulseRectangle01Icon,
  ServerStack01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Meter } from "@/components/appica/meter";
import { Sparkline } from "@/components/appica/sparkline";
import { FlowNumber, FlowScaled, NumberFlowGroup } from "@/components/effects/number-flow";
import { Spotlight } from "@/components/effects/spotlight";
import { QueryView } from "@/components/states";
import { LiveDot } from "@/components/status-dot";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const BIT_UNITS = ["bps", "Kbps", "Mbps", "Gbps", "Tbps"] as const;

/** The last full minute of the last hour (the newest bucket is still filling). */
function latest(traffic: Traffic) {
  const points = traffic.points.slice(0, -1);
  const last = points.at(-1);
  const seconds = traffic.bucketSeconds;
  const hits = points.reduce((sum, p) => sum + p.cacheHits, 0);
  const misses = points.reduce((sum, p) => sum + p.cacheMisses, 0);
  return {
    points,
    rps: last ? last.requests / seconds : 0,
    bps: last ? (last.bytesSent * 8) / seconds : 0,
    hit: hits + misses > 0 ? (hits / (hits + misses)) * 100 : 0,
  };
}

/** Starts at zero and moves to the value once the tile is on screen, so the digits roll in. */
function useArrival<T extends number>(value: T): T | 0 {
  const [arrived, setArrived] = React.useState(false);
  React.useEffect(() => {
    const frame = requestAnimationFrame(() => setArrived(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  return arrived ? value : 0;
}

function Tile({
  icon,
  title,
  span,
  children,
  footer,
  index,
}: {
  icon: typeof ServerStack01Icon;
  title: string;
  /** The window a value covers when it is not the last minute, shown after the title. */
  span?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  index: number;
}) {
  return (
    <div
      className="relative flex min-h-36 flex-col overflow-hidden rounded-2xl bg-card shadow-elev-1 edge-lit animate-enter"
      style={{ animationDelay: `${index * 50}ms` }}
    >
      <Spotlight />
      <div className="relative z-[1] flex items-center gap-2 px-4 pt-3.5 text-[13px] text-muted-foreground">
        <HugeiconsIcon icon={icon} strokeWidth={2} className="size-4" />
        <span className="truncate">{title}</span>
        {span ? <span className="ms-auto shrink-0 text-xs">{span}</span> : null}
      </div>
      <div className="relative z-[1] truncate px-4 pt-1.5 text-[1.75rem] leading-tight font-semibold tracking-tight font-stretch-112%">
        {children}
      </div>
      <div className="relative z-[1] mt-auto">{footer}</div>
    </div>
  );
}

/**
 * The platform right now, under the section's title: request rate and egress of the last full
 * minute, the cache hit ratio of the last hour (labelled, as the statistics below show it for the
 * chosen range), and nodes online. Traffic polls every minute, the size of the hour's buckets, so
 * the 1-hour traffic query keeps the cadence the statistics give it; the digits roll to each new
 * value. Until its first answer the traffic tiles are a loader, and a failed first load an error
 * with a retry, never a row of zeros; the nodes tile comes from the overview summary the page has
 * already loaded and stands on its own. The live light is on only while the traffic tiles show
 * live numbers. Tiles the user hid are left out (the traffic query too when all three are); with
 * none left the section is gone.
 */
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
        <h2 id="live-title" className="text-base font-semibold">
          {m.overview_live_title()}
        </h2>
        {tiles.length > 0 && traffic.isSuccess ? <LiveDot label={m.overview_live()} /> : null}
      </div>
      <NumberFlowGroup>
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
          {nodes ? <NodesTile online={online} total={total} index={tiles.length} /> : null}
        </div>
      </NumberFlowGroup>
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
  const now = latest(traffic);
  const rps = useArrival(Math.round(now.rps));
  const bps = useArrival(now.bps);
  const hit = useArrival(now.hit);
  const series = (pick: (p: Traffic["points"][number]) => number) => now.points.map(pick);
  const index = (tile: TrafficTile) => tiles.indexOf(tile);

  return (
    <>
      {tiles.includes("live-requests") ? (
        <Tile
          icon={PulseRectangle01Icon}
          title={m.overview_request_rate()}
          index={index("live-requests")}
          footer={<Sparkline tone="signal" data={series((p) => p.requests)} />}
        >
          <FlowNumber value={rps} suffix={m.overview_per_second()} />
        </Tile>
      ) : null}
      {tiles.includes("live-egress") ? (
        <Tile
          icon={ArrowDataTransferVerticalIcon}
          title={m.overview_egress()}
          index={index("live-egress")}
          footer={<Sparkline tone="signal" data={series((p) => p.bytesSent)} />}
        >
          <FlowScaled value={bps} units={BIT_UNITS} />
        </Tile>
      ) : null}
      {tiles.includes("live-hit-ratio") ? (
        <Tile
          icon={DatabaseLightningIcon}
          title={m.analytics_hit_ratio()}
          span={m.analytics_range_1h()}
          index={index("live-hit-ratio")}
          footer={
            <Sparkline
              tone="metric"
              data={series((p) =>
                p.cacheHits + p.cacheMisses > 0 ? p.cacheHits / (p.cacheHits + p.cacheMisses) : 0,
              )}
            />
          }
        >
          <FlowNumber
            value={hit / 100}
            format={{ style: "percent", maximumFractionDigits: 1, minimumFractionDigits: 1 }}
          />
        </Tile>
      ) : null}
    </>
  );
}

function NodesTile({ online, total, index }: { online: number; total: number; index: number }) {
  const nodes = useArrival(online);
  return (
    <Tile
      icon={ServerStack01Icon}
      title={m.clusters_nodes_online()}
      index={index}
      footer={
        <div className="flex flex-col gap-2 px-4 pb-4">
          <Meter
            value={total > 0 ? (online / total) * 100 : 0}
            high={99.9}
            optimum={100}
            label={m.clusters_nodes_count({ online, total })}
          />
        </div>
      }
    >
      <FlowNumber value={nodes} suffix={` / ${total}`} />
    </Tile>
  );
}
