import {
  CACHE_SIZE_GB_RANGE,
  CACHE_ZONE_FEATURE,
  forbiddenOriginRange,
  NODE_DECOMMISSION_FEATURE,
  type Node,
  nodeSupportsFeature,
  nodeUpgradeRecommended,
  unicastAddress,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon, MoreHorizontalIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { MetricCard } from "@/components/analytics/panel";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { Input } from "@/components/arc/input/input";
import { DecommissionNodeDialog } from "@/components/clusters/node-dialogs";
import { markOverflow } from "@/components/data-table";
import { OptionSelect } from "@/components/form-select";
import { FieldError } from "@/components/layout/form";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { Meter } from "@/components/meter";
import { NodeChannelFact } from "@/components/node-channel-state";
import { ProbeResults } from "@/components/probes";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { nextDraftKey } from "@/components/site/save-site";
import { StatusDot } from "@/components/status-dot";
import { TimeAgo } from "@/components/time-ago";
import { useUnsavedChanges } from "@/hooks/use-unsaved-changes";
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
import { nodeMainAddress } from "@/lib/node-views";
import { errorMessage, orpc } from "@/lib/orpc";

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
  if (node.decommissionRequestedAt)
    return (
      <StatusDot tone="warn" pulse>
        {m.node_decommissioning()}
      </StatusDot>
    );
  if (node.status === "disabled") return <StatusDot tone="idle">{m.nodes_disabled()}</StatusDot>;
  return node.online ? (
    <StatusDot tone="good" glow>
      {m.nodes_online()}
    </StatusDot>
  ) : (
    <StatusDot tone="bad">{m.nodes_offline()}</StatusDot>
  );
}

export function NodeOverview({ node }: { node: Node }) {
  return (
    <div className="grid gap-4">
      <Panel>
        <PanelHeader>
          <PanelTitle>{m.scope_node_status()}</PanelTitle>
          <span data-testid="node-detail-state">
            <DetailState node={node} />
          </span>
        </PanelHeader>
        <PanelContent className="flex flex-col gap-3">
          <code className="break-all text-xs text-muted-foreground">{node.hostname}</code>
          {node.decommissionRequestedAt ? (
            <SafetyNote data-testid="node-decommission-waiting">
              {node.online ? m.node_decommission_waiting() : m.node_decommission_waiting_offline()}
            </SafetyNote>
          ) : null}
          {node.decommissionError ? (
            <Badge
              size="sm"
              tone="danger"
              title={node.decommissionError}
              data-testid="node-decommission-failed"
            >
              {m.node_decommission_failed()}
            </Badge>
          ) : null}
          <NodeFacts node={node} />
        </PanelContent>
      </Panel>
      <NodeMetrics node={node} />
    </div>
  );
}

export function NodeProbes({ node }: { node: Node }) {
  return (
    <Panel>
      <PanelHeader>
        <PanelTitle>{m.probes_results()}</PanelTitle>
      </PanelHeader>
      <PanelContent className="flex flex-col gap-4">
        <NodeProbeSwitch node={node} />
        <ProbeResults input={{ nodeId: node.id }} by="prober" testId="node-probe-results" />
      </PanelContent>
    </Panel>
  );
}

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
    <div className={className}>
      <MetricCard
        title={label}
        value={<span data-testid={testId}>{children}</span>}
        footer={meter}
      />
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
        <div className="grid grid-cols-2 gap-3 @xl/main:grid-cols-6">
          <Metric
            label={m.node_metrics_cpu()}
            testId="node-metric-cpu"
            className="@xl/main:col-span-3"
            meter={<LoadMeter value={metrics.cpuPercent} label={m.node_metrics_cpu()} />}
          >
            {formatPercent(metrics.cpuPercent)}
          </Metric>
          <Metric
            label={m.node_metrics_memory()}
            testId="node-metric-memory"
            className="@xl/main:col-span-3"
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
          <Metric label={m.node_metrics_load()} testId="node-metric-load" className="col-span-2">
            {load(metrics.load1)} / {load(metrics.load5)} / {load(metrics.load15)}
          </Metric>
          <Metric
            label={m.node_metrics_egress()}
            testId="node-metric-egress"
            className="@xl/main:col-span-2"
          >
            {formatBitRate(metrics.egressBps / 8)}
          </Metric>
          <Metric
            label={m.node_metrics_connections()}
            testId="node-metric-connections"
            className="@xl/main:col-span-2"
          >
            {formatNumber(metrics.activeConnections)}
          </Metric>
        </div>
      ) : (
        <p
          className="rounded-lg border bg-card p-4 text-sm text-muted-foreground"
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
    <div className="flex min-w-0 flex-col gap-1 rounded-md bg-well px-3 py-2.5">
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
        {node.agentVersion &&
        !node.upgradeRequired &&
        nodeUpgradeRecommended(node.supportedFeatures) ? (
          <Badge
            size="sm"
            tone="neutral"
            title={m.node_upgrade_recommended_title()}
            data-testid="node-fact-upgrade-recommended"
          >
            {m.node_upgrade_recommended()}
          </Badge>
        ) : null}
      </Fact>
      <Fact label={m.nodes_col_last_seen()} testId="node-fact-last-seen">
        <span title={node.lastSeenAt ? formatDateTime(node.lastSeenAt) : undefined}>
          <TimeAgo at={node.lastSeenAt} />
        </span>
      </Fact>
      <Fact label={m.node_reported_addresses()} testId="node-fact-ips">
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
      <Fact label={m.node_addresses_title()} testId="node-fact-address">
        <code className="break-all">{nodeMainAddress(node)}</code>
        {node.schedulingAddresses.length ? (
          <Badge size="sm" tone="neutral">
            {levelLabel(Math.min(...node.schedulingAddresses.map((address) => address.level)))}
          </Badge>
        ) : null}
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
export function NodeCache({ node }: { node: Node }) {
  const cluster = useQuery(orpc.clusters.get.queryOptions({ input: { id: node.clusterId } }));
  const nodes = useQuery(orpc.nodes.list.queryOptions({ input: { clusterId: node.clusterId } }));
  const setCache = useMutation({
    ...orpc.nodes.setCache.mutationOptions(),
    meta: { invalidates: [orpc.nodes.key()], success: m.common_saved, toastError: true },
  });
  const saved = node.cache.maxSizeGb === null ? "" : String(node.cache.maxSizeGb);
  const [size, setSize] = React.useState(saved);
  useUnsavedChanges(size !== saved);
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
      <MetricCard
        title={m.node_cache_title()}
        aside={
          usage ? (
            <span
              className="text-xs text-muted-foreground tabular-nums"
              title={formatDateTime(usage.measuredAt)}
            >
              {m.node_cache_measured({ time: timeAgo(usage.measuredAt) })}
            </span>
          ) : undefined
        }
        value={
          <span
            data-testid="node-cache-usage"
            className={usage ? undefined : "text-sm font-normal text-muted-foreground"}
          >
            {usage
              ? m.node_cache_used({
                  used: formatBytes(usage.usedBytes),
                  total: formatBytes(usage.maxBytes),
                })
              : m.node_cache_unreported()}
          </span>
        }
        footer={
          usage && usage.maxBytes > 0 ? (
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
          ) : undefined
        }
      />
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

export function NodeAddresses({ node }: { node: Node }) {
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
          className="overflow-hidden rounded-md faint-well [--cell-bg:var(--well)]"
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
  const [initial] = React.useState(rows);
  useUnsavedChanges(JSON.stringify(rows) !== JSON.stringify(initial));
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

export function NodeDetailActions({ node }: { node: Node }) {
  const [confirming, setConfirming] = React.useState(false);
  const cancel = useMutation({
    ...orpc.nodes.cancelDecommission.mutationOptions(),
    meta: { invalidates: "all", toastError: true },
  });
  if (!nodeSupportsFeature(node.supportedFeatures, NODE_DECOMMISSION_FEATURE)) return null;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="icon-button"
              aria-label={m.common_actions()}
              data-testid="node-detail-actions"
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {node.decommissionRequestedAt ? (
            <DropdownMenuItem
              disabled={cancel.isPending}
              onClick={() => cancel.mutate({ id: node.id })}
              data-testid="node-decommission-cancel"
            >
              {m.node_decommission_cancel()}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              variant="destructive"
              disabled={node.status !== "active"}
              onClick={() => setConfirming(true)}
              data-testid="node-decommission-start"
            >
              {m.node_decommission()}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      <DecommissionNodeDialog node={node} open={confirming} onOpenChange={setConfirming} />
    </>
  );
}
