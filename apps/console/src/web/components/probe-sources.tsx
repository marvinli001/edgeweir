import {
  PROBE_SOURCE_CATALOG,
  type ProbeMode,
  type ProbeSource,
  type ProbeSourceEntry,
  type ProbeSourceMappingInput,
  type ProbeSourceMonitor,
  type ProbeSourceProvider,
  probeSourceEntry,
} from "@edgeweir/contract";
import {
  Add01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  WebhookIcon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/arc/dialog/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { Input } from "@/components/arc/input/input";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect, OptionSelect } from "@/components/form-select";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/layout/form";
import {
  Panel,
  PanelAction,
  PanelContent,
  PanelHeader,
  PanelTitle,
} from "@/components/layout/panel";
import { Spinner } from "@/components/layout/spinner";
import { SafetyNote } from "@/components/safety-note";
import { NumberField } from "@/components/site/fields";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { TimeAgo } from "@/components/time-ago";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { formatDateTime, formatPercent, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { rowLink, rowLinkButton } from "@/lib/row-link";
import { cn } from "@/lib/utils";

const PROVIDER_LABEL: Record<ProbeSourceProvider, () => string> = {
  generic_webhook: m.probe_source_provider_generic_webhook,
  uptimerobot: m.probe_source_provider_uptimerobot,
  betterstack: m.probe_source_provider_betterstack,
  pingdom: m.probe_source_provider_pingdom,
  checkly: m.probe_source_provider_checkly,
  datadog: m.probe_source_provider_datadog,
  aliyun_site_monitor: m.probe_source_provider_aliyun_site_monitor,
  tencent_cat: m.probe_source_provider_tencent_cat,
};
const FIELD_LABEL: Record<string, () => string> = {
  api_key: m.probe_source_field_api_key,
  api_token: m.probe_source_field_api_token,
  application_key: m.probe_source_field_application_key,
  account_id: m.probe_source_field_account_id,
  site: m.probe_source_field_site,
  access_key_id: m.probe_source_field_access_key_id,
  access_key_secret: m.probe_source_field_access_key_secret,
  region: m.probe_source_field_region,
  secret_id: m.probe_source_field_secret_id,
  secret_key: m.probe_source_field_secret_key,
};
const fieldLabel = (key: string) => FIELD_LABEL[key]?.() ?? key;
const ERROR_LABEL: Record<string, () => string> = {
  auth_failed: m.probe_source_error_auth_failed,
  rate_limited: m.probe_source_error_rate_limited,
  unreachable: m.probe_source_error_unreachable,
  refused: m.probe_source_error_refused,
  bad_response: m.probe_source_error_bad_response,
  provider_error: m.probe_source_error_provider_error,
};
const sourceErrorLabel = (code: string) => ERROR_LABEL[code]?.() ?? code;
const MODE_LABEL: Record<ProbeMode, () => string> = {
  internal: m.probe_mode_internal,
  external: m.probe_mode_external,
  all: m.probe_mode_all,
  any: m.probe_mode_any,
};
const MODES: ProbeMode[] = ["internal", "external", "all", "any"];

function SourceStatus({ source }: { source: ProbeSource }) {
  switch (source.status) {
    case "disabled":
      return (
        <StatusDot tone="idle" data-testid="probe-source-disabled">
          {m.nodes_disabled()}
        </StatusDot>
      );
    case "waiting":
      return (
        <StatusDot tone="idle" data-testid="probe-source-waiting">
          {m.probe_source_waiting()}
        </StatusDot>
      );
    case "failing":
      return (
        <div className="flex flex-col gap-0.5">
          <StatusDot tone="bad" data-testid="probe-source-failing">
            {m.probe_source_failing()}
          </StatusDot>
          <span className="text-xs text-destructive" data-testid="probe-source-error">
            {sourceErrorLabel(source.lastError)}
          </span>
        </div>
      );
    case "stale":
      return (
        <StatusDot tone="warn" data-testid="probe-source-stale">
          {m.probe_source_stale()}
        </StatusDot>
      );
    default:
      return (
        <StatusDot tone="good" glow data-testid="probe-source-healthy">
          {m.probe_source_healthy()}
        </StatusDot>
      );
  }
}

type SourceAction = {
  kind: "edit" | "mappings" | "results" | "rotate" | "delete";
  source: ProbeSource;
};

function SourceActions({
  source,
  onAction,
}: {
  source: ProbeSource;
  onAction: (action: SourceAction) => void;
}) {
  const update = useMutation({
    ...orpc.probeSources.update.mutationOptions(),
    meta: { invalidates: [orpc.probeSources.key()], toastError: true },
  });
  const entry = probeSourceEntry(source.provider);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            className="icon-button"
            size="sm"
            variant="ghost"
            aria-label={m.common_actions()}
            data-testid="probe-source-actions"
          />
        }
      >
        <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem
          onClick={() => onAction({ kind: "mappings", source })}
          data-testid="probe-source-mappings"
        >
          {m.probe_source_mappings()}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onAction({ kind: "results", source })}
          data-testid="probe-source-results"
        >
          {m.probes_results()}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => onAction({ kind: "edit", source })}
          data-testid="probe-source-edit"
        >
          {m.common_edit()}
        </DropdownMenuItem>
        {entry?.webhook === "generated" ? (
          <DropdownMenuItem
            onClick={() => onAction({ kind: "rotate", source })}
            data-testid="probe-source-rotate"
          >
            {m.probe_source_rotate()}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem
          onClick={() => update.mutate({ id: source.id, enabled: !source.enabled })}
          data-testid="probe-source-toggle"
        >
          {source.enabled ? m.nodes_disable() : m.nodes_enable()}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          variant="destructive"
          onClick={() => onAction({ kind: "delete", source })}
          data-testid="probe-source-delete"
        >
          {m.common_delete()}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** External probe sources: state, last data and mappings of each, with their dialogs. */
export function ProbeSourcesPanel() {
  const sources = useQuery({
    ...orpc.probeSources.list.queryOptions(),
    refetchInterval: 10_000,
    meta: { background: true },
  });
  const [adding, setAdding] = React.useState(false);
  const action = useDialogState<SourceAction>();
  const columns = React.useMemo<Columns<ProbeSource>>(
    () => [
      {
        id: "name",
        header: () => m.probes_col_name(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <button
              type="button"
              className={cn(rowLinkButton, "font-medium")}
              onClick={() => action.show({ kind: "results", source: row.original })}
              {...rowLink}
              data-testid="probe-source-name"
            >
              {row.original.name}
            </button>
            <span className="text-xs text-muted-foreground">
              {PROVIDER_LABEL[row.original.provider]()}
            </span>
          </div>
        ),
      },
      {
        id: "status",
        header: () => m.nodes_col_status(),
        cell: ({ row }) => <SourceStatus source={row.original} />,
      },
      {
        id: "last",
        header: () => m.probe_source_last_data(),
        cell: ({ row }) => (
          <span
            className="text-xs whitespace-nowrap text-muted-foreground"
            title={
              row.original.lastSuccessAt ? formatDateTime(row.original.lastSuccessAt) : undefined
            }
          >
            <TimeAgo at={row.original.lastSuccessAt} />
          </span>
        ),
      },
      {
        id: "mappings",
        header: () => m.probe_source_mappings(),
        cell: ({ row }) => (
          <div className="flex flex-col text-xs" data-testid="probe-source-mapping-count">
            <span className="tabular-nums">
              {m.probe_source_monitor_count({ count: row.original.mappings })}
            </span>
            {row.original.down > 0 ? (
              <span className="text-destructive" data-testid="probe-source-down">
                {m.probe_source_down_count({ count: row.original.down })}
              </span>
            ) : null}
          </div>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <SourceActions source={row.original} onAction={action.show} />
          </div>
        ),
      },
    ],
    [action.show],
  );
  return (
    <Panel className="animate-enter" style={{ animationDelay: "90ms" }} data-testid="probe-sources">
      <PanelHeader>
        <PanelTitle>{m.probe_sources_title()}</PanelTitle>
        <PanelAction>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => setAdding(true)}
            data-testid="probe-source-add"
          >
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.probe_source_add()}
          </Button>
        </PanelAction>
      </PanelHeader>
      <QueryView
        query={sources}
        frame={PanelContent}
        empty={
          <PanelContent>
            <EmptyState compact icon={WebhookIcon} title={m.probe_sources_empty()}>
              <Button size="sm" onClick={() => setAdding(true)}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.probe_source_add()}
              </Button>
            </EmptyState>
          </PanelContent>
        }
      >
        {(list) => (
          <PanelContent className="flex flex-col gap-3">
            <DataTable
              data={list}
              columns={columns}
              getRowId={(s) => s.id}
              testId="probe-sources-table"
              pinFirstColumn
            />
          </PanelContent>
        )}
      </QueryView>
      <SourceDialog open={adding} onOpenChange={setAdding} source={null} />
      {action.value ? (
        <SourceActionDialog
          key={`source-${action.key}`}
          action={action.value}
          open={action.open}
          onOpenChange={action.onOpenChange}
        />
      ) : null}
    </Panel>
  );
}

function SourceActionDialog({ action, ...dialog }: { action: SourceAction } & DialogProps) {
  switch (action.kind) {
    case "edit":
      return <SourceDialog source={action.source} {...dialog} />;
    case "mappings":
      return <MappingsDialog source={action.source} {...dialog} />;
    case "results":
      return <ResultsDialog source={action.source} {...dialog} />;
    case "rotate":
      return <RotateDialog source={action.source} {...dialog} />;
    case "delete":
      return <DeleteSourceDialog source={action.source} {...dialog} />;
  }
}

/** The webhook URL and secret of a source, shown once after it was made. */
function WebhookSecret({
  url,
  secret,
  provider,
}: {
  url: string;
  secret: string;
  provider: string;
}) {
  const template = probeSourceEntry(provider)?.webhookTemplate;
  return (
    <FieldGroup data-testid="probe-source-webhook">
      <Field>
        <FieldLabel>{m.probe_source_webhook_url()}</FieldLabel>
        <CodeBlock value={url} testId="probe-source-webhook-url" />
      </Field>
      <Field>
        <FieldLabel>{m.probe_source_webhook_secret()}</FieldLabel>
        <CodeBlock value={secret} testId="probe-source-webhook-secret" />
        <SafetyNote>{m.enroll_shown_once()}</SafetyNote>
      </Field>
      {template ? (
        <Field>
          <FieldLabel>{m.probe_source_webhook_body()}</FieldLabel>
          <CodeBlock value={template} testId="probe-source-webhook-body" />
        </Field>
      ) : null}
    </FieldGroup>
  );
}

/** Adds a source (source null) or edits one; secret fields are written, never shown. */
function SourceDialog({
  source,
  open,
  onOpenChange,
}: { source: ProbeSource | null } & DialogProps) {
  const [provider, setProvider] = React.useState<ProbeSourceProvider>(
    source?.provider ?? "generic_webhook",
  );
  const entry = probeSourceEntry(provider) as ProbeSourceEntry;
  const [fields, setFields] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      entry.fields.map((f) => [f.key, f.secret ? "" : (source?.options[f.key] ?? f.default ?? "")]),
    ),
  );
  const [poll, setPoll] = React.useState(String(source?.pollIntervalSeconds ?? 60));
  const [stale, setStale] = React.useState(String(source?.staleAfterSeconds ?? 300));
  const [created, setCreated] = React.useState<{ url: string; secret: string } | null>(null);
  const create = useMutation({
    ...orpc.probeSources.create.mutationOptions(),
    meta: { invalidates: [orpc.probeSources.key()] },
  });
  const update = useMutation({
    ...orpc.probeSources.update.mutationOptions(),
    meta: { invalidates: [orpc.probeSources.key()], success: m.common_saved },
  });
  const check = useMutation(orpc.probeSources.check.mutationOptions());
  const chooseProvider = (next: ProbeSourceProvider) => {
    setProvider(next);
    const nextEntry = probeSourceEntry(next) as ProbeSourceEntry;
    setFields(Object.fromEntries(nextEntry.fields.map((f) => [f.key, f.default ?? ""])));
    setPoll(String(Math.max(60, nextEntry.minPollSeconds)));
    check.reset();
  };
  const filled = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== ""));
  const forget = (isOpen: boolean) => {
    if (isOpen) return;
    setCreated(null);
    create.reset();
    check.reset();
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange} onOpenChangeComplete={forget}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{source ? source.name : m.probe_source_add()}</DialogTitle>
        </DialogHeader>
        {created ? (
          <div className="flex flex-col gap-4">
            <WebhookSecret url={created.url} secret={created.secret} provider={provider} />
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)} data-testid="probe-source-close">
                {m.common_close()}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              event.stopPropagation();
              const data = new FormData(event.currentTarget);
              const name = String(data.get("sourceName") ?? "").trim();
              const webhookSecret = String(data.get("sourceWebhookSecret") ?? "") || undefined;
              try {
                if (source) {
                  await update.mutateAsync({
                    id: source.id,
                    name,
                    fields: filled,
                    webhookSecret,
                    ...(entry.pull ? { pollIntervalSeconds: Number(poll) } : {}),
                    staleAfterSeconds: Number(stale),
                  });
                  onOpenChange(false);
                  return;
                }
                const result = await create.mutateAsync({
                  name,
                  provider,
                  fields: filled,
                  webhookSecret,
                  ...(entry.pull ? { pollIntervalSeconds: Number(poll) } : {}),
                  staleAfterSeconds: Number(stale),
                });
                if (result.webhookSecret && result.source.webhookUrl)
                  setCreated({ url: result.source.webhookUrl, secret: result.webhookSecret });
                else onOpenChange(false);
              } catch {
                // shown below
              }
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="sourceName">{m.probes_name()}</FieldLabel>
                <Input
                  id="sourceName"
                  name="sourceName"
                  required
                  maxLength={64}
                  defaultValue={source?.name ?? ""}
                  data-testid="probe-source-name-input"
                />
              </Field>
              {source ? null : (
                <FormSelect
                  id="sourceProvider"
                  label={m.probe_source_provider()}
                  value={provider}
                  options={PROBE_SOURCE_CATALOG.map((e) => ({
                    value: e.id,
                    label: PROVIDER_LABEL[e.id](),
                  }))}
                  onChange={chooseProvider}
                  testId="probe-source-provider"
                />
              )}
              {entry.fields.map((field) =>
                field.options ? (
                  <FormSelect
                    key={field.key}
                    id={`source-${field.key}`}
                    label={fieldLabel(field.key)}
                    value={fields[field.key] || null}
                    options={field.options.map((o) => ({ value: o, label: o }))}
                    onChange={(value) => setFields((f) => ({ ...f, [field.key]: value }))}
                    testId={`probe-source-field-${field.key}`}
                  />
                ) : (
                  <Field key={field.key}>
                    <FieldLabel htmlFor={`source-${field.key}`}>{fieldLabel(field.key)}</FieldLabel>
                    <Input
                      id={`source-${field.key}`}
                      type={field.secret ? "password" : "text"}
                      autoComplete="off"
                      required={
                        field.required && !(field.secret && source?.secretsSet.includes(field.key))
                      }
                      maxLength={field.maxLength}
                      placeholder={
                        field.secret && source?.secretsSet.includes(field.key)
                          ? m.probe_source_secret_kept()
                          : field.placeholder
                      }
                      value={fields[field.key] ?? ""}
                      onChange={(e) => {
                        const value = e.currentTarget.value;
                        setFields((f) => ({ ...f, [field.key]: value }));
                      }}
                      data-testid={`probe-source-field-${field.key}`}
                    />
                  </Field>
                ),
              )}
              {entry.webhook === "entered" ? (
                <Field>
                  <FieldLabel htmlFor="sourceWebhookSecret">
                    {m.probe_source_webhook_secret()}
                  </FieldLabel>
                  <Input
                    id="sourceWebhookSecret"
                    name="sourceWebhookSecret"
                    type="password"
                    autoComplete="off"
                    minLength={16}
                    maxLength={256}
                    placeholder={source?.webhookUrl ? m.probe_source_secret_kept() : undefined}
                  />
                </Field>
              ) : null}
              <div className="grid gap-4 sm:grid-cols-2">
                {entry.pull ? (
                  <NumberField
                    id="sourcePoll"
                    label={m.probe_source_poll_interval()}
                    value={poll}
                    onChange={setPoll}
                    min={entry.minPollSeconds}
                    max={3600}
                    step={1}
                    required
                    testId="probe-source-poll"
                  />
                ) : null}
                <NumberField
                  id="sourceStale"
                  label={m.probe_source_stale_after()}
                  value={stale}
                  onChange={setStale}
                  min={60}
                  max={86400}
                  step={1}
                  required
                  testId="probe-source-stale-after"
                />
              </div>
              {entry.pull ? (
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={check.isPending}
                    onClick={() =>
                      check.mutate(
                        source ? { id: source.id, fields: filled } : { provider, fields: filled },
                      )
                    }
                    data-testid="probe-source-check"
                  >
                    {check.isPending ? <Spinner /> : null}
                    {m.probe_source_check()}
                  </Button>
                  {check.data ? (
                    check.data.ok ? (
                      <span className="text-sm text-state-good" data-testid="probe-source-check-ok">
                        {m.probe_source_check_ok({ count: check.data.monitors ?? 0 })}
                      </span>
                    ) : (
                      <span
                        className="text-sm text-destructive"
                        data-testid="probe-source-check-failed"
                      >
                        {sourceErrorLabel(check.data.error)}
                      </span>
                    )
                  ) : null}
                  {check.isError ? <FieldError>{errorMessage(check.error)}</FieldError> : null}
                </div>
              ) : null}
              {create.isError || update.isError ? (
                <FieldError>{errorMessage(create.error ?? update.error)}</FieldError>
              ) : null}
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  {m.common_cancel()}
                </Button>
                <Button
                  type="submit"
                  disabled={create.isPending || update.isPending}
                  data-testid="probe-source-submit"
                >
                  {create.isPending || update.isPending ? <Spinner /> : null}
                  {source ? m.common_save() : m.common_create()}
                </Button>
              </DialogFooter>
            </FieldGroup>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

const ALL_ADDRESSES = "__all__";
type DraftMapping = {
  key: number;
  monitorId: string;
  monitorName: string;
  nodeId: string;
  address: string;
};

/** Which node (and address) each monitor checks; loads the provider's monitors to suggest. */
function MappingsDialog({ source, open, onOpenChange }: { source: ProbeSource } & DialogProps) {
  const mappings = useQuery(orpc.probeSources.mappings.queryOptions({ input: { id: source.id } }));
  const nodes = useQuery(orpc.nodes.list.queryOptions({ input: {} }));
  const monitors = useMutation({
    mutationFn: () => orpc.probeSources.monitors.call({ id: source.id }),
  });
  const save = useMutation({
    ...orpc.probeSources.setMappings.mutationOptions(),
    meta: { invalidates: [orpc.probeSources.key()], success: m.common_saved },
  });
  const nextKey = React.useRef(0);
  const [rows, setRows] = React.useState<DraftMapping[] | null>(null);
  const draft =
    rows ??
    (mappings.data ?? []).map((m) => ({
      key: nextKey.current++,
      monitorId: m.monitorId,
      monitorName: m.monitorName,
      nodeId: m.nodeId,
      address: m.address ?? ALL_ADDRESSES,
    }));
  const edit = (key: number, change: Partial<DraftMapping>) =>
    setRows(draft.map((r) => (r.key === key ? { ...r, ...change } : r)));
  const nodeList = nodes.data ?? [];
  const addFromProvider = (list: ProbeSourceMonitor[]) => {
    const known = new Set(draft.map((r) => r.monitorId));
    setRows([
      ...draft,
      ...list
        .filter((mon) => !known.has(mon.id) && mon.suggestedNodeId)
        .map((mon) => ({
          key: nextKey.current++,
          monitorId: mon.id,
          monitorName: mon.name,
          nodeId: mon.suggestedNodeId ?? "",
          address: mon.suggestedAddress ?? ALL_ADDRESSES,
        })),
    ]);
  };
  const valid = draft.every((r) => r.monitorId.trim() && r.nodeId);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.probe_source_mappings_title({ name: source.name })}</DialogTitle>
        </DialogHeader>
        <QueryView query={mappings}>
          {() => (
            <div className="flex flex-col gap-3">
              {draft.length ? (
                <ul className="flex flex-col gap-2" data-testid="probe-source-mapping-rows">
                  {draft.map((row) => {
                    const node = nodeList.find((n) => n.id === row.nodeId);
                    return (
                      <li
                        key={row.key}
                        className="grid grid-cols-1 items-center gap-2 sm:grid-cols-[1fr_1fr_1fr_auto]"
                        data-testid="probe-source-mapping-row"
                      >
                        <Input
                          aria-label={m.probe_source_monitor()}
                          placeholder={m.probe_source_monitor()}
                          value={row.monitorId}
                          maxLength={200}
                          onChange={(e) => edit(row.key, { monitorId: e.currentTarget.value })}
                          title={row.monitorName || undefined}
                          data-testid="probe-source-mapping-monitor"
                        />
                        <OptionSelect
                          label={m.probe_source_node()}
                          placeholder={m.probe_source_node()}
                          value={row.nodeId || null}
                          options={nodeList.map((n) => ({ value: n.id, label: n.name }))}
                          onChange={(nodeId) => edit(row.key, { nodeId, address: ALL_ADDRESSES })}
                          testId="probe-source-mapping-node"
                        />
                        <OptionSelect
                          label={m.probe_source_address()}
                          value={row.address}
                          options={[
                            { value: ALL_ADDRESSES, label: m.probe_source_all_addresses() },
                            ...(node?.schedulingAddresses ?? []).map((a) => ({
                              value: a.address,
                              label: a.address,
                            })),
                          ]}
                          onChange={(address) => edit(row.key, { address })}
                          testId="probe-source-mapping-address"
                        />
                        <Button
                          type="button"
                          className="icon-button"
                          size="sm"
                          variant="ghost"
                          aria-label={m.common_delete()}
                          onClick={() => setRows(draft.filter((r) => r.key !== row.key))}
                        >
                          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                        </Button>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <EmptyState compact icon={WebhookIcon} title={m.probe_source_mappings_empty()} />
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setRows([
                      ...draft,
                      {
                        key: nextKey.current++,
                        monitorId: "",
                        monitorName: "",
                        nodeId: "",
                        address: ALL_ADDRESSES,
                      },
                    ])
                  }
                  data-testid="probe-source-mapping-add"
                >
                  <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                  {m.probe_source_mapping_add()}
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  disabled={monitors.isPending}
                  onClick={async () => {
                    try {
                      addFromProvider(await monitors.mutateAsync());
                    } catch {
                      // shown below
                    }
                  }}
                  data-testid="probe-source-mapping-suggest"
                >
                  {monitors.isPending ? <Spinner /> : null}
                  {m.probe_source_suggest()}
                </Button>
              </div>
              {monitors.data ? (
                <SafetyNote data-testid="probe-source-suggested">
                  {m.probe_source_suggested({
                    count: monitors.data.filter((x) => x.suggestedNodeId).length,
                    total: monitors.data.length,
                  })}
                </SafetyNote>
              ) : null}
              {monitors.isError ? <FieldError>{errorMessage(monitors.error)}</FieldError> : null}
              {save.isError ? <FieldError>{errorMessage(save.error)}</FieldError> : null}
              <DialogFooter>
                <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
                  {m.common_cancel()}
                </Button>
                <Button
                  disabled={!valid || save.isPending}
                  onClick={async () => {
                    const input: ProbeSourceMappingInput[] = draft.map((r) => ({
                      monitorId: r.monitorId.trim(),
                      monitorName: r.monitorName,
                      nodeId: r.nodeId,
                      address: r.address === ALL_ADDRESSES ? null : r.address,
                    }));
                    try {
                      await save.mutateAsync({ id: source.id, mappings: input });
                      onOpenChange(false);
                    } catch {
                      // shown above
                    }
                  }}
                  data-testid="probe-source-mapping-save"
                >
                  {save.isPending ? <Spinner /> : null}
                  {m.common_save()}
                </Button>
              </DialogFooter>
            </div>
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

function ResultsDialog({ source, open, onOpenChange }: { source: ProbeSource } & DialogProps) {
  const results = useQuery({
    ...orpc.probeSources.results.queryOptions({ input: { id: source.id } }),
    refetchInterval: 10_000,
    meta: { background: true },
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{m.probes_results_title({ name: source.name })}</DialogTitle>
        </DialogHeader>
        {source.webhookUrl ? (
          <Field>
            <FieldLabel>{m.probe_source_webhook_url()}</FieldLabel>
            <CodeBlock value={source.webhookUrl} testId="probe-source-results-webhook-url" />
          </Field>
        ) : null}
        <QueryView
          query={results}
          empty={<EmptyState compact icon={WebhookIcon} title={m.probes_results_empty()} />}
        >
          {(list) => (
            <div className="overflow-x-auto">
              <table className="w-full text-sm" data-testid="probe-source-results-table">
                <thead>
                  <tr className="text-left text-xs text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">{m.probe_source_monitor()}</th>
                    <th className="py-1.5 pr-3 font-medium">{m.probe_source_node()}</th>
                    <th className="py-1.5 pr-3 font-medium">{m.probe_source_location()}</th>
                    <th className="py-1.5 pr-3 font-medium">{m.nodes_col_status()}</th>
                    <th className="py-1.5 pr-3 font-medium">{m.probes_col_round()}</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((r) => (
                    <tr
                      key={`${r.monitorId}|${r.location}`}
                      className={cn(
                        "border-t border-border",
                        !r.counted && "text-muted-foreground",
                      )}
                      data-testid="probe-source-result"
                    >
                      <td className="py-1.5 pr-3 font-mono text-xs break-all">
                        {r.monitorName || r.monitorId}
                      </td>
                      <td className="py-1.5 pr-3">
                        {r.nodeName ?? (
                          <Badge size="sm" tone="neutral">
                            {m.probe_source_unmapped()}
                          </Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-xs">{r.location || "—"}</td>
                      <td className="py-1.5 pr-3">
                        {r.up ? (
                          <StatusDot tone="good">{m.probe_source_up()}</StatusDot>
                        ) : (
                          <StatusDot tone="bad">{m.probe_source_down()}</StatusDot>
                        )}
                      </td>
                      <td className="py-1.5 pr-3 text-xs whitespace-nowrap">
                        {m.probes_loss({ loss: formatPercent(r.lossPercent) })}
                        {r.rttMs !== null ? ` · ${m.probes_rtt({ rtt: r.rttMs })}` : ""}
                        <span
                          className="block text-muted-foreground"
                          title={formatDateTime(r.checkedAt)}
                        >
                          <TimeAgo at={r.receivedAt} />
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </QueryView>
      </DialogContent>
    </Dialog>
  );
}

function RotateDialog({ source, open, onOpenChange }: { source: ProbeSource } & DialogProps) {
  const rotate = useMutation(orpc.probeSources.rotateWebhookSecret.mutationOptions());
  if (rotate.data && source.webhookUrl)
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-xl">
          <DialogHeader>
            <DialogTitle>{m.probe_source_rotate()}</DialogTitle>
          </DialogHeader>
          <WebhookSecret
            url={source.webhookUrl}
            secret={rotate.data.webhookSecret}
            provider={source.provider}
          />
          <DialogFooter>
            <Button onClick={() => onOpenChange(false)}>{m.common_close()}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.probe_source_rotate_confirm({ name: source.name })}
      submitLabel={m.probe_source_rotate()}
      submitTestId="probe-source-rotate-submit"
      onSubmit={async () => {
        await rotate.mutateAsync({ id: source.id });
      }}
    >
      <SafetyNote>{m.probe_source_rotate_note()}</SafetyNote>
    </FormDialog>
  );
}

function DeleteSourceDialog({ source, open, onOpenChange }: { source: ProbeSource } & DialogProps) {
  const remove = useMutation({
    ...orpc.probeSources.delete.mutationOptions(),
    meta: { invalidates: [orpc.probeSources.key()], success: m.common_deleted },
  });
  return (
    <ControlledConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.probe_source_delete_confirm({ name: source.name })}
      onConfirm={async () => {
        await remove.mutateAsync({ id: source.id });
      }}
    />
  );
}

/** The global probe mode and each cluster's own; every change applies at once. */
export function ProbeModesPanel() {
  const modes = useQuery(orpc.probeSources.modes.queryOptions());
  const settings = useQuery(orpc.settings.probes.queryOptions());
  const setGlobal = useMutation({
    ...orpc.settings.setProbes.mutationOptions(),
    meta: {
      invalidates: [orpc.probeSources.key(), orpc.settings.probes.key()],
      success: m.common_saved,
      toastError: true,
    },
  });
  const setCluster = useMutation({
    ...orpc.probeSources.setClusterMode.mutationOptions(),
    meta: { invalidates: [orpc.probeSources.key()], success: m.common_saved, toastError: true },
  });
  const options = MODES.map((mode) => ({ value: mode, label: MODE_LABEL[mode]() }));
  return (
    <Panel className="animate-enter" style={{ animationDelay: "105ms" }} data-testid="probe-modes">
      <PanelHeader>
        <PanelTitle>{m.probe_mode_title()}</PanelTitle>
      </PanelHeader>
      <QueryView query={modes} frame={PanelContent}>
        {(data) => (
          <PanelContent className="flex flex-col gap-4">
            <div className="grid items-center gap-2 sm:grid-cols-[12rem_minmax(0,20rem)]">
              <span className="text-sm text-muted-foreground">{m.probe_mode_global()}</span>
              <OptionSelect
                label={m.probe_mode_global()}
                value={data.global}
                options={options}
                disabled={!settings.data || setGlobal.isPending}
                onChange={(mode) => {
                  if (settings.data) setGlobal.mutate({ ...settings.data, mode });
                }}
                testId="probe-mode-global"
              />
            </div>
            {data.clusters.length ? (
              <ul className="flex flex-col gap-2" data-testid="probe-mode-clusters">
                {data.clusters.map((c) => (
                  <li
                    key={c.clusterId}
                    className="grid items-center gap-2 sm:grid-cols-[12rem_minmax(0,20rem)]"
                  >
                    <span className="truncate text-sm">{c.clusterName}</span>
                    <OptionSelect
                      label={c.clusterName}
                      value={c.mode ?? ALL_ADDRESSES}
                      options={[
                        {
                          value: ALL_ADDRESSES,
                          label: m.probe_mode_follow({ mode: MODE_LABEL[data.global]() }),
                        },
                        ...options,
                      ]}
                      disabled={setCluster.isPending}
                      onChange={(mode) =>
                        setCluster.mutate({
                          clusterId: c.clusterId,
                          mode: mode === ALL_ADDRESSES ? null : (mode as ProbeMode),
                        })
                      }
                      testId="probe-mode-cluster"
                    />
                  </li>
                ))}
              </ul>
            ) : null}
            {data.global === "internal" &&
            data.clusters.every((c) => !c.mode || c.mode === "internal") ? (
              <SafetyNote data-testid="probe-mode-internal-note">
                {m.probe_mode_internal_note()}
              </SafetyNote>
            ) : null}
          </PanelContent>
        )}
      </QueryView>
    </Panel>
  );
}
