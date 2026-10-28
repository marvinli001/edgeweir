import {
  type Site,
  USAGE_GUARD_MAX_BPS,
  USAGE_GUARD_MIN_BPS,
  type UsageGuard,
  type UsageGuardAction,
  type UsageGuardMetric,
  type UsageGuardPeriod,
  type UsageGuardSettings,
  validTimeZone,
} from "@edgeweir/contract";
import { Delete02Icon, Edit02Icon, Shield01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Meter } from "@/components/appica/meter";
import { Alert } from "@/components/arc/alert/alert";
import { Button } from "@/components/arc/button/button";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect, type Option } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatBitRate,
  formatBytes,
  formatCompact,
  formatDateMinutes,
  formatPercent,
  m,
} from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const GB = 1e9;
const MBPS = 1e6;

const metricLabel = (metric: UsageGuardMetric) =>
  ({
    bytes: m.usage_guard_metric_bytes,
    requests: m.usage_guard_metric_requests,
    bandwidth: m.usage_guard_metric_bandwidth,
  })[metric]();

/**
 * A site's usage protection (usageGuard.get, polled every minute): each limit with the period's
 * usage and a meter that turns at the warning threshold, the action the guard holds with a
 * restore button, and a dialog that edits or removes the settings.
 */
export function UsageGuardCard({ site }: { site: Site }) {
  const query = useQuery(
    orpc.usageGuard.get.queryOptions({
      input: { id: site.id },
      refetchInterval: 60_000,
      meta: { background: true },
    }),
  );
  const [editing, setEditing] = React.useState(false);
  const guard = query.data;
  return (
    <Card
      className="animate-enter"
      style={{ animationDelay: "60ms" }}
      data-testid="usage-guard-card"
    >
      <CardHeader>
        <CardTitle>{m.usage_guard_title()}</CardTitle>
        {guard?.settings ? (
          <CardAction className="flex gap-1">
            <Button
              className="icon-button"
              size="sm"
              variant="ghost"
              aria-label={m.common_edit()}
              onClick={() => setEditing(true)}
              data-testid="usage-guard-edit"
            >
              <HugeiconsIcon icon={Edit02Icon} strokeWidth={2} />
            </Button>
            <DeleteButton guard={guard} />
          </CardAction>
        ) : null}
      </CardHeader>
      <QueryView
        query={query}
        frame={CardContent}
        isEmpty={(data) => data.settings === null}
        empty={
          <CardContent>
            <EmptyState compact title={m.usage_guard_empty()} icon={Shield01Icon} art="checkpoint">
              <Button onClick={() => setEditing(true)} data-testid="usage-guard-setup">
                {m.usage_guard_setup()}
              </Button>
            </EmptyState>
          </CardContent>
        }
      >
        {(data) => <UsageGuardBody site={site} guard={data} />}
      </QueryView>
      {editing && guard ? (
        <UsageGuardDialog open onOpenChange={setEditing} siteId={site.id} guard={guard} />
      ) : null}
    </Card>
  );
}

function UsageGuardBody({ site, guard }: { site: Site; guard: UsageGuard }) {
  const { settings, usage, period } = guard;
  if (!settings || !usage || !period) return null;
  const rows: { metric: UsageGuardMetric; used: number; limit: number; text: string }[] = [];
  if (settings.bytesLimit !== null) {
    const used = Number(usage.bytes);
    const limit = Number(settings.bytesLimit);
    rows.push({
      metric: "bytes",
      used,
      limit,
      text: m.usage_guard_of({ used: formatBytes(used), limit: formatBytes(limit) }),
    });
  }
  if (settings.requestsLimit !== null) {
    const used = Number(usage.requests);
    const limit = Number(settings.requestsLimit);
    rows.push({
      metric: "requests",
      used,
      limit,
      text: m.usage_guard_of({ used: formatCompact(used), limit: formatCompact(limit) }),
    });
  }
  if (settings.bandwidthBps !== null)
    rows.push({
      metric: "bandwidth",
      used: usage.bandwidthBps,
      limit: settings.bandwidthBps,
      text: m.usage_guard_of({
        used: formatBitRate(usage.bandwidthBps / 8),
        limit: formatBitRate(settings.bandwidthBps / 8),
      }),
    });
  const warn = settings.warnPercent ?? 100 - 2 ** -46;
  return (
    <CardContent className="flex flex-col gap-4">
      {guard.held ? <HeldAlert site={site} guard={guard} /> : null}
      {guard.pausedUntil ? (
        <SafetyNote data-testid="usage-guard-paused">
          {m.usage_guard_paused({ time: formatDateMinutes(guard.pausedUntil) })}
        </SafetyNote>
      ) : null}
      {guard.lastError ? <SafetyNote>{m.usage_guard_action_failed()}</SafetyNote> : null}
      <dl className="flex flex-col gap-3">
        {rows.map((row) => {
          const percent = row.limit > 0 ? (row.used / row.limit) * 100 : 0;
          return (
            <div
              key={row.metric}
              className="flex flex-col gap-1.5"
              data-testid={`usage-guard-${row.metric}`}
            >
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <dt className="text-muted-foreground">{metricLabel(row.metric)}</dt>
                <dd className="tabular-nums">
                  {row.text}
                  <span className="ml-2 text-muted-foreground">{formatPercent(percent)}</span>
                </dd>
              </div>
              <Meter
                value={Math.min(100, percent)}
                low={warn}
                high={100 - 2 ** -46}
                label={`${metricLabel(row.metric)} ${formatPercent(percent)}`}
              />
              {row.metric === "bandwidth" ? (
                <span className="text-xs text-muted-foreground tabular-nums">
                  {m.usage_guard_peak({ value: formatBitRate(usage.bandwidthPeakBps / 8) })}
                </span>
              ) : null}
            </div>
          );
        })}
      </dl>
      <p className="text-xs text-muted-foreground" data-testid="usage-guard-period">
        {(settings.period === "day" ? m.usage_guard_period_day : m.usage_guard_period_month)({
          end: formatDateMinutes(period.end),
        })}
        {" · "}
        {actionLabel(settings.action)}
      </p>
    </CardContent>
  );
}

const actionLabel = (action: UsageGuardAction) =>
  ({
    alert: m.usage_guard_action_alert,
    maintenance: m.usage_guard_action_maintenance,
    disable: m.usage_guard_action_disable,
  })[action]();

/** What restoring or deleting a guard changes: the guard, the site's state and maintenance. */
const GUARD_VIEWS = [orpc.usageGuard.key(), orpc.sites.key(), orpc.maintenance.key()];

/** What the guard holds, and the restore that lifts it and pauses the guard until the period ends. */
function HeldAlert({ site, guard }: { site: Site; guard: UsageGuard }) {
  const restore = useMutation({
    ...orpc.usageGuard.restore.mutationOptions(),
    meta: { invalidates: GUARD_VIEWS, success: m.usage_guard_restored },
  });
  const held = guard.held;
  if (!held) return null;
  const title = (
    held.action === "maintenance" ? m.usage_guard_held_maintenance : m.usage_guard_held_disable
  )({ metric: metricLabel(held.metric) });
  return (
    <Alert tone="danger" title={title} data-testid="usage-guard-held" data-action={held.action}>
      <span className="flex">
        <ConfirmDialog
          trigger={
            <Button size="sm" variant="secondary" data-testid="usage-guard-restore">
              {m.usage_guard_restore()}
            </Button>
          }
          title={m.usage_guard_restore_confirm({ name: site.name })}
          note={
            guard.period
              ? m.usage_guard_restore_note({ time: formatDateMinutes(guard.period.end) })
              : undefined
          }
          confirmLabel={m.usage_guard_restore()}
          onConfirm={() => restore.mutateAsync({ id: site.id })}
        />
      </span>
    </Alert>
  );
}

function DeleteButton({ guard }: { guard: UsageGuard }) {
  const remove = useMutation({
    ...orpc.usageGuard.delete.mutationOptions(),
    meta: { invalidates: GUARD_VIEWS, success: m.usage_guard_deleted },
  });
  return (
    <ConfirmDialog
      trigger={
        <Button
          className="icon-button"
          size="sm"
          variant="ghost"
          aria-label={m.common_delete()}
          data-testid="usage-guard-delete"
        >
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      }
      destructive
      title={m.usage_guard_delete_confirm()}
      note={guard.held ? m.usage_guard_delete_note() : undefined}
      confirmLabel={m.common_delete()}
      onConfirm={() => remove.mutateAsync({ id: guard.siteId })}
    />
  );
}

/** The browser's time zone when the runtime knows it, else UTC. */
function browserTimeZone() {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return zone && validTimeZone(zone) ? zone : "UTC";
}

/** Every IANA zone the browser knows, UTC first. */
function timeZoneOptions(current: string): Option[] {
  const names =
    typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const all = ["UTC", ...names.filter((name) => name !== "UTC")];
  if (!all.includes(current)) all.unshift(current);
  return all.map((value) => ({ value, label: value.replaceAll("_", " ") }));
}

/** A decimal without trailing zeros ("0.5", "1000"). */
const plain = (value: number) =>
  new Intl.NumberFormat("en-US", { maximumFractionDigits: 9, useGrouping: false }).format(value);

interface Draft {
  period: UsageGuardPeriod;
  timeZone: string;
  bytesGb: string;
  requests: string;
  bandwidthMbps: string;
  warn: boolean;
  warnPercent: string;
  action: UsageGuardAction;
  recovery: UsageGuardSettings["recovery"];
  holdMinutes: string;
}

const toDraft = (settings: UsageGuardSettings | null): Draft => ({
  period: settings?.period ?? "month",
  timeZone: settings?.timeZone ?? browserTimeZone(),
  bytesGb: settings?.bytesLimit ? plain(Number(settings.bytesLimit) / GB) : "",
  requests: settings?.requestsLimit ?? "",
  bandwidthMbps: settings?.bandwidthBps ? plain(settings.bandwidthBps / MBPS) : "",
  warn: settings ? settings.warnPercent !== null : true,
  warnPercent: String(settings?.warnPercent ?? 80),
  action: settings?.action ?? "maintenance",
  recovery: settings?.recovery ?? "auto",
  holdMinutes: String(settings?.bandwidthHoldMinutes ?? 30),
});

/** Bytes of a GB amount ("" → no limit); null when not a positive amount. */
function bytesOf(text: string): string | null | undefined {
  if (!text.trim()) return null;
  const value = Number(text);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  const bytes = Math.round(value * GB);
  return bytes >= 1 ? BigInt(bytes).toString() : undefined;
}

function requestsOf(text: string): string | null | undefined {
  if (!text.trim()) return null;
  return /^[1-9][0-9]{0,37}$/.test(text.trim()) ? text.trim() : undefined;
}

function bpsOf(text: string): number | null | undefined {
  if (!text.trim()) return null;
  const bps = Math.round(Number(text) * MBPS);
  return Number.isFinite(bps) && bps >= USAGE_GUARD_MIN_BPS && bps <= USAGE_GUARD_MAX_BPS
    ? bps
    : undefined;
}

const integerIn = (text: string, min: number, max: number) => {
  const value = Number(text);
  return Number.isInteger(value) && value >= min && value <= max ? value : undefined;
};

function UsageGuardDialog({
  open,
  onOpenChange,
  siteId,
  guard,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  siteId: string;
  guard: UsageGuard;
}) {
  const save = useMutation({
    ...orpc.usageGuard.update.mutationOptions(),
    meta: { invalidates: [orpc.usageGuard.key()], success: m.usage_guard_saved },
  });
  const [draft, setDraft] = React.useState(() => toDraft(guard.settings));
  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const zones = React.useMemo(() => timeZoneOptions(draft.timeZone), [draft.timeZone]);
  const bytesLimit = bytesOf(draft.bytesGb);
  const requestsLimit = requestsOf(draft.requests);
  const bandwidthBps = bpsOf(draft.bandwidthMbps);
  const warnPercent = draft.warn ? integerIn(draft.warnPercent, 1, 99) : null;
  const holdMinutes = integerIn(draft.holdMinutes, 5, 1440);
  const noLimit = bytesLimit === null && requestsLimit === null && bandwidthBps === null;
  const invalid =
    bytesLimit === undefined ||
    requestsLimit === undefined ||
    bandwidthBps === undefined ||
    warnPercent === undefined ||
    holdMinutes === undefined;
  const periodOptions: Option<UsageGuardPeriod>[] = [
    { value: "day", label: m.usage_guard_period_option_day() },
    { value: "month", label: m.usage_guard_period_option_month() },
  ];
  const actionOptions: Option<UsageGuardAction>[] = [
    { value: "alert", label: m.usage_guard_action_alert() },
    { value: "maintenance", label: m.usage_guard_action_maintenance() },
    { value: "disable", label: m.usage_guard_action_disable() },
  ];
  const recoveryOptions: Option<UsageGuardSettings["recovery"]>[] = [
    { value: "auto", label: m.usage_guard_recovery_auto() },
    { value: "manual", label: m.usage_guard_recovery_manual() },
  ];
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.usage_guard_title()}
      submitLabel={m.common_save()}
      submitTestId="usage-guard-save"
      submitDisabled={noLimit || invalid}
      onSubmit={async () => {
        if (invalid || noLimit) return;
        await save.mutateAsync({
          id: siteId,
          period: draft.period,
          timeZone: draft.timeZone,
          bytesLimit,
          requestsLimit,
          bandwidthBps,
          warnPercent,
          action: draft.action,
          recovery: draft.recovery,
          bandwidthHoldMinutes: holdMinutes,
          ...(guard.updatedAt ? { expectedUpdatedAt: guard.updatedAt } : {}),
        });
        onOpenChange(false);
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormSelect
          id="usage-guard-period"
          label={m.usage_guard_period()}
          value={draft.period}
          options={periodOptions}
          onChange={(value) => set("period", value)}
          testId="usage-guard-period-select"
        />
        <FormSelect
          id="usage-guard-time-zone"
          label={m.usage_guard_time_zone()}
          value={draft.timeZone}
          options={zones}
          onChange={(value) => set("timeZone", value)}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        <NumberField
          id="usage-guard-bytes"
          label={m.usage_guard_bytes_gb()}
          value={draft.bytesGb}
          onChange={(value) => set("bytesGb", value)}
          min={0}
          step="any"
          placeholder={m.usage_guard_no_limit()}
          invalid={bytesLimit === undefined}
          testId="usage-guard-bytes-input"
        />
        <NumberField
          id="usage-guard-requests"
          label={m.usage_guard_metric_requests()}
          value={draft.requests}
          onChange={(value) => set("requests", value)}
          min={1}
          step={1}
          placeholder={m.usage_guard_no_limit()}
          invalid={requestsLimit === undefined}
          testId="usage-guard-requests-input"
        />
        <NumberField
          id="usage-guard-bandwidth"
          label={m.usage_guard_bandwidth_mbps()}
          value={draft.bandwidthMbps}
          onChange={(value) => set("bandwidthMbps", value)}
          min={0}
          step="any"
          placeholder={m.usage_guard_no_limit()}
          invalid={bandwidthBps === undefined}
          testId="usage-guard-bandwidth-input"
        />
      </div>
      {noLimit ? <SafetyNote>{m.usage_guard_limit_required()}</SafetyNote> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <SwitchField
          id="usage-guard-warn"
          label={m.usage_guard_warn()}
          checked={draft.warn}
          onCheckedChange={(checked) => set("warn", checked)}
        />
        <NumberField
          id="usage-guard-warn-percent"
          label={m.usage_guard_warn_percent()}
          value={draft.warnPercent}
          onChange={(value) => set("warnPercent", value)}
          min={1}
          max={99}
          step={1}
          disabled={!draft.warn}
          invalid={draft.warn && warnPercent === undefined}
        />
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormSelect
          id="usage-guard-action"
          label={m.usage_guard_action()}
          value={draft.action}
          options={actionOptions}
          onChange={(value) => set("action", value)}
          testId="usage-guard-action-select"
        />
        <FormSelect
          id="usage-guard-recovery"
          label={m.usage_guard_recovery()}
          value={draft.recovery}
          options={recoveryOptions}
          onChange={(value) => set("recovery", value)}
          disabled={draft.action === "alert"}
        />
      </div>
      {draft.action !== "alert" && draft.recovery === "auto" && bandwidthBps ? (
        <NumberField
          id="usage-guard-hold"
          label={m.usage_guard_hold_minutes()}
          value={draft.holdMinutes}
          onChange={(value) => set("holdMinutes", value)}
          min={5}
          max={1440}
          step={1}
          invalid={holdMinutes === undefined}
        />
      ) : null}
    </FormDialog>
  );
}
