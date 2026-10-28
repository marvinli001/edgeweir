import {
  CACHE_SIZE_GB_RANGE,
  CACHE_ZONE_FEATURE,
  forbiddenOriginRange,
  type Node,
  unicastAddress,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Meter } from "@/components/appica/meter";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/arc/tabs/tabs";
import { markOverflow } from "@/components/data-table";
import { OptionSelect } from "@/components/form-select";
import { NodeChannelFact } from "@/components/node-channel-state";
import { NodeDebugLogs } from "@/components/node-debug-logs";
import { NodeLogs } from "@/components/node-logs";
import { ProbeResults } from "@/components/probes";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { nextDraftKey } from "@/components/site/save-site";
import { StatusDot } from "@/components/status-dot";
import { FieldError } from "@/components/ui/field";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  formatBitRate,
  formatBytes,
  formatDateTime,
  formatList,
  formatNumber,
  formatPercent,
  getLocale,
  m,
  timeAgo,
} from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const MAX_ADDRESSES = 8;
const LEVELS = [0, 1, 2] as const;
/** Nodes renew a third of the way before expiry (10 of 30 days): less means renewal is failing. */
const CERT_WARN_MS = 10 * 24 * 3600 * 1000;

const levelLabel = (level: number) =>
  level === 0
    ? m.node_address_level_0()
    : level === 1
      ? m.node_address_level_1()
      : m.node_address_level_2();

const load = (value: number) =>
  new Intl.NumberFormat(getLocale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(
    value,
  );

/** The node channel refuses the node's certificate: expired (enroll again) or another verify error. */
export function AuthErrorBadge({ node }: { node: Node }) {
  if (!node.authError) return null;
  return node.authError === "CERT_HAS_EXPIRED" ? (
    <Badge size="sm" tone="danger" data-testid="node-cert-expired">
      {m.node_cert_expired()}
    </Badge>
  ) : (
    <Badge size="sm" tone="danger" title={node.authError} data-testid="node-cert-rejected">
      {m.node_cert_rejected()}
    </Badge>
  );
}

/**
 * The certificates of its revision the node could not load
 * (certificate-isolation-v1); their names on hover.
 */
export function CertificateFailuresBadge({ node }: { node: Node }) {
  const failures = node.certificateFailures;
  if (!failures.length) return null;
  const names = failures.map((f) => f.certificateName || f.certificateId);
  return (
    <Badge
      size="sm"
      tone="danger"
      title={m.node_certificate_failures_names({ certificates: formatList(names) })}
      data-testid="node-certificate-failures"
    >
      {m.node_certificate_failures({ count: failures.length })}
    </Badge>
  );
}

/** Used share of a node's memory, 0-100; null without a total. */
export const memoryPercent = (metrics: NonNullable<Node["metrics"]>) =>
  metrics.memoryTotalBytes > 0 ? (metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100 : null;

/** CPU or memory use from which a node's load is a warning, and from which an error. */
export const LOAD_WARN = 75;
export const LOAD_BAD = 90;

/**
 * CPU or memory use as a meter: good below 75 %, a warning from 75 % and an error from 90 %. The
 * meter's zones are value < low, low..high and value > high, so `high` is the largest number below
 * 90 and 90 itself is an error.
 */
function LoadMeter({ value, label }: { value: number; label: string }) {
  return (
    <Meter
      value={value}
      low={LOAD_WARN}
      high={LOAD_BAD - 2 ** -46}
      label={`${label} ${formatPercent(value)}`}
    />
  );
}

/** A node's state in its detail header: lit while online. */
function DetailState({ node }: { node: Node }) {
  if (node.status === "disabled") return <StatusDot tone="idle">{m.nodes_disabled()}</StatusDot>;
  return node.online ? (
    <StatusDot tone="good" glow>
      {m.nodes_online()}
    </StatusDot>
  ) : (
    <StatusDot tone="bad">{m.nodes_offline()}</StatusDot>
  );
}

/** The tabs of a node's details (?nodeTab=). */
export type NodeDetailTab = "overview" | "logs";

/**
 * A node's details in a side sheet. Overview: host metrics, the scheduling addresses with their
 * levels and reachability (and an editor for configured ones), whether it also probes, and how the
 * probes see it. Logs: pulls of the node's debug log buffer, then its warnings, errors and events.
 * `node` comes from the polling node list.
 */
export function NodeDetailSheet({
  node,
  tab = "overview",
  onTabChange,
  onClose,
}: {
  node: Node;
  tab?: NodeDetailTab;
  onTabChange: (tab: NodeDetailTab) => void;
  onClose: () => void;
}) {
  return (
    <Sheet open onOpenChange={(open) => !open && onClose()}>
      <SheetContent
        side="right"
        className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-2xl"
        data-testid="node-detail"
      >
        <SheetHeader className="gap-1 border-b border-edge py-5 pr-16">
          <SheetTitle className="flex flex-wrap items-center gap-x-3 gap-y-1 text-lg font-semibold tracking-tight [font-stretch:106%]">
            <span className="min-w-0 break-all" data-testid="node-detail-name">
              {node.name}
            </span>
            <span className="text-sm font-normal tracking-normal [font-stretch:100%]">
              <DetailState node={node} />
            </span>
          </SheetTitle>
          <span className="truncate font-mono text-xs text-muted-foreground">{node.hostname}</span>
        </SheetHeader>
        <Tabs
          value={tab}
          onValueChange={(value) => onTabChange(value as NodeDetailTab)}
          className="min-h-0 flex-1 gap-0"
        >
          <div className="border-b border-edge px-6 py-3">
            <TabsList className="w-full sm:w-auto">
              <TabsTrigger value="overview" data-testid="node-detail-tab-overview">
                {m.node_detail_overview()}
              </TabsTrigger>
              <TabsTrigger value="logs" data-testid="node-detail-tab-logs">
                {m.node_logs_tab()}
              </TabsTrigger>
            </TabsList>
          </div>
          <TabsContent
            value="overview"
            className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
          >
            <NodeMetrics node={node} />
            <NodeFacts node={node} />
            <NodeProbeSwitch node={node} />
            <NodeCache node={node} />
            <NodeAddresses node={node} />
            <section className="flex min-w-0 flex-col gap-3">
              <h3 className="text-sm font-medium">{m.probes_results()}</h3>
              <ProbeResults input={{ nodeId: node.id }} by="prober" testId="node-probe-results" />
            </section>
          </TabsContent>
          <TabsContent
            value="logs"
            className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto p-6"
          >
            <NodeDebugLogs node={node} />
            <NodeLogs node={node} />
          </TabsContent>
        </Tabs>
      </SheetContent>
    </Sheet>
  );
}

/** One metric tile of the detail: label, value (the test id is on the value alone), a gauge. */
function Metric({
  label,
  children,
  testId,
  meter,
  className,
}: {
  label: string;
  children: React.ReactNode;
  testId: string;
  meter?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5 rounded-xl bg-well px-3 py-2.5", className)}>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd
        className="truncate text-lg leading-tight font-semibold tracking-tight readout [font-stretch:108%]"
        data-testid={testId}
      >
        {children}
      </dd>
      {meter ? <dd className="pt-0.5">{meter}</dd> : null}
    </div>
  );
}

function NodeMetrics({ node }: { node: Node }) {
  const metrics = node.metrics;
  const memory = metrics ? memoryPercent(metrics) : null;
  return (
    <section className="flex flex-col gap-3" data-testid="node-metrics">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{m.node_metrics_title()}</h3>
        {metrics ? (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(metrics.reportedAt)}
            data-testid="node-metrics-reported"
          >
            {m.node_metrics_reported({ time: timeAgo(metrics.reportedAt) })}
          </span>
        ) : null}
      </div>
      {metrics ? (
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-6">
          <Metric
            label={m.node_metrics_cpu()}
            testId="node-metric-cpu"
            className="sm:col-span-3"
            meter={<LoadMeter value={metrics.cpuPercent} label={m.node_metrics_cpu()} />}
          >
            {formatPercent(metrics.cpuPercent)}
          </Metric>
          <Metric
            label={m.node_metrics_memory()}
            testId="node-metric-memory"
            className="sm:col-span-3"
            meter={
              memory === null ? undefined : (
                <LoadMeter value={memory} label={m.node_metrics_memory()} />
              )
            }
          >
            <span
              title={`${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`}
            >
              {memory === null ? formatBytes(metrics.memoryUsedBytes) : formatPercent(memory)}
            </span>
          </Metric>
          <Metric
            label={m.node_metrics_load()}
            testId="node-metric-load"
            className="col-span-2 sm:col-span-2"
          >
            {load(metrics.load1)} / {load(metrics.load5)} / {load(metrics.load15)}
          </Metric>
          <Metric
            label={m.node_metrics_egress()}
            testId="node-metric-egress"
            className="sm:col-span-2"
          >
            {formatBitRate(metrics.egressBps / 8)}
          </Metric>
          <Metric
            label={m.node_metrics_connections()}
            testId="node-metric-connections"
            className="sm:col-span-2"
          >
            {formatNumber(metrics.activeConnections)}
          </Metric>
        </dl>
      ) : (
        <p
          className="rounded-xl bg-well px-3 py-2.5 text-sm text-muted-foreground"
          data-testid="node-metrics-none"
        >
          {m.node_metrics_none()}
        </p>
      )}
    </section>
  );
}

function Fact({
  label,
  children,
  testId,
}: {
  label: string;
  children: React.ReactNode;
  testId: string;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl bg-well px-3 py-2.5">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** How far the node's clock is from the console's, as the node last measured it. */
function NodeClockFact({ clock }: { clock: Node["clock"] }) {
  if (!clock) return <span className="text-muted-foreground">—</span>;
  const seconds = formatNumber(Math.round(Math.abs(clock.offsetMs) / 100) / 10);
  return (
    <>
      <span className="tabular-nums">
        {Math.abs(clock.offsetMs) < 100
          ? m.node_clock_in_sync()
          : clock.offsetMs > 0
            ? m.node_clock_ahead({ seconds })
            : m.node_clock_behind({ seconds })}
      </span>
      {clock.skewed ? (
        <Badge size="sm" tone="danger" data-testid="node-clock-skewed">
          {m.node_clock_skewed()}
        </Badge>
      ) : null}
    </>
  );
}

/**
 * Its group and region, applied revision, agent and engine, addresses, data plane health, the
 * connection's source address, the node channel address in use, the client certificate's
 * lifetime and the clock offset.
 */
function NodeFacts({ node }: { node: Node }) {
  const certLeft = node.certNotAfter ? Date.parse(node.certNotAfter) - Date.now() : null;
  return (
    <dl className="grid gap-2 sm:grid-cols-2" data-testid="node-facts">
      <Fact label={m.nodes_col_group()} testId="node-fact-group">
        <span>{node.nodeGroupName ?? "—"}</span>
        {node.regionName ? <span className="text-muted-foreground">{node.regionName}</span> : null}
      </Fact>
      <Fact label={m.nodes_col_revision()} testId="node-fact-revision">
        <span className="font-mono">#{node.appliedRevision}</span>
        {node.applyState === "failed" ? (
          <Badge size="sm" tone="danger" title={node.applyMessage}>
            {m.nodes_apply_failed()}
          </Badge>
        ) : null}
      </Fact>
      <Fact label={m.nodes_col_agent()} testId="node-fact-agent">
        <span className="font-mono">{node.agentVersion || "—"}</span>
        <span className="text-muted-foreground">
          {node.engine} {node.engineVersion}
        </span>
      </Fact>
      <Fact label={m.nodes_col_ips()} testId="node-fact-ips">
        {node.ipAddresses.length ? (
          node.ipAddresses.map((ip) => (
            <span key={ip} className="font-mono break-all">
              {ip}
            </span>
          ))
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </Fact>
      <Fact label={m.node_data_plane()} testId="node-data-plane">
        {node.dataPlaneHealthy ? (
          <StatusDot tone="good" glow={node.online}>
            {m.node_data_plane_healthy()}
          </StatusDot>
        ) : (
          <StatusDot tone="bad">{m.nodes_unhealthy()}</StatusDot>
        )}
      </Fact>
      <Fact label={m.node_remote_address()} testId="node-remote-address">
        <span className="font-mono">{node.remoteAddress ?? "—"}</span>
      </Fact>
      <Fact label={m.system_node_api_url()} testId="node-channel">
        <NodeChannelFact status={node.channel} />
      </Fact>
      <Fact label={m.node_cert_not_after()} testId="node-cert-not-after">
        {node.certNotAfter ? (
          <span className="tabular-nums">{formatDateTime(node.certNotAfter)}</span>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
        {node.authError ? (
          <AuthErrorBadge node={node} />
        ) : certLeft === null ? null : certLeft <= 0 ? (
          <Badge size="sm" tone="danger" data-testid="node-cert-expired">
            {m.node_cert_expired()}
          </Badge>
        ) : certLeft < CERT_WARN_MS ? (
          <Badge size="sm" tone="neutral" data-testid="node-cert-expiring">
            {m.node_cert_expiring()}
          </Badge>
        ) : null}
      </Fact>
      <Fact label={m.node_clock()} testId="node-clock">
        <NodeClockFact clock={node.clock} />
      </Fact>
    </dl>
  );
}

function NodeProbeSwitch({ node }: { node: Node }) {
  const setProbe = useMutation({
    ...orpc.nodes.setProbe.mutationOptions(),
    meta: { invalidates: [orpc.nodes.key()], toastError: true },
  });
  const hasRegion = !!node.regionName;
  return (
    <section className="flex flex-col gap-2">
      <SwitchField
        id={`node-probe-${node.id}`}
        label={m.node_probe_switch()}
        checked={node.probeEnabled}
        disabled={setProbe.isPending || (!hasRegion && !node.probeEnabled)}
        onCheckedChange={(enabled) => setProbe.mutate({ id: node.id, enabled })}
        className="self-start"
        testId="node-probe-switch"
      />
      {hasRegion ? null : (
        <SafetyNote data-testid="node-probe-no-region">{m.node_probe_no_region()}</SafetyNote>
      )}
    </section>
  );
}

/**
 * The node's cache zone: its disk usage as last measured and its own size
 * (empty follows the cluster's; needs cache-zone-v1 on every active node).
 */
function NodeCache({ node }: { node: Node }) {
  const cluster = useQuery(orpc.clusters.get.queryOptions({ input: { id: node.clusterId } }));
  const nodes = useQuery(orpc.nodes.list.queryOptions({ input: { clusterId: node.clusterId } }));
  const setCache = useMutation({
    ...orpc.nodes.setCache.mutationOptions(),
    meta: { invalidates: [orpc.nodes.key()], success: m.common_saved, toastError: true },
  });
  const saved = node.cache.maxSizeGb === null ? "" : String(node.cache.maxSizeGb);
  const [size, setSize] = React.useState(saved);
  const available = (nodes.data ?? [])
    .filter((n) => n.status === "active")
    .every((n) => n.supportedFeatures.includes(CACHE_ZONE_FEATURE));
  const usage = node.cache.usage;
  const valid =
    size.trim() === "" ||
    (Number.isInteger(Number(size)) &&
      Number(size) >= CACHE_SIZE_GB_RANGE.min &&
      Number(size) <= CACHE_SIZE_GB_RANGE.max);
  const blocked = !available && node.cache.maxSizeGb === null;
  return (
    <section className="flex flex-col gap-3" data-testid="node-cache">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium">{m.node_cache_title()}</h3>
        {usage ? (
          <span
            className="text-xs text-muted-foreground tabular-nums"
            title={formatDateTime(usage.measuredAt)}
          >
            {m.node_cache_measured({ time: timeAgo(usage.measuredAt) })}
          </span>
        ) : null}
      </div>
      {/* The last measured use as a tile with its gauge (a full cache is normal: one zone). */}
      <div className="flex min-w-0 flex-col gap-2 rounded-xl bg-well px-3 py-2.5">
        <p
          className={cn("text-sm tabular-nums", usage ? "font-medium" : "text-muted-foreground")}
          data-testid="node-cache-usage"
        >
          {usage
            ? m.node_cache_used({
                used: formatBytes(usage.usedBytes),
                total: formatBytes(usage.maxBytes),
              })
            : m.node_cache_unreported()}
        </p>
        {usage && usage.maxBytes > 0 ? (
          <Meter
            value={Math.min(100, (usage.usedBytes / usage.maxBytes) * 100)}
            low={0}
            high={100}
            optimum={50}
            label={m.node_cache_used({
              used: formatBytes(usage.usedBytes),
              total: formatBytes(usage.maxBytes),
            })}
          />
        ) : null}
      </div>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid)
            setCache.mutate({ id: node.id, maxSizeGb: size.trim() === "" ? null : Number(size) });
        }}
      >
        <div className="w-44">
          <NumberField
            id={`node-cache-size-${node.id}`}
            label={m.node_cache_size()}
            value={size}
            min={CACHE_SIZE_GB_RANGE.min}
            max={CACHE_SIZE_GB_RANGE.max}
            step={1}
            disabled={blocked}
            invalid={!valid}
            placeholder={
              cluster.data
                ? m.node_cache_cluster({ size: String(cluster.data.cache.maxSizeGb) })
                : ""
            }
            onChange={setSize}
            testId="node-cache-size"
          />
        </div>
        <Button
          type="submit"
          variant="secondary"
          disabled={size === saved || !valid || setCache.isPending}
          data-testid="node-cache-save"
        >
          {setCache.isPending ? <Spinner /> : null}
          {m.common_save()}
        </Button>
      </form>
      {valid ? null : (
        <FieldError id={`node-cache-size-${node.id}-error`} className="animate-in fade-in">
          {m.common_whole_number_range({
            min: formatNumber(CACHE_SIZE_GB_RANGE.min),
            max: formatNumber(CACHE_SIZE_GB_RANGE.max),
          })}
        </FieldError>
      )}
      {blocked ? (
        <SafetyNote data-testid="node-cache-unavailable">
          {m.feature_unavailable_nodes()}
        </SafetyNote>
      ) : null}
    </section>
  );
}

type AddressDraft = { key: number; address: string; level: number };

function NodeAddresses({ node }: { node: Node }) {
  const [editing, setEditing] = React.useState(false);
  const configured = node.schedulingAddresses.some((a) => a.source === "configured");
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="flex items-center gap-2 text-sm font-medium">
          {m.node_addresses_title()}
          {node.dnsIssue === "no_public_address" ? (
            <Badge size="sm" tone="neutral" data-testid="node-detail-dns-issue">
              {m.node_dns_no_public_address()}
            </Badge>
          ) : null}
        </h3>
        {editing ? null : (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setEditing(true)}
            data-testid="node-addresses-edit"
          >
            {m.node_addresses_edit()}
          </Button>
        )}
      </div>
      {editing ? (
        <AddressEditor node={node} configured={configured} onDone={() => setEditing(false)} />
      ) : node.schedulingAddresses.length === 0 ? (
        <p className="text-sm text-muted-foreground">{m.node_addresses_none()}</p>
      ) : (
        <div
          ref={markOverflow}
          className="overflow-hidden rounded-xl sunk-well [--cell-bg:var(--well)]"
          data-testid="node-addresses"
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="cell-pinned">{m.node_address_col_address()}</TableHead>
                <TableHead>{m.node_address_col_level()}</TableHead>
                <TableHead>{m.node_address_col_source()}</TableHead>
                <TableHead>{m.node_address_col_state()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {[...node.schedulingAddresses]
                .sort((a, b) => a.level - b.level || a.address.localeCompare(b.address))
                .map((a) => {
                  const inUse = a.level === node.schedulingLevel && a.reachable;
                  return (
                    <TableRow
                      key={`${a.level}-${a.address}`}
                      data-testid="node-address-row"
                      data-address={a.address}
                      data-level={a.level}
                      data-source={a.source}
                      data-reachable={a.reachable}
                    >
                      <TableCell className="cell-pinned font-mono text-xs">{a.address}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <Badge size="sm" tone={a.level === 0 ? "neutral" : "neutral"}>
                            {levelLabel(a.level)}
                          </Badge>
                          {inUse ? (
                            <Badge size="sm" tone="info" data-testid="node-address-in-use">
                              {m.node_address_in_use()}
                            </Badge>
                          ) : null}
                        </span>
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {a.source === "configured"
                          ? m.node_address_source_configured()
                          : m.node_address_source_reported()}
                      </TableCell>
                      <TableCell>
                        {a.reachable ? (
                          <StatusDot tone="good">{m.node_address_reachable()}</StatusDot>
                        ) : (
                          <StatusDot tone="bad">{m.node_address_unreachable()}</StatusDot>
                        )}
                      </TableCell>
                    </TableRow>
                  );
                })}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}

/**
 * Configured scheduling addresses with their levels. Starts from the
 * configured ones, or from the reported ones as primaries; saving replaces
 * them, "use reported addresses" clears them.
 */
function AddressEditor({
  node,
  configured,
  onDone,
}: {
  node: Node;
  configured: boolean;
  onDone: () => void;
}) {
  const save = useMutation({
    ...orpc.nodes.setAddresses.mutationOptions(),
    meta: { invalidates: [orpc.nodes.key()], success: m.common_saved },
  });
  const [rows, setRows] = React.useState<AddressDraft[]>(() =>
    node.schedulingAddresses
      .filter((a) => !configured || a.source === "configured")
      .map((a) => ({ key: nextDraftKey(), address: a.address, level: configured ? a.level : 0 })),
  );
  const [error, setError] = React.useState<string | null>(null);
  const [pending, setPending] = React.useState<"save" | "reset" | null>(null);
  const patch = (key: number, change: Partial<AddressDraft>) =>
    setRows(rows.map((row) => (row.key === key ? { ...row, ...change } : row)));
  const addRow = (address: string) =>
    setRows([
      ...rows,
      { key: nextDraftKey(), address, level: rows.some((r) => r.level === 0) ? 1 : 0 },
    ]);
  // The connection's source address, offered when public and not listed: it
  // may be a proxy's, so it is never added on its own.
  const suggested =
    node.remoteAddress &&
    unicastAddress(node.remoteAddress) &&
    forbiddenOriginRange(node.remoteAddress, []) === null &&
    !rows.some((row) => unicastAddress(row.address.trim()) === node.remoteAddress)
      ? node.remoteAddress
      : null;
  const submit = async (
    addresses: { address: string; level: number }[],
    kind: "save" | "reset",
  ) => {
    setError(null);
    if (addresses.length && !addresses.some((a) => a.level === 0)) {
      setError(m.node_addresses_primary_required());
      return;
    }
    setPending(kind);
    try {
      await save.mutateAsync({ id: node.id, addresses });
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setPending(null);
    }
  };
  return (
    <form
      className="flex flex-col gap-3"
      data-testid="node-address-editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(
          rows
            .map((row) => ({ address: row.address.trim(), level: row.level }))
            .filter((row) => row.address),
          "save",
        );
      }}
    >
      <ol className="flex flex-col gap-2">
        {rows.map((row, index) => (
          <li
            key={row.key}
            className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-2 animate-enter"
            style={{ animationDelay: `${index * 30}ms` }}
            data-testid="node-address-draft"
          >
            <Input
              value={row.address}
              onChange={(e) => patch(row.key, { address: e.target.value })}
              aria-label={m.node_address_col_address()}
              placeholder="192.0.2.10"
              className="font-mono"
              maxLength={64}
              required
              data-testid="node-address-input"
            />
            <OptionSelect
              value={String(row.level)}
              options={LEVELS.map((level) => ({ value: String(level), label: levelLabel(level) }))}
              onChange={(value) => patch(row.key, { level: Number(value) })}
              label={m.node_address_col_level()}
              className="w-28"
              testId="node-address-level"
            />
            <Button
              className="icon-button"
              type="button"
              size="sm"
              variant="ghost"
              aria-label={m.common_remove()}
              onClick={() => setRows(rows.filter((r) => r.key !== row.key))}
              data-testid="node-address-remove"
            >
              <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
            </Button>
          </li>
        ))}
      </ol>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={rows.length >= MAX_ADDRESSES}
          onClick={() => addRow("")}
          data-testid="node-address-add"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.node_addresses_add()}
        </Button>
        {suggested ? (
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={rows.length >= MAX_ADDRESSES}
            onClick={() => addRow(suggested)}
            data-testid="node-address-suggest"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.node_addresses_use_remote({ address: suggested })}
          </Button>
        ) : null}
      </div>
      {error ? (
        <FieldError className="animate-in fade-in" data-testid="node-addresses-error">
          {error}
        </FieldError>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {configured ? (
          <Button
            type="button"
            variant="ghost"
            className="mr-auto"
            disabled={pending !== null}
            onClick={() => void submit([], "reset")}
            data-testid="node-addresses-reset"
          >
            {pending === "reset" ? <Spinner /> : null}
            {m.node_addresses_reset()}
          </Button>
        ) : null}
        <Button type="button" variant="secondary" onClick={onDone} disabled={pending !== null}>
          {m.common_cancel()}
        </Button>
        <Button type="submit" disabled={pending !== null} data-testid="node-addresses-save">
          {pending === "save" ? <Spinner /> : null}
          {m.common_save()}
        </Button>
      </div>
    </form>
  );
}
