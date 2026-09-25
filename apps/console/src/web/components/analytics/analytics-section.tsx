import type { AnalyticsRange, TrafficTopItem } from "@edgeweir/contract";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { StatusCodesCard, TopListCard } from "@/components/analytics/breakdowns";
import { type DetailTarget, MetricDetailDialog } from "@/components/analytics/detail-dialog";
import { MetricChart } from "@/components/analytics/metric-chart";
import { MetricCard } from "@/components/analytics/panel";
import { RangeSelect } from "@/components/analytics/range-select";
import { ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
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
 * Traffic of the caller's scope (or one site) over a range: two large charts with value axes,
 * four compact ones, the status-class split and optional top lists. Every card follows the one
 * range control; a refetch keeps the old numbers, dimmed, until the new ones arrive.
 */
export function AnalyticsSection({
  range,
  onRangeChange,
  siteId,
  topLists = [],
  admin = false,
  delay = 0,
}: {
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
  siteId?: string;
  topLists?: TopList[];
  /** Platform administrator: node breakdowns and each site's organization in the dialogs. */
  admin?: boolean;
  /** Entrance delay of the first card, in ms. */
  delay?: number;
}) {
  // The card whose breakdown dialog is open.
  const [detail, setDetail] = React.useState<string | null>(null);
  const available = { site: !siteId, node: admin };
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
  const queries = [traffic, topSites, topNodes];
  const fetching = queries.some((q) => q.isFetching);
  const stale = queries.some((q) => q.isPlaceholderData);
  const enter = (index: number, className?: string) => ({
    className: cn("animate-enter", className),
    style: { animationDelay: `${delay + index * 60}ms` },
  });
  // Without top lists the status card has the row to itself.
  const statusWide = topLists.length === 0;
  const metric = METRICS.find((candidate) => candidate.id === detail);
  const target: DetailTarget | null = metric
    ? {
        id: metric.id,
        title: metric.title(),
        views: detailViews(metric.details, available),
        metric,
      }
    : detail === "status-codes"
      ? {
          id: detail,
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
      {traffic.isPending ? (
        <LoadingState />
      ) : traffic.isError ? (
        <ErrorState error={traffic.error} onRetry={() => traffic.refetch()} />
      ) : (
        <div
          className={cn(
            "flex flex-col gap-3 transition-opacity duration-300",
            stale && "opacity-60",
          )}
          aria-busy={stale}
          data-testid="analytics"
        >
          {(["lg", "sm"] as const).map((size, row) => (
            <div
              key={size}
              className={cn(
                "grid gap-3",
                size === "lg" ? "@3xl/main:grid-cols-2" : "grid-cols-2 @3xl/main:grid-cols-4",
              )}
            >
              {METRICS.filter((metric) => metric.size === size).map((metric, index) => {
                const data = traffic.data.points.map((point) => ({
                  time: point.time,
                  value: metric.point(point, traffic.data.bucketSeconds),
                }));
                const total = metric.total(traffic.data.totals);
                const open = () => setDetail(metric.id);
                return (
                  <div key={metric.id} {...enter(row * 2 + index)}>
                    <MetricCard
                      title={metric.title()}
                      value={total === null ? "—" : metric.format(total)}
                      change={relativeChange(total, metric.total(traffic.data.previous))}
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
          ))}
          <div
            className={cn(
              "grid gap-3 @3xl/main:grid-cols-2",
              topLists.length > 1 && "@4xl/main:grid-cols-3",
            )}
          >
            <div {...enter(6, statusWide ? "@3xl/main:col-span-2" : undefined)}>
              <StatusCodesCard
                totals={traffic.data.totals}
                wide={statusWide}
                onOpen={() => setDetail("status-codes")}
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
          </div>
        </div>
      )}
      <MetricDetailDialog
        target={target}
        onClose={() => setDetail(null)}
        range={range}
        onRangeChange={onRangeChange}
        siteId={siteId}
        traffic={traffic.data}
        showParent={admin}
      />
    </section>
  );
}
