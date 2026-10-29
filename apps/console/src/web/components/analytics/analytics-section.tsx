import type { AnalyticsRange, OverviewCard, SiteCard, TrafficTopItem } from "@edgeweir/contract";
import { RefreshIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { StatusCodesCard, TopListCard } from "@/components/analytics/breakdowns";
import { type DetailTarget, MetricDetailDialog } from "@/components/analytics/detail-dialog";
import {
  DIMENSION_CARDS,
  DimensionCards,
  TopCountriesCard,
} from "@/components/analytics/dimensions";
import { MetricChart } from "@/components/analytics/metric-chart";
import { MetricCard } from "@/components/analytics/panel";
import { RangeSelect } from "@/components/analytics/range-select";
import { TopRequestsCard } from "@/components/analytics/top-requests";
import { Button } from "@/components/arc/button/button";
import { type CardGroup, CardsMenu } from "@/components/cards-menu";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { useDialogState } from "@/hooks/use-dialog-state";
import { useHiddenCards } from "@/hooks/use-hidden-cards";
import { detailViews, METRICS, type Metric, relativeChange } from "@/lib/analytics";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;

type StatsCard = OverviewCard | SiteCard;

export interface TopList {
  id: "sites" | "nodes";
  title: string;
  renderLink: React.ComponentProps<typeof TopListCard>["renderLink"];
  showParent?: boolean;
}

/** Columns of a row of `count` compact charts: four side by side, two by two below @3xl. */
const SMALL_GRID = [
  "",
  "",
  "@sm/main:grid-cols-2",
  "@sm/main:grid-cols-2 @3xl/main:grid-cols-3",
  "@sm/main:grid-cols-2 @3xl/main:grid-cols-4",
];

/** Columns of the status row with `count` cards: four sit two by two up to a very wide main area. */
const STATUS_GRID = [
  "",
  "",
  "@3xl/main:grid-cols-2",
  "@3xl/main:grid-cols-2 @4xl/main:grid-cols-3",
  "@3xl/main:grid-cols-2 @7xl/main:grid-cols-4",
];

/**
 * Traffic of every site (or one site) over a range: two large charts with value axes,
 * four compact ones, the status-class split and optional top lists, then a site's countries,
 * networks, referrers, protocols and clients. Every card follows the one range control; a refetch
 * keeps the old numbers, dimmed, until the new ones arrive. The cards menu in the header hides
 * cards (the console home's or every site's, kept with the account); the rows close up around
 * the cards that remain, and a card's query stops while it is hidden.
 */
export function AnalyticsSection({
  range,
  onRangeChange,
  siteId,
  topLists = [],
  topCountries = false,
  aside,
  menuGroups,
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
  aside?: { id: OverviewCard; title: string; content: React.ReactNode };
  /** The console home's other cards in the cards menu, before and after these. */
  menuGroups?: { before: CardGroup<"overview">[]; after: CardGroup<"overview">[] };
  /** Entrance delay of the first card, in ms. */
  delay?: number;
}) {
  // The card whose breakdown dialog is open.
  const detail = useDialogState<string>();
  const cards = useHiddenCards(siteId ? "site" : "overview");
  const shows = (id: StatsCard) => !cards.hidden.has(id);
  const large = METRICS.filter((metric) => metric.size === "lg" && shows(metric.id));
  const small = METRICS.filter((metric) => metric.size === "sm" && shows(metric.id));
  const asideShown = aside && shows(aside.id) ? aside : null;
  const statusShown = shows("status-codes");
  const lists = topLists.filter((list) => shows(`top-${list.id}`));
  const countriesShown = topCountries && shows("top-countries");
  const requestLists = (["url", "ip"] as const).filter((by) => shows(`top-${by}s`));
  const dimensions = siteId ? DIMENSION_CARDS.filter((card) => shows(card.id)) : [];
  const statusCells = (statusShown ? 1 : 0) + lists.length + (countriesShown ? 1 : 0);
  const anyShown =
    large.length + small.length + statusCells + requestLists.length + dimensions.length > 0 ||
    !!asideShown;

  const available = { site: !siteId, node: true };
  const live = {
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    meta: { background: true },
  } as const;
  const known = cards.query.isSuccess;
  const traffic = useQuery({
    ...orpc.analytics.traffic.queryOptions({ input: { range, siteId } }),
    ...live,
  });
  const topSites = useQuery({
    ...orpc.analytics.topSites.queryOptions({ input: { range } }),
    ...live,
    enabled: known && lists.some((l) => l.id === "sites"),
  });
  const topNodes = useQuery({
    ...orpc.analytics.topNodes.queryOptions({ input: { range } }),
    ...live,
    enabled: known && lists.some((l) => l.id === "nodes"),
  });
  // Statistics dimensions: one query for every card that shows them.
  const dimensionsQuery = useQuery({
    ...orpc.analytics.dimensions.queryOptions({ input: { range, siteId } }),
    ...live,
    enabled: known && (dimensions.length > 0 || countriesShown),
  });
  const queries = [traffic, topSites, topNodes, dimensionsQuery];
  const fetching = queries.some((q) => q.isFetching);
  const stale = queries.some((q) => q.isPlaceholderData);
  // Cards enter one after another, in the order they show.
  let order = 0;
  const enter = (className?: string) => ({
    className: cn("animate-enter", className),
    style: { animationDelay: `${delay + order++ * 60}ms` },
  });
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

  const statsGroup: CardGroup<"overview" | "site"> = {
    label: m.analytics_title(),
    cards: [
      ...METRICS.filter((c) => c.size === "lg").map((c) => ({ id: c.id, label: c.title() })),
      ...(aside ? [{ id: aside.id, label: aside.title }] : []),
      ...METRICS.filter((c) => c.size === "sm").map((c) => ({ id: c.id, label: c.title() })),
      { id: "status-codes", label: m.analytics_status_codes() },
      ...topLists.map((list) => ({ id: `top-${list.id}` as const, label: list.title })),
      ...(topCountries ? [{ id: "top-countries" as const, label: m.stats_top_countries() }] : []),
      { id: "top-urls", label: m.analytics_top_urls() },
      { id: "top-ips", label: m.analytics_top_ips() },
      ...(siteId ? DIMENSION_CARDS.map((card) => ({ id: card.id, label: card.title() })) : []),
    ],
  };

  type Series = NonNullable<typeof traffic.data>;
  /** Every small metric is null or zero in every bucket: the row drops its charts. */
  const quiet = (series: Series) =>
    small.every((item) => series.points.every((p) => !item.point(p, series.bucketSeconds)));
  const chart = (item: Metric, series: Series, fill = false, empty = false) => {
    const data = series.points.map((point) => ({
      time: point.time,
      value: item.point(point, series.bucketSeconds),
    }));
    const total = item.total(series.totals);
    const open = () => detail.show(item.id);
    return (
      <div key={item.id} {...enter()}>
        <MetricCard
          title={item.title()}
          value={total === null ? "—" : item.format(total)}
          change={relativeChange(total, item.total(series.previous))}
          better={item.better}
          size={item.size}
          onOpen={open}
          testId={`metric-${item.id}`}
          fill={fill}
          empty={empty}
        >
          <MetricChart
            data={data}
            label={item.title()}
            format={item.format}
            axis={item.size === "lg"}
            domain={item.domain}
            onClick={open}
          />
        </MetricCard>
      </div>
    );
  };

  return (
    <section className="flex flex-col gap-3" aria-labelledby="analytics-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="analytics-title" className="mr-auto text-section font-medium">
          {m.analytics_title()}
        </h2>
        <RangeSelect value={range} onChange={onRangeChange} />
        <Button
          className="icon-button"
          size="sm"
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
        <CardsMenu
          cards={cards}
          groups={[...(menuGroups?.before ?? []), statsGroup, ...(menuGroups?.after ?? [])]}
        />
      </div>
      <QueryView query={combineQueries(traffic, cards.query)}>
        {([series]) => {
          // Counted afresh on every render of the cards (React may render them twice).
          order = 0;
          return anyShown ? (
            <div
              className={cn(
                "flex flex-col gap-3 transition-opacity duration-300",
                stale && "opacity-60",
              )}
              aria-busy={stale}
              data-testid="analytics"
            >
              {asideShown ? (
                <div
                  className={cn(
                    "grid gap-3",
                    large.length === 1 && "@3xl/main:grid-cols-2",
                    large.length > 0 && "@5xl/main:grid-cols-3",
                  )}
                >
                  {large.length > 0 ? (
                    <div
                      className={cn(
                        "grid gap-3 @5xl/main:col-span-2",
                        large.length > 1 && "@3xl/main:grid-cols-2 @5xl/main:grid-cols-1",
                      )}
                    >
                      {large.map((item) => chart(item, series, large.length === 1))}
                    </div>
                  ) : null}
                  <div {...enter("flex min-w-0 flex-col *:flex-1")}>{asideShown.content}</div>
                </div>
              ) : large.length > 0 ? (
                <div className={cn("grid gap-3", large.length > 1 && "@3xl/main:grid-cols-2")}>
                  {large.map((item) => chart(item, series))}
                </div>
              ) : null}
              {small.length > 0 ? (
                <div className={cn("grid gap-3", SMALL_GRID[small.length])}>
                  {small.map((item) => chart(item, series, false, quiet(series)))}
                </div>
              ) : null}
              {statusCells > 0 ? (
                <div className={cn("grid gap-3", STATUS_GRID[statusCells])}>
                  {statusShown ? (
                    <div {...enter()}>
                      <StatusCodesCard
                        totals={series.totals}
                        // Alone in the row, the classes sit side by side.
                        wide={statusCells === 1}
                        onOpen={() => detail.show("status-codes")}
                      />
                    </div>
                  ) : null}
                  {lists.map((list) => {
                    const items: TrafficTopItem[] =
                      (list.id === "sites" ? topSites.data : topNodes.data) ?? [];
                    return (
                      <div key={list.id} {...enter()}>
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
                  {countriesShown ? (
                    <div {...enter()}>
                      <TopCountriesCard query={dimensionsQuery} />
                    </div>
                  ) : null}
                </div>
              ) : null}
              {requestLists.length > 0 ? (
                <div
                  className={cn("grid gap-3", requestLists.length > 1 && "@3xl/main:grid-cols-2")}
                >
                  {requestLists.map((by) => (
                    <TopRequestsCard key={by} range={range} siteId={siteId} by={by} />
                  ))}
                </div>
              ) : null}
              {dimensions.length > 0 ? (
                <DimensionCards
                  query={dimensionsQuery}
                  shown={new Set(dimensions.map((card) => card.id))}
                  delay={delay + order * 60}
                />
              ) : null}
            </div>
          ) : (
            <EmptyState title={m.cards_all_hidden()}>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => cards.show(statsGroup.cards.map((card) => card.id))}
                data-testid="cards-show-all"
              >
                {m.cards_show_all()}
              </Button>
            </EmptyState>
          );
        }}
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
