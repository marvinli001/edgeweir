import { arrayMove } from "@dnd-kit/sortable";
import type {
  DnsBindingInput,
  DnsLine,
  DnsResolutionLine,
  Node,
  NodeGroup,
} from "@edgeweir/contract";
import { DNS_LINES, dnsBindingInput, providerLines } from "@edgeweir/contract";
import { ArrowDown01Icon, ArrowUp01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CodeBlock } from "@/components/copy-button";
import { DnsHeldBack } from "@/components/dns-protection";
import { FormSelect } from "@/components/form-select";
import { SafetyNote } from "@/components/safety-note";
import { NumberField, SwitchField } from "@/components/site/fields";
import { SaveBar } from "@/components/site/save-site";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatDateTime, m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import {
  dnsRevisionReason,
  modeLabel,
  resolutionLineLabel,
  revisionError,
  statusLabel,
} from "./labels";

/** The DNS tab of a cluster: binding, records (or the manual list and zone file), revisions. */
export function ClusterDns({ clusterId }: { clusterId: string }) {
  const binding = useQuery(
    orpc.dns.binding.queryOptions({
      input: { clusterId },
      refetchInterval: 10_000,
      meta: { background: true },
    }),
  );
  const providers = useQuery(orpc.dns.providers.queryOptions());
  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: { clusterId } }));
  const nodes = useQuery(orpc.nodes.list.queryOptions({ input: { clusterId } }));
  const queries = [binding, providers, groups, nodes];
  const error = queries.find((q) => q.isLoadingError);
  if (error)
    return (
      <ErrorState
        error={error.error}
        onRetry={() => {
          for (const q of queries) void q.refetch();
        }}
      />
    );
  if (!binding.data || !providers.data || !groups.data || !nodes.data) return <LoadingState />;
  const state = binding.data;
  return (
    <div className="flex flex-col gap-4" data-testid="cluster-dns">
      {state.blocked ? <DnsHeldBack clusterId={clusterId} blocked={state.blocked} /> : null}
      <BindingEditor
        key={`${state.binding.updatedAt}-${state.binding.mode}`}
        clusterId={clusterId}
        initial={{
          mode: state.binding.mode,
          providerId: state.binding.providerId,
          domain: state.binding.domain,
          ttl: state.binding.ttl,
          lines: state.binding.lines,
          lineAliases: state.binding.lineAliases,
        }}
        providers={providers.data.items}
        groups={groups.data.filter((g) => g.clusterId === clusterId)}
        nodes={nodes.data.filter((n) => n.clusterId === clusterId)}
      />
      {state.binding.mode === "manual" ? (
        <ManualRecords clusterId={clusterId} updatedAt={state.binding.updatedAt} />
      ) : state.binding.mode === "auto" ? (
        <CurrentRecords clusterId={clusterId} state={state} />
      ) : null}
      <Revisions clusterId={clusterId} />
    </div>
  );
}

type BindingState = Awaited<ReturnType<typeof client.dns.binding>>;

function BindingEditor({
  clusterId,
  initial,
  providers,
  groups,
  nodes,
}: {
  clusterId: string;
  initial: DnsBindingInput;
  providers: { id: string; name: string; zone: string; provider: string }[];
  groups: NodeGroup[];
  nodes: Node[];
}) {
  const [draft, setDraft] = React.useState(initial),
    [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient();
  const save = useMutation(orpc.dns.saveBinding.mutationOptions());
  const account = providers.find((p) => p.id === draft.providerId);
  // Without an account (manual records) every line can be created by hand.
  const supported: readonly DnsResolutionLine[] = account
    ? providerLines(account.provider)
    : DNS_LINES;
  const defaultOnly = supported.length === 1;
  const patchLine = (index: number, change: Partial<DnsLine>) =>
    setDraft({
      ...draft,
      lines: draft.lines.map((line, i) => (i === index ? { ...line, ...change } : line)),
    });
  return (
    <Card>
      <form
        className="flex flex-col gap-4"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          const parsed = dnsBindingInput.safeParse(draft);
          if (!parsed.success) {
            setError(m.error_dns_policy_invalid());
            return;
          }
          try {
            const result = await save.mutateAsync({ clusterId, binding: parsed.data });
            await queries.invalidateQueries({ queryKey: orpc.dns.key() });
            toast.success(result ? m.dns_saved({ revision: result.revision }) : m.common_saved());
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <CardHeader>
          <CardTitle>{m.dns_binding_title()}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <div className="grid gap-4 sm:grid-cols-2">
            <FormSelect
              id="dns-binding-mode"
              label={m.dns_mode()}
              value={draft.mode}
              onChange={(mode) => setDraft({ ...draft, mode: mode as DnsBindingInput["mode"] })}
              options={(["off", "manual", "auto"] as const).map((mode) => ({
                value: mode,
                label: modeLabel(mode),
              }))}
            />
            {draft.mode !== "off" ? (
              <FormSelect
                id="dns-binding-account"
                label={m.dns_account()}
                value={draft.providerId ?? "none"}
                options={[
                  ...(draft.mode === "manual" ? [{ value: "none", label: m.cert_none() }] : []),
                  ...providers.map((p) => ({ value: p.id, label: p.name })),
                ]}
                onChange={(value) => {
                  const providerId = value === "none" ? null : value;
                  const next = providers.find((p) => p.id === providerId);
                  const lines = next ? providerLines(next.provider) : DNS_LINES;
                  // Lines the new provider lacks fall back to the default line.
                  setDraft({
                    ...draft,
                    providerId,
                    lines: draft.lines.map((line) =>
                      lines.includes(line.resolutionLine)
                        ? line
                        : { ...line, resolutionLine: "default" },
                    ),
                  });
                }}
              />
            ) : null}
            {draft.mode !== "off" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="dns-binding-zone">{m.dns_zone()}</FieldLabel>
                  <Input id="dns-binding-zone" value={account?.zone ?? ""} disabled readOnly />
                </Field>
                <Field>
                  <FieldLabel htmlFor="dns-binding-domain">{m.dns_cluster_domain()}</FieldLabel>
                  <Input
                    id="dns-binding-domain"
                    value={draft.domain}
                    placeholder={account ? `cdn.${account.zone}` : undefined}
                    onChange={(e) =>
                      setDraft({ ...draft, domain: e.target.value.trim().toLowerCase() })
                    }
                  />
                </Field>
                <NumberField
                  id="dns-binding-ttl"
                  label={m.dns_ttl()}
                  value={String(draft.ttl)}
                  min={30}
                  max={3600}
                  onChange={(ttl) => setDraft({ ...draft, ttl: Number(ttl) })}
                />
                <SwitchField
                  id="dns-binding-aliases"
                  label={m.dns_line_aliases()}
                  checked={draft.lineAliases}
                  onCheckedChange={(lineAliases) => setDraft({ ...draft, lineAliases })}
                />
              </>
            ) : null}
          </div>
          {draft.mode !== "off" ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-3">
                <h3 className="text-sm font-medium">{m.dns_lines()}</h3>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={
                    groups.every((g) => draft.lines.some((line) => line.nodeGroupId === g.id)) ||
                    draft.lines.length >= 128
                  }
                  onClick={() =>
                    setDraft({
                      ...draft,
                      lines: [
                        ...draft.lines,
                        {
                          name: `line-${draft.lines.length + 1}`,
                          nodeGroupId:
                            groups.find((g) => !draft.lines.some((l) => l.nodeGroupId === g.id))
                              ?.id ?? "",
                          overrides: [],
                          resolutionLine: "default",
                          backupNodeGroupIds: [],
                          minHealthyIps: 1,
                        },
                      ],
                    })
                  }
                  data-testid="dns-line-add"
                >
                  {m.dns_add_line()}
                </Button>
              </div>
              {defaultOnly && draft.lines.length ? (
                <SafetyNote data-testid="dns-resolution-default-only">
                  {m.dns_resolution_default_only()}
                </SafetyNote>
              ) : null}
              {draft.lines.map((line, index) => (
                <div
                  key={line.nodeGroupId || index}
                  className="grid gap-4 rounded-xl border p-4 animate-enter"
                  style={{ animationDelay: `${index * 40}ms` }}
                  data-testid="dns-line"
                >
                  <div className="grid gap-3 sm:grid-cols-2">
                    <Field>
                      <FieldLabel htmlFor={`line-name-${index}`}>{m.dns_line_name()}</FieldLabel>
                      <Input
                        id={`line-name-${index}`}
                        value={line.name}
                        onChange={(e) => patchLine(index, { name: e.target.value })}
                      />
                    </Field>
                    <FormSelect
                      id={`line-group-${index}`}
                      label={m.dns_node_group()}
                      value={line.nodeGroupId}
                      options={groups
                        .filter(
                          (g) =>
                            g.id === line.nodeGroupId ||
                            !draft.lines.some((other) => other.nodeGroupId === g.id),
                        )
                        .map((g) => ({ value: g.id, label: g.name }))}
                      onChange={(nodeGroupId) =>
                        patchLine(index, {
                          nodeGroupId,
                          overrides: [],
                          backupNodeGroupIds: line.backupNodeGroupIds.filter(
                            (id) => id !== nodeGroupId,
                          ),
                        })
                      }
                    />
                    <FormSelect
                      id={`line-resolution-${index}`}
                      label={m.dns_resolution_line()}
                      value={line.resolutionLine}
                      options={DNS_LINES.filter(
                        (value) => supported.includes(value) || value === line.resolutionLine,
                      ).map((value) => ({ value, label: resolutionLineLabel(value) }))}
                      onChange={(value) =>
                        patchLine(index, { resolutionLine: value as DnsResolutionLine })
                      }
                      disabled={defaultOnly && line.resolutionLine === "default"}
                      testId="dns-line-resolution"
                    />
                    <NumberField
                      id={`line-min-healthy-${index}`}
                      label={m.dns_min_healthy()}
                      value={String(line.minHealthyIps)}
                      min={1}
                      max={64}
                      step={1}
                      required
                      onChange={(value) => patchLine(index, { minHealthyIps: Number(value) })}
                      testId="dns-line-min-healthy"
                    />
                  </div>
                  <BackupGroups
                    groups={groups.filter((g) => g.id !== line.nodeGroupId)}
                    value={line.backupNodeGroupIds}
                    onChange={(backupNodeGroupIds) => patchLine(index, { backupNodeGroupIds })}
                  />
                  {nodes
                    .filter((n) => n.nodeGroupId === line.nodeGroupId)
                    .map((n) => (
                      <Field key={n.id}>
                        <FieldLabel htmlFor={`line-address-${index}-${n.id}`}>
                          {m.dns_node_address({ name: n.name })}
                        </FieldLabel>
                        <AddressInput
                          id={`line-address-${index}-${n.id}`}
                          initial={line.overrides.find((o) => o.nodeId === n.id)?.addresses ?? []}
                          onChange={(addresses) =>
                            patchLine(index, {
                              overrides: [
                                ...line.overrides.filter((o) => o.nodeId !== n.id),
                                ...(addresses.length ? [{ nodeId: n.id, addresses }] : []),
                              ],
                            })
                          }
                        />
                      </Field>
                    ))}
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="justify-self-end"
                    onClick={() =>
                      setDraft({ ...draft, lines: draft.lines.filter((_, i) => i !== index) })
                    }
                  >
                    {m.common_remove()}
                  </Button>
                </div>
              ))}
            </>
          ) : null}
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
          pending={save.isPending}
          error={error}
          testId="dns-binding-save"
        />
      </form>
    </Card>
  );
}

const MAX_BACKUP_GROUPS = 4;

/** A line's backup node groups in the order they take over. */
function BackupGroups({
  groups,
  value,
  onChange,
}: {
  groups: NodeGroup[];
  value: string[];
  onChange: (value: string[]) => void;
}) {
  const remaining = groups.filter((g) => !value.includes(g.id));
  const nameOf = (id: string) => groups.find((g) => g.id === id)?.name ?? id;
  return (
    <FieldSet className="gap-2" data-testid="dns-line-backups">
      <FieldLegend variant="label" className="mb-1">
        {m.dns_backup_groups()}
      </FieldLegend>
      {value.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="dns-line-backup-none">
          {m.dns_backup_none()}
        </p>
      ) : (
        <ol className="flex flex-col gap-2">
          {value.map((id, index) => {
            const name = nameOf(id);
            return (
              <li
                key={id}
                className="flex min-h-10 items-center gap-1 rounded-xl border py-1 pr-1 pl-3 animate-enter"
                data-testid="dns-line-backup"
                data-group={name}
              >
                <span className="w-5 text-xs text-muted-foreground tabular-nums">{index + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{name}</span>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.dns_backup_up({ name })}
                  disabled={index === 0}
                  onClick={() => onChange(arrayMove(value, index, index - 1))}
                >
                  <HugeiconsIcon icon={ArrowUp01Icon} strokeWidth={2} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.dns_backup_down({ name })}
                  disabled={index === value.length - 1}
                  onClick={() => onChange(arrayMove(value, index, index + 1))}
                >
                  <HugeiconsIcon icon={ArrowDown01Icon} strokeWidth={2} />
                </Button>
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={m.dns_backup_remove({ name })}
                  onClick={() => onChange(value.filter((other) => other !== id))}
                >
                  <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
                </Button>
              </li>
            );
          })}
        </ol>
      )}
      {remaining.length && value.length < MAX_BACKUP_GROUPS ? (
        <Select
          value={null}
          onValueChange={(id) => {
            if (id) onChange([...value, String(id)]);
          }}
        >
          <SelectTrigger
            size="sm"
            className="self-start"
            aria-label={m.dns_backup_group_add()}
            data-testid="dns-line-backup-add"
          >
            <SelectValue placeholder={m.dns_backup_group_add()} />
          </SelectTrigger>
          <SelectContent>
            {remaining.map((g) => (
              <SelectItem key={g.id} value={g.id}>
                {g.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </FieldSet>
  );
}

function AddressInput({
  id,
  initial,
  onChange,
}: {
  id: string;
  initial: string[];
  onChange: (values: string[]) => void;
}) {
  const [raw, setRaw] = React.useState(initial.join(", "));
  return (
    <Input
      id={id}
      placeholder={m.dns_auto_address()}
      value={raw}
      onChange={(e) => {
        setRaw(e.target.value);
        onChange(e.target.value.split(/[,\s]+/).filter(Boolean));
      }}
    />
  );
}

function RecordTable({
  records,
  testId,
}: {
  records: { name: string; type: string; data: string; ttl: number; line?: DnsResolutionLine }[];
  testId: string;
}) {
  if (!records.length) return <EmptyState title={m.dns_no_records()} />;
  return (
    <Table data-testid={testId}>
      <TableHeader>
        <TableRow>
          <TableHead>{m.dns_record_name()}</TableHead>
          <TableHead>{m.dns_record_type()}</TableHead>
          <TableHead>{m.dns_resolution_line()}</TableHead>
          <TableHead>{m.dns_record_data()}</TableHead>
          <TableHead>{m.dns_ttl()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {records.map((r) => (
          <TableRow
            key={`${r.name}|${r.type}|${r.line ?? "default"}|${r.data}`}
            data-testid="dns-record"
            data-line={r.line ?? "default"}
          >
            <TableCell className="font-mono text-xs">{r.name}</TableCell>
            <TableCell>{r.type}</TableCell>
            <TableCell className="whitespace-nowrap" data-testid="dns-record-line">
              {resolutionLineLabel(r.line ?? "default")}
            </TableCell>
            <TableCell className="font-mono text-xs">{r.data}</TableCell>
            <TableCell className="tabular-nums">{r.ttl}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function CurrentRecords({ clusterId, state }: { clusterId: string; state: BindingState }) {
  const queries = useQueryClient();
  const repair = useMutation(orpc.dns.reconcile.mutationOptions());
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="flex-1">{m.dns_current_records()}</CardTitle>
        {state.revision ? (
          <Badge variant="outline" data-testid="dns-binding-status">
            {state.applied ? m.dns_applied() : statusLabel(state.revision.status)}
          </Badge>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          disabled={repair.isPending}
          data-testid="dns-reconcile"
          onClick={async () => {
            try {
              await repair.mutateAsync({ clusterId });
              toast.success(m.common_saved());
            } catch (e) {
              toast.error(errorMessage(e));
            } finally {
              await queries.invalidateQueries({ queryKey: orpc.dns.key() });
            }
          }}
        >
          {repair.isPending ? <Spinner /> : null}
          {m.dns_reconcile()}
        </Button>
      </CardHeader>
      <CardContent className="grid gap-3">
        {state.revision?.lastError ? (
          <SafetyNote className="text-destructive">
            {revisionError(state.revision.lastError)}
          </SafetyNote>
        ) : null}
        <RecordTable records={state.records} testId="dns-current-records" />
      </CardContent>
    </Card>
  );
}

function ManualRecords({ clusterId, updatedAt }: { clusterId: string; updatedAt: string }) {
  const exported = useQuery(
    orpc.dns.exportBinding.queryOptions({ input: { clusterId }, meta: { key: updatedAt } }),
  );
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle className="flex-1">{m.dns_manual_records()}</CardTitle>
        {exported.data?.zoneFile ? (
          <Button
            size="sm"
            variant="outline"
            data-testid="dns-download-zone"
            onClick={() => {
              const url = URL.createObjectURL(
                new Blob([exported.data.zoneFile], { type: "text/dns" }),
              );
              const link = document.createElement("a");
              link.href = url;
              link.download = `${exported.data.origin}.zone`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            {m.dns_download_zone()}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="grid gap-4">
        <SafetyNote>{m.dns_manual_note()}</SafetyNote>
        {exported.isPending ? (
          <LoadingState />
        ) : exported.isLoadingError ? (
          <ErrorState error={exported.error} onRetry={() => void exported.refetch()} />
        ) : (
          <>
            <RecordTable records={exported.data.records} testId="dns-manual-records" />
            {exported.data.zoneFile ? (
              <div className="grid gap-2">
                <h3 className="text-sm font-medium">{m.dns_zone_file()}</h3>
                <CodeBlock value={exported.data.zoneFile} testId="dns-zone-file" wrap={false} />
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Revisions({ clusterId }: { clusterId: string }) {
  const queries = useQueryClient();
  const history = useQuery(
    orpc.dns.bindingRevisions.queryOptions({
      input: { clusterId },
      refetchInterval: 10_000,
      meta: { background: true },
    }),
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>{m.dns_revisions()}</CardTitle>
      </CardHeader>
      <CardContent>
        {history.isPending ? (
          <LoadingState />
        ) : history.isLoadingError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : !history.data.length ? (
          <EmptyState title={m.dns_no_revisions()} />
        ) : (
          <Table data-testid="dns-revisions">
            <TableHeader>
              <TableRow>
                <TableHead>{m.dns_version()}</TableHead>
                <TableHead>{m.dns_status()}</TableHead>
                <TableHead>{m.dns_reason()}</TableHead>
                <TableHead>{m.dns_records()}</TableHead>
                <TableHead>{m.dns_time()}</TableHead>
                <TableHead>{m.common_actions()}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {history.data.map((r) => (
                <TableRow key={r.revision}>
                  <TableCell className="font-mono">{r.revision}</TableCell>
                  <TableCell>
                    <span className="flex items-center gap-2">
                      <Badge variant="outline">{statusLabel(r.status)}</Badge>
                      {r.lastError ? (
                        <span className="text-xs text-muted-foreground">
                          {revisionError(r.lastError)}
                        </span>
                      ) : null}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm" data-testid="dns-revision-reason">
                    {dnsRevisionReason(r)}
                  </TableCell>
                  <TableCell className="tabular-nums">{r.recordCount}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {formatDateTime(r.createdAt)}
                  </TableCell>
                  <TableCell>
                    <ConfirmDialog
                      title={m.dns_rollback()}
                      note={m.dns_rollback_note({ revision: r.revision })}
                      trigger={
                        <Button size="sm" variant="outline">
                          {m.dns_rollback()}
                        </Button>
                      }
                      onConfirm={async () => {
                        await client.dns.rollbackBinding({ clusterId, revision: r.revision });
                        await queries.invalidateQueries({ queryKey: orpc.dns.key() });
                      }}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
