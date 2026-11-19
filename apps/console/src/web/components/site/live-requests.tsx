import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Panel, PanelHeader } from "@/components/analytics/panel";
import { RequestRateCard } from "@/components/analytics/request-rate-card";
import { QueryView } from "@/components/states";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export function LiveRequests({ siteId }: { siteId: string }) {
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range: "1h", siteId } }),
    refetchInterval: 60_000,
    placeholderData: keepPreviousData,
    meta: { background: true },
  });
  return (
    <QueryView query={traffic} frame={Pending} loadingClassName="min-h-42">
      {(data) => (
        <RequestRateCard
          title={m.site_live_requests()}
          points={data.points.slice(0, -1)}
          seconds={data.bucketSeconds}
          live
        />
      )}
    </QueryView>
  );
}

function Pending({ children }: { children?: ReactNode }) {
  return (
    <Panel>
      <PanelHeader title={m.site_live_requests()} />
      {children}
    </Panel>
  );
}
