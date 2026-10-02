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
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
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
    <StatusDot tone="good" pulse data-testid="probe-online">
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
  const [action, setAction] = React.useState<ProbeAction | null>(null);
  const columns = React.useMemo<Columns<Probe>>(
    () => [
      {
        id: "name",
        header: () => m.probes_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <button
              type="button"
              className="w-fit text-left font-medium underline-offset-4 hover:underline"
              onClick={() => setAction({ kind: "results", probe: row.original })}
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
            <ProbeActions probe={row.original} onAction={setAction} />
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <div className="flex flex-col gap-4">
      {probes.isPending ? (
        <LoadingState />
      ) : probes.isLoadingError ? (
        <ErrorState error={probes.error} onRetry={() => probes.refetch()} />
      ) : probes.data.length === 0 ? (
        <EmptyState icon={Radar01Icon} title={m.probes_empty()}>
          <Button onClick={() => onAddOpenChange(true)}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.probes_add()}
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          data={probes.data}
          columns={columns}
          getRowId={(p) => p.id}
          testId="probes-table"
        />
      )}
      <ProbeSettingsCard />
      <AddProbeDialog key={addKey} open={addOpen} onOpenChange={onAddOpenChange} />
      {action?.kind === "rename" ? (
        <RenameProbeDialog probe={action.probe} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === "delete" ? (
        <DeleteProbeDialog probe={action.probe} onClose={() => setAction(null)} />
      ) : null}
      {action?.kind === "results" ? (
        <ProbeResultsDialog probe={action.probe} onClose={() => setAction(null)} />
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
  // Closing forgets the token: it is shown once.
  const setOpen = (next: boolean) => {
    if (!next) {
      setResult(null);
      create.reset();
    }
    onOpenChange(next);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
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
                  <Countdown target={result.expiresAt} className="text-foreground" />
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
                <code className="rounded-xl bg-muted p-2 font-mono text-xs break-all">
                  {result.serverUrl}
                </code>
              </Field>
              <Field>
                <FieldLabel>{m.enroll_ca_fingerprint()}</FieldLabel>
                <code className="rounded-xl bg-muted p-2 font-mono text-xs break-all">
                  {result.caSha256}
                </code>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <Button onClick={() => setOpen(false)} data-testid="probe-token-close">
                {m.common_close()}
              </Button>
            </DialogFooter>
          </div>
        ) : regions.isPending ? (
          <LoadingState />
        ) : regions.isLoadingError ? (
          <ErrorState error={regions.error} onRetry={() => regions.refetch()} />
        ) : (
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
                  options={regionList.map((r) => ({ value: r.id, label: `${r.name} (${r.code})` }))}
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
      </DialogContent>
    </Dialog>
  );
}

function RenameProbeDialog({ probe, onClose }: { probe: Probe; onClose: () => void }) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.probes.update.mutationOptions());
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
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
        onClose();
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

function DeleteProbeDialog({ probe, onClose }: { probe: Probe; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.probes.delete.mutationOptions());
  return (
    <ControlledConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.probes_delete_confirm({ name: probe.name })}
      onConfirm={async () => {
        await remove.mutateAsync({ id: probe.id });
        await queryClient.invalidateQueries();
        toast.success(m.common_deleted());
      }}
    />
  );
}

function ProbeResultsDialog({ probe, onClose }: { probe: Probe; onClose: () => void }) {
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
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
  if (results.isPending) return <LoadingState />;
  if (results.isLoadingError)
    return <ErrorState error={results.error} onRetry={() => results.refetch()} />;
  if (!results.data.length)
    return <EmptyState icon={Radar01Icon} title={m.probes_results_empty()} />;
  const rows = [...results.data].sort((a, b) =>
    (by === "node" ? a.nodeName : a.proberName).localeCompare(
      by === "node" ? b.nodeName : b.proberName,
    ),
  );
  return (
    <div className="overflow-hidden rounded-2xl border" data-testid={testId}>
      <Table>
        <TableHeader className="bg-muted/60">
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
      style={{ animationDelay: `${Math.min(index, 12) * 30}ms` }}
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
          <Badge variant="secondary" className="uppercase">
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

/** Interval, timeout and attempts of the probes, and when an address counts as down or up. */
export function ProbeSettingsCard() {
  const query = useQuery(orpc.settings.probes.queryOptions());
  return (
    <Card className="animate-enter" style={{ animationDelay: "120ms" }}>
      <CardHeader>
        <CardTitle>{m.probes_settings_title()}</CardTitle>
      </CardHeader>
      {query.isPending ? (
        <CardContent>
          <LoadingState />
        </CardContent>
      ) : query.isLoadingError ? (
        <CardContent>
          <ErrorState error={query.error} onRetry={() => query.refetch()} />
        </CardContent>
      ) : (
        <ProbeSettingsForm key={JSON.stringify(query.data)} initial={query.data} />
      )}
    </Card>
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

type SettingsDraft = Record<keyof ProbeSettings, string>;
const toDraft = (s: ProbeSettings): SettingsDraft => ({
  intervalSeconds: String(s.intervalSeconds),
  timeoutMs: String(s.timeoutMs),
  attempts: String(s.attempts),
  lossPercent: String(s.lossPercent),
  ipDownSeconds: String(s.ipDownSeconds),
  ipUpSeconds: String(s.ipUpSeconds),
});

function ProbeSettingsForm({ initial }: { initial: ProbeSettings }) {
  const queryClient = useQueryClient();
  const save = useMutation(orpc.settings.setProbes.mutationOptions());
  const [draft, setDraft] = React.useState(() => toDraft(initial));
  const [error, setError] = React.useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(toDraft(initial));
  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        const values = Object.fromEntries(
          Object.entries(draft).map(([key, value]) => [key, Number(value)]),
        ) as ProbeSettings;
        if (values.timeoutMs > values.intervalSeconds * 1000) {
          setError(m.probes_settings_timeout_too_long());
          return;
        }
        try {
          await save.mutateAsync(values);
          await queryClient.invalidateQueries({ queryKey: orpc.settings.probes.key() });
          toast.success(m.common_saved());
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {SETTINGS_FIELDS.map((field) => (
          <NumberField
            key={field.key}
            id={`probe-settings-${field.key}`}
            label={field.label()}
            value={draft[field.key]}
            onChange={(value) => setDraft({ ...draft, [field.key]: value })}
            min={field.min}
            max={field.max}
            step={1}
            required
            testId={`probe-settings-${field.key}`}
          />
        ))}
      </CardContent>
      <SaveBar dirty={dirty} pending={save.isPending} error={error} testId="probe-settings-save" />
    </form>
  );
}
