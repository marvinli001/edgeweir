import { Add01Icon, GlobeIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { GradientGlow } from "@/components/appica/effects";
import { Meter } from "@/components/appica/meter";
import { Sparkline } from "@/components/appica/sparkline";
import { Page } from "@/components/page";
import { SectionCards } from "@/components/section-cards";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { TrafficChart } from "@/components/traffic-chart";
import { buttonVariants } from "@/components/ui/button";
import { formatNumber, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/")({
  component: OverviewPage,
});

function OverviewPage() {
  const overview = useQuery({
    ...orpc.overview.get.queryOptions(),
    refetchInterval: 10_000,
    meta: { background: true },
  });

  return (
    <Page title={m.overview_title()}>
      {overview.isPending ? (
        <LoadingState />
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => overview.refetch()} />
      ) : overview.data.sites === 0 ? (
        <EmptyState icon={GlobeIcon} title={m.sites_empty_title()}>
          <Link to="/sites" search={{ create: true }} className={buttonVariants()}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.nav_new_site()}
          </Link>
        </EmptyState>
      ) : (
        <>
          <GradientGlow>
            <SectionCards cards={statCards(overview.data)} />
          </GradientGlow>
          <TrafficChart data={overview.data.traffic} />
        </>
      )}
    </Page>
  );
}

function statCards(data: { sites: number; traffic: { requests: number; cacheHits: number }[] }) {
  const requests = data.traffic.reduce((sum, p) => sum + p.requests, 0);
  const hits = data.traffic.reduce((sum, p) => sum + p.cacheHits, 0);
  const ratio = requests > 0 ? (hits / requests) * 100 : 0;
  return [
    { label: m.overview_sites(), value: formatNumber(data.sites), testId: "stat-sites" },
    {
      label: m.overview_requests(),
      value: formatNumber(requests),
      visual: (
        <Sparkline data={data.traffic.map((p) => p.requests)} label={m.overview_requests()} />
      ),
      testId: "stat-requests",
    },
    {
      label: m.overview_hit_ratio(),
      value: requests > 0 ? formatPercent(ratio) : "—",
      visual: <Meter value={ratio} label={m.overview_hit_ratio()} />,
      testId: "stat-hit-ratio",
    },
  ];
}
