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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/dns")({ component: DnsPage });

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
  const error = [providers, bindings, catalog].find((q) => q.isLoadingError);
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
                      <span className="min-w-48 flex-1 text-sm break-words">
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
                          await client.dns.deleteProvider({ id: p.id });
                          await refresh();
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
                <Table data-testid="dns-bindings">
                  <TableHeader>
                    <TableRow>
                      <TableHead>{m.dns_cluster()}</TableHead>
                      <TableHead>{m.dns_mode()}</TableHead>
                      <TableHead>{m.dns_cluster_domain()}</TableHead>
                      <TableHead>{m.dns_status()}</TableHead>
                      <TableHead>{m.common_actions()}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {bindings.data.map((b) => (
                      <TableRow key={b.clusterId}>
                        <TableCell>{b.clusterName}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{modeLabel(b.mode)}</Badge>
                        </TableCell>
                        <TableCell className="font-mono text-xs">{b.domain}</TableCell>
                        <TableCell>
                          {b.mode === "auto" && b.revision ? (
                            <span className="flex items-center gap-2">
                              <Badge variant={b.blocked ? "destructive" : "outline"}>
                                {b.blocked
                                  ? m.dns_blocked()
                                  : b.applied
                                    ? m.dns_applied()
                                    : statusLabel(b.revision.status)}
                              </Badge>
                              {b.revision.lastError && !b.blocked ? (
                                <span className="text-xs text-muted-foreground">
                                  {revisionError(b.revision.lastError, b.revision.lastErrorParams)}
                                </span>
                              ) : null}
                            </span>
                          ) : null}
                        </TableCell>
                        <TableCell>
                          <Button
                            size="sm"
                            variant="outline"
                            render={
                              <Link to="/clusters" search={{ cluster: b.clusterId, tab: "dns" }} />
                            }
                          >
                            {m.dns_open_cluster()}
                          </Button>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
          <DnsProtectionCard />
        </>
      )}
      {creating || editing ? (
        <DnsCredentialDialog
          scope="account"
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
