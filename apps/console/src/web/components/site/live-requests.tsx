import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { LivePoint } from "@/components/effects/live-chart";
import { FlowNumber } from "@/components/effects/number-flow";
import { LiveDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatClockTime, formatCompact, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const LiveChart = React.lazy(() => import("@/components/effects/live-chart"));

/**
 * The site's requests per second over the last hour, minute by minute, polled every 10 s. The
 * newest minute is still filling, so it is left out. Hovering reads any minute.
 */
export function LiveRequests({ siteId }: { siteId: string }) {
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range: "1h", siteId } }),
    refetchInterval: 10_000,
    placeholderData: keepPreviousData,
    meta: { background: true },
  });
  const points = React.useMemo<LivePoint[]>(() => {
    const data = traffic.data;
    if (!data) return [];
    return data.points.slice(0, -1).map((p) => ({
      time: Date.parse(p.time) / 1000,
      value: p.requests / data.bucketSeconds,
    }));
  }, [traffic.data]);
  const [reading, setReading] = React.useState<LivePoint | null>(null);
  const shown = reading ?? points.at(-1) ?? null;

  return (
    <Card size="sm" data-testid="live-requests">
      <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <CardTitle className="text-[13px] font-normal text-muted-foreground">
          {m.site_live_requests()}
        </CardTitle>
        <LiveDot label={m.overview_live()} />
        <div className="ml-auto flex items-baseline gap-2">
          {reading ? (
            <span className="text-xs tabular-nums text-muted-foreground">
              {formatClockTime(new Date(reading.time * 1000).toISOString())}
            </span>
          ) : null}
          <span className="text-xl font-semibold tracking-tight">
            <FlowNumber value={Math.round(shown?.value ?? 0)} suffix={m.overview_per_second()} />
          </span>
        </div>
      </CardHeader>
      <CardContent>
        <React.Suspense fallback={<div className="h-42" />}>
          <LiveChart
            points={points}
            format={(value) => `${formatCompact(value)}${m.overview_per_second()}`}
            formatTime={(seconds) => formatClockTime(new Date(seconds * 1000).toISOString())}
            label={m.site_live_requests()}
            onRead={setReading}
          />
        </React.Suspense>
      </CardContent>
    </Card>
  );
}
