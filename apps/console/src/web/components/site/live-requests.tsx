import type { Traffic } from "@edgeweir/contract";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import type { LivePoint } from "@/components/effects/live-chart";
import { FlowNumber } from "@/components/effects/number-flow";
import { QueryView } from "@/components/states";
import { LiveDot } from "@/components/status-dot";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatClockTime, formatCompact, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const LiveChart = React.lazy(() => import("@/components/effects/live-chart"));

/**
 * The site's requests per second over the last hour, minute by minute, polled every minute (the
 * size of the hour's buckets, like the overview's live tiles). The newest minute is still filling,
 * so it is left out. Hovering reads any minute. Until the first answer the card holds a loader,
 * and a failed first load an error with a retry (no live light, no 0/s).
 */
export function LiveRequests({ siteId }: { siteId: string }) {
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range: "1h", siteId } }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    meta: { background: true },
  });
  return (
    <Card size="sm" data-testid="live-requests">
      <QueryView query={traffic} frame={Pending} loadingClassName="min-h-42">
        {(data) => <LiveRequestsChart traffic={data} />}
      </QueryView>
    </Card>
  );
}

function LiveHeader({ children }: { children?: React.ReactNode }) {
  return (
    <CardHeader className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <CardTitle className="text-[13px] font-normal text-muted-foreground">
        {m.site_live_requests()}
      </CardTitle>
      {children}
    </CardHeader>
  );
}

/** The title over the loading or error state. */
function Pending({ children }: { children?: React.ReactNode }) {
  return (
    <>
      <LiveHeader />
      <CardContent>{children}</CardContent>
    </>
  );
}

function LiveRequestsChart({ traffic }: { traffic: Traffic }) {
  const points = React.useMemo<LivePoint[]>(
    () =>
      traffic.points.slice(0, -1).map((p) => ({
        time: Date.parse(p.time) / 1000,
        value: p.requests / traffic.bucketSeconds,
      })),
    [traffic],
  );
  const [reading, setReading] = React.useState<LivePoint | null>(null);
  const shown = reading ?? points.at(-1) ?? null;

  return (
    <>
      <LiveHeader>
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
      </LiveHeader>
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
    </>
  );
}
