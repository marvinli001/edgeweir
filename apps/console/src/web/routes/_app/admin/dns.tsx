import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  CapabilityBadges,
  DnsCredentialDialog,
  type EditableCredential,
  useDnsCatalog,
} from "@/components/dns/credential-dialog";
import { modeLabel, providerLabel, revisionError, statusLabel } from "@/components/dns/labels";
import { DnsProtectionCard } from "@/components/dns-protection";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/admin/dns")({ component: DnsPage });

function DnsPage() {
  const providers = useQuery(orpc.dns.providers.queryOptions());
  const bindings = useQuery(
    orpc.dns.bindings.queryOptions({ refetchInterval: 10_000, meta: { background: true } }),
  );
  const catalog = useDnsCatalog();
  const queries = useQueryClient();
  const [creating, setCreating] = React.useState(false);
  const [editing, setEditing] = React.useState<EditableCredential | null>(null);
  const refresh = () => queries.invalidateQueries({ queryKey: orpc.dns.key() });
  const error = [providers, bindings, catalog].find((q) => q.isError);
  return (
    <Page
      title={m.dns_title()}
      actions={
        <Button onClick={() => setCreating(true)} data-testid="dns-account-create">
          {m.dns_add_account()}
        </Button>
      }
    >
      {error ? (
        <ErrorState error={error.error} onRetry={() => void refresh()} />
      ) : !providers.data || !bindings.data || !catalog.data ? (
        <LoadingState />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>{m.dns_accounts()}</CardTitle>
            </CardHeader>
            <CardContent>
              {!providers.data.items.length ? (
                <EmptyState title={m.dns_accounts_empty()}>
                  <Button onClick={() => setCreating(true)}>{m.dns_add_account()}</Button>
                </EmptyState>
              ) : (
                <ul className="divide-y" data-testid="dns-accounts">
                  {providers.data.items.map((p, index) => (
                    <li
                      key={p.id}
                      className="flex flex-wrap items-center gap-3 py-3 animate-enter"
                      style={{ animationDelay: `${index * 40}ms` }}
                    >
                      <span className="min-w-0 flex-1 text-sm break-all">
                        <span>{p.name}</span>
                        <span className="ml-2 text-muted-foreground">{p.zone}</span>
                      </span>
                      <Badge variant="outline">{providerLabel(p.provider)}</Badge>
                      <CapabilityBadges provider={catalog.data.find((c) => c.id === p.provider)} />
                      <TestButton id={p.id} />
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
          <Card>
            <CardHeader>
              <CardTitle>{m.dns_bindings()}</CardTitle>
            </CardHeader>
            <CardContent>
              {!bindings.data.length ? (
                <EmptyState title={m.clusters_empty_title()} />
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm" data-testid="dns-bindings">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="p-2">{m.dns_cluster()}</th>
                        <th className="p-2">{m.dns_mode()}</th>
                        <th className="p-2">{m.dns_cluster_domain()}</th>
                        <th className="p-2">{m.dns_status()}</th>
                        <th className="p-2">{m.common_actions()}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bindings.data.map((b) => (
                        <tr key={b.clusterId} className="border-t">
                          <td className="p-2">{b.clusterName}</td>
                          <td className="p-2">
                            <Badge variant="outline">{modeLabel(b.mode)}</Badge>
                          </td>
                          <td className="p-2 font-mono text-xs break-all">{b.domain}</td>
                          <td className="p-2">
                            {b.mode === "auto" && b.revision ? (
                              <span className="flex flex-wrap items-center gap-2">
                                <Badge variant={b.blocked ? "destructive" : "outline"}>
                                  {b.blocked
                                    ? m.dns_blocked()
                                    : b.applied
                                      ? m.dns_applied()
                                      : statusLabel(b.revision.status)}
                                </Badge>
                                {b.revision.lastError && !b.blocked ? (
                                  <span className="text-xs text-muted-foreground">
                                    {revisionError(b.revision.lastError)}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                          </td>
                          <td className="p-2">
                            <Button
                              size="sm"
                              variant="outline"
                              render={
                                <Link
                                  to="/admin/clusters"
                                  search={{ cluster: b.clusterId, tab: "dns" }}
                                />
                              }
                            >
                              {m.dns_open_cluster()}
                            </Button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardContent>
          </Card>
          <DnsProtectionCard />
        </>
      )}
      {creating || editing ? (
        <DnsCredentialDialog
          scope="platform"
          initial={editing ?? undefined}
          testEnabled={providers.data?.testEnabled ?? false}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={async () => {
            await refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

function TestButton({ id }: { id: string }) {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={async () => {
        setPending(true);
        try {
          const result = await client.dns.testProvider({ id });
          toast.success(m.dns_test_ok({ records: result.records }));
        } catch (e) {
          toast.error(errorMessage(e));
        } finally {
          setPending(false);
        }
      }}
    >
      {m.dns_test_connection()}
    </Button>
  );
}
