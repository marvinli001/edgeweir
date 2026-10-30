import type { AiCrawlCatalogue, AiCrawlOverview, AnalyticsRange } from "@edgeweir/contract";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { NoTraffic, StatusCodesCard } from "@/components/analytics/breakdowns";
import { MetricChart } from "@/components/analytics/metric-chart";
import { ChangeIndicator, MetricCard, Panel, PanelHeader } from "@/components/analytics/panel";
import { RangeSelect } from "@/components/analytics/range-select";
import { Badge } from "@/components/arc/badge/badge";
import { FilterSelect } from "@/components/form-select";
import { LinkButton } from "@/components/link-button";
import { SafetyNote } from "@/components/safety-note";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { aiCrawlerCategoryLabel, formatUsd, verificationLabel } from "@/lib/ai-crawl";
import { relativeChange } from "@/lib/analytics";
import { formatBytes, formatCompact, formatNumber, formatPercent, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const REFRESH_MS = 60_000;
const MINUTE = 60_000;

type Totals = AiCrawlOverview["totals"];
type CrawlerRow = AiCrawlOverview["crawlers"][number];

/**
 * A site's AI crawler traffic over a range, optionally for one operator or crawler: a summary
 * line, metric cards (requests, allowed and failed with their trend; refused, bytes, robots.txt
 * fetches and pay per crawl charges as values), a card per operator with its crawlers, the status
 * classes and the most requested paths.
 */
export function AiCrawlOverviewSection({
  siteId,
  range,
  onRangeChange,
}: {
  siteId: string;
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
}) {
  const [operator, setOperator] = React.useState<string | undefined>();
  const [crawler, setCrawler] = React.useState<string | undefined>();
  const catalogue = useQuery(orpc.aiCrawl.catalogue.queryOptions());
  const overview = useQuery({
    ...orpc.aiCrawl.overview.queryOptions({ input: { id: siteId, range, crawler, operator } }),
    placeholderData: keepPreviousData,
    refetchInterval: REFRESH_MS,
    meta: { background: true },
  });
  const crawlers = (catalogue.data?.crawlers ?? []).filter(
    (c) => c.detectable && (!operator || c.operator === operator),
  );
  return (
    <section className="flex flex-col gap-3" aria-labelledby="ai-crawl-title">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id="ai-crawl-title" className="mr-auto text-section font-medium">
          {m.ai_crawl_overview_title()}
        </h2>
        <FilterSelect
          value={operator}
          onChange={(value) => {
            setOperator(value);
            setCrawler(undefined);
          }}
          allLabel={m.ai_crawl_all_operators()}
          options={(catalogue.data?.operators ?? []).map((o) => ({ value: o.id, label: o.name }))}
          label={m.ai_crawl_operator()}
          testId="ai-crawl-filter-operator"
          className="w-full sm:w-40"
        />
        <FilterSelect
          value={crawler}
          onChange={setCrawler}
          allLabel={m.ai_crawl_all_crawlers()}
          options={crawlers.map((c) => ({ value: c.id, label: c.name }))}
          label={m.ai_crawl_crawler()}
          testId="ai-crawl-filter-crawler"
          className="w-full sm:w-44"
        />
        <RangeSelect value={range} onChange={onRangeChange} />
      </div>
      <QueryView query={combineQueries(overview, catalogue)}>
        {([data, list]) => (
          <div
            className={cn(
              "flex flex-col gap-3 transition-opacity duration-300",
              overview.isPlaceholderData && "opacity-60",
            )}
            aria-busy={overview.isPlaceholderData}
            data-testid="ai-crawl-overview"
          >
            <OverviewBody siteId={siteId} data={data} catalogue={list} />
          </div>
        )}
      </QueryView>
    </section>
  );
}

function OverviewBody({
  siteId,
  data,
  catalogue,
}: {
  siteId: string;
  data: AiCrawlOverview;
  catalogue: AiCrawlCatalogue;
}) {
  const { totals, previous } = data;
  const partial =
    data.unsupportedNodes > 0 ? (
      <SafetyNote data-testid="ai-crawl-partial">{m.stats_dims_partial()}</SafetyNote>
    ) : null;
  if (totals.requests === 0)
    return (
      <>
        <EmptyState compact title={m.ai_crawl_no_requests()} />
        {partial}
      </>
    );
  const trend = (pick: (point: AiCrawlOverview["series"][number]) => number) =>
    data.series.map((point) => ({ time: point.t, value: pick(point) }));
  const card = (
    id: string,
    title: string,
    key: keyof Totals,
    better: "up" | "down",
    format: (value: number) => string = formatCompact,
    chart?: (point: AiCrawlOverview["series"][number]) => number,
  ) => (
    <MetricCard
      key={id}
      title={title}
      value={format(totals[key])}
      change={relativeChange(totals[key], previous[key])}
      better={better}
      size="sm"
      empty={!chart}
      testId={`ai-crawl-metric-${id}`}
    >
      {chart ? <MetricChart data={trend(chart)} label={title} format={formatCompact} /> : null}
    </MetricCard>
  );
  // The logs of the range: from its first bucket to a minute from now (the latest request is in).
  const logWindow = {
    from: data.series[0]?.t,
    to: new Date(Date.now() + MINUTE).toISOString(),
  };
  return (
    <>
      <p className="text-sm" data-testid="ai-crawl-summary">
        {m.ai_crawl_summary({
          crawlers: formatNumber(data.crawlers.length),
          requests: formatNumber(totals.requests),
          allowed: formatPercent((totals.allowed / totals.requests) * 100),
        })}
        {totals.charged > 0
          ? ` ${m.ai_crawl_summary_charged({
              count: formatNumber(totals.charged),
              amount: formatUsd(totals.chargedMicros),
            })}`
          : null}
      </p>
      <div className="grid gap-3 @sm/main:grid-cols-3">
        {card(
          "requests",
          m.ai_crawl_requests(),
          "requests",
          "up",
          formatCompact,
          (p) => p.requests,
        )}
        {card("allowed", m.ai_crawl_allowed(), "allowed", "up", formatCompact, (p) => p.allowed)}
        {card("failed", m.ai_crawl_failed(), "failed", "down", formatCompact, (p) => p.failed)}
      </div>
      <div className="grid gap-3 @sm/main:grid-cols-2 @3xl/main:grid-cols-4">
        {card("blocked", m.ai_crawl_blocked(), "blocked", "down")}
        {card("bytes", m.ai_crawl_bytes(), "bytes", "down", formatBytes)}
        {card("robots", m.ai_crawl_robots_fetches(), "robots", "up")}
        {card("charged", m.ai_crawl_charged(), "chargedMicros", "up", formatUsd)}
      </div>
      <div className="grid gap-3 @3xl/main:grid-cols-2" data-testid="ai-crawl-operators">
        {groupByOperator(data.crawlers, catalogue).map((group) => (
          <OperatorCard
            key={group.id}
            siteId={siteId}
            name={group.name}
            rows={group.rows}
            catalogue={catalogue}
            window={logWindow}
          />
        ))}
      </div>
      <div className="grid gap-3 @4xl/main:grid-cols-2">
        <StatusCodesCard totals={totals} />
        <TopPathsCard paths={data.paths} catalogue={catalogue} />
      </div>
      {partial}
    </>
  );
}

/** The crawlers with requests, by operator (the catalogue's order), the busiest operator first. */
function groupByOperator(rows: CrawlerRow[], catalogue: AiCrawlCatalogue) {
  const operatorOf = new Map(catalogue.crawlers.map((c) => [c.id, c.operator]));
  return catalogue.operators
    .map((operator) => {
      const mine = rows.filter((row) => operatorOf.get(row.crawler) === operator.id);
      return {
        id: operator.id,
        name: operator.name,
        rows: mine,
        requests: mine.reduce((sum, row) => sum + row.requests, 0),
      };
    })
    .filter((group) => group.rows.length > 0)
    .sort((a, b) => b.requests - a.requests);
}

function OperatorCard({
  siteId,
  name,
  rows,
  catalogue,
  window,
}: {
  siteId: string;
  name: string;
  rows: CrawlerRow[];
  catalogue: AiCrawlCatalogue;
  window: { from?: string; to?: string };
}) {
  const total = rows.reduce((sum, row) => sum + row.requests, 0);
  return (
    <Panel data-testid="ai-crawl-operator">
      <PanelHeader
        title={name}
        aside={<span className="text-dense tabular-nums">{formatCompact(total)}</span>}
      />
      <ul className="flex flex-col divide-y px-4 pt-2 pb-2">
        {rows.map((row) => {
          const entry = catalogue.crawlers.find((c) => c.id === row.crawler);
          return (
            <li
              key={row.crawler}
              className="flex flex-col gap-1.5 py-2.5"
              data-testid="ai-crawl-crawler-row"
              data-crawler={row.crawler}
            >
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{entry?.name ?? row.crawler}</span>
                {entry ? (
                  <Badge size="sm" tone="neutral">
                    {aiCrawlerCategoryLabel(entry.category)}
                  </Badge>
                ) : null}
                <span className="ml-auto tabular-nums" data-testid="ai-crawl-crawler-requests">
                  {formatCompact(row.requests)}
                </span>
                <ChangeIndicator
                  change={relativeChange(row.requests, row.previousRequests)}
                  better="up"
                />
                <LinkButton
                  size="sm"
                  variant="ghost"
                  className="icon-button relative size-6 min-h-6 -my-1 shrink-0"
                  aria-label={m.attacks_view_logs()}
                  title={m.attacks_view_logs()}
                  to="/sites/$id"
                  params={{ id: siteId }}
                  search={{ tab: "logs", crawler: row.crawler, from: window.from, to: window.to }}
                  data-testid="ai-crawl-crawler-logs"
                >
                  <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                </LinkButton>
              </div>
              <OutcomeBar row={row} />
              <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                <span>
                  {m.ai_crawl_allowed()} {formatCompact(row.allowed)}
                </span>
                <span>
                  {m.ai_crawl_blocked()} {formatCompact(row.blocked)}
                </span>
                {verificationParts(row).map(([key, count]) => (
                  <span key={key} data-testid={`ai-crawl-verification-${key}`}>
                    {verificationLabel(key)} {formatCompact(count)}
                  </span>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </Panel>
  );
}

/** The claims of a crawler by what the nodes found, without the empty ones. */
function verificationParts(row: CrawlerRow): [string, number][] {
  const pending = Math.max(0, row.requests - row.verified - row.unverified - row.unverifiable);
  return (
    [
      ["verified", row.verified],
      ["failed", row.unverified],
      ["unverifiable", row.unverifiable],
      ["pending", pending],
    ] as [string, number][]
  ).filter(([, count]) => count > 0);
}

/** Allowed, refused by AI crawl control and otherwise failed (4xx / 5xx), as one bar. */
function OutcomeBar({ row }: { row: CrawlerRow }) {
  const other = Math.max(0, row.failed - row.blocked);
  const parts = [
    { key: "allowed", value: row.allowed, color: "var(--status-2xx)" },
    { key: "blocked", value: row.blocked, color: "var(--status-5xx)" },
    { key: "other", value: other, color: "var(--status-4xx)" },
  ].filter((part) => part.value > 0);
  return (
    <div className="flex h-1.5 gap-0.5 overflow-hidden rounded-full bg-wash" aria-hidden>
      {parts.map((part) => (
        <span
          key={part.key}
          data-slot="bar-segment"
          className="h-full min-w-0.5 bg-(--segment)"
          style={{ flexGrow: part.value, "--segment": part.color } as React.CSSProperties}
        />
      ))}
    </div>
  );
}

function TopPathsCard({
  paths,
  catalogue,
}: {
  paths: AiCrawlOverview["paths"];
  catalogue: AiCrawlCatalogue;
}) {
  const max = Math.max(1, ...paths.map((p) => p.requests));
  const nameOf = new Map(catalogue.crawlers.map((c) => [c.id, c.name]));
  return (
    <Panel className="h-full" data-testid="ai-crawl-paths">
      <PanelHeader title={m.ai_crawl_top_paths()} />
      {paths.length === 0 ? (
        <NoTraffic />
      ) : (
        <ol className="flex flex-col px-4 pt-2 pb-2">
          {paths.map((p) => (
            <li key={`${p.crawler}|${p.path}`} className="flex flex-col gap-1.5 py-2">
              <span className="flex items-baseline gap-2 text-sm">
                <span className="min-w-0 truncate font-mono text-xs" title={p.path}>
                  {p.path}
                </span>
                <span className="shrink-0 truncate text-xs text-muted-foreground">
                  {nameOf.get(p.crawler) ?? p.crawler}
                </span>
                <span className="ml-auto shrink-0 tabular-nums">{formatCompact(p.requests)}</span>
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-wash">
                <span
                  data-slot="bar-fill"
                  className="block h-full rounded-full bg-metric"
                  style={{ width: `${(p.requests / max) * 100}%` }}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}
