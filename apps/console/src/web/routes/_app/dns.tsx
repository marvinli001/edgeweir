import type { DnsRevision } from "@edgeweir/contract";
import { Add01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { CardTable } from "@/components/clusters/card-table";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  CapabilityBadges,
  DnsCredentialDialog,
  type EditableCredential,
  useDnsCatalog,
} from "@/components/dns/credential-dialog";
import { modeLabel, providerLabel, revisionError, statusLabel } from "@/components/dns/labels";
import { DnsProtectionCard } from "@/components/dns-protection";
import { enterDelay, Page } from "@/components/page";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { StatusDot, type StatusTone } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useDialogState } from "@/hooks/use-dialog-state";
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
  const credential = useDialogState<EditableCredential | "new">();
  const refresh = () => queries.invalidateQueries({ queryKey: orpc.dns.key() });
  return (
    <Page
      title={m.dns_title()}
      actions={
        <Button onClick={() => credential.show("new")} data-testid="dns-account-create">
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.dns_add_account()}
        </Button>
      }
    >
      <QueryView query={combineQueries(providers, bindings, catalog)}>
        {([providerList, bindingList, catalogList]) => (
          <>
            <Card className="animate-enter">
              <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>{m.dns_accounts()}</CardTitle>
                {providerList.items.length ? <Count value={providerList.items.length} /> : null}
              </CardHeader>
              <CardContent>
                {!providerList.items.length ? (
                  <EmptyState title={m.dns_accounts_empty()}>
                    <Button onClick={() => credential.show("new")}>
                      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                      {m.dns_add_account()}
                    </Button>
                  </EmptyState>
                ) : (
                  <ul className="-my-1 divide-y divide-edge" data-testid="dns-accounts">
                    {providerList.items.map((p, index) => (
                      <li
                        key={p.id}
                        className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3 animate-enter"
                        style={enterDelay(index, 40)}
                      >
                        <span className="flex w-full flex-wrap items-center gap-2 text-sm @3xl/main:w-auto @3xl/main:min-w-48 @3xl/main:flex-1">
                          <span className="font-medium break-all">{p.name}</span>
                          <ValueWell>{p.zone}</ValueWell>
                        </span>
                        <span className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline">{providerLabel(p.provider)}</Badge>
                          <CapabilityBadges
                            provider={catalogList.find((c) => c.id === p.provider)}
                          />
                        </span>
                        <span className="flex items-center gap-1">
                          <TestButton id={p.id} />
                          <Button size="sm" variant="outline" onClick={() => credential.show(p)}>
                            {m.common_edit()}
                          </Button>
                          <ConfirmDialog
                            title={m.common_delete()}
                            note={p.zone}
                            destructive
                            trigger={
                              <Button size="sm" variant="destructive">
                                {m.common_delete()}
                              </Button>
                            }
                            onConfirm={async () => {
                              await client.dns.deleteProvider({ id: p.id });
                              await refresh();
                            }}
                          />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>
            <Card className="pb-0 animate-enter" style={enterDelay(1, 60)}>
              <CardHeader className="flex flex-row items-center gap-2">
                <CardTitle>{m.dns_bindings()}</CardTitle>
                {bindingList.length ? <Count value={bindingList.length} /> : null}
              </CardHeader>
              {!bindingList.length ? (
                <CardContent className="pb-(--card-spacing)">
                  <EmptyState art="node" title={m.clusters_empty_title()} />
                </CardContent>
              ) : (
                <CardTable pinFirstColumn>
                  <Table data-testid="dns-bindings">
                    <TableHeader>
                      <TableRow>
                        <TableHead className="cell-pinned">{m.dns_cluster()}</TableHead>
                        <TableHead>{m.dns_mode()}</TableHead>
                        <TableHead>{m.dns_cluster_domain()}</TableHead>
                        <TableHead>{m.dns_status()}</TableHead>
                        <TableHead>
                          <span className="sr-only">{m.common_actions()}</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {bindingList.map((b) => (
                        <TableRow key={b.clusterId}>
                          <TableCell className="cell-pinned font-medium">{b.clusterName}</TableCell>
                          <TableCell>
                            <Badge variant={b.mode === "off" ? "outline" : "secondary"}>
                              {modeLabel(b.mode)}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            {b.domain ? <ValueWell>{b.domain}</ValueWell> : "—"}
                          </TableCell>
                          <TableCell>
                            {b.mode === "auto" && b.revision ? (
                              <span className="flex items-center gap-2">
                                <BindingState
                                  blocked={!!b.blocked}
                                  applied={b.applied}
                                  status={b.revision.status}
                                />
                                {b.revision.lastError && !b.blocked ? (
                                  <span className="text-xs text-muted-foreground">
                                    {revisionError(
                                      b.revision.lastError,
                                      b.revision.lastErrorParams,
                                    )}
                                  </span>
                                ) : null}
                              </span>
                            ) : null}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              size="sm"
                              variant="ghost"
                              nativeButton={false}
                              render={
                                <Link
                                  to="/clusters"
                                  search={{ cluster: b.clusterId, tab: "dns" }}
                                />
                              }
                            >
                              {m.dns_open_cluster()}
                              <HugeiconsIcon icon={ArrowRight01Icon} strokeWidth={2} />
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardTable>
              )}
            </Card>
            <DnsProtectionCard />
          </>
        )}
      </QueryView>
      {credential.value ? (
        <DnsCredentialDialog
          key={credential.key}
          scope="account"
          initial={credential.value === "new" ? undefined : credential.value}
          testEnabled={providers.data?.testEnabled ?? false}
          open={credential.open}
          onOpenChange={credential.onOpenChange}
          onSaved={async () => {
            await refresh();
          }}
        />
      ) : null}
    </Page>
  );
}

/** A machine value (zone, cluster domain) in a small well. */
function ValueWell({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex max-w-full rounded-md bg-well px-1.5 py-0.5 font-mono text-xs break-all text-foreground">
      {children}
    </span>
  );
}

function Count({ value }: { value: number }) {
  return (
    <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-wash px-1.5 text-xs font-medium tabular-nums text-muted-foreground">
      {value}
    </span>
  );
}

/** A binding's publication as a light and a word: held back, published, or on its way. */
function BindingState({
  blocked,
  applied,
  status,
}: {
  blocked: boolean;
  applied: boolean;
  status: DnsRevision["status"];
}) {
  const tone: StatusTone = blocked
    ? "bad"
    : applied || status === "applied"
      ? "good"
      : status === "failed"
        ? "bad"
        : status === "pending"
          ? "warn"
          : "idle";
  return (
    <StatusDot tone={tone} pulse={!blocked && !applied && status === "pending"}>
      {blocked ? m.dns_blocked() : applied ? m.dns_applied() : statusLabel(status)}
    </StatusDot>
  );
}

function TestButton({ id }: { id: string }) {
  const [pending, setPending] = React.useState(false);
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      data-testid="dns-account-test"
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
      {pending ? <Spinner /> : null}
      {m.dns_test_connection()}
    </Button>
  );
}
