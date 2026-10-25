import {
  NODE_DEBUG_LOG_LIMITS,
  NODE_DEBUG_LOGS_FEATURE,
  NODE_LOG_SOURCES,
  type Node,
  type NodeDebugLog,
  type NodeDebugLogEntry,
  type NodeDebugLogLevel,
  type NodeDebugLogSummary,
  type NodeLogSource,
  nodeSupportsFeature,
} from "@edgeweir/contract";
import { Download01Icon, Search01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/arc/dialog/dialog";
import { Input } from "@/components/arc/input/input";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { nodeLogSourceLabel } from "@/components/node-logs";
import { EmptyState, QueryView } from "@/components/states";
import { Dot, type StatusTone } from "@/components/status-dot";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { downloadText } from "@/lib/browser";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import { toast } from "@/lib/toast";

type RangeChoice = "all" | "15m" | "1h";
const RANGE_MS: Record<Exclude<RangeChoice, "all">, number> = {
  "15m": 15 * 60_000,
  "1h": 3_600_000,
};
type LevelFilter = "all" | "info" | "warn";
const LEVEL_RANK: Record<NodeDebugLogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LEVEL_TONE: Record<NodeDebugLogLevel, StatusTone> = {
  debug: "idle",
  info: "good",
  warn: "warn",
  error: "bad",
};
const levelLabel = (level: NodeDebugLogLevel) =>
  ({
    debug: m.node_debug_level_debug,
    info: m.node_debug_level_info_entry,
    warn: m.node_log_level_warn,
    error: m.node_log_level_error,
  })[level]();
const COMPONENT = /^[a-z0-9_.-]{1,64}$/;
/** Entries the viewer shows at first and adds per "show more". */
const PAGE = 500;

const isOpen = (pull: NodeDebugLogSummary) => pull.state === "pending" || pull.state === "running";

function failureLabel(pull: NodeDebugLogSummary): string {
  if (pull.errorCode === "debug_logs_timeout") return m.node_debug_failed_timeout();
  if (pull.errorCode === "task_unsupported") return m.node_debug_failed_unsupported();
  if (pull.errorCode === "debug_logs_failed")
    return pull.errorParams.reason === "disabled"
      ? m.node_debug_failed_disabled()
      : m.node_debug_failed_upload();
  return m.node_debug_failed();
}

/**
 * The node's debug log pulls (debug-logs-v1): pulling asks the node for the debug log buffer it
 * keeps in memory; the list refreshes while a pull waits for the node, and a finished pull can be
 * viewed and downloaded (JSON lines). Nodes without the feature show nothing.
 */
export function NodeDebugLogs({ node }: { node: Node }) {
  const [pulling, setPulling] = React.useState(false);
  const [viewing, setViewing] = React.useState<string | null>(null);
  const supported = nodeSupportsFeature(node.supportedFeatures, NODE_DEBUG_LOGS_FEATURE);
  const pulls = useQuery({
    ...orpc.nodes.debugLogs.queryOptions({ input: { id: node.id } }),
    enabled: supported,
    refetchInterval: (query) => (query.state.data?.pulls.some(isOpen) ? 2_000 : false),
    meta: { background: true },
  });
  if (!supported) return null;
  const open = pulls.data?.pulls.some(isOpen) ?? false;
  return (
    <section className="flex min-w-0 flex-col gap-3" data-testid="node-debug-logs">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-medium">{m.node_debug_title()}</h3>
        <Button
          size="sm"
          variant="secondary"
          disabled={open}
          onClick={() => setPulling(true)}
          data-testid="node-debug-pull"
        >
          {open ? <Spinner /> : null}
          {m.node_debug_pull()}
        </Button>
      </div>
      <QueryView query={pulls} isEmpty={(data) => data.pulls.length === 0} empty={null}>
        {(data) => (
          <ol
            className="min-w-0 divide-y divide-border/70 overflow-hidden rounded-xl border border-edge"
            data-testid="node-debug-pulls"
          >
            {data.pulls.map((pull, i) => (
              <PullRow
                key={pull.id}
                pull={pull}
                index={i}
                node={node}
                onView={() => setViewing(pull.id)}
              />
            ))}
          </ol>
        )}
      </QueryView>
      <PullDialog node={node} open={pulling} onOpenChange={setPulling} />
      {viewing ? (
        <DebugLogViewer node={node} pullId={viewing} onClose={() => setViewing(null)} />
      ) : null}
    </section>
  );
}

function PullRow({
  pull,
  index,
  node,
  onView,
}: {
  pull: NodeDebugLogSummary;
  index: number;
  node: Node;
  onView: () => void;
}) {
  const [downloading, setDownloading] = React.useState(false);
  const download = async () => {
    setDownloading(true);
    try {
      saveDebugLog(node, await client.nodes.debugLog({ id: node.id, pullId: pull.id }));
    } catch {
      toast.error(m.node_debug_failed());
    } finally {
      setDownloading(false);
    }
  };
  return (
    <li
      className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5 text-xs animate-enter"
      style={{ animationDelay: `${Math.min(index, 8) * 30}ms` }}
      data-testid="node-debug-pull-row"
      data-state={pull.state}
    >
      <span className="font-mono whitespace-nowrap text-muted-foreground">
        {formatDateTime(pull.createdAt)}
      </span>
      {isOpen(pull) ? (
        <span className="inline-flex items-center gap-1.5">
          <Spinner className="size-3" />
          {m.node_debug_waiting()}
        </span>
      ) : pull.state === "failed" ? (
        <span className="inline-flex items-center gap-1.5" data-testid="node-debug-pull-failed">
          <Dot tone="bad" small />
          {failureLabel(pull)}
        </span>
      ) : (
        <span className="inline-flex items-center gap-1.5 font-medium tabular-nums">
          <Dot tone="good" small />
          {m.node_debug_entries({ count: formatNumber(pull.entryCount) })}
        </span>
      )}
      {pull.truncated ? (
        <Badge size="sm" tone="neutral">
          {m.node_debug_truncated()}
        </Badge>
      ) : null}
      {pull.supervisorMissing ? (
        <Badge size="sm" tone="neutral">
          {m.node_debug_supervisor_missing()}
        </Badge>
      ) : null}
      {pull.state === "succeeded" ? (
        <span className="ml-auto flex items-center gap-1">
          <Button
            className="min-h-6 px-2 text-xs"
            size="sm"
            variant="ghost"
            onClick={onView}
            data-testid="node-debug-view"
          >
            {m.node_debug_view()}
          </Button>
          <Button
            className="min-h-6 px-2 text-xs"
            size="sm"
            variant="ghost"
            disabled={downloading}
            onClick={() => void download()}
            data-testid="node-debug-download"
          >
            {downloading ? <Spinner /> : <HugeiconsIcon icon={Download01Icon} strokeWidth={2} />}
            {m.node_debug_download()}
          </Button>
        </span>
      ) : null}
    </li>
  );
}

/** Saves the pull as JSON lines, one entry per line, oldest first. */
function saveDebugLog(node: Node, pull: NodeDebugLog) {
  const stamp = pull.createdAt.replace(/[:.]/g, "-");
  downloadText(
    `${node.name}-debug-${stamp}.jsonl`,
    pull.entries.map((e) => JSON.stringify(e)).join("\n") + (pull.entries.length ? "\n" : ""),
    "application/x-ndjson",
  );
}

function PullDialog({
  node,
  open,
  onOpenChange,
}: {
  node: Node;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [range, setRange] = React.useState<RangeChoice>("all");
  const [source, setSource] = React.useState<"all" | NodeLogSource>("all");
  const [components, setComponents] = React.useState("");
  const list = components
    .split(/[\s,]+/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const valid =
    list.length <= NODE_DEBUG_LOG_LIMITS.components && list.every((c) => COMPONENT.test(c));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.node_debug_pull()}
      submitLabel={m.node_debug_pull_submit()}
      submitTestId="node-debug-pull-submit"
      submitDisabled={!valid}
      onSubmit={async () => {
        await client.nodes.pullDebugLogs({
          id: node.id,
          from: range === "all" ? undefined : new Date(Date.now() - RANGE_MS[range]).toISOString(),
          components: list,
          sources: source === "all" ? [] : [source],
        });
        await queryClient.invalidateQueries({
          queryKey: orpc.nodes.debugLogs.key({ input: { id: node.id } }),
        });
        toast.success(m.node_debug_requested());
        onOpenChange(false);
      }}
    >
      <FormSelect
        id="node-debug-range"
        label={m.node_debug_range()}
        value={range}
        options={[
          { value: "all", label: m.node_debug_range_all() },
          { value: "15m", label: m.node_debug_range_15m() },
          { value: "1h", label: m.node_debug_range_1h() },
        ]}
        onChange={setRange}
        testId="node-debug-range"
      />
      <FormSelect
        id="node-debug-source"
        label={m.node_logs_source()}
        value={source}
        options={[
          { value: "all", label: m.node_logs_source_all() },
          ...NODE_LOG_SOURCES.map((value) => ({ value, label: nodeLogSourceLabel(value) })),
        ]}
        onChange={setSource}
        testId="node-debug-source"
      />
      <Field data-invalid={!valid || undefined}>
        <FieldLabel htmlFor="node-debug-components">{m.node_debug_components()}</FieldLabel>
        <Input
          id="node-debug-components"
          value={components}
          maxLength={1100}
          onChange={(event) => setComponents(event.target.value)}
          placeholder={m.node_debug_components_placeholder()}
          aria-invalid={!valid || undefined}
          data-testid="node-debug-components"
        />
        {valid ? null : <FieldError>{m.node_debug_components_invalid()}</FieldError>}
      </Field>
    </FormDialog>
  );
}

/** One pull's entries, oldest first: filter by level and message, a page at a time; download. */
function DebugLogViewer({
  node,
  pullId,
  onClose,
}: {
  node: Node;
  pullId: string;
  onClose: () => void;
}) {
  const pull = useQuery(orpc.nodes.debugLog.queryOptions({ input: { id: node.id, pullId } }));
  const [level, setLevel] = React.useState<LevelFilter>("all");
  const [search, setSearch] = React.useState("");
  const [shown, setShown] = React.useState(PAGE);
  const q = search.trim().toLowerCase();
  const entries = React.useMemo(
    () =>
      (pull.data?.entries ?? []).filter(
        (e) =>
          (level === "all" || LEVEL_RANK[e.level] >= LEVEL_RANK[level]) &&
          (!q || e.message.toLowerCase().includes(q)),
      ),
    [pull.data, level, q],
  );
  return (
    <Dialog open onOpenChange={(next) => !next && onClose()}>
      <DialogContent
        className="flex max-h-[calc(100svh-2rem)] flex-col gap-4 sm:max-w-3xl"
        data-testid="node-debug-viewer"
      >
        <DialogHeader>
          <DialogTitle>{m.node_debug_title()}</DialogTitle>
        </DialogHeader>
        <QueryView query={pull}>
          {(data) => (
            <div className="flex min-h-0 min-w-0 flex-col gap-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                <span className="tabular-nums">
                  {m.node_debug_entries({ count: formatNumber(data.entryCount) })}
                </span>
                {data.bufferSince ? (
                  <span>
                    {m.node_debug_buffer_since({ time: formatDateTime(data.bufferSince) })}
                  </span>
                ) : null}
                {data.truncated ? (
                  <Badge size="sm" tone="neutral">
                    {m.node_debug_truncated()}
                  </Badge>
                ) : null}
                {data.supervisorMissing ? (
                  <Badge size="sm" tone="neutral">
                    {m.node_debug_supervisor_missing()}
                  </Badge>
                ) : null}
                <Button
                  size="sm"
                  variant="secondary"
                  className="ml-auto"
                  onClick={() => saveDebugLog(node, data)}
                  data-testid="node-debug-viewer-download"
                >
                  <HugeiconsIcon icon={Download01Icon} strokeWidth={2} />
                  {m.node_debug_download()}
                </Button>
              </div>
              <div className="grid gap-2 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)]">
                <OptionSelect
                  value={level}
                  options={[
                    { value: "all", label: m.node_debug_level_all() },
                    { value: "info", label: m.node_debug_level_info() },
                    { value: "warn", label: m.node_debug_level_warn() },
                  ]}
                  onChange={(value) => {
                    setLevel(value);
                    setShown(PAGE);
                  }}
                  label={m.node_logs_level()}
                  size="sm"
                  testId="node-debug-level"
                />
                <InputGroup>
                  <InputGroupAddon>
                    <HugeiconsIcon icon={Search01Icon} strokeWidth={2} />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    value={search}
                    maxLength={200}
                    onChange={(event) => {
                      setSearch(event.target.value);
                      setShown(PAGE);
                    }}
                    placeholder={m.node_logs_search()}
                    aria-label={m.node_logs_search()}
                    data-testid="node-debug-search"
                  />
                </InputGroup>
              </div>
              {entries.length === 0 ? (
                <EmptyState title={m.node_debug_empty()} />
              ) : (
                <div className="flex min-h-0 flex-col gap-3 overflow-y-auto">
                  <ol
                    className="min-w-0 divide-y divide-border/70 rounded-xl border border-edge"
                    data-testid="node-debug-entries"
                  >
                    {entries.slice(0, shown).map((entry, i) => (
                      // Entries have no id; their place in the pull is stable.
                      // biome-ignore lint/suspicious/noArrayIndexKey: see above
                      <DebugEntryRow key={i} entry={entry} />
                    ))}
                  </ol>
                  {entries.length > shown ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      className="self-center"
                      onClick={() => setShown((n) => n + PAGE)}
                      data-testid="node-debug-more"
                    >
                      {m.node_debug_more()}
                    </Button>
                  ) : null}
                </div>
              )}
            </div>
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

function DebugEntryRow({ entry }: { entry: NodeDebugLogEntry }) {
  const fields = Object.entries(entry.fields).sort(([a], [b]) => a.localeCompare(b));
  return (
    <li
      className="flex min-w-0 flex-col gap-1 px-3 py-2 text-xs"
      data-testid="node-debug-entry"
      data-level={entry.level}
    >
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
        <span className="inline-flex items-center gap-1.5 font-medium whitespace-nowrap">
          <Dot tone={LEVEL_TONE[entry.level]} small />
          {levelLabel(entry.level)}
        </span>
        <span className="font-mono whitespace-nowrap text-muted-foreground">
          {formatDateTime(entry.time)}
        </span>
        <Badge size="sm" tone="neutral">
          {nodeLogSourceLabel(entry.source)}
          {entry.component ? ` · ${entry.component}` : ""}
        </Badge>
        {entry.truncated ? (
          <Badge size="sm" tone="neutral">
            {m.node_logs_truncated()}
          </Badge>
        ) : null}
      </div>
      <p className="min-w-0 font-mono break-words whitespace-pre-wrap">{entry.message}</p>
      {fields.length > 0 ? (
        <p className="min-w-0 font-mono break-all whitespace-pre-wrap text-muted-foreground">
          {fields.map(([key, value]) => `${key}=${value}`).join(" ")}
        </p>
      ) : null}
    </li>
  );
}
