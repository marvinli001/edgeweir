import type { DnsBindingInput, DnsLine, Node, NodeGroup } from "@edgeweir/contract";
import { dnsBindingInput } from "@edgeweir/contract";
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
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { formatDateTime, m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";
import { modeLabel, revisionError, statusLabel } from "./labels";

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
  const error = queries.find((q) => q.isError);
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
  providers: { id: string; name: string; zone: string }[];
  groups: NodeGroup[];
  nodes: Node[];
}) {
  const [draft, setDraft] = React.useState(initial),
    [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient();
  const save = useMutation(orpc.dns.saveBinding.mutationOptions());
  const account = providers.find((p) => p.id === draft.providerId);
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
                onChange={(value) =>
                  setDraft({ ...draft, providerId: value === "none" ? null : value })
                }
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
                        },
                      ],
                    })
                  }
                  data-testid="dns-line-add"
                >
                  {m.dns_add_line()}
                </Button>
              </div>
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
                      onChange={(nodeGroupId) => patchLine(index, { nodeGroupId, overrides: [] })}
                    />
                  </div>
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
  records: { name: string; type: string; data: string; ttl: number }[];
  testId: string;
}) {
  if (!records.length) return <EmptyState title={m.dns_no_records()} />;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" data-testid={testId}>
        <thead>
          <tr className="text-muted-foreground">
            <th className="p-2">{m.dns_record_name()}</th>
            <th className="p-2">{m.dns_record_type()}</th>
            <th className="p-2">{m.dns_record_data()}</th>
            <th className="p-2">{m.dns_ttl()}</th>
          </tr>
        </thead>
        <tbody>
          {records.map((r) => (
            <tr key={`${r.name}|${r.type}|${r.data}`} className="border-t">
              <td className="p-2 font-mono text-xs break-all">{r.name}</td>
              <td className="p-2">{r.type}</td>
              <td className="p-2 font-mono text-xs break-all">{r.data}</td>
              <td className="p-2 tabular-nums">{r.ttl}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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
        ) : exported.isError ? (
          <ErrorState error={exported.error} onRetry={() => void exported.refetch()} />
        ) : (
          <>
            <RecordTable records={exported.data.records} testId="dns-manual-records" />
            {exported.data.zoneFile ? (
              <div className="grid gap-2">
                <h3 className="text-sm font-medium">{m.dns_zone_file()}</h3>
                <CodeBlock value={exported.data.zoneFile} testId="dns-zone-file" />
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
        ) : history.isError ? (
          <ErrorState error={history.error} onRetry={() => void history.refetch()} />
        ) : !history.data.length ? (
          <EmptyState title={m.dns_no_revisions()} />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm" data-testid="dns-revisions">
              <thead>
                <tr className="text-muted-foreground">
                  <th className="p-2">{m.dns_version()}</th>
                  <th className="p-2">{m.dns_status()}</th>
                  <th className="p-2">{m.dns_records()}</th>
                  <th className="p-2">{m.dns_time()}</th>
                  <th className="p-2">{m.common_actions()}</th>
                </tr>
              </thead>
              <tbody>
                {history.data.map((r) => (
                  <tr key={r.revision} className="border-t">
                    <td className="p-2 font-mono">{r.revision}</td>
                    <td className="p-2">
                      <span className="flex flex-wrap items-center gap-2">
                        <Badge variant="outline">{statusLabel(r.status)}</Badge>
                        {r.lastError ? (
                          <span className="text-xs text-muted-foreground">
                            {revisionError(r.lastError)}
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="p-2 tabular-nums">{r.recordCount}</td>
                    <td className="p-2 text-xs whitespace-nowrap text-muted-foreground">
                      {formatDateTime(r.createdAt)}
                    </td>
                    <td className="p-2">
                      <ConfirmDialog
                        title={m.dns_rollback()}
                        note={m.dns_rollback_note({ revision: r.revision })}
                        trigger={
                          <Button size="sm" variant="outline">
                            {m.dns_rollback()}
                          </Button>
                        }
                        onConfirm={async () => {
                          try {
                            await client.dns.rollbackBinding({ clusterId, revision: r.revision });
                            await queries.invalidateQueries({ queryKey: orpc.dns.key() });
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
