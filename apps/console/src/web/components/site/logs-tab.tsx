import { crsDetectionRule, type LogEntry, type LogQuery } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect } from "@/components/form-select";
import { RowMenu } from "@/components/quick-actions";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, ErrorState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { requestUrl } from "@/lib/purge";
import { cn } from "@/lib/utils";

const localTime = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
export function LogsTab({ siteId }: { siteId: string }) {
  const settings = useQuery(orpc.logs.settings.queryOptions({ input: { siteId } }));
  const cache = useQueryClient();
  const save = useMutation(
    orpc.logs.configure.mutationOptions({
      onSuccess: async () => {
        await cache.invalidateQueries();
        toast.success(m.common_saved());
      },
    }),
  );
  const [filters, setFilters] = React.useState(() => ({
    from: localTime(new Date(Date.now() - 3600000)),
    to: localTime(new Date(Date.now() + 60000)),
    status: "",
    ip: "",
    path: "",
    requestId: "",
  }));
  // The end stays "a minute from now" until the user sets one, so searching again shows new logs.
  const [endIsNow, setEndIsNow] = React.useState(true);
  const [query, setQuery] = React.useState<LogQuery>(() => ({
    siteId,
    from: new Date(Date.now() - 3600000).toISOString(),
    to: new Date(Date.now() + 60000).toISOString(),
    ip: "",
    path: "",
    limit: 100,
  }));
  const logs = useQuery(orpc.logs.query.queryOptions({ input: query }));
  const exporter = useAction();
  return (
    <div className="min-w-0 space-y-5">
      <Card>
        <CardContent className="space-y-4">
          <QueryView query={settings}>
            {({ sampleRate }) => (
              <FormSelect
                id="logSampleRate"
                label={m.logs_sampling()}
                value={String(sampleRate)}
                disabled={save.isPending}
                options={[0, 100, 1000, 10000].map((rate) => ({
                  value: String(rate),
                  label: rate === 0 ? m.logs_disabled() : m.logs_percent({ value: rate / 100 }),
                }))}
                onChange={(rate) => save.mutate({ siteId, sampleRate: Number(rate) })}
              />
            )}
          </QueryView>
          {save.isError && <ErrorState error={save.error} />}
          <SafetyNote>{m.logs_privacy()}</SafetyNote>
        </CardContent>
      </Card>
      <Card>
        <CardContent className="space-y-5">
          <form
            className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
            onSubmit={(event) => {
              event.preventDefault();
              const toText = endIsNow ? localTime(new Date(Date.now() + 60000)) : filters.to;
              if (toText !== filters.to) setFilters({ ...filters, to: toText });
              const from = new Date(filters.from),
                to = new Date(toText);
              if (
                !Number.isFinite(from.getTime()) ||
                !Number.isFinite(to.getTime()) ||
                from >= to
              ) {
                toast.error(m.logs_invalid_time());
                return;
              }
              const next: LogQuery = {
                siteId,
                from: from.toISOString(),
                to: to.toISOString(),
                status: filters.status ? Number(filters.status) : undefined,
                ip: filters.ip,
                path: filters.path,
                // Exact match; empty matches every request.
                requestId: filters.requestId.trim() || undefined,
                limit: 100,
              };
              // The same search again fetches again.
              if (JSON.stringify(next) === JSON.stringify(query)) void logs.refetch();
              else setQuery(next);
            }}
          >
            {(
              [
                ["from", "log-from", m.logs_from(), "datetime-local", 64],
                ["to", "log-to", m.logs_to(), "datetime-local", 64],
                ["status", "log-status", m.logs_status(), "number", 64],
                ["ip", "log-ip", m.logs_ip(), "text", 64],
                ["path", "log-path", m.logs_path(), "text", 2048],
                ["requestId", "log-request-id", m.logs_request_id(), "text", 128],
              ] as const
            ).map(([key, id, label, type, maxLength]) => (
              <Field key={key}>
                <FieldLabel htmlFor={id}>{label}</FieldLabel>
                <Input
                  id={id}
                  type={type}
                  value={filters[key]}
                  min={key === "status" ? 100 : undefined}
                  max={key === "status" ? 599 : undefined}
                  maxLength={maxLength}
                  required={key === "from" || key === "to"}
                  spellCheck={key === "requestId" ? false : undefined}
                  className={key === "requestId" ? "font-mono" : undefined}
                  onChange={(event) => {
                    if (key === "to") setEndIsNow(false);
                    setFilters({ ...filters, [key]: event.target.value });
                  }}
                  data-testid={key === "requestId" ? "logs-request-id" : undefined}
                />
              </Field>
            ))}
            <div className="flex items-end gap-2">
              <Button type="submit" disabled={logs.isFetching} data-testid="logs-search">
                {logs.isFetching && <Spinner />}
                {m.logs_search()}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={exporter.pending}
                onClick={async () => {
                  try {
                    const output = await exporter.run(() =>
                      client.logs.export({ ...query, limit: 1000 }),
                    );
                    const url = URL.createObjectURL(
                      new Blob(["\uFEFF", output.csv], { type: "text/csv;charset=utf-8" }),
                    );
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `edgeweir-logs-${siteId}.csv`;
                    link.click();
                    URL.revokeObjectURL(url);
                    if (output.truncated) toast.info(m.logs_export_limit());
                  } catch (error) {
                    toast.error(errorMessage(error));
                  }
                }}
              >
                {exporter.pending && <Spinner />}
                {m.logs_export()}
              </Button>
            </div>
          </form>
          <QueryView
            query={logs}
            isEmpty={(data) => data.entries.length === 0}
            empty={<EmptyState title={m.logs_empty()} />}
          >
            {({ entries, truncated }) => (
              <>
                {truncated && <SafetyNote>{m.logs_query_limit()}</SafetyNote>}
                <LogTable key={logs.dataUpdatedAt} entries={entries} siteId={siteId} />
              </>
            )}
          </QueryView>
        </CardContent>
      </Card>
    </div>
  );
}

/** The status class's color beside the code (the code itself is the label). */
function statusDot(status: number): string {
  if (status >= 500) return "bg-status-5xx";
  if (status >= 400) return "bg-status-4xx";
  if (status >= 300) return "bg-status-3xx";
  if (status >= 200) return "bg-status-2xx";
  return "bg-muted-foreground/50";
}

/*
 * The log rows. From 57rem of well width each row is a grid on the header's columns (--log-cols on
 * the table); narrower, a row wraps: time, status and actions, then the request, then the other
 * values, each after its column's name (data-label), so nothing scrolls sideways.
 */
const LOG_VARS = "[--log-cols:11rem_9rem_minmax(14rem,1fr)_4.5rem_5.5rem_5rem_5.5rem_3rem]";
const LOG_COLUMNS = "grid-cols-(--log-cols)";
const CELL = "@min-[57rem]/logs:order-none @min-[57rem]/logs:px-3 @min-[57rem]/logs:py-2.5";
const LABELLED =
  "before:me-1.5 before:font-sans before:text-muted-foreground before:content-[attr(data-label)] @min-[57rem]/logs:before:content-none";

/**
 * Sampled requests in a well: a sticky header, rows rendered only while they are in view
 * (TanStack Virtual, rows measured as they wrap), machine values in monospace. The request's id,
 * JA4 fingerprint and CRS matches sit under the request, so the table keeps its width.
 */
function LogTable({ entries, siteId }: { entries: LogEntry[]; siteId: string }) {
  const scroller = React.useRef<HTMLElement>(null);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) => entries[index]?.id ?? index,
  });
  const headers = [
    m.logs_time(),
    m.logs_ip(),
    m.logs_request(),
    m.logs_status(),
    m.logs_bytes(),
    m.logs_duration(),
    m.logs_cache(),
  ];
  return (
    <section
      ref={scroller}
      // Scrollable by keyboard: the well takes focus and arrows scroll it.
      // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container must be focusable.
      tabIndex={0}
      aria-label={m.logs_request()}
      className="@container/logs max-h-[min(70svh,42rem)] overflow-y-auto rounded-2xl sunk-well outline-none focus-lit"
      data-testid="logs-table"
    >
      <table
        className={cn("grid text-left text-sm", LOG_VARS)}
        aria-rowcount={entries.length + 1}
      >
        <thead className="sticky top-0 z-[2] hidden bg-well @min-[57rem]/logs:grid">
          <tr className={cn("grid border-b", LOG_COLUMNS)} aria-rowindex={1}>
            {headers.map((label, index) => (
              <th
                key={label}
                className={cn(
                  "px-3 py-2 text-xs font-medium whitespace-nowrap text-muted-foreground first:pl-4",
                  (index === 4 || index === 5) && "text-right",
                )}
              >
                {label}
              </th>
            ))}
            <th className="px-3 py-2 pr-4">
              <span className="sr-only">{m.common_actions()}</span>
            </th>
          </tr>
        </thead>
        <tbody className="relative grid" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const row = entries[item.index];
            if (!row) return null;
            return (
              <tr
                key={item.key}
                ref={virtualizer.measureElement}
                data-index={item.index}
                aria-rowindex={item.index + 2}
                className={cn(
                  "absolute inset-x-0 top-0 flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/70 px-4 py-2.5 font-mono text-xs leading-5 transition-colors hover:bg-wash has-aria-expanded:bg-wash",
                  "@min-[57rem]/logs:grid @min-[57rem]/logs:items-start @min-[57rem]/logs:gap-0 @min-[57rem]/logs:p-0",
                  LOG_COLUMNS,
                )}
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <td
                  className={cn(
                    "order-1 flex-1 whitespace-nowrap text-muted-foreground @min-[57rem]/logs:pl-4",
                    CELL,
                  )}
                >
                  {new Date(row.time).toLocaleString()}
                </td>
                <td className={cn("order-5 break-all", LABELLED, CELL)} data-label={m.logs_ip()}>
                  {row.clientIp}
                </td>
                <td className={cn("order-4 flex min-w-0 basis-full flex-col gap-1", CELL)}>
                  <span className="break-all">
                    <span className="text-muted-foreground">{row.method}</span> {row.host}
                    {row.path}
                  </span>
                  {row.requestId || row.ja4 || row.wafBlocked || row.wafRuleIds.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-muted-foreground">
                      {/* The id the node answered with (X-Request-Id, also on error pages). */}
                      {row.requestId ? (
                        <span className="min-w-0 break-all">
                          {m.logs_request_id()}{" "}
                          <span className="font-mono" data-testid="log-request-id">
                            {row.requestId}
                          </span>
                        </span>
                      ) : null}
                      {row.ja4 ? (
                        <span className="min-w-0 break-all">
                          {m.logs_ja4()}{" "}
                          <span className="font-mono" data-testid="log-ja4">
                            {row.ja4}
                          </span>
                        </span>
                      ) : null}
                      {row.wafBlocked || row.wafRuleIds.length > 0 ? (
                        <span className="flex flex-wrap items-center gap-1.5" data-testid="log-waf">
                          {m.logs_waf()}
                          {row.wafBlocked ? (
                            <Badge variant="destructive" data-testid="log-waf-blocked">
                              {m.logs_waf_blocked()}
                            </Badge>
                          ) : null}
                          {row.wafRuleIds.map((id) => (
                            <span
                              key={id}
                              className="font-mono tabular-nums text-foreground"
                              data-testid="log-waf-rule"
                            >
                              {id}
                            </span>
                          ))}
                        </span>
                      ) : null}
                    </span>
                  ) : null}
                </td>
                <td className={cn("order-2", CELL)}>
                  <span className="inline-flex items-center gap-1.5 tabular-nums">
                    <span
                      className={cn(
                        "size-1.5 shrink-0 rounded-full border border-transparent",
                        statusDot(row.status),
                      )}
                    />
                    {row.status}
                  </span>
                </td>
                <td
                  className={cn(
                    "order-6 tabular-nums @min-[57rem]/logs:text-right",
                    LABELLED,
                    CELL,
                  )}
                  data-label={m.logs_bytes()}
                >
                  {row.bytesSent}
                </td>
                <td
                  className={cn(
                    "order-7 tabular-nums @min-[57rem]/logs:text-right",
                    LABELLED,
                    CELL,
                  )}
                  data-label={m.logs_duration()}
                >
                  {row.durationMs}
                </td>
                <td className={cn("order-8", LABELLED, CELL)} data-label={m.logs_cache()}>
                  {row.cacheStatus}
                </td>
                <td
                  className={cn(
                    "order-3 -my-1 font-sans @min-[57rem]/logs:my-0 @min-[57rem]/logs:py-1.5 @min-[57rem]/logs:pr-4 @min-[57rem]/logs:text-right",
                    CELL,
                  )}
                >
                  <RowMenu
                    items={[
                      {
                        label: m.quick_ban_ip(),
                        action: { kind: "ban", address: row.clientIp, siteId },
                        testId: "log-ban",
                      },
                      ...(row.host
                        ? [
                            {
                              label: m.quick_purge_url(),
                              action: {
                                kind: "purge" as const,
                                targets: [requestUrl(row.host, row.path)],
                                siteId,
                              },
                              testId: "log-purge",
                            },
                          ]
                        : []),
                      ...row.wafRuleIds.filter(crsDetectionRule).map((ruleId) => ({
                        label: m.quick_exclude_rule({ id: String(ruleId) }),
                        action: { kind: "exclude-rule" as const, siteId, ruleId },
                        testId: "log-exclude-rule",
                      })),
                    ]}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}
