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
  children,
  footer,
  index,
}: {
  icon: typeof ServerStack01Icon;
  title: string;
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
      </div>
      <div className="relative z-[1] truncate px-4 pt-1.5 text-[1.75rem] leading-tight font-semibold tracking-tight font-stretch-112%">
        {children}
      </div>
      <div className="relative z-[1] mt-auto">{footer}</div>
    </div>
  );
}

/**
 * The platform right now: request rate and egress of the last full minute, the cache hit ratio
 * of the last hour, and nodes online. Polls every 10 s; the digits roll to each new value. Until
 * the first answer the row is a loader, and a failed first load an error with a retry, never a
 * row of zeros.
 */
export function LiveKpis({
  online,
  total,
  className,
}: {
  online: number;
  total: number;
  className?: string;
}) {
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range: "1h" } }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
    meta: { background: true },
  });
  return (
    <QueryView query={traffic} loadingClassName="min-h-36">
      {(data) => <LiveTiles traffic={data} online={online} total={total} className={className} />}
    </QueryView>
  );
}

function LiveTiles({
  traffic,
  online,
  total,
  className,
}: {
  traffic: Traffic;
  online: number;
  total: number;
  className?: string;
}) {
  const now = latest(traffic);
  const rps = useArrival(Math.round(now.rps));
  const bps = useArrival(now.bps);
  const hit = useArrival(now.hit);
  const nodes = useArrival(online);
  const series = (pick: (p: Traffic["points"][number]) => number) => now.points.map(pick);

  return (
    <NumberFlowGroup>
      <div className={cn("grid gap-3 @sm/main:grid-cols-2", className)}>
        <Tile
          icon={PulseRectangle01Icon}
          title={m.overview_request_rate()}
          index={0}
          footer={<Sparkline data={series((p) => p.requests)} />}
        >
          <FlowNumber value={rps} suffix={m.overview_per_second()} />
        </Tile>
        <Tile
          icon={ArrowDataTransferVerticalIcon}
          title={m.overview_egress()}
          index={1}
          footer={<Sparkline data={series((p) => p.bytesSent)} />}
        >
          <FlowScaled value={bps} units={BIT_UNITS} />
        </Tile>
        <Tile
          icon={DatabaseLightningIcon}
          title={m.analytics_hit_ratio()}
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
      </div>
    </NumberFlowGroup>
  );
}
