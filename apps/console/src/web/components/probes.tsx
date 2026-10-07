import type { Probe, ProbeResultDto, ProbeSettings, ProbeTokenResult } from "@edgeweir/contract";
import { Add01Icon, MoreHorizontalIcon, Radar01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { Countdown } from "@/components/appica/countdown";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { enterDelay } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { SettingsCard } from "@/components/settings-card";
import { NumberField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
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
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { useOpenKey } from "@/hooks/use-open-key";
import { formatDateTime, formatPercent, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

const PROBE_ERRORS: Record<string, () => string> = {
  timeout: () => m.probe_error_timeout(),
  refused: () => m.probe_error_refused(),
  reset: () => m.probe_error_reset(),
  tls: () => m.probe_error_tls(),
  status: () => m.probe_error_status(),
  unreachable: () => m.probe_error_unreachable(),
};
/** A probe failure code in words; unknown codes as they are. */
export const probeErrorLabel = (code: string) => (code ? (PROBE_ERRORS[code]?.() ?? code) : "");

function ProbeStatus({ probe }: { probe: Probe }) {
  if (!probe.enabled)
    return (
      <StatusDot tone="idle" data-testid="probe-disabled">
        {m.nodes_disabled()}
      </StatusDot>
    );
  if (!probe.enrolledAt)
    return (
      <StatusDot tone="idle" data-testid="probe-pending">
        {m.probes_pending()}
      </StatusDot>
    );
  return probe.online ? (
    <StatusDot tone="good" glow data-testid="probe-online">
      {m.nodes_online()}
    </StatusDot>
  ) : (
    <StatusDot tone="bad" data-testid="probe-offline">
      {m.nodes_offline()}
    </StatusDot>
  );
}

type ProbeAction = { kind: "rename" | "delete" | "results"; probe: Probe };

/**
 * The row menu. A component of its own: column templates are plain
 * functions (DataTable) and hold no hooks.
 */
function ProbeActions({
  probe,
  onAction,
}: {
  probe: Probe;
  onAction: (action: ProbeAction) => void;
}) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.probes.update.mutationOptions());
  const toggle = async () => {
    try {
      await update.mutateAsync({ id: probe.id, enabled: !probe.enabled });
      await queryClient.invalidateQueries({ queryKey: orpc.probes.key() });
    } catch (error) {
      toast.error(errorMessage(error));
    }
  };
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={m.common_actions()}
            data-testid="probe-actions"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => onAction({ kind: "results", probe })}
          data-testid="probe-results"
        >
          {m.probes_results()}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onAction({ kind: "rename", probe })}
          data-testid="probe-rename"
        >
          {m.nodes_rename()}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={toggle} data-testid="probe-toggle">
          {probe.enabled ? m.nodes_disable() : m.nodes_enable()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onAction({ kind: "delete", probe })}
          data-testid="probe-delete"
        >
          {m.common_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The probes tab: every probe with its region, state and last round, and the probe settings. */
export function ProbesPanel({
  addOpen,
  onAddOpenChange,
}: {
  addOpen: boolean;
  onAddOpenChange: (open: boolean) => void;
}) {
  const addKey = useOpenKey(addOpen);
  const probes = useQuery({
    ...orpc.probes.list.queryOptions(),
    refetchInterval: 5_000,
    meta: { background: true },
  });
  const action = useDialogState<ProbeAction>();
  const columns = React.useMemo<Columns<Probe>>(
    () => [
      {
        id: "name",
        header: () => m.probes_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <button
              type="button"
              className="w-fit rounded-sm text-left font-medium underline-offset-4 outline-none focus-lit hover:underline"
              onClick={() => action.show({ kind: "results", probe: row.original })}
              data-testid="probe-name"
            >
              {row.original.name}
            </button>
            {row.original.hostname ? (
              <span className="text-xs text-muted-foreground">{row.original.hostname}</span>
            ) : null}
          </div>
        ),
      },
      {
        id: "region",
        header: () => m.node_groups_region(),
        cell: ({ row }) => (
          <Badge variant="secondary" data-testid="probe-region">
            {row.original.regionName} · {row.original.regionCode}
          </Badge>
        ),
      },
      {
        id: "status",
        header: () => m.nodes_col_status(),
        cell: ({ row }) => <ProbeStatus probe={row.original} />,
      },
      {
        id: "lastSeen",
        header: () => m.probes_col_last_seen(),
        cell: ({ row }) => (
          <span
            className="text-xs whitespace-nowrap text-muted-foreground"
            title={row.original.lastSeenAt ? formatDateTime(row.original.lastSeenAt) : undefined}
          >
            {timeAgo(row.original.lastSeenAt)}
          </span>
        ),
      },
      {
        id: "version",
        header: () => m.probes_col_version(),
        cell: ({ row }) => (
          <div className="flex flex-col text-xs text-muted-foreground">
            <span>{row.original.agentVersion || "—"}</span>
            {row.original.os ? (
              <span>
                {row.original.os}/{row.original.arch}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "round",
        header: () => m.probes_col_round(),
        cell: ({ row }) => {
          const round = row.original.lastRound;
          if (!round) return <span className="text-muted-foreground">—</span>;
          return (
            <div className="flex flex-col gap-0.5 text-xs" data-testid="probe-round">
              <span className="whitespace-nowrap">
                <span
                  className={cn(round.lossPercent > 0 && "text-destructive")}
                  data-testid="probe-loss"
                >
                  {m.probes_loss({ loss: formatPercent(round.lossPercent) })}
                </span>
                {round.avgRttMs !== null ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span data-testid="probe-rtt">
                      {m.probes_rtt({ rtt: Math.round(round.avgRttMs) })}
                    </span>
                  </>
                ) : null}
              </span>
              {round.failed > 0 ? (
                <span className="text-destructive">
                  {m.probes_failed_targets({ count: round.failed })}
                </span>
              ) : (
                <span className="text-muted-foreground" title={formatDateTime(round.checkedAt)}>
                  {timeAgo(round.checkedAt)}
                </span>
              )}
            </div>
          );
        },
      },
      {
        id: "targets",
        header: () => m.probes_col_targets(),
        cell: ({ row }) => (
          <span className="tabular-nums" data-testid="probe-targets">
            {row.original.targets}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <ProbeActions probe={row.original} onAction={action.show} />
          </div>
        ),
      },
    ],
    [action.show],
  );

  return (
    <div className="flex flex-col gap-6">
      <QueryView
        query={probes}
        empty={
          <EmptyState icon={Radar01Icon} title={m.probes_empty()}>
            <Button onClick={() => onAddOpenChange(true)}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.probes_add()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          <DataTable
            data={list}
            columns={columns}
            getRowId={(p) => p.id}
            testId="probes-table"
            pinFirstColumn
          />
        )}
      </QueryView>
      <ProbeMatrixCard />
      <ProbeSettingsCard />
      <AddProbeDialog key={`add-${addKey}`} open={addOpen} onOpenChange={onAddOpenChange} />
      {action.value ? (
        <ProbeActionDialog
          key={`action-${action.key}`}
          action={action.value}
          open={action.open}
          onOpenChange={action.onOpenChange}
        />
      ) : null}
    </div>
  );
}

const TTL_OPTIONS = [15, 60, 24 * 60];
const ttlLabel = (minutes: number) =>
  minutes < 60
    ? m.enroll_ttl_minutes({ count: minutes })
    : m.enroll_ttl_hours({ count: minutes / 60 });

/** A one-time token for a new probe in a region, shown once with the command that starts it. */
function AddProbeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const regions = useQuery({ ...orpc.regions.list.queryOptions(), enabled: open });
  const create = useMutation(orpc.probes.createToken.mutationOptions());
  const [regionId, setRegionId] = React.useState("");
  const [ttl, setTtl] = React.useState(60);
  const [result, setResult] = React.useState<ProbeTokenResult | null>(null);
  const regionList = regions.data ?? [];
  const selectedRegion = regionList.some((r) => r.id === regionId)
    ? regionId
    : (regionList[0]?.id ?? "");
  // The token is shown once: forgotten once the dialog has closed, not while it closes.
  const forget = (isOpen: boolean) => {
    if (isOpen) return;
    setResult(null);
    create.reset();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={forget}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{m.probes_add()}</DialogTitle>
        </DialogHeader>
        {result ? (
          <div className="flex flex-col gap-4" data-testid="probe-token-result">
            <FieldGroup>
              <Field>
                <FieldLabel>{m.probes_command()}</FieldLabel>
                <CodeBlock value={result.command} testId="probe-command" />
                {/* The countdown renders a <div>, which a SafetyNote <p> cannot hold. */}
                <div className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
                  <span title={formatDateTime(result.expiresAt)}>{m.enroll_expires_in()}</span>
                  <Countdown
                    target={result.expiresAt}
                    className="rounded-md bg-wash px-1.5 text-foreground"
                  />
                  <span aria-hidden="true">·</span>
                  <SafetyNote data-testid="probe-token-once">{m.enroll_shown_once()}</SafetyNote>
                </div>
              </Field>
              <Field>
                <FieldLabel>{m.probes_token()}</FieldLabel>
                <CodeBlock value={result.token} testId="probe-token" />
              </Field>
              <Field>
                <FieldLabel>{m.system_node_api_url()}</FieldLabel>
                <code className="rounded-xl px-3 py-2 font-mono text-xs break-all sunk-well">
                  {result.serverUrl}
                </code>
              </Field>
              <Field>
                <FieldLabel>{m.enroll_ca_fingerprint()}</FieldLabel>
                <code className="rounded-xl px-3 py-2 font-mono text-xs leading-relaxed break-all sunk-well">
                  {result.caSha256}
                </code>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} data-testid="probe-token-close">
                {m.common_close()}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <QueryView query={regions}>
            {() => (
              <form
                onSubmit={async (event) => {
                  event.preventDefault();
                  const data = new FormData(event.currentTarget);
                  try {
                    setResult(
                      await create.mutateAsync({
                        name: String(data.get("probeName") ?? "").trim(),
                        regionId: selectedRegion,
                        ttlMinutes: ttl,
                      }),
                    );
                  } catch {
                    // rendered below via create.error
                  }
                }}
              >
                <FieldGroup>
                  <Field>
                    <FieldLabel htmlFor="probeName">{m.probes_name()}</FieldLabel>
                    <Input
                      id="probeName"
                      name="probeName"
                      required
                      maxLength={64}
                      placeholder="probe-sh-01"
                      data-testid="probe-name-input"
                    />
                  </Field>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <FormSelect
                      id="probe-region"
                      label={m.node_groups_region()}
                      value={selectedRegion}
                      options={regionList.map((r) => ({
                        value: r.id,
                        label: `${r.name} (${r.code})`,
                      }))}
                      onChange={setRegionId}
                      disabled={!regionList.length}
                      testId="probe-region-select"
                    />
                    <FormSelect
                      id="probe-ttl"
                      label={m.enroll_ttl()}
                      value={String(ttl)}
                      options={TTL_OPTIONS.map((v) => ({ value: String(v), label: ttlLabel(v) }))}
                      onChange={(value) => setTtl(Number(value))}
                    />
                  </div>
                  {regionList.length ? null : (
                    <SafetyNote data-testid="probe-no-regions">{m.probes_no_regions()}</SafetyNote>
                  )}
                  {create.isError ? <FieldError>{errorMessage(create.error)}</FieldError> : null}
                  <DialogFooter>
                    <Button
                      type="submit"
                      disabled={create.isPending || !selectedRegion}
                      data-testid="probe-generate"
                    >
                      {create.isPending ? <Spinner /> : null}
                      {m.probes_generate()}
                    </Button>
                  </DialogFooter>
                </FieldGroup>
              </form>
            )}
          </QueryView>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** The dialog of a probe menu action. */
function ProbeActionDialog({ action, ...dialog }: { action: ProbeAction } & DialogProps) {
  switch (action.kind) {
    case "rename":
      return <RenameProbeDialog probe={action.probe} {...dialog} />;
    case "delete":
      return <DeleteProbeDialog probe={action.probe} {...dialog} />;
    case "results":
      return <ProbeResultsDialog probe={action.probe} {...dialog} />;
  }
}

function RenameProbeDialog({ probe, open, onOpenChange }: { probe: Probe } & DialogProps) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.probes.update.mutationOptions());
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.nodes_rename()}
      submitLabel={m.common_save()}
      submitTestId="probe-rename-submit"
      onSubmit={async (data) => {
        await update.mutateAsync({
          id: probe.id,
          name: String(data.get("probeNewName") ?? "").trim(),
        });
        await queryClient.invalidateQueries({ queryKey: orpc.probes.key() });
        toast.success(m.common_saved());
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="probeNewName">{m.probes_name()}</FieldLabel>
        <Input
          id="probeNewName"
          name="probeNewName"
          required
          maxLength={64}
          defaultValue={probe.name}
        />
      </Field>
    </FormDialog>
  );
}

function DeleteProbeDialog({ probe, open, onOpenChange }: { probe: Probe } & DialogProps) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.probes.delete.mutationOptions());
  return (
    <ControlledConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.probes_delete_confirm({ name: probe.name })}
      onConfirm={async () => {
        await remove.mutateAsync({ id: probe.id });
        await queryClient.invalidateQueries();
        toast.success(m.common_deleted());
      }}
    />
  );
}

function ProbeResultsDialog({ probe, open, onOpenChange }: { probe: Probe } & DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.probes_results_title({ name: probe.name })}</DialogTitle>
        </DialogHeader>
        <ProbeResults input={{ probeId: probe.id }} by="node" testId="probe-results-table" />
      </DialogContent>
    </Dialog>
  );
}

/**
 * The latest result per target: by node (a probe's targets) or by prober (who
 * measured a node). Polls while open.
 */
export function ProbeResults({
  input,
  by,
  testId,
}: {
  input: { probeId?: string; nodeId?: string };
  by: "node" | "prober";
  testId: string;
}) {
  const results = useQuery({
    ...orpc.probes.results.queryOptions({ input }),
    refetchInterval: 10_000,
    meta: { background: true },
  });
  return (
    <QueryView
      query={results}
      empty={<EmptyState icon={Radar01Icon} title={m.probes_results_empty()} />}
    >
      {(list) => (
        <ResultsTable
          rows={[...list].sort((a, b) =>
            (by === "node" ? a.nodeName : a.proberName).localeCompare(
              by === "node" ? b.nodeName : b.proberName,
            ),
          )}
          by={by}
          testId={testId}
        />
      )}
    </QueryView>
  );
}

function ResultsTable({
  rows,
  by,
  testId,
}: {
  rows: ProbeResultDto[];
  by: "node" | "prober";
  testId: string;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border border-edge" data-testid={testId}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{by === "node" ? m.nodes_col_name() : m.probes_col_prober()}</TableHead>
            <TableHead>{m.probes_col_address()}</TableHead>
            <TableHead>{m.probes_col_loss()}</TableHead>
            <TableHead>{m.probes_col_rtt()}</TableHead>
            <TableHead>{m.probes_col_error()}</TableHead>
            <TableHead>{m.probes_col_checked()}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((r, index) => (
            <ResultRow key={resultKey(r)} result={r} by={by} index={index} />
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

const resultKey = (r: ProbeResultDto) =>
  `${r.proberKind}:${r.proberId}:${r.nodeId}:${r.address}:${r.port}`;

function ResultRow({
  result: r,
  by,
  index,
}: {
  result: ProbeResultDto;
  by: "node" | "prober";
  index: number;
}) {
  const failed = r.sent > 0 && r.lost === r.sent;
  return (
    <TableRow
      className="animate-enter"
      style={enterDelay(index)}
      data-testid="probe-result-row"
      data-node={r.nodeName}
      data-prober={r.proberName}
    >
      <TableCell className="align-top">
        {by === "node" ? (
          <span className="font-medium">{r.nodeName}</span>
        ) : (
          <div className="flex flex-col gap-0.5">
            <span className="flex items-center gap-1.5 font-medium">
              {r.proberName}
              {r.proberKind === "node" ? (
                <Badge variant="outline">{m.probes_prober_node()}</Badge>
              ) : null}
            </span>
            {r.regionName ? (
              <span className="text-xs text-muted-foreground">{r.regionName}</span>
            ) : null}
          </div>
        )}
      </TableCell>
      <TableCell className="align-top">
        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs whitespace-nowrap">
            {r.address.includes(":") ? `[${r.address}]` : r.address}:{r.port}
          </span>
          <Badge variant="secondary" className="font-mono uppercase">
            {r.method}
          </Badge>
        </div>
      </TableCell>
      <TableCell className="align-top">
        <StatusDot tone={failed ? "bad" : r.lost > 0 ? "warn" : "good"} data-testid="result-loss">
          {formatPercent(r.lossPercent)}
        </StatusDot>
      </TableCell>
      <TableCell className="align-top tabular-nums">
        {r.sent > r.lost ? m.probes_rtt({ rtt: r.rttMs }) : "—"}
      </TableCell>
      <TableCell className="align-top text-xs text-muted-foreground">
        {probeErrorLabel(r.error) || "—"}
      </TableCell>
      <TableCell className="align-top text-xs whitespace-nowrap text-muted-foreground">
        <span title={formatDateTime(r.checkedAt)}>{timeAgo(r.checkedAt)}</span>
      </TableCell>
    </TableRow>
  );
}

/**
 * RTT bands of the latency matrix (ms): one hue (the metric blue), lighter to darker. The value is
 * printed in every cell, so the fill never carries it alone; text stays foreground (AA on the
 * darkest band in both themes).
 */
const RTT_BANDS = [
  { below: 30, label: "< 30", className: "bg-metric/12" },
  { below: 80, label: "30–80", className: "bg-metric/26" },
  { below: 150, label: "80–150", className: "bg-metric/40" },
  { below: 250, label: "150–250", className: "bg-metric/55" },
  { below: Number.POSITIVE_INFINITY, label: "≥ 250", className: "bg-metric/70" },
] as const;

const bandOf = (rtt: number) => RTT_BANDS.find((band) => rtt < band.below) ?? RTT_BANDS[4];

interface MatrixProber {
  key: string;
  name: string;
  kind: ProbeResultDto["proberKind"];
  region: string | null;
}

interface MatrixCell {
  /** Median RTT of the targets that answered; null when none did. */
  rtt: number | null;
  /** Lost attempts / sent attempts over the node's targets, in percent. */
  lossPercent: number;
  /** Every target of the node lost every attempt. */
  failed: boolean;
  checkedAt: string;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
};

/** Probers × nodes from the latest result per target (addresses and ports of a node folded). */
function matrixOf(results: ProbeResultDto[]) {
  const probers = new Map<string, MatrixProber>();
  const nodes = new Map<string, string>();
  const groups = new Map<string, ProbeResultDto[]>();
  for (const r of results) {
    const key = `${r.proberKind}:${r.proberId}`;
    if (!probers.has(key))
      probers.set(key, { key, name: r.proberName, kind: r.proberKind, region: r.regionName });
    nodes.set(r.nodeId, r.nodeName);
    const cell = `${key}|${r.nodeId}`;
    groups.set(cell, [...(groups.get(cell) ?? []), r]);
  }
  const cells = new Map<string, MatrixCell>();
  for (const [key, rows] of groups) {
    const sent = rows.reduce((sum, r) => sum + r.sent, 0);
    const lost = rows.reduce((sum, r) => sum + r.lost, 0);
    const answered = rows.filter((r) => r.lost < r.sent);
    cells.set(key, {
      rtt: answered.length ? Math.round(median(answered.map((r) => r.rttMs))) : null,
      lossPercent: sent ? (lost / sent) * 100 : 0,
      failed: sent > 0 && answered.length === 0,
      checkedAt: rows.reduce((last, r) => (r.checkedAt > last ? r.checkedAt : last), ""),
    });
  }
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  return {
    // Probes first, then the nodes that also probe.
    probers: [...probers.values()].sort((a, b) =>
      a.kind === b.kind ? byName(a.name, b.name) : a.kind === "probe" ? -1 : 1,
    ),
    nodes: [...nodes].map(([id, name]) => ({ id, name })).sort((a, b) => byName(a.name, b.name)),
    cells,
  };
}

/**
 * The latest round as a heat matrix: who probed (rows) × which node (columns), each cell the
 * median RTT of the node's targets in a blue band, a warning dot for partial loss and the loss in
 * red where nothing answered. The API keeps the latest result per target only, so this is one
 * round, not a time series. A real table, so screen readers get row and column headers and every
 * value; polls like the probe results. Hidden while there are no results.
 */
function ProbeMatrixCard() {
  const results = useQuery({
    ...orpc.probes.results.queryOptions({ input: {} }),
    refetchInterval: 10_000,
    meta: { background: true },
  });
  // Nothing measured yet: the probe list says so (its empty state or its pending rows).
  if (results.data?.length === 0) return null;
  return (
    <Card className="animate-enter" style={{ animationDelay: "60ms" }} data-testid="probe-matrix">
      <CardHeader>
        <CardTitle>{m.probes_col_round()}</CardTitle>
      </CardHeader>
      <QueryView query={results} frame={CardContent}>
        {(rows) => <ProbeMatrix results={rows} />}
      </QueryView>
    </Card>
  );
}

function ProbeMatrix({ results }: { results: ProbeResultDto[] }) {
  const { probers, nodes, cells } = React.useMemo(() => matrixOf(results), [results]);
  return (
    <CardContent className="flex flex-col gap-4">
      <div className="-mx-(--card-spacing) overflow-x-auto px-(--card-spacing) [scrollbar-width:thin]">
        <table className="w-max min-w-full border-separate border-spacing-0.5 text-xs">
          <caption className="sr-only">{m.probes_col_round()}</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="sticky left-0 z-10 bg-card pr-3 pb-1.5 text-left font-medium text-muted-foreground"
              >
                {m.probes_col_prober()}
              </th>
              {nodes.map((node) => (
                <th
                  key={node.id}
                  scope="col"
                  className="px-1 pb-1.5 text-center font-medium whitespace-nowrap text-muted-foreground"
                >
                  {node.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {probers.map((prober, index) => (
              <tr
                key={prober.key}
                className="animate-enter"
                style={enterDelay(index)}
                data-testid="probe-matrix-row"
              >
                <th
                  scope="row"
                  className="sticky left-0 z-10 bg-card py-0.5 pr-3 text-left font-normal whitespace-nowrap"
                >
                  <span className="flex items-center gap-1.5 text-sm font-medium">
                    {prober.name}
                    {prober.kind === "node" ? (
                      <Badge variant="outline">{m.probes_prober_node()}</Badge>
                    ) : null}
                  </span>
                  {prober.region ? (
                    <span className="block text-muted-foreground">{prober.region}</span>
                  ) : null}
                </th>
                {nodes.map((node) => (
                  <MatrixValue
                    key={node.id}
                    cell={cells.get(`${prober.key}|${node.id}`)}
                    title={`${prober.name} → ${node.name}`}
                  />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <MatrixLegend />
    </CardContent>
  );
}

function MatrixValue({ cell, title }: { cell: MatrixCell | undefined; title: string }) {
  const base =
    "relative h-10 min-w-16 rounded-lg border border-transparent px-2 text-center align-middle font-medium whitespace-nowrap tabular-nums";
  if (!cell) return <td className={cn(base, "font-normal text-muted-foreground")}>—</td>;
  const loss = m.probes_loss({ loss: formatPercent(cell.lossPercent) });
  const details = [
    title,
    cell.rtt !== null ? m.probes_rtt({ rtt: cell.rtt }) : probeErrorLabel("unreachable"),
    loss,
    timeAgo(cell.checkedAt),
  ].join(" · ");
  if (cell.failed || cell.rtt === null)
    return (
      <td
        className={cn(base, "bg-tint-destructive text-destructive")}
        title={details}
        data-testid="probe-matrix-cell"
        data-state="failed"
      >
        {formatPercent(cell.lossPercent)}
        <span className="sr-only">{`, ${probeErrorLabel("unreachable")}`}</span>
      </td>
    );
  return (
    <td
      className={cn(base, bandOf(cell.rtt).className)}
      title={details}
      data-testid="probe-matrix-cell"
      data-state={cell.lossPercent > 0 ? "loss" : "ok"}
    >
      {cell.rtt}
      {cell.lossPercent > 0 ? (
        <>
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 size-1.5 rounded-full border border-transparent bg-state-warn"
          />
          <span className="sr-only">{`, ${loss}`}</span>
        </>
      ) : null}
    </td>
  );
}

/** What the fills, the dot and the red cells mean. */
function MatrixLegend() {
  const swatch =
    "inline-block h-3 w-5 shrink-0 rounded-sm border border-transparent ring-1 ring-edge ring-inset";
  return (
    <ul
      className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted-foreground"
      data-testid="probe-matrix-legend"
    >
      <li className="font-medium text-foreground">{m.probes_col_rtt()}</li>
      {RTT_BANDS.map((band) => (
        <li key={band.label} className="flex items-center gap-1.5 tabular-nums">
          <span aria-hidden="true" className={cn(swatch, band.className)} />
          {m.probes_rtt({ rtt: band.label })}
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="inline-block size-1.5 rounded-full border border-transparent bg-state-warn"
        />
        {m.probes_col_loss()}
      </li>
      <li className="flex items-center gap-1.5">
        <span aria-hidden="true" className={cn(swatch, "bg-tint-destructive")} />
        {probeErrorLabel("unreachable")}
      </li>
    </ul>
  );
}

const SETTINGS_FIELDS: {
  key: keyof ProbeSettings;
  label: () => string;
  min: number;
  max: number;
}[] = [
  { key: "intervalSeconds", label: () => m.probes_settings_interval(), min: 5, max: 60 },
  { key: "timeoutMs", label: () => m.probes_settings_timeout(), min: 500, max: 10000 },
  { key: "attempts", label: () => m.probes_settings_attempts(), min: 1, max: 10 },
  { key: "lossPercent", label: () => m.probes_settings_loss(), min: 1, max: 100 },
  { key: "ipDownSeconds", label: () => m.probes_settings_down(), min: 5, max: 3600 },
  { key: "ipUpSeconds", label: () => m.probes_settings_up(), min: 5, max: 3600 },
];

/** Interval, timeout and attempts of the probes, and when an address counts as down or up. */
export function ProbeSettingsCard() {
  return (
    <SettingsCard
      title={m.probes_settings_title()}
      className="animate-enter"
      style={{ animationDelay: "120ms" }}
      query={orpc.settings.probes.queryOptions()}
      mutation={orpc.settings.setProbes.mutationOptions()}
      toDraft={(s) =>
        Object.fromEntries(SETTINGS_FIELDS.map(({ key }) => [key, String(s[key])])) as Record<
          keyof ProbeSettings,
          string
        >
      }
      toInput={(d) =>
        Object.fromEntries(SETTINGS_FIELDS.map(({ key }) => [key, Number(d[key])])) as ProbeSettings
      }
      check={(s) =>
        s.timeoutMs > s.intervalSeconds * 1000 ? m.probes_settings_timeout_too_long() : null
      }
      contentClassName="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3"
      saveTestId="probe-settings-save"
    >
      {({ draft, set }) =>
        SETTINGS_FIELDS.map((field) => (
          <NumberField
            key={field.key}
            id={`probe-settings-${field.key}`}
            label={field.label()}
            value={draft[field.key]}
            onChange={(value) => set({ [field.key]: value })}
            min={field.min}
            max={field.max}
            step={1}
            required
            testId={`probe-settings-${field.key}`}
          />
        ))
      }
    </SettingsCard>
  );
}
