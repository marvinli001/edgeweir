import {
  type AnalyticsRange,
  crsDetectionRule,
  type SecurityEventKind,
  securityEventKind,
  type TrafficBreakdown,
} from "@edgeweir/contract";
import { Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import {
  type ChartRow,
  type Series,
  SeriesLegend,
  StackedBarsChart,
  seriesColor,
  useSeriesSlots,
} from "@/components/analytics/breakdown-charts";
import { FormSelect } from "@/components/form-select";
import { Pager } from "@/components/pager";
import { RowMenu, type RowMenuItem } from "@/components/quick-actions";
import { SafetyNote } from "@/components/safety-note";
import { AutoMitigationCard } from "@/components/site/auto-mitigation-card";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { blockReasonLabel, clientJump, type LogJump } from "@/lib/access-logs";
import { ANALYTICS_RANGES, OTHER_COLOR, RANGE_HOURS, rangeLabel } from "@/lib/analytics";
import { formatCompact, formatDateTime, formatNumber, formatPercent, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { eventKindLabel, levelLabel, metricLabel } from "@/lib/protection";
import { groupBuckets } from "@/lib/time-buckets";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 20;
const ALL = "all";
/** Reasons plotted on their own; the rest are one gray series. */
const CHART_REASONS = 5;
const MINUTE = 60_000;

/**
 * The jump into the site's logs for something on this tab: the filters, within `hours` back from
 * now (the end a minute ahead, so the request that just happened is in).
 */
function windowJump(jump: LogJump, hours: number): LogJump {
  const now = Date.now();
  return {
    ...jump,
    from: new Date(now - hours * 3_600_000).toISOString(),
    to: new Date(now + MINUTE).toISOString(),
  };
}

/** A small link to the site's sampled logs, filtered. */
function LogsLink({ siteId, jump, testId }: { siteId: string; jump: LogJump; testId?: string }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      className="-my-1 shrink-0"
      nativeButton={false}
      aria-label={m.attacks_view_logs()}
      title={m.attacks_view_logs()}
      render={
        <Link
          to="/sites/$id"
          params={{ id: siteId }}
          search={{ tab: "logs", ...jump }}
          data-testid={testId}
        />
      }
    >
      <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
    </Button>
  );
}

/** The site's attack dashboard: what was refused and why, who is behind it, and where to look. */
export function AttacksTab({
  siteId,
  siteName,
  range,
  onRangeChange,
}: {
  siteId: string;
  siteName: string;
  range: AnalyticsRange;
  onRangeChange: (range: AnalyticsRange) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex justify-end">
        <div className="w-full sm:w-44">
          <FormSelect
            id="attacks-range"
            label={m.security_hours()}
            value={range}
            testId="attacks-range"
            options={ANALYTICS_RANGES.map((value) => ({ value, label: rangeLabel(value) }))}
            onChange={(value) => onRangeChange(value as AnalyticsRange)}
          />
        </div>
      </div>
      <AutoMitigationCard siteId={siteId} siteName={siteName} />
      <BlockReasonsCard siteId={siteId} range={range} />
      <NodeLevelsCard siteId={siteId} />
      <TopCard siteId={siteId} range={range} />
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        <WafRulesCard siteId={siteId} range={range} />
        <LoggedRulesCard siteId={siteId} range={range} />
        <ChallengesCard siteId={siteId} range={range} />
        <AuthFailuresCard siteId={siteId} range={range} />
      </div>
      {/* A new range starts at the first page. */}
      <EventsCard key={range} siteId={siteId} range={range} />
    </div>
  );
}

/** The site's statistics dimensions over the range (block reasons, challenges). */
function useDimensions(siteId: string, range: AnalyticsRange) {
  return useQuery({
    ...orpc.analytics.dimensions.queryOptions({ input: { range, siteId } }),
    placeholderData: keepPreviousData,
  });
}

/**
 * Requests refused or challenged per block reason: stacked bars over the range with the five
 * leading reasons, and the ranked reasons, each linking to the logs of that reason.
 */
function BlockReasonsCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const over = useQuery({
    ...orpc.analytics.breakdown.queryOptions({
      input: { range, siteId, by: "block_reason", limit: 20 },
    }),
    placeholderData: keepPreviousData,
  });
  const dimensions = useDimensions(siteId, range);
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
      data-testid="block-reasons-card"
    >
      <CardHeader>
        <CardTitle>{m.block_reasons_title()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={combineQueries(over, dimensions)}>
          {([series, { blockReasons, unsupportedNodes }]) => (
            <>
              {series.total > 0 ? <BlockReasonsChart data={series} range={range} /> : null}
              <TopList
                title={m.block_reasons_reason()}
                items={[...blockReasons]
                  .filter((item) => item.requests > 0)
                  .sort((a, b) => b.requests - a.requests)
                  .map((item) => ({
                    id: item.key,
                    value: blockReasonLabel(item.key),
                    count: item.requests,
                  }))}
                testId="block-reasons"
                trailing={(item) => (
                  <LogsLink
                    siteId={siteId}
                    jump={{
                      blockReason: item.id as LogJump["blockReason"],
                      from: series.from,
                      to: new Date(Date.parse(series.to) + MINUTE).toISOString(),
                    }}
                    testId="block-reason-logs"
                  />
                )}
              />
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="block-reasons-partial">
                  {m.stats_dims_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Stacked bars of the leading reasons over time, the rest in gray. */
function BlockReasonsChart({ data, range }: { data: TrafficBreakdown; range: AnalyticsRange }) {
  const leaders = data.items.slice(0, CHART_REASONS);
  const slots = useSeriesSlots(leaders.map((item) => item.id));
  const rest = data.totalSeries.map((total, t) =>
    Math.max(0, total - leaders.reduce((sum, item) => sum + (item.series[t] ?? 0), 0)),
  );
  const restTotal = rest.reduce((sum, value) => sum + value, 0);
  const series: (Series & { value: string })[] = leaders.map((item, index) => ({
    key: `s${index}`,
    label: blockReasonLabel(item.id),
    color: seriesColor(slots.get(item.id)),
    value: formatCompact(item.total),
  }));
  if (restTotal > 0)
    series.push({
      key: "rest",
      label: m.analytics_other(),
      color: OTHER_COLOR,
      value: formatCompact(restTotal),
    });
  const groups = groupBuckets(
    data.times,
    [...leaders.map((item) => item.series), ...(restTotal > 0 ? [rest] : [])],
    data.bucketSeconds,
  );
  const rows: ChartRow[] = groups.map((group) => ({
    time: group.time,
    ...Object.fromEntries(series.map((s, i) => [s.key, group.values[i] ?? 0])),
  }));
  return (
    <div className="rounded-2xl sunk-well pb-3" data-testid="block-reasons-chart">
      <SeriesLegend series={series} mark="bar" />
      <div className="px-4 pt-3">
        <StackedBarsChart data={rows} series={series} format={formatCompact} range={range} />
      </div>
    </div>
  );
}

/** One ranked list: a title and the entries with their counts (and a trailing control). */
function TopList({
  title,
  items,
  testId,
  mono,
  actions,
  trailing,
}: {
  title: string;
  /** `id` keys an entry whose value may repeat (e.g. rule names). */
  items: { id?: string; value: string; count: number }[];
  testId: string;
  mono?: boolean;
  /** The row menu of an entry. */
  actions?: (value: string) => RowMenuItem[];
  /** Something after the count, e.g. a link. */
  trailing?: (item: { id?: string; value: string; count: number }) => React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2" data-testid={testId}>
      <h3 className="text-sm font-medium text-muted-foreground">{title}</h3>
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.security_top_empty()}</p>
      ) : (
        <ol className="divide-y rounded-2xl sunk-well">
          {items.map((item) => (
            <li key={item.id ?? item.value} className="flex items-center gap-3 px-3 py-2 text-sm">
              <span className={`min-w-0 flex-1 break-all ${mono ? "font-mono text-xs" : ""}`}>
                {item.value}
              </span>
              <span className="tabular-nums text-muted-foreground">{formatNumber(item.count)}</span>
              {trailing ? trailing(item) : null}
              {actions ? <TopListActions items={actions(item.value)} /> : null}
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** An entry's menu, or the menu's room so the counts of a list stay aligned. */
function TopListActions({ items }: { items: RowMenuItem[] }) {
  return items.length ? <RowMenu items={items} /> : <span aria-hidden className="w-6 shrink-0" />;
}

/** The level each node holds for the site now. */
function NodeLevelsCard({ siteId }: { siteId: string }) {
  const state = useQuery(
    orpc.security.state.queryOptions({
      input: { id: siteId, hours: 24 },
      refetchInterval: 15_000,
      meta: { background: true },
    }),
  );
  return (
    <Card id="attacks-nodes" className="scroll-mt-4 animate-enter">
      <CardHeader>
        <CardTitle>{m.security_nodes_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryView
          query={state}
          isEmpty={(data) => data.nodes.length === 0}
          empty={<EmptyState title={m.security_no_nodes()} />}
        >
          {({ nodes }) => (
            <ul className="divide-y rounded-2xl sunk-well" data-testid="security-nodes">
              {nodes.map((node, index) => (
                <li
                  key={node.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 animate-enter"
                  style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                  data-testid="security-node-row"
                  data-node-id={node.id}
                  data-level={node.level}
                >
                  <span className="min-w-32 flex-1 truncate text-sm font-medium">{node.name}</span>
                  <StatusDot tone={node.online ? "good" : "idle"}>
                    {node.online ? m.security_online() : m.security_offline()}
                  </StatusDot>
                  <Badge
                    variant={node.level === "normal" ? "outline" : "destructive"}
                    data-testid="security-node-level"
                  >
                    {levelLabel(node.level)}
                  </Badge>
                  {node.escalatedPaths ? (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {m.security_escalated_paths({ count: formatNumber(node.escalatedPaths) })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** The heaviest addresses and paths the nodes reported in CC events over the range. */
function TopCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const hours = RANGE_HOURS[range];
  const state = useQuery({
    ...orpc.security.state.queryOptions({ input: { id: siteId, hours } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "240ms" }}>
      <CardHeader>
        <CardTitle>{m.security_top_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryView query={state}>
          {({ topIps, topPaths }) => (
            <div className="grid gap-4 md:grid-cols-2">
              <TopList
                title={m.security_top_ips()}
                items={topIps}
                testId="security-top-ips"
                mono
                trailing={(item) => (
                  <LogsLink
                    siteId={siteId}
                    jump={windowJump(clientJump(item.value), hours)}
                    testId="top-ip-logs"
                  />
                )}
                actions={(address) => [
                  { label: m.quick_ban_ip(), action: { kind: "ban", address, siteId } },
                ]}
              />
              <TopList
                title={m.security_top_paths()}
                items={topPaths}
                testId="security-top-paths"
                mono
                trailing={(item) => (
                  <LogsLink
                    siteId={siteId}
                    jump={windowJump({ path: item.value }, hours)}
                    testId="top-path-logs"
                  />
                )}
                actions={(path) => [
                  {
                    label: m.quick_purge_url(),
                    action: { kind: "purge", targets: [path], siteId },
                  },
                ]}
              />
            </div>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Most-matched CRS rules of the site over the range (approximate). */
function WafRulesCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const rules = useQuery({
    ...orpc.waf.topRules.queryOptions({ input: { id: siteId, range, limit: 10 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "270ms" }}>
      <CardHeader>
        <CardTitle>{m.waf_top_title()}</CardTitle>
      </CardHeader>
      <CardContent>
        <QueryView query={rules}>
          {({ items }) => (
            <TopList
              title={m.waf_top_rules()}
              items={items.map((item) => ({ value: String(item.ruleId), count: item.requests }))}
              testId="waf-top-rules"
              mono
              actions={(value) =>
                crsDetectionRule(Number(value))
                  ? [
                      {
                        label: m.quick_exclude_rule({ id: value }),
                        action: { kind: "exclude-rule", siteId, ruleId: Number(value) },
                        testId: "waf-top-exclude-rule",
                      },
                      {
                        label: m.quick_exclude_path(),
                        action: { kind: "exclude-path", siteId, ruleIds: [Number(value)] },
                        testId: "waf-top-exclude-path",
                      },
                    ]
                  : []
              }
            />
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Requests that matched rules with the log action, per rule, over the range (approximate). */
function LoggedRulesCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const logged = useQuery({
    ...orpc.rules.topLogged.queryOptions({ input: { id: siteId, range, limit: 10 } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "285ms" }}>
      <CardHeader>
        <CardTitle>{m.rules_logged_title()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={logged}>
          {({ items, unsupportedNodes }) => (
            <>
              <TopList
                title={m.rules_logged_rule()}
                items={items.map((item) => ({
                  id: item.ruleId,
                  value:
                    item.name === null
                      ? m.rules_logged_deleted()
                      : item.platform
                        ? m.rules_logged_platform({ name: item.name })
                        : item.name,
                  count: item.requests,
                }))}
                testId="logged-rules"
              />
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="logged-rules-partial">
                  {m.rules_logged_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Requests the site's access authentication refused over the range. */
function AuthFailuresCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const failures = useQuery({
    ...orpc.authRules.failures.queryOptions({ input: { id: siteId, range } }),
    placeholderData: keepPreviousData,
  });
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "300ms" }}
      data-testid="auth-failures-card"
    >
      <CardHeader>
        <CardTitle>{m.auth_failures_title()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={failures}>
          {({ requests, unsupportedNodes }) => (
            <>
              <p
                className="font-heading text-3xl font-medium tabular-nums"
                data-testid="auth-failures-count"
              >
                {formatNumber(requests)}
              </p>
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="auth-failures-partial">
                  {m.auth_failures_partial()}
                </SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** Challenges issued and passed over the range, and the share that passed. */
function ChallengesCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const dimensions = useDimensions(siteId, range);
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "330ms" }}
      data-testid="challenges-card"
    >
      <CardHeader>
        <CardTitle>{m.challenges_title()}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <QueryView query={dimensions}>
          {({ challenges, unsupportedNodes }) => (
            <>
              {challenges.issued === 0 && challenges.passed === 0 ? (
                <p className="text-sm text-muted-foreground" data-testid="challenges-empty">
                  {m.security_top_empty()}
                </p>
              ) : (
                <dl className="grid grid-cols-3 gap-4 sm:max-w-xl">
                  {(
                    [
                      // A pass can be counted by another node than the challenge (or fall in
                      // the next range): the rate stops at 100%, and needs issued challenges.
                      ...(challenges.issued > 0
                        ? ([
                            [
                              "rate",
                              m.challenges_rate(),
                              formatPercent(
                                Math.min(100, (challenges.passed / challenges.issued) * 100),
                              ),
                            ],
                          ] as const)
                        : []),
                      ["issued", m.challenges_issued(), formatNumber(challenges.issued)],
                      ["passed", m.challenges_passed(), formatNumber(challenges.passed)],
                    ] as const
                  ).map(([key, label, value]) => (
                    <div key={key} className="flex min-w-0 flex-col gap-1">
                      <dt className="text-xs text-muted-foreground">{label}</dt>
                      <dd
                        className={cn(
                          "font-heading font-medium tabular-nums",
                          key === "rate" ? "text-3xl" : "text-xl",
                        )}
                        data-testid={`challenges-${key}`}
                      >
                        {value}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {unsupportedNodes > 0 ? (
                <SafetyNote data-testid="challenges-partial">{m.stats_dims_partial()}</SafetyNote>
              ) : null}
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}

/** The jump to the logs around a CC event: a window of five minutes each side, its client or path. */
function eventJump(event: {
  kind: SecurityEventKind;
  occurredAt: string;
  address: string;
  path: string;
}): LogJump {
  const at = Date.parse(event.occurredAt);
  return {
    ...(event.kind === "ip_banned" && event.address ? clientJump(event.address) : {}),
    ...(event.kind === "path_level" && event.path ? { path: event.path } : {}),
    from: new Date(at - 5 * MINUTE).toISOString(),
    to: new Date(at + 5 * MINUTE).toISOString(),
  };
}

/** CC decisions of the nodes within the range: level changes and automatic bans. */
function EventsCard({ siteId, range }: { siteId: string; range: AnalyticsRange }) {
  const [page, setPage] = React.useState(1);
  const [kind, setKind] = React.useState<SecurityEventKind | undefined>();
  const hours = RANGE_HOURS[range];
  const events = useQuery({
    ...orpc.security.events.queryOptions({
      input: { id: siteId, kind, hours, page, pageSize: PAGE_SIZE },
    }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    meta: { background: true },
  });
  return (
    <Card className="animate-enter" style={{ animationDelay: "360ms" }}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>{m.security_events_title()}</CardTitle>
        <div className="w-full sm:w-44">
          <FormSelect
            id="security-event-kind"
            label={m.security_event_kind()}
            value={kind ?? ALL}
            testId="security-event-kind"
            options={[
              { value: ALL, label: m.security_event_kind_all() },
              ...securityEventKind.options.map((value) => ({
                value,
                label: eventKindLabel(value),
              })),
            ]}
            onChange={(value) => {
              setPage(1);
              setKind(value === ALL ? undefined : (value as SecurityEventKind));
            }}
          />
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <QueryView
          query={events}
          isEmpty={(data) => data.items.length === 0}
          empty={<EmptyState title={m.security_events_empty()} />}
        >
          {({ items, total }) => (
            <>
              <ol
                className="flex flex-col divide-y rounded-2xl sunk-well"
                data-testid="security-events"
              >
                {items.map((event, index) => (
                  <li
                    key={event.id}
                    className="flex flex-col gap-1 px-3 py-2.5 animate-enter"
                    style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
                    data-testid="security-event-row"
                    data-kind={event.kind}
                  >
                    <div className="flex flex-wrap items-center gap-2 text-sm">
                      <Badge variant={event.kind === "ip_banned" ? "destructive" : "secondary"}>
                        {eventKindLabel(event.kind)}
                      </Badge>
                      {event.kind === "ip_banned" ? (
                        <span className="font-mono text-xs break-all">{event.address}</span>
                      ) : (
                        <span>
                          {m.security_level_change({
                            from: levelLabel(event.previousLevel),
                            to: levelLabel(event.level),
                          })}
                        </span>
                      )}
                      {event.path ? (
                        <span className="font-mono text-xs break-all">{event.path}</span>
                      ) : null}
                      <span
                        className="ml-auto text-xs text-muted-foreground"
                        title={formatDateTime(event.occurredAt)}
                      >
                        {timeAgo(event.occurredAt)}
                      </span>
                      <LogsLink siteId={siteId} jump={eventJump(event)} testId="event-logs" />
                      {event.kind === "ip_banned" && event.address ? (
                        <RowMenu
                          items={[
                            {
                              label: m.quick_ban_everywhere(),
                              action: { kind: "ban", address: event.address, scope: "platform" },
                              testId: "event-ban-everywhere",
                            },
                            {
                              label: m.bans_unban(),
                              action: { kind: "unban", address: event.address, siteId },
                              testId: "event-unban",
                            },
                          ]}
                        />
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                      <span>{event.node?.name || m.security_node_deleted()}</span>
                      {event.metric ? (
                        <span className="tabular-nums">
                          {m.security_metric_value({
                            metric: metricLabel(event.metric),
                            observed: formatNumber(event.observed),
                            threshold: formatNumber(event.threshold),
                          })}
                        </span>
                      ) : null}
                    </div>
                  </li>
                ))}
              </ol>
              <Pager page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
            </>
          )}
        </QueryView>
      </CardContent>
    </Card>
  );
}
