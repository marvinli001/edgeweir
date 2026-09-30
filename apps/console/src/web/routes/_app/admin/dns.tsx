import {
  type Cluster,
  type DnsPolicy,
  type DnsProviderInput,
  type DnsRevision,
  dnsPolicy,
  dnsProviderKind,
  type Node,
  type NodeGroup,
} from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DnsHeldBack, DnsProtectionCard } from "@/components/dns-protection";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
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

type EditableProvider = {
  id: string;
  name: string;
  zone: string;
  provider: DnsProviderInput["provider"];
};
export const Route = createFileRoute("/_app/admin/dns")({ component: DnsPage });
const providerLabel = (value: DnsProviderInput["provider"]) =>
  ({
    cloudflare: m.cert_dns_cloudflare,
    alidns: m.cert_dns_alidns,
    huaweicloud: m.cert_dns_huawei,
    dnspod: m.cert_dns_dnspod,
    test: m.dns_test_provider,
  })[value]?.() ?? value;
const statusLabel = (value: DnsRevision["status"]) =>
  ({
    pending: m.dns_pending,
    applied: m.dns_applied,
    failed: m.dns_failed,
    superseded: m.dns_superseded,
    blocked: m.dns_blocked,
  })[value]?.() ?? value;
function DnsPage() {
  const providers = useQuery(orpc.dns.providers.queryOptions()),
    config = useQuery(
      orpc.dns.get.queryOptions({ refetchInterval: 10000, meta: { background: true } }),
    ),
    history = useQuery(
      orpc.dns.revisions.queryOptions({ refetchInterval: 10000, meta: { background: true } }),
    );
  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: {} })),
    nodes = useQuery(orpc.nodes.list.queryOptions({ input: {} })),
    clusters = useQuery(orpc.clusters.list.queryOptions());
  const queries = useQueryClient(),
    [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<EditableProvider | null>(null);
  const repair = useMutation(orpc.dns.reconcile.mutationOptions());
  const refresh = async () => {
    await queries.invalidateQueries();
  };
  const ready = providers.data && config.data && groups.data && nodes.data && clusters.data;
  const error = [providers, config, groups, nodes, clusters].find((q) => q.isError);
  return (
    <Page
      title={m.dns_title()}
      actions={
        <>
          <Button
            variant="outline"
            disabled={repair.isPending}
            onClick={async () => {
              try {
                await repair.mutateAsync({});
                await refresh();
                toast.success(m.common_saved());
              } catch (e) {
                toast.error(errorMessage(e));
              }
            }}
            data-testid="dns-reconcile"
          >
            {repair.isPending ? <Spinner /> : null}
            {m.dns_reconcile()}
          </Button>
          <Button onClick={() => setCreating(true)} data-testid="dns-provider-create">
            {m.dns_add_provider()}
          </Button>
        </>
      }
    >
      {error ? (
        <ErrorState error={error.error} onRetry={() => void refresh()} />
      ) : !ready ? (
        <LoadingState />
      ) : (
        <>
          {config.data.blocked ? <DnsHeldBack blocked={config.data.blocked} /> : null}
          <Card>
            <CardHeader>
              <CardTitle>{m.dns_providers()}</CardTitle>
            </CardHeader>
            <CardContent>
              {!providers.data.items.length ? (
                <EmptyState title={m.cert_dns_empty()} />
              ) : (
                <ul className="divide-y">
                  {providers.data.items.map((p) => (
                    <li key={p.id} className="flex flex-wrap items-center gap-3 py-3">
                      <span className="min-w-0 flex-1 break-all text-sm">
                        <span>{p.name}</span>
                        <span className="ml-2 text-muted-foreground">{p.zone}</span>
                      </span>
                      <Badge variant="outline">{providerLabel(p.provider)}</Badge>
                      <Button size="sm" variant="outline" onClick={() => setEditing(p)}>
                        {m.common_edit()}
                      </Button>
                      <ConfirmDialog
                        title={m.common_delete()}
                        note={p.zone}
                        destructive
                        trigger={
                          <Button size="sm" variant="outline">
                            {m.common_delete()}
                          </Button>
                        }
                        onConfirm={async () => {
                          try {
                            await client.dns.deleteProvider({ id: p.id });
                            await refresh();
                          } catch (e) {
                            toast.error(errorMessage(e));
                          }
                        }}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
          <PolicyEditor
            key={JSON.stringify(config.data.policy)}
            initial={config.data.policy}
            providers={providers.data.items}
            groups={groups.data}
            nodes={nodes.data}
            clusters={clusters.data}
          />
          <DnsProtectionCard />
        </>
      )}
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
              <table className="w-full text-left text-sm">
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
                        <Badge variant="outline">{statusLabel(r.status)}</Badge>
                      </td>
                      <td className="p-2 tabular-nums">{r.recordCount}</td>
                      <td className="p-2 whitespace-nowrap text-xs text-muted-foreground">
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
                              await client.dns.rollback({ revision: r.revision });
                              await refresh();
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
      {creating || editing ? (
        <ProviderDialog
          initial={editing ?? undefined}
          testEnabled={providers.data?.testEnabled ?? false}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={refresh}
        />
      ) : null}
    </Page>
  );
}
function PolicyEditor({
  initial,
  providers,
  groups,
  nodes,
  clusters,
}: {
  initial: DnsPolicy;
  providers: { id: string; name: string; zone: string }[];
  groups: NodeGroup[];
  nodes: Node[];
  clusters: Cluster[];
}) {
  const [draft, setDraft] = React.useState(initial),
    [error, setError] = React.useState<string | null>(null);
  const queries = useQueryClient();
  const save = useMutation(orpc.dns.save.mutationOptions());
  const patchLine = (index: number, change: Partial<DnsPolicy["lines"][number]>) =>
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
          try {
            const parsed = dnsPolicy.safeParse(draft);
            if (!parsed.success) {
              setError(m.error_dns_policy_invalid());
              return;
            }
            const result = await save.mutateAsync(parsed.data);
            await queries.invalidateQueries();
            toast.success(m.dns_saved({ revision: result.revision }));
          } catch (e) {
            setError(errorMessage(e));
          }
        }}
      >
        <CardHeader>
          <CardTitle>{m.dns_policy()}</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-5">
          <SwitchField
            id="dns-enabled"
            label={m.rules_enabled()}
            checked={draft.enabled}
            onCheckedChange={(enabled) => setDraft({ ...draft, enabled })}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <FormSelect
              id="dns-selected-provider"
              label={m.cert_dns_provider()}
              value={draft.providerId ?? "none"}
              options={[
                { value: "none", label: m.cert_none() },
                ...providers.map((p) => ({ value: p.id, label: `${p.name} · ${p.zone}` })),
              ]}
              onChange={(value) =>
                setDraft({ ...draft, providerId: value === "none" ? null : value })
              }
            />
            <Field>
              <FieldLabel htmlFor="dns-suffix">{m.dns_cname_domain()}</FieldLabel>
              <Input
                id="dns-suffix"
                value={draft.cnameSuffix}
                onChange={(e) => setDraft({ ...draft, cnameSuffix: e.target.value })}
              />
            </Field>
            <NumberField
              id="dns-ttl"
              label={m.dns_ttl()}
              value={String(draft.ttl)}
              min={30}
              max={3600}
              onChange={(ttl) => setDraft({ ...draft, ttl: Number(ttl) })}
            />
          </div>
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
                        groups.find((g) => !draft.lines.some((line) => line.nodeGroupId === g.id))
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
              key={line.nodeGroupId}
              className="grid gap-4 rounded-xl border p-4 animate-enter"
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
                    .map((g) => ({
                      value: g.id,
                      label: `${clusters.find((c) => c.id === g.clusterId)?.name ?? ""} / ${g.name}`,
                    }))}
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
                      onChange={(addresses) => {
                        patchLine(index, {
                          overrides: [
                            ...line.overrides.filter((o) => o.nodeId !== n.id),
                            ...(addresses.length ? [{ nodeId: n.id, addresses }] : []),
                          ],
                        });
                      }}
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
        </CardContent>
        <SaveBar
          dirty={JSON.stringify(draft) !== JSON.stringify(initial)}
          pending={save.isPending}
          error={error}
          testId="dns-policy-save"
        />
      </form>
    </Card>
  );
}
function ProviderDialog({
  testEnabled,
  onClose,
  onSaved,
  initial,
}: {
  testEnabled: boolean;
  initial?: EditableProvider;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [provider, setProvider] = React.useState(initial?.provider ?? "cloudflare");
  const mutation = useMutation(orpc.dns.createProvider.mutationOptions());
  const update = useMutation(orpc.dns.updateProvider.mutationOptions());
  const fields: Record<string, string[]> = {
    cloudflare: ["api_token"],
    alidns: ["access_key_id", "access_key_secret"],
    huaweicloud: ["access_key_id", "secret_access_key", "region_id"],
    dnspod: ["auth_token"],
    test: ["api_token"],
  };
  const labels: Record<string, () => string> = {
    api_token: m.cert_api_token,
    auth_token: m.cert_api_token,
    access_key_id: m.cert_access_id,
    access_key_secret: m.cert_access_secret,
    secret_access_key: m.cert_access_secret,
    region_id: m.cert_region,
  };
  return (
    <FormDialog
      open
      title={initial ? m.common_edit() : m.dns_add_provider()}
      submitLabel={initial ? m.common_save() : m.common_create()}
      submitTestId="dns-provider-submit"
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      onSubmit={async (data) => {
        const credentials = Object.fromEntries(
          (fields[provider] ?? []).map((key) => [key, String(data.get(key))]),
        );
        if (initial)
          await update.mutateAsync({
            id: initial.id,
            name: String(data.get("dns-provider-name")),
            credentials,
          });
        else
          await mutation.mutateAsync({
            name: String(data.get("dns-provider-name")),
            zone: String(data.get("dns-provider-zone")),
            provider: dnsProviderKind.parse(provider),
            credentials,
          });
        await onSaved();
        onClose();
      }}
    >
      <Field>
        <FieldLabel htmlFor="dns-provider-name">{m.cert_name()}</FieldLabel>
        <Input
          id="dns-provider-name"
          name="dns-provider-name"
          required
          defaultValue={initial?.name}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="dns-provider-zone">{m.cert_dns_zone()}</FieldLabel>
        <Input
          id="dns-provider-zone"
          name="dns-provider-zone"
          required
          defaultValue={initial?.zone}
          disabled={!!initial}
        />
      </Field>
      <FormSelect
        id="dns-provider-kind"
        disabled={!!initial}
        label={m.cert_dns_provider()}
        value={provider}
        onChange={(value) => setProvider(dnsProviderKind.parse(value))}
        options={dnsProviderKind.options
          .filter((kind) => kind !== "test" || testEnabled)
          .map((kind) => ({ value: kind, label: providerLabel(kind) }))}
      />
      {(fields[provider] ?? []).map((key) => (
        <Field key={`${provider}-${key}`}>
          <FieldLabel htmlFor={key}>{labels[key]?.()}</FieldLabel>
          <Input
            id={key}
            name={key}
            required
            type={key === "region_id" ? "text" : "password"}
            autoComplete="off"
          />
        </Field>
      ))}
    </FormDialog>
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
