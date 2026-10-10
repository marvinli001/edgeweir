import type { AnalyticsRange, TrafficTopItem } from "@edgeweir/contract";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { StatusCodesCard, TopListCard } from "@/components/analytics/breakdowns";
import { type DetailTarget, MetricDetailDialog } from "@/components/analytics/detail-dialog";
import { DimensionCards, TopCountriesCard } from "@/components/analytics/dimensions";
import { MetricChart } from "@/components/analytics/metric-chart";
import { MetricCard } from "@/components/analytics/panel";
import { RangeSelect } from "@/components/analytics/range-select";
import { TopRequestsCard } from "@/components/analytics/top-requests";
import { QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { useDialogState } from "@/hooks/use-dialog-state";
import { detailViews, METRICS, relativeChange } from "@/lib/analytics";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;

export interface TopList {
  id: "sites" | "nodes";
  title: string;
  renderLink: React.ComponentProps<typeof TopListCard>["renderLink"];
  showParent?: boolean;
}

/**
 * Traffic of every site (or one site) over a range: two large charts with value axes,
 * four compact ones, the status-class split and optional top lists, then a site's countries,
 * networks, referrers, protocols and clients. Every card follows the one range control; a refetch
 * keeps the old numbers, dimmed, until the new ones arrive.
 */
export function AnalyticsSection({
  range,
  onRangeChange,
  siteId,
  topLists = [],
  topCountries = false,
  aside,
  delay = 0,
}: {
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
  siteId?: string;
  topLists?: TopList[];
  /** The countries with the most bytes sent, beside the top lists (the overview's). */
  topCountries?: boolean;
  /**
   * A card beside the two large charts (the overview's edge network): from @5xl the charts stack
   * in two thirds of the row and the card takes the last third; narrower, it follows them.
   */
  aside?: React.ReactNode;
  /** Entrance delay of the first card, in ms. */
  delay?: number;
}) {
  // The card whose breakdown dialog is open.
  const detail = useDialogState<string>();
  const available = { site: !siteId, node: true };
  const live = {
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    meta: { background: true },
  } as const;
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range, siteId } }),
    ...live,
  });
  const topSites = useQuery({
    ...orpc.analytics.topSites.queryOptions({ input: { range } }),
    ...live,
    enabled: topLists.some((l) => l.id === "sites"),
  });
  const topNodes = useQuery({
    ...orpc.analytics.topNodes.queryOptions({ input: { range } }),
    ...live,
    enabled: topLists.some((l) => l.id === "nodes"),
  });
  // Statistics dimensions: one query for every card that shows them.
  const dimensions = useQuery({
    ...orpc.analytics.dimensions.queryOptions({ input: { range, siteId } }),
    ...live,
    enabled: !!siteId || topCountries,
  });
  const queries = [traffic, topSites, topNodes, dimensions];
  const fetching = queries.some((q) => q.isFetching);
  const stale = queries.some((q) => q.isPlaceholderData);
  const enter = (index: number, className?: string) => ({
    className: cn("animate-enter", className),
    style: { animationDelay: `${delay + index * 60}ms` },
  });
  // Without top lists the status card has the row to itself.
  const statusWide = topLists.length === 0 && !topCountries;
  // Cards in the status row: four sit two by two up to a very wide main area.
  const cells = 1 + topLists.length + (topCountries ? 1 : 0);
  const metric = METRICS.find((candidate) => candidate.id === detail.value);
  const target: DetailTarget | null = metric
    ? {
        id: metric.id,
        title: metric.title(),
        views: detailViews(metric.details, available),
        metric,
      }
    : detail.value === "status-codes"
      ? {
          id: detail.value,
          title: m.analytics_status_codes(),
          views: detailViews([{ kind: "status" }], available),
        }
      : null;

  return (
    <section className="flex flex-col gap-3" aria-labelledby="analytics-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="analytics-title" className="mr-auto text-base font-semibold">
          {m.analytics_title()}
        </h2>
        <RangeSelect value={range} onChange={onRangeChange} />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={m.analytics_refresh()}
          disabled={fetching}
          onClick={() => {
            for (const q of queries) if (q.isEnabled) void q.refetch();
          }}
          data-testid="analytics-refresh"
        >
          <HugeiconsIcon
            icon={RefreshIcon}
            strokeWidth={2}
            className={cn(fetching && "animate-spin motion-reduce:animate-none")}
          />
        </Button>
      </div>
      <QueryView query={traffic}>
        {(series) => (
          <div
            className={cn(
              "flex flex-col gap-3 transition-opacity duration-300",
              stale && "opacity-60",
            )}
            aria-busy={stale}
            data-testid="analytics"
          >
            {(["lg", "sm"] as const).map((size, row) => {
              const charts = (
                <div
                  key={size}
                  className={cn(
                    "grid gap-3",
                    size === "sm"
                      ? "@sm/main:grid-cols-2 @3xl/main:grid-cols-4"
                      : aside
                        ? "@3xl/main:grid-cols-2 @5xl/main:col-span-2 @5xl/main:grid-cols-1"
                        : "@3xl/main:grid-cols-2",
                  )}
                >
                  {METRICS.filter((metric) => metric.size === size).map((metric, index) => {
                    const data = series.points.map((point) => ({
                      time: point.time,
                      value: metric.point(point, series.bucketSeconds),
                    }));
                    const total = metric.total(series.totals);
                    const open = () => detail.show(metric.id);
                    return (
                      <div key={metric.id} {...enter(row * 2 + index)}>
                        <MetricCard
                          title={metric.title()}
                          value={total === null ? "—" : metric.format(total)}
                          change={relativeChange(total, metric.total(series.previous))}
                          better={metric.better}
                          size={size}
                          onOpen={open}
                          testId={`metric-${metric.id}`}
                        >
                          <MetricChart
                            data={data}
                            label={metric.title()}
                            format={metric.format}
                            axis={size === "lg"}
                            domain={metric.domain}
                            onClick={open}
                          />
                        </MetricCard>
                      </div>
                    );
                  })}
                </div>
              );
              return size === "lg" && aside ? (
                <div key={size} className="grid gap-3 @5xl/main:grid-cols-3">
                  {charts}
                  <div {...enter(2, "flex min-w-0 flex-col *:flex-1")}>{aside}</div>
                </div>
              ) : (
                charts
              );
            })}
            <div
              className={cn(
                "grid gap-3 @3xl/main:grid-cols-2",
                cells === 3 && "@4xl/main:grid-cols-3",
                cells >= 4 && "@7xl/main:grid-cols-4",
              )}
            >
              <div {...enter(6, statusWide ? "@3xl/main:col-span-2" : undefined)}>
                <StatusCodesCard
                  totals={series.totals}
                  wide={statusWide}
                  onOpen={() => detail.show("status-codes")}
                />
              </div>
              {topLists.map((list, index) => {
                const items: TrafficTopItem[] =
                  (list.id === "sites" ? topSites.data : topNodes.data) ?? [];
                return (
                  <div key={list.id} {...enter(7 + index)}>
                    <TopListCard
                      title={list.title}
                      items={items}
                      renderLink={list.renderLink}
                      showParent={list.showParent}
                      testId={`top-${list.id}`}
                    />
                  </div>
                );
              })}
              {topCountries ? (
                <div {...enter(7 + topLists.length)}>
                  <TopCountriesCard query={dimensions} />
                </div>
              ) : null}
            </div>
            <div className="grid gap-3 @3xl/main:grid-cols-2">
              <TopRequestsCard range={range} siteId={siteId} by="url" />
              <TopRequestsCard range={range} siteId={siteId} by="ip" />
            </div>
            {siteId ? <DimensionCards query={dimensions} delay={delay + 9 * 60} /> : null}
          </div>
        )}
      </QueryView>
      <MetricDetailDialog
        target={target}
        open={detail.open}
        onOpenChange={detail.onOpenChange}
        range={range}
        onRangeChange={onRangeChange}
        siteId={siteId}
        traffic={traffic.data}
        showParent
      />
    </section>
  );
}
