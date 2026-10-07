import type { Traffic } from "@edgeweir/contract";
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
 * live numbers.
 */
export function LiveKpis({ online, total }: { online: number; total: number }) {
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range: "1h" } }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    meta: { background: true },
  });
  return (
    <section className="flex flex-col gap-3" aria-labelledby="live-title">
      <div className="flex items-center gap-3">
        <h2 id="live-title" className="text-base font-semibold">
          {m.overview_live_title()}
        </h2>
        {traffic.isSuccess ? <LiveDot label={m.overview_live()} /> : null}
      </div>
      <NumberFlowGroup>
        <div className="grid gap-3 @sm/main:grid-cols-2 @3xl/main:grid-cols-4">
          <QueryView query={traffic} frame={TrafficPending} loadingClassName="min-h-36">
            {(data) => <TrafficTiles traffic={data} />}
          </QueryView>
          <NodesTile online={online} total={total} />
        </div>
      </NumberFlowGroup>
    </section>
  );
}

/** The loader or the error in the traffic tiles' place, beside the nodes tile. */
function TrafficPending({ children }: { children?: React.ReactNode }) {
  return (
    <div className="col-span-full flex flex-col justify-center @3xl/main:col-span-3">
      {children}
    </div>
  );
}

function TrafficTiles({ traffic }: { traffic: Traffic }) {
  const now = latest(traffic);
  const rps = useArrival(Math.round(now.rps));
  const bps = useArrival(now.bps);
  const hit = useArrival(now.hit);
  const series = (pick: (p: Traffic["points"][number]) => number) => now.points.map(pick);

  return (
    <>
      <Tile
        icon={PulseRectangle01Icon}
        title={m.overview_request_rate()}
        index={0}
        footer={<Sparkline tone="signal" data={series((p) => p.requests)} />}
      >
        <FlowNumber value={rps} suffix={m.overview_per_second()} />
      </Tile>
      <Tile
        icon={ArrowDataTransferVerticalIcon}
        title={m.overview_egress()}
        index={1}
        footer={<Sparkline tone="signal" data={series((p) => p.bytesSent)} />}
      >
        <FlowScaled value={bps} units={BIT_UNITS} />
      </Tile>
      <Tile
        icon={DatabaseLightningIcon}
        title={m.analytics_hit_ratio()}
        span={m.analytics_range_1h()}
        index={2}
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
    </>
  );
}

function NodesTile({ online, total }: { online: number; total: number }) {
  const nodes = useArrival(online);
  return (
    <Tile
      icon={ServerStack01Icon}
      title={m.clusters_nodes_online()}
      index={3}
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
