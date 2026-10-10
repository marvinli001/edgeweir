import type { StatsDimensions } from "@edgeweir/contract";
import type * as React from "react";
import { NoTraffic } from "@/components/analytics/breakdowns";
import { Panel, PanelHeader } from "@/components/analytics/panel";
import { SafetyNote } from "@/components/safety-note";
import { type QueryResult, QueryView } from "@/components/states";
import {
  asnText,
  browserLabel,
  countryName,
  deviceLabel,
  httpVersionLabel,
  osLabel,
  tlsVersionLabel,
} from "@/lib/access-logs";
import { OTHER_COLOR, SERIES_COLORS } from "@/lib/analytics";
import { formatBytes, formatCompact, formatPercent, m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Rows a ranked card shows (the API keeps more). */
const RANK_SIZE = 10;
/** Countries on the overview, as many as its other top lists. */
const OVERVIEW_COUNTRIES = 5;

interface RankItem {
  key: string;
  label: React.ReactNode;
  /** What the bar is scaled by. */
  value: number;
  /** The value as shown. */
  display: string;
  /** A second value, quieter (bytes beside requests). */
  aside?: string;
}

/** A ranked list with a share bar under each row, scaled to the leader. */
function RankCard({
  title,
  items,
  testId,
  className,
  style,
}: {
  title: string;
  items: RankItem[];
  testId: string;
  className?: string;
  style?: React.CSSProperties;
}) {
  const max = Math.max(1, ...items.map((item) => item.value));
  return (
    <Panel data-testid={testId} className={cn("h-full", className)} style={style}>
      <PanelHeader title={title} />
      {items.length === 0 ? (
        <NoTraffic />
      ) : (
        <ol className="flex flex-col px-2 pt-2 pb-2">
          {items.map((item) => (
            <li
              key={item.key}
              className="flex flex-col gap-1.5 rounded-xl px-2 py-2"
              data-testid="stats-item"
              data-key={item.key}
            >
              <span className="flex min-w-0 items-baseline gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate">{item.label}</span>
                {item.aside ? (
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {item.aside}
                  </span>
                ) : null}
                <span className="shrink-0 tabular-nums">{item.display}</span>
              </span>
              <span className="h-1 overflow-hidden rounded-full bg-wash">
                <span
                  data-slot="bar-fill"
                  className="block h-full rounded-full bg-metric transition-[width] duration-500 motion-reduce:transition-none"
                  style={{ width: `${(item.value / max) * 100}%` }}
                />
              </span>
            </li>
          ))}
        </ol>
      )}
    </Panel>
  );
}

const countryLabel = (code: string) => (
  <>
    <span className="font-medium">{countryName(code)}</span>
    {code ? <span className="ml-1.5 font-mono text-xs text-muted-foreground">{code}</span> : null}
  </>
);

/** No requests in any of the lists: the card shows one quiet line instead of one per list. */
const silent = (...lists: { requests: number }[][]) =>
  lists.every((list) => list.every((item) => item.requests === 0));

/**
 * One dimension's split: a segmented bar and the leading keys with their share; the rest (and the
 * key "other") is one gray "other".
 */
function Distribution({
  title,
  items,
  label,
  testId,
}: {
  title: string;
  items: { key: string; requests: number }[];
  label: (key: string) => string;
  testId: string;
}) {
  const total = items.reduce((sum, item) => sum + item.requests, 0);
  const named = items
    .filter((item) => item.key !== "other" && item.requests > 0)
    .sort((a, b) => b.requests - a.requests);
  const shown = named.slice(0, SERIES_COLORS.length);
  const rest = total - shown.reduce((sum, item) => sum + item.requests, 0);
  const segments = [
    ...shown.map((item, index) => ({
      key: item.key,
      label: label(item.key),
      value: item.requests,
      color: SERIES_COLORS[index] as string,
    })),
    ...(rest > 0
      ? [{ key: "other", label: m.analytics_other(), value: rest, color: OTHER_COLOR }]
      : []),
  ];
  return (
    <div className="flex min-w-0 flex-col gap-2.5" data-testid={testId}>
      <h4 className="text-xs font-medium text-muted-foreground">{title}</h4>
      {total === 0 ? (
        <p className="text-sm text-muted-foreground">{m.analytics_no_traffic()}</p>
      ) : (
        <>
          <div className="flex h-2 gap-0.5 overflow-hidden rounded-[4px]" aria-hidden>
            {segments.map((segment) => (
              <span
                key={segment.key}
                data-slot="bar-segment"
                className="h-full min-w-0.5 bg-(--segment) transition-[flex-grow] duration-500 motion-reduce:transition-none"
                // The color through a class, so forced colors can repaint it (index.css).
                style={
                  { flexGrow: segment.value, "--segment": segment.color } as React.CSSProperties
                }
              />
            ))}
          </div>
          <ul className="flex flex-col gap-1.5 text-sm">
            {segments.map((segment) => (
              <li
                key={segment.key}
                className="flex min-w-0 items-center gap-2"
                data-testid="stats-share"
                data-key={segment.key}
              >
                <span
                  className="size-2.5 shrink-0 rounded-[3px]"
                  style={{ backgroundColor: segment.color }}
                />
                <span className="min-w-0 flex-1 truncate">{segment.label}</span>
                <span className="shrink-0 tabular-nums">{formatCompact(segment.value)}</span>
                <span className="w-14 shrink-0 text-right text-xs tabular-nums text-muted-foreground">
                  {formatPercent((segment.value / total) * 100)}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/**
 * A site's countries, networks, referring hosts, clients and protocols, under the top lists.
 * Three columns from @5xl (clients take two), two from @3xl (clients move to a row of their own,
 * so protocols sit beside the referrers).
 */
export function DimensionCards({
  query,
  delay = 0,
}: {
  query: QueryResult<StatsDimensions>;
  /** Entrance delay of the first card, in ms. */
  delay?: number;
}) {
  const enter = (index: number) => ({
    className: "animate-enter",
    style: { animationDelay: `${delay + index * 60}ms` },
  });
  return (
    <QueryView query={query}>
      {(data) => (
        <div className="flex flex-col gap-3" data-testid="stats-dimensions">
          {data.unsupportedNodes > 0 ? (
            <SafetyNote data-testid="stats-dims-partial">{m.stats_dims_partial()}</SafetyNote>
          ) : null}
          <div className="grid gap-3 @3xl/main:grid-cols-2 @5xl/main:grid-cols-3">
            <RankCard
              title={m.stats_countries()}
              testId="stats-countries"
              {...enter(0)}
              items={data.countries.slice(0, RANK_SIZE).map((item) => ({
                key: item.country || "unknown",
                label: countryLabel(item.country),
                value: item.requests,
                display: formatCompact(item.requests),
                aside: formatBytes(item.bytesSent),
              }))}
            />
            <RankCard
              title={m.stats_asns()}
              testId="stats-asns"
              {...enter(1)}
              items={data.asns.slice(0, RANK_SIZE).map((item) => ({
                key: String(item.asn),
                label: (
                  <>
                    <span className="font-mono text-xs">{asnText(item.asn)}</span>
                    {item.name ? <span className="ml-1.5">{item.name}</span> : null}
                  </>
                ),
                value: item.requests,
                display: formatCompact(item.requests),
              }))}
            />
            <RankCard
              title={m.stats_referers()}
              testId="stats-referers"
              {...enter(2)}
              items={data.referers.slice(0, RANK_SIZE).map((item) => ({
                key: item.host,
                label: <span className="font-mono text-xs">{item.host}</span>,
                value: item.requests,
                display: formatCompact(item.requests),
              }))}
            />
            <Panel
              data-testid="stats-clients"
              className="h-full animate-enter @3xl/main:order-last @3xl/main:col-span-2 @5xl/main:order-none"
              style={{ animationDelay: `${delay + 3 * 60}ms` }}
            >
              <PanelHeader title={m.stats_clients()} />
              {silent(data.browsers, data.oses, data.devices) ? (
                <NoTraffic />
              ) : (
                <div className="@container px-4 pt-3 pb-4">
                  <div className="grid gap-5 @xl:grid-cols-3 @xl:gap-6">
                    <Distribution
                      title={m.stats_browsers()}
                      items={data.browsers}
                      label={browserLabel}
                      testId="stats-browsers"
                    />
                    <Distribution
                      title={m.stats_oses()}
                      items={data.oses}
                      label={osLabel}
                      testId="stats-oses"
                    />
                    <Distribution
                      title={m.stats_devices()}
                      items={data.devices}
                      label={deviceLabel}
                      testId="stats-devices"
                    />
                  </div>
                </div>
              )}
            </Panel>
            <Panel
              data-testid="stats-protocols"
              className="h-full animate-enter"
              style={{ animationDelay: `${delay + 4 * 60}ms` }}
            >
              <PanelHeader title={m.stats_protocols()} />
              {silent(data.httpVersions, data.tlsVersions) ? (
                <NoTraffic />
              ) : (
                <div className="grid gap-5 px-4 pt-3 pb-4">
                  <Distribution
                    title={m.stats_http_versions()}
                    items={data.httpVersions}
                    label={httpVersionLabel}
                    testId="stats-http-versions"
                  />
                  <Distribution
                    title={m.stats_tls_versions()}
                    items={data.tlsVersions}
                    label={tlsVersionLabel}
                    testId="stats-tls-versions"
                  />
                </div>
              )}
            </Panel>
          </div>
        </div>
      )}
    </QueryView>
  );
}

/** The card around the overview's countries while they load or fail. */
function CountriesFrame({ children }: { children?: React.ReactNode }) {
  return (
    <Panel data-testid="top-countries" className="h-full">
      <PanelHeader title={m.stats_top_countries()} />
      <div className="px-4 py-4">{children}</div>
    </Panel>
  );
}

/** The overview's countries with the most bytes sent, across every site. */
export function TopCountriesCard({ query }: { query: QueryResult<StatsDimensions> }) {
  return (
    <QueryView query={query} frame={CountriesFrame}>
      {(data) => (
        <RankCard
          title={m.stats_top_countries()}
          testId="top-countries"
          items={[...data.countries]
            .sort((a, b) => b.bytesSent - a.bytesSent)
            .filter((item) => item.bytesSent > 0)
            .slice(0, OVERVIEW_COUNTRIES)
            .map((item) => ({
              key: item.country || "unknown",
              label: countryLabel(item.country),
              value: item.bytesSent,
              display: formatBytes(item.bytesSent),
            }))}
        />
      )}
    </QueryView>
  );
}
