import {
  BLOCK_REASONS,
  CACHE_STATUSES,
  crsDetectionRule,
  type FeatureAvailability,
  type LogEntry,
  type LogQuery,
  type LogSettings,
  type LogSettingsInput,
} from "@edgeweir/contract";
import { ArrowDown01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import * as React from "react";
import { toast } from "sonner";
import { FormSelect, type Option, OptionSelect } from "@/components/form-select";
import { RowMenu } from "@/components/quick-actions";
import { SafetyNote } from "@/components/safety-note";
import { ListInput } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { combineQueries, EmptyState, ErrorState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAction } from "@/hooks/use-action";
import { useDraft } from "@/hooks/use-draft";
import {
  activeMoreFilters,
  asnText,
  authKindLabel,
  blockReasonLabel,
  countryName,
  emptyMoreFilters,
  headerLines,
  LOG_STATUS_CLASSES,
  type LogFilterError,
  type LogFilters,
  logHeadersError,
  logQueryOf,
  METHODS,
  type MoreFilter,
  normalizeLogHeaders,
  protocolText,
} from "@/lib/access-logs";
import { formatNumber, m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { requestUrl } from "@/lib/purge";
import { cn } from "@/lib/utils";
import { exclusionPath } from "@/lib/waf-exclusions";

const localTime = (date: Date) =>
  new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);

export function LogsTab({ siteId }: { siteId: string }) {
  const settings = useQuery(orpc.logs.settings.queryOptions({ input: { siteId } }));
  const features = useQuery(orpc.sites.features.queryOptions({ input: { id: siteId } }));
  return (
    <div className="min-w-0 space-y-5">
      <Card>
        <QueryView query={combineQueries(settings, features)} frame={CardContent}>
          {([saved, available]) => (
            <LogSettingsForm
              siteId={siteId}
              settings={saved}
              availability={available.accessLogsV2}
            />
          )}
        </QueryView>
      </Card>
      <LogSearch siteId={siteId} />
    </div>
  );
}

/** A switch whose label may wrap (the options' labels are long in English). */
function OptionSwitch({
  id,
  label,
  checked,
  onCheckedChange,
  disabled,
  testId,
}: {
  id: string;
  label: string;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
    <Field orientation="horizontal" data-disabled={disabled || undefined} className="w-auto">
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onCheckedChange}
        data-testid={testId}
      />
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
    </Field>
  );
}

type Options = Pick<LogSettings, "logBlocked" | "logQuery" | "logHeaders" | "logPeer">;

/**
 * The sample rate (saved as it is picked) and the site's options (saved together; only what
 * changed is sent). Without access-logs-v2 on every node of the cluster an option can only be
 * turned off.
 */
function LogSettingsForm({
  siteId,
  settings,
  availability,
}: {
  siteId: string;
  settings: LogSettings;
  availability: FeatureAvailability;
}) {
  const cache = useQueryClient();
  const rate = useMutation(
    orpc.logs.configure.mutationOptions({
      onSuccess: async () => {
        await cache.invalidateQueries();
        toast.success(m.common_saved());
      },
    }),
  );
  const options = useMutation(orpc.logs.configure.mutationOptions());
  const saved: Options = {
    logBlocked: settings.logBlocked,
    logQuery: settings.logQuery,
    logHeaders: settings.logHeaders,
    logPeer: settings.logPeer,
  };
  const { draft, setDraft, dirty } = useDraft(saved);
  const [error, setError] = React.useState<string | null>(null);
  const set = (change: Partial<Options>) => {
    setDraft({ ...draft, ...change });
    setError(null);
  };
  const headersError = logHeadersError(draft.logHeaders);
  const locked = (on: boolean) => !availability.available && !on;
  const switches = [
    ["logBlocked", "log-blocked", m.logs_log_blocked()],
    ["logQuery", "log-query", m.logs_log_query()],
    ["logPeer", "log-peer", m.logs_log_peer()],
  ] as const;
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      onSubmit={async (event) => {
        event.preventDefault();
        if (headersError) return;
        const headers = normalizeLogHeaders(draft.logHeaders);
        const input: LogSettingsInput = { siteId };
        for (const [key] of switches) if (draft[key] !== saved[key]) input[key] = draft[key];
        if (headers.join("\n") !== saved.logHeaders.join("\n")) input.logHeaders = headers;
        try {
          await options.mutateAsync(input);
          // The saved names come back normalized: the form takes them now, so it is clean then.
          setDraft({ ...draft, logHeaders: headers });
          await cache.invalidateQueries({
            queryKey: orpc.logs.settings.queryKey({ input: { siteId } }),
          });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="flex flex-col gap-5">
        <div className="w-full sm:w-56">
          <FormSelect
            id="logSampleRate"
            label={m.logs_sampling()}
            value={String(settings.sampleRate)}
            disabled={rate.isPending}
            options={[0, 100, 1000, 10000].map((value) => ({
              value: String(value),
              label: value === 0 ? m.logs_disabled() : m.logs_percent({ value: value / 100 }),
            }))}
            onChange={(value) => rate.mutate({ siteId, sampleRate: Number(value) })}
          />
        </div>
        {rate.isError && <ErrorState error={rate.error} />}
        <div className="flex flex-col gap-3" data-testid="log-options">
          {switches.map(([key, id, label]) => (
            <OptionSwitch
              key={key}
              id={id}
              label={label}
              checked={draft[key]}
              onCheckedChange={(checked) => set({ [key]: checked })}
              disabled={locked(saved[key]) || options.isPending}
              testId={id}
            />
          ))}
        </div>
        <Field
          className="max-w-xl"
          data-invalid={headersError ? true : undefined}
          data-disabled={locked(saved.logHeaders.length > 0) || undefined}
        >
          <FieldLabel htmlFor="log-headers">{m.logs_log_headers()}</FieldLabel>
          <ListInput
            id="log-headers"
            value={draft.logHeaders}
            onChange={(logHeaders) => set({ logHeaders })}
            disabled={locked(saved.logHeaders.length > 0) || options.isPending}
            invalid={!!headersError}
            testId="log-headers"
          />
          {headersError ? (
            <FieldError className="animate-in fade-in" data-testid="log-headers-error">
              {headersError}
            </FieldError>
          ) : null}
        </Field>
        {availability.available ? null : (
          <SafetyNote className="animate-in fade-in" data-testid="log-options-unavailable">
            {m.feature_unavailable_nodes()}
          </SafetyNote>
        )}
        <SafetyNote data-testid="logs-privacy">
          {m.logs_privacy({ days: settings.retentionDays })}
        </SafetyNote>
      </CardContent>
      <SaveBar
        dirty={dirty}
        pending={options.isPending}
        error={error}
        testId="log-options-save"
        errorTestId="log-options-error"
      />
    </form>
  );
}

const initialFilters = (): LogFilters => ({
  from: localTime(new Date(Date.now() - 3600000)),
  to: localTime(new Date(Date.now() + 60000)),
  status: "",
  ip: "",
  path: "",
  requestId: "",
  ...emptyMoreFilters(),
});

/** Field ids and test ids are `log-filter-<kebab name>`. */
const kebab = (key: string) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);

const INVALID_TEXT: Record<LogFilterError, () => string> = {
  country: m.logs_invalid_country,
  asn: m.logs_invalid_asn,
  minDuration: m.logs_invalid_duration,
  cidr: m.logs_invalid_cidr,
};

const ALL = "__all__";

/** The query form (the common filters, the others behind "more filters") and the results. */
function LogSearch({ siteId }: { siteId: string }) {
  const [filters, setFilters] = React.useState(initialFilters);
  // The end stays "a minute from now" until the user sets one, so searching again shows new logs.
  const [endIsNow, setEndIsNow] = React.useState(true);
  const [more, setMore] = React.useState(false);
  const [invalid, setInvalid] = React.useState<LogFilterError | null>(null);
  const [query, setQuery] = React.useState<LogQuery>(() => {
    const result = logQueryOf(
      siteId,
      initialFilters(),
      new Date(Date.now() - 3600000).toISOString(),
      new Date(Date.now() + 60000).toISOString(),
    );
    return "query" in result ? result.query : ({} as LogQuery);
  });
  const logs = useQuery(orpc.logs.query.queryOptions({ input: query }));
  const exporter = useAction();
  const set = (key: keyof LogFilters, value: string) => {
    if (key === "to") setEndIsNow(false);
    if (key === invalid) setInvalid(null);
    setFilters({ ...filters, [key]: value });
  };
  const active = activeMoreFilters(filters);

  const textField = (
    key: keyof LogFilters,
    label: string,
    {
      type = "text",
      maxLength,
      mono,
      min,
      max,
      testId = `log-filter-${kebab(key)}`,
      id = `log-filter-${kebab(key)}`,
    }: {
      type?: string;
      maxLength?: number;
      mono?: boolean;
      min?: number;
      max?: number;
      testId?: string;
      id?: string;
    } = {},
  ) => {
    const bad = invalid === key;
    return (
      <Field key={key} data-invalid={bad || undefined}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <Input
          id={id}
          type={type}
          value={filters[key]}
          min={min}
          max={max}
          maxLength={maxLength}
          required={key === "from" || key === "to"}
          spellCheck={mono ? false : undefined}
          aria-invalid={bad || undefined}
          aria-describedby={bad ? `${id}-error` : undefined}
          className={mono ? "font-mono" : undefined}
          onChange={(event) => set(key, event.target.value)}
          data-testid={testId}
        />
        {bad ? (
          <FieldError id={`${id}-error`} className="animate-in fade-in">
            {INVALID_TEXT[key as LogFilterError]()}
          </FieldError>
        ) : null}
      </Field>
    );
  };

  const selectField = (key: MoreFilter, label: string, options: readonly Option[]) => {
    const id = `log-filter-${kebab(key)}`;
    return (
      <Field key={key}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <OptionSelect
          id={id}
          value={filters[key] || ALL}
          options={[{ value: ALL, label: m.logs_filter_all() }, ...options]}
          onChange={(value) => set(key, value === ALL ? "" : value)}
          testId={id}
        />
      </Field>
    );
  };
  const plain = (values: readonly string[]) => values.map((value) => ({ value, label: value }));

  return (
    <Card>
      <CardContent className="space-y-5">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const toText = endIsNow ? localTime(new Date(Date.now() + 60000)) : filters.to;
            if (toText !== filters.to) setFilters({ ...filters, to: toText });
            const from = new Date(filters.from),
              to = new Date(toText);
            if (!Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || from >= to) {
              toast.error(m.logs_invalid_time());
              return;
            }
            const result = logQueryOf(siteId, filters, from.toISOString(), to.toISOString());
            if ("invalid" in result) {
              setInvalid(result.invalid);
              setMore(true);
              return;
            }
            setInvalid(null);
            // The same search again fetches again.
            if (JSON.stringify(result.query) === JSON.stringify(query)) void logs.refetch();
            else setQuery(result.query);
          }}
        >
          <Collapsible open={more} onOpenChange={setMore} className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {textField("from", m.logs_from(), { type: "datetime-local", id: "log-from" })}
              {textField("to", m.logs_to(), { type: "datetime-local", id: "log-to" })}
              {textField("status", m.logs_status(), {
                type: "number",
                min: 100,
                max: 599,
                id: "log-status",
              })}
              {textField("ip", m.logs_ip(), { maxLength: 64, id: "log-ip" })}
              {textField("path", m.logs_path(), { maxLength: 2048, id: "log-path" })}
              {textField("requestId", m.logs_request_id(), {
                maxLength: 128,
                mono: true,
                id: "log-request-id",
                testId: "logs-request-id",
              })}
            </div>
            <CollapsibleContent
              className="grid grid-cols-2 gap-4 border-t pt-4 animate-in fade-in duration-300 motion-reduce:animate-none lg:grid-cols-3"
              data-testid="logs-more-filters-panel"
            >
              {textField("host", m.logs_host(), { maxLength: 253 })}
              {selectField("method", m.logs_method(), plain(METHODS))}
              {selectField("statusClass", m.logs_status_class(), plain(LOG_STATUS_CLASSES))}
              {selectField("cacheStatus", m.logs_cache_status(), plain(CACHE_STATUSES))}
              {selectField("blockReason", m.logs_block_reason(), [
                { value: "any", label: m.block_reason_any() },
                ...BLOCK_REASONS.map((value) => ({ value, label: blockReasonLabel(value) })),
              ])}
              {textField("country", m.logs_country(), { maxLength: 2, mono: true })}
              {textField("asn", m.logs_asn(), { type: "number", min: 1, max: 4294967295 })}
              {textField("ua", m.logs_ua(), { maxLength: 256 })}
              {textField("referer", m.logs_referer(), { maxLength: 256 })}
              {textField("minDuration", m.logs_min_duration(), {
                type: "number",
                min: 0,
                max: 86400000,
              })}
              {textField("cidr", m.logs_cidr(), { maxLength: 64, mono: true })}
            </CollapsibleContent>
            <div className="flex flex-wrap items-center gap-2">
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
                      new Blob(["﻿", output.csv], { type: "text/csv;charset=utf-8" }),
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
              <CollapsibleTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    className="sm:ml-auto"
                    data-testid="logs-more-filters"
                  />
                }
              >
                {active > 0 && !more
                  ? m.logs_more_filters_count({ count: active })
                  : m.logs_more_filters()}
                <HugeiconsIcon
                  icon={ArrowDown01Icon}
                  strokeWidth={2}
                  className={cn(
                    "transition-transform motion-reduce:transition-none",
                    more && "rotate-180",
                  )}
                />
              </CollapsibleTrigger>
            </div>
          </Collapsible>
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
 * values, each after its column's name (data-label), so nothing scrolls sideways. A row's details
 * take a line of their own under it.
 */
const LOG_VARS = "[--log-cols:11rem_9rem_minmax(14rem,1fr)_4.5rem_5.5rem_5rem_5.5rem_3rem]";
const LOG_COLUMNS = "grid-cols-(--log-cols)";
const CELL = "@min-[57rem]/logs:order-none @min-[57rem]/logs:px-3 @min-[57rem]/logs:py-2.5";
const LABELLED =
  "before:me-1.5 before:font-sans before:text-muted-foreground before:content-[attr(data-label)] @min-[57rem]/logs:before:content-none";

/** What a line's details show, in order; empty values are left out. */
function details(
  row: LogEntry,
): { key: string; label: string; testId: string; value: React.ReactNode }[] {
  const rows: { key: string; label: string; testId: string; value: React.ReactNode }[] = [];
  const add = (key: string, label: string, testId: string, value: React.ReactNode) => {
    rows.push({ key, label, testId, value });
  };
  if (row.userAgent) add("ua", m.logs_field_user_agent(), "log-user-agent", row.userAgent);
  if (row.referer) add("referer", m.logs_field_referer(), "log-referer", row.referer);
  const protocol = protocolText(row);
  if (protocol) add("protocol", m.logs_field_protocol(), "log-protocol", protocol);
  if (row.country)
    add(
      "country",
      m.logs_field_country(),
      "log-country",
      <>
        <span className="font-sans">{countryName(row.country)}</span>{" "}
        <span className="text-muted-foreground">{row.country}</span>
      </>,
    );
  if (row.asn > 0)
    add(
      "asn",
      m.logs_field_asn(),
      "log-asn",
      <>
        {asnText(row.asn)}
        {row.asName ? <span className="font-sans"> {row.asName}</span> : null}
      </>,
    );
  if (row.upstreamAddr || row.upstreamStatus > 0)
    add(
      "upstream",
      m.logs_field_upstream(),
      "log-upstream",
      m.logs_upstream_value({
        address: row.upstreamAddr || "—",
        status: row.upstreamStatus || "—",
        ms: formatNumber(row.upstreamMs),
      }),
    );
  if (row.requestBytes > 0)
    add(
      "request-bytes",
      m.logs_field_request_bytes(),
      "log-request-bytes",
      formatNumber(row.requestBytes),
    );
  if (row.contentType)
    add("content-type", m.logs_field_content_type(), "log-content-type", row.contentType);
  if (row.query) add("query", m.logs_field_query(), "log-query-string", row.query);
  const headers = headerLines(row.headers);
  if (headers.length)
    add(
      "headers",
      m.logs_field_headers(),
      "log-request-headers",
      headers.map((line) => (
        <span key={line} className="block">
          {line}
        </span>
      )),
    );
  if (row.peerIp) add("peer", m.logs_field_peer(), "log-peer-ip", row.peerIp);
  return rows;
}

/**
 * Sampled requests in a well: a sticky header, rows rendered only while they are in view
 * (TanStack Virtual, rows measured as they wrap or open), machine values in monospace. The request's
 * block reason, id, JA4 fingerprint, CRS matches and the log rules that wrote the line sit under the
 * request, so the table keeps its width; the rest opens under the row.
 */
function LogTable({ entries, siteId }: { entries: LogEntry[]; siteId: string }) {
  const ruleName = useRuleNames(siteId, entries);
  const scroller = React.useRef<HTMLElement>(null);
  const [open, setOpen] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
      <table className={cn("grid text-left text-sm", LOG_VARS)} aria-rowcount={entries.length + 1}>
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
            const more = details(row);
            const expanded = more.length > 0 && open.has(row.id);
            const detailsId = `log-details-${item.index}`;
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
                data-testid="log-row"
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
                  <span className="flex min-w-0 items-start gap-1">
                    {more.length > 0 ? (
                      <Button
                        type="button"
                        size="icon-xs"
                        variant="ghost"
                        className="-my-0.5 -ml-1 shrink-0 font-sans"
                        aria-label={m.logs_details()}
                        aria-expanded={expanded}
                        aria-controls={expanded ? detailsId : undefined}
                        onClick={() => toggle(row.id)}
                        data-testid="log-details-toggle"
                      >
                        <HugeiconsIcon
                          icon={ArrowRight01Icon}
                          strokeWidth={2}
                          className={cn(
                            "transition-transform motion-reduce:transition-none",
                            expanded && "rotate-90",
                          )}
                        />
                      </Button>
                    ) : null}
                    <span className="min-w-0 break-all">
                      <span className="text-muted-foreground">{row.method}</span> {row.host}
                      {row.path}
                    </span>
                  </span>
                  {row.blockReason ||
                  row.requestId ||
                  row.ja4 ||
                  row.wafBlocked ||
                  row.wafRuleIds.length > 0 ||
                  row.ruleIds.length > 0 ? (
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 font-sans text-muted-foreground">
                      {/* Why the node refused or challenged it, and the rule behind that. */}
                      {row.blockReason ? (
                        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                          <Badge
                            variant={row.blockReason === "challenge" ? "secondary" : "destructive"}
                            data-testid="log-block-reason"
                            data-reason={row.blockReason}
                          >
                            {blockReasonLabel(row.blockReason)}
                          </Badge>
                          {row.blockRuleId ? (
                            <span
                              className={cn(
                                "min-w-0 break-all text-foreground",
                                ruleName(row.blockRuleId) === null && "font-mono",
                              )}
                              data-testid="log-block-rule"
                              data-rule-id={row.blockRuleId}
                            >
                              {ruleName(row.blockRuleId) ?? row.blockRuleId}
                            </span>
                          ) : null}
                        </span>
                      ) : null}
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
                      {/* Log rules that wrote this line whatever the sample rate. */}
                      {row.ruleIds.length > 0 ? (
                        <span
                          className="flex min-w-0 flex-wrap items-center gap-1.5"
                          data-testid="log-rules"
                        >
                          {m.logs_rules()}
                          {row.ruleIds.map((id) => {
                            const name = ruleName(id);
                            return (
                              <span
                                key={id}
                                className={cn(
                                  "min-w-0 break-all text-foreground",
                                  name === null && "font-mono",
                                )}
                                data-testid="log-rule"
                                data-rule-id={id}
                              >
                                {name ?? id}
                              </span>
                            );
                          })}
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
                      // The request's path, with every rule it matched that can be excluded.
                      ...(row.wafRuleIds.some(crsDetectionRule)
                        ? [
                            {
                              label: m.quick_exclude_path(),
                              action: {
                                kind: "exclude-path" as const,
                                siteId,
                                ruleIds: row.wafRuleIds.filter(crsDetectionRule),
                                path: exclusionPath(row.path),
                              },
                              testId: "log-exclude-path",
                            },
                          ]
                        : []),
                    ]}
                  />
                </td>
                {expanded ? (
                  <td
                    id={detailsId}
                    className="order-9 basis-full animate-in fade-in duration-200 motion-reduce:animate-none @min-[57rem]/logs:order-none @min-[57rem]/logs:col-span-full @min-[57rem]/logs:px-4 @min-[57rem]/logs:pb-3"
                    data-testid="log-details"
                  >
                    <dl className="grid gap-x-4 gap-y-1.5 rounded-xl bg-card/60 px-3 py-2.5 sm:grid-cols-[8rem_minmax(0,1fr)]">
                      {more.map((entry) => (
                        <div key={entry.key} className="contents">
                          <dt className="font-sans text-muted-foreground max-sm:pt-1">
                            {entry.label}
                          </dt>
                          <dd className="min-w-0 break-all" data-testid={entry.testId}>
                            {entry.value}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  </td>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

/**
 * Names of the rules lines name (log rules, the rule behind a block: the site's own, platform rules
 * marked, access authentication rules by kind), or null for a rule that is gone or not loaded yet;
 * read only when a line names one.
 */
function useRuleNames(siteId: string, entries: LogEntry[]) {
  const named = entries.some((entry) => entry.ruleIds.length > 0 || entry.blockRuleId !== "");
  const authNamed = entries.some((entry) => entry.blockReason === "auth" && entry.blockRuleId);
  const own = useQuery({
    ...orpc.rules.get.queryOptions({ input: { id: siteId } }),
    enabled: named,
  });
  const platform = useQuery({ ...orpc.platformRules.get.queryOptions(), enabled: named });
  const auth = useQuery({
    ...orpc.authRules.get.queryOptions({ input: { id: siteId } }),
    enabled: authNamed,
  });
  const names = React.useMemo(
    () =>
      new Map<string, string>([
        ...(platform.data ?? []).map(
          (rule) => [rule.id, m.rules_logged_platform({ name: rule.name })] as const,
        ),
        ...(own.data ?? []).map((rule) => [rule.id, rule.name] as const),
        ...(auth.data?.rules ?? []).map((rule) => [rule.id, authKindLabel(rule.kind)] as const),
      ]),
    [own.data, platform.data, auth.data],
  );
  return (id: string): string | null => names.get(id) ?? null;
}
