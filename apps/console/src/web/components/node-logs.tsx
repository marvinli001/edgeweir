import {
  NODE_LOG_SOURCES,
  NODE_LOGS_FEATURE,
  type Node,
  type NodeLogEntry,
  type NodeLogEvent,
  type NodeLogLevel,
  type NodeLogSource,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { ArrowRight01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { OptionSelect } from "@/components/form-select";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/layout/input-group";
import { Spinner } from "@/components/layout/spinner";
import { EmptyState, QueryView } from "@/components/states";
import { Dot, type StatusTone } from "@/components/status-dot";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

type LevelFilter = "all" | "warn" | "error";
type SourceFilter = "all" | NodeLogSource;
type RangeFilter = "all" | "1h" | "24h" | "7d";
const RANGE_MS: Record<Exclude<RangeFilter, "all">, number> = {
  "1h": 3_600_000,
  "24h": 86_400_000,
  "7d": 7 * 86_400_000,
};

const LEVEL_TONE: Record<NodeLogLevel, StatusTone> = { info: "good", warn: "warn", error: "bad" };
const levelLabel = (level: NodeLogLevel) =>
  ({ info: m.node_log_level_info, warn: m.node_log_level_warn, error: m.node_log_level_error })[
    level
  ]();
export const nodeLogSourceLabel = (source: NodeLogSource) =>
  ({
    agent: m.node_log_source_agent,
    supervisor: m.node_log_source_supervisor,
    nginx: m.node_log_source_nginx,
    lua: m.node_log_source_lua,
  })[source]();
const EVENT_LABEL: Record<NodeLogEvent, () => string> = {
  agent_started: m.node_log_event_agent_started,
  config_applied: m.node_log_event_config_applied,
  last_known_good: m.node_log_event_last_known_good,
  engine_started: m.node_log_event_engine_started,
  certificate_renewed: m.node_log_event_certificate_renewed,
  channel_switched: m.node_log_event_channel_switched,
  upgrade_applied: m.node_log_event_upgrade_applied,
  engine_logs_unavailable: m.node_log_event_engine_logs_unavailable,
};
const eventLabel = (event: string) => EVENT_LABEL[event as NodeLogEvent]?.() ?? event;

/**
 * A node's warnings, errors and events (node-logs-v1), newest first: filters, a page at a time,
 * the first pages refreshed every 10 seconds. Nodes without the feature upload none.
 */
export function NodeLogs({ node }: { node: Node }) {
  const [level, setLevel] = React.useState<LevelFilter>("all");
  const [source, setSource] = React.useState<SourceFilter>("all");
  const [range, setRange] = React.useState<RangeFilter>("all");
  // `from` is fixed when the range is chosen: the query stays the same while it refreshes.
  const [from, setFrom] = React.useState<string | undefined>();
  const [q, setQ] = React.useState("");
  const [search, setSearch] = React.useState("");
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search]);
  const supported = nodeSupportsFeature(node.supportedFeatures, NODE_LOGS_FEATURE);
  const filtered = level !== "all" || source !== "all" || range !== "all" || q !== "";

  const logs = useInfiniteQuery({
    ...orpc.nodes.logs.infiniteOptions({
      input: (cursor: string | undefined) => ({
        id: node.id,
        minLevel: level === "all" ? undefined : level,
        source: source === "all" ? undefined : source,
        from,
        q: q || undefined,
        cursor,
        limit: 100,
      }),
      initialPageParam: undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
    refetchInterval: 10_000,
    meta: { background: true },
    placeholderData: keepPreviousData,
  });

  const clear = () => {
    setLevel("all");
    setSource("all");
    setRange("all");
    setFrom(undefined);
    setSearch("");
    setQ("");
  };

  return (
    <div className="flex min-w-0 flex-col gap-4" data-testid="node-logs">
      <div className="grid gap-2 sm:grid-cols-[repeat(3,minmax(0,1fr))]">
        <OptionSelect
          value={level}
          options={[
            { value: "all", label: m.node_logs_level_all() },
            { value: "warn", label: m.node_logs_level_warn() },
            { value: "error", label: m.node_logs_level_error() },
          ]}
          onChange={setLevel}
          label={m.node_logs_level()}
          size="sm"
          testId="node-logs-level"
        />
        <OptionSelect
          value={source}
          options={[
            { value: "all", label: m.node_logs_source_all() },
            ...NODE_LOG_SOURCES.map((value) => ({ value, label: nodeLogSourceLabel(value) })),
          ]}
          onChange={setSource}
          label={m.node_logs_source()}
          size="sm"
          testId="node-logs-source"
        />
        <OptionSelect
          value={range}
          options={[
            { value: "all", label: m.node_logs_range_all() },
            { value: "1h", label: m.node_logs_range_1h() },
            { value: "24h", label: m.node_logs_range_24h() },
            { value: "7d", label: m.node_logs_range_7d() },
          ]}
          onChange={(value) => {
            setRange(value);
            setFrom(
              value === "all" ? undefined : new Date(Date.now() - RANGE_MS[value]).toISOString(),
            );
          }}
          label={m.node_logs_range()}
          size="sm"
          testId="node-logs-range"
        />
        <InputGroup className="sm:col-span-3">
          <InputGroupAddon>
            <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
            placeholder={m.node_logs_search()}
            aria-label={m.node_logs_search()}
            data-testid="node-logs-search"
          />
        </InputGroup>
      </div>
      <QueryView
        query={logs}
        isEmpty={(data) => data.pages.every((page) => page.entries.length === 0)}
        empty={
          !supported && !filtered ? (
            <EmptyState title={m.node_logs_unsupported()} />
          ) : filtered ? (
            <EmptyState compact title={m.node_logs_empty_filtered()}>
              <Button size="sm" variant="secondary" onClick={clear} data-testid="node-logs-clear">
                {m.node_logs_clear()}
              </Button>
            </EmptyState>
          ) : (
            <EmptyState compact title={m.node_logs_empty()} />
          )
        }
      >
        {(data) => (
          <div className="flex min-w-0 flex-col gap-3">
            <ol
              className="min-w-0 divide-y divide-border/70 overflow-hidden rounded-md border border-edge"
              data-testid="node-log-list"
            >
              {data.pages
                .flatMap((page) => page.entries)
                .map((entry) => (
                  <NodeLogRow key={entry.id} entry={entry} />
                ))}
            </ol>
            {logs.hasNextPage ? (
              <Button
                size="sm"
                variant="secondary"
                className="self-center"
                disabled={logs.isFetchingNextPage}
                onClick={() => void logs.fetchNextPage()}
                data-testid="node-logs-more"
              >
                {logs.isFetchingNextPage ? <Spinner /> : null}
                {m.node_logs_more()}
              </Button>
            ) : null}
          </div>
        )}
      </QueryView>
    </div>
  );
}

function NodeLogRow({ entry }: { entry: NodeLogEntry }) {
  const [open, setOpen] = React.useState(false);
  const fields = Object.entries(entry.fields).sort(([a], [b]) => a.localeCompare(b));
  const detailsId = `node-log-${entry.id}`;
  if (entry.kind === "dropped" && entry.dropped) {
    const { rateLimited, overflow } = entry.dropped;
    return (
      <li
        className="flex flex-wrap items-center gap-x-3 gap-y-1 bg-wash/60 px-3 py-2 text-xs text-muted-foreground"
        data-testid="node-log-dropped"
      >
        <span className="font-mono whitespace-nowrap">{formatDateTime(entry.time)}</span>
        <span>
          {m.node_logs_dropped({
            count: formatNumber(rateLimited + overflow),
            rateLimited: formatNumber(rateLimited),
            overflow: formatNumber(overflow),
          })}
        </span>
      </li>
    );
  }
  return (
    <li
      className={cn(
        "flex min-w-0 flex-col gap-1.5 px-3 py-2.5 text-xs transition-colors hover:bg-wash",
        open && "bg-wash",
      )}
      data-testid="node-log-row"
      data-level={entry.level}
      data-source={entry.source}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium whitespace-nowrap">
          <Dot tone={LEVEL_TONE[entry.level]} small />
          {levelLabel(entry.level)}
        </span>
        <span className="font-mono whitespace-nowrap text-muted-foreground">
          {formatDateTime(entry.time)}
        </span>
        <Badge size="sm" tone="neutral" data-testid="node-log-source">
          {nodeLogSourceLabel(entry.source)}
          {entry.component ? ` · ${entry.component}` : ""}
        </Badge>
        {entry.repeated > 0 ? (
          <Badge size="sm" tone="neutral" data-testid="node-log-repeated">
            {m.node_logs_repeated({ count: formatNumber(entry.repeated) })}
          </Badge>
        ) : null}
        {entry.truncated ? (
          <Badge size="sm" tone="neutral">
            {m.node_logs_truncated()}
          </Badge>
        ) : null}
      </div>
      <div className="flex min-w-0 items-start gap-1">
        {fields.length > 0 || entry.event ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="icon-button size-6 min-h-6 -my-0.5 -ml-1 shrink-0"
            aria-label={m.logs_details()}
            aria-expanded={open}
            aria-controls={open ? detailsId : undefined}
            onClick={() => setOpen((v) => !v)}
            data-testid="node-log-toggle"
          >
            <HugeiconsIcon
              icon={ArrowRight01Icon}
              strokeWidth={2}
              className={cn(
                "transition-transform motion-reduce:transition-none",
                open && "rotate-90",
              )}
            />
          </Button>
        ) : null}
        <p
          className={cn(
            "min-w-0 break-words whitespace-pre-wrap",
            entry.event ? "font-medium" : "font-mono",
          )}
          data-testid="node-log-message"
        >
          {entry.event ? eventLabel(entry.event) : entry.message}
        </p>
      </div>
      {open ? (
        <dl
          id={detailsId}
          className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-3 gap-y-1 rounded-lg bg-well/70 p-2.5 font-mono animate-in fade-in duration-200 motion-reduce:animate-none"
          data-testid="node-log-fields"
        >
          {entry.event ? (
            <>
              <dt className="text-muted-foreground">{m.node_logs_message()}</dt>
              <dd className="min-w-0 break-words whitespace-pre-wrap">{entry.message}</dd>
            </>
          ) : null}
          {fields.map(([key, value]) => (
            <React.Fragment key={key}>
              <dt className="text-muted-foreground">{key}</dt>
              <dd className="min-w-0 break-all whitespace-pre-wrap">{value}</dd>
            </React.Fragment>
          ))}
        </dl>
      ) : null}
    </li>
  );
}
