import { forbiddenOriginRange, type Node, unicastAddress } from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { OptionSelect } from "@/components/form-select";
import { ProbeResults } from "@/components/probes";
import { SafetyNote } from "@/components/safety-note";
import { SwitchField } from "@/components/site/fields";
import { nextDraftKey } from "@/components/site/save-site";
import { Dot, StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
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

export const levelLabel = (level: number) =>
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
    <Badge variant="destructive" data-testid="node-cert-expired">
      {m.node_cert_expired()}
    </Badge>
  ) : (
    <Badge variant="destructive" title={node.authError} data-testid="node-cert-rejected">
      {m.node_cert_rejected()}
    </Badge>
  );
}

/** Used share of a node's memory, 0-100; null without a total. */
export const memoryPercent = (metrics: NonNullable<Node["metrics"]>) =>
  metrics.memoryTotalBytes > 0 ? (metrics.memoryUsedBytes / metrics.memoryTotalBytes) * 100 : null;

/**
 * A node's details: host metrics, the scheduling addresses with their levels
 * and reachability (and an editor for configured ones), whether it also
 * probes, and how the probes see it. `node` comes from the polling node list.
 */
export function NodeDetailDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl"
        data-testid="node-detail"
      >
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-3 pr-8">
            <span data-testid="node-detail-name">{node.name}</span>
            {node.status === "disabled" ? (
              <StatusDot tone="idle">{m.nodes_disabled()}</StatusDot>
            ) : node.online ? (
              <StatusDot tone="good" pulse>
                {m.nodes_online()}
              </StatusDot>
            ) : (
              <StatusDot tone="bad">{m.nodes_offline()}</StatusDot>
            )}
          </DialogTitle>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-6">
          <NodeMetrics node={node} />
          <NodeFacts node={node} />
          <NodeProbeSwitch node={node} />
          <NodeAddresses node={node} />
          <section className="flex flex-col gap-3">
            <h3 className="text-sm font-medium">{m.probes_results()}</h3>
            <ProbeResults input={{ nodeId: node.id }} by="prober" testId="node-probe-results" />
          </section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function Metric({
  label,
  children,
  testId,
  className,
}: {
  label: string;
  children: React.ReactNode;
  testId: string;
  className?: string;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1 rounded-xl border px-3 py-2", className)}>
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate text-base font-semibold tabular-nums" data-testid={testId}>
        {children}
      </dd>
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
        <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Metric label={m.node_metrics_cpu()} testId="node-metric-cpu">
            {formatPercent(metrics.cpuPercent)}
          </Metric>
          <Metric label={m.node_metrics_memory()} testId="node-metric-memory">
            <span
              title={`${formatBytes(metrics.memoryUsedBytes)} / ${formatBytes(metrics.memoryTotalBytes)}`}
            >
              {memory === null ? formatBytes(metrics.memoryUsedBytes) : formatPercent(memory)}
            </span>
          </Metric>
          <Metric
            label={m.node_metrics_load()}
            testId="node-metric-load"
            className="col-span-2 sm:col-span-1"
          >
            {load(metrics.load1)} / {load(metrics.load5)} / {load(metrics.load15)}
          </Metric>
          <Metric label={m.node_metrics_egress()} testId="node-metric-egress">
            {formatBitRate(metrics.egressBps / 8)}
          </Metric>
          <Metric label={m.node_metrics_connections()} testId="node-metric-connections">
            {formatNumber(metrics.activeConnections)}
          </Metric>
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground" data-testid="node-metrics-none">
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
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border px-3 py-2">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-2 text-sm" data-testid={testId}>
        {children}
      </dd>
    </div>
  );
}

/** Data plane health, the connection's source address and the client certificate's lifetime. */
function NodeFacts({ node }: { node: Node }) {
  const certLeft = node.certNotAfter ? Date.parse(node.certNotAfter) - Date.now() : null;
  return (
    <dl className="grid gap-2 sm:grid-cols-2" data-testid="node-facts">
      <Fact label={m.node_data_plane()} testId="node-data-plane">
        {node.dataPlaneHealthy ? (
          <StatusDot tone="good">{m.node_data_plane_healthy()}</StatusDot>
        ) : (
          <StatusDot tone="bad">{m.nodes_unhealthy()}</StatusDot>
        )}
      </Fact>
      <Fact label={m.node_remote_address()} testId="node-remote-address">
        <span className="font-mono">{node.remoteAddress ?? "—"}</span>
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
          <Badge variant="destructive" data-testid="node-cert-expired">
            {m.node_cert_expired()}
          </Badge>
        ) : certLeft < CERT_WARN_MS ? (
          <Badge variant="outline" data-testid="node-cert-expiring">
            {m.node_cert_expiring()}
          </Badge>
        ) : null}
      </Fact>
    </dl>
  );
}

function NodeProbeSwitch({ node }: { node: Node }) {
  const queryClient = useQueryClient();
  const setProbe = useMutation(orpc.nodes.setProbe.mutationOptions());
  const hasRegion = !!node.regionName;
  return (
    <section className="flex flex-col gap-2">
      <SwitchField
        id={`node-probe-${node.id}`}
        label={m.node_probe_switch()}
        checked={node.probeEnabled}
        disabled={setProbe.isPending || (!hasRegion && !node.probeEnabled)}
        onCheckedChange={async (enabled) => {
          try {
            await setProbe.mutateAsync({ id: node.id, enabled });
            await queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
          } catch (error) {
            toast.error(errorMessage(error));
          }
        }}
        className="self-start"
        testId="node-probe-switch"
      />
      {hasRegion ? null : (
        <SafetyNote data-testid="node-probe-no-region">{m.node_probe_no_region()}</SafetyNote>
      )}
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
            <Badge variant="outline" data-testid="node-detail-dns-issue">
              {m.node_dns_no_public_address()}
            </Badge>
          ) : null}
        </h3>
        {editing ? null : (
          <Button
            size="sm"
            variant="outline"
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
        <div className="overflow-hidden rounded-2xl border" data-testid="node-addresses">
          <Table>
            <TableHeader className="bg-muted/60">
              <TableRow>
                <TableHead>{m.node_address_col_address()}</TableHead>
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
                      <TableCell className="font-mono text-xs">{a.address}</TableCell>
                      <TableCell>
                        <span className="flex items-center gap-1.5">
                          <Badge variant={a.level === 0 ? "secondary" : "outline"}>
                            {levelLabel(a.level)}
                          </Badge>
                          {inUse ? (
                            <Badge data-testid="node-address-in-use">
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
  const queryClient = useQueryClient();
  const save = useMutation(orpc.nodes.setAddresses.mutationOptions());
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
      await queryClient.invalidateQueries({ queryKey: orpc.nodes.key() });
      toast.success(m.common_saved());
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
              type="button"
              size="icon-sm"
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
          variant="outline"
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
        <Button type="button" variant="outline" onClick={onDone} disabled={pending !== null}>
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

/** CPU and memory of a node in the node list; "—" before it reports metrics. */
export function NodeLoad({ node }: { node: Node }) {
  const metrics = node.metrics;
  if (!metrics) return <span className="text-muted-foreground">—</span>;
  const memory = memoryPercent(metrics);
  const tone = (value: number | null) =>
    value === null ? "idle" : value >= 90 ? "bad" : value >= 75 ? "warn" : "good";
  return (
    <div className="flex flex-col gap-0.5 text-xs whitespace-nowrap" data-testid="node-load">
      <span className="flex items-center gap-1.5">
        <Dot tone={tone(metrics.cpuPercent)} small />
        {m.node_metrics_cpu()} {formatPercent(metrics.cpuPercent)}
      </span>
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <Dot tone={tone(memory)} small />
        {m.node_metrics_memory()} {memory === null ? "—" : formatPercent(memory)}
      </span>
    </div>
  );
}
