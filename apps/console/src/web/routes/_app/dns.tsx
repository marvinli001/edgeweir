import type { DnsRevision } from "@edgeweir/contract";
import { Add01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { DropdownMenuItem } from "@/components/arc/dropdown-menu/dropdown-menu";
import { CardTable } from "@/components/clusters/card-table";
import {
  CapabilityBadges,
  DnsCredentialDialog,
  type EditableCredential,
  useDnsCatalog,
} from "@/components/dns/credential-dialog";
import { modeLabel, providerLabel, revisionError, statusLabel } from "@/components/dns/labels";
import { DnsProtectionCard } from "@/components/dns-protection";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/layout/table";
import { enterDelay, Page } from "@/components/page";
import { ItemMenu } from "@/components/row-menu";
import { combineQueries, EmptyState, QueryView } from "@/components/states";
import { StatusDot, type StatusTone } from "@/components/status-dot";
import { useDialogState } from "@/hooks/use-dialog-state";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import { rowActivationHandlers, rowClickable, rowLink, rowLinkButton } from "@/lib/row-link";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/utils";

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
        {([providerList, bindingList, catalogList]) => {
          const anyDomain = bindingList.some((b) => b.domain);
          return (
            <>
              <Panel className="animate-enter">
                <PanelHeader className="flex flex-row items-center gap-2">
                  <PanelTitle>{m.dns_accounts()}</PanelTitle>
                  {providerList.items.length ? <Count value={providerList.items.length} /> : null}
                </PanelHeader>
                <PanelContent>
                  {!providerList.items.length ? (
                    <EmptyState compact title={m.dns_accounts_empty()}>
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
                          className={cn(
                            "-mx-3 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-md px-3 py-3 animate-enter",
                            rowClickable,
                          )}
                          style={enterDelay(index, 40)}
                          {...rowActivationHandlers}
                        >
                          <span className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm @3xl/main:min-w-48">
                            <button
                              type="button"
                              className={cn(rowLinkButton, "font-medium [overflow-wrap:anywhere]")}
                              onClick={() => credential.show(p)}
                              {...rowLink}
                            >
                              {p.name}
                            </button>
                            <ValueWell>{p.zone}</ValueWell>
                          </span>
                          <span className="flex flex-wrap items-center gap-1.5">
                            <Badge size="sm" tone="neutral">
                              {providerLabel(p.provider)}
                            </Badge>
                            <CapabilityBadges
                              provider={catalogList.find((c) => c.id === p.provider)}
                            />
                          </span>
                          <AccountMenu
                            id={p.id}
                            zone={p.zone}
                            onDelete={async () => {
                              await client.dns.deleteProvider({ id: p.id });
                              await refresh();
                            }}
                          />
                        </li>
                      ))}
                    </ul>
                  )}
                </PanelContent>
              </Panel>
              <Panel className="pb-0 animate-enter" style={enterDelay(1, 60)}>
                <PanelHeader className="flex flex-row items-center gap-2">
                  <PanelTitle>{m.dns_bindings()}</PanelTitle>
                  {bindingList.length ? <Count value={bindingList.length} /> : null}
                </PanelHeader>
                {!bindingList.length ? (
                  <PanelContent className="pb-(--panel-pad)">
                    <EmptyState title={m.clusters_empty_title()} />
                  </PanelContent>
                ) : (
                  <CardTable pinFirstColumn>
                    <Table data-testid="dns-bindings">
                      <TableHeader>
                        <TableRow>
                          <TableHead className="cell-pinned">{m.dns_cluster()}</TableHead>
                          {anyDomain ? <TableHead>{m.dns_cluster_domain()}</TableHead> : null}
                          <TableHead>{m.dns_status()}</TableHead>
                          <TableHead>
                            <span className="sr-only">{m.common_actions()}</span>
                          </TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {bindingList.map((b) => (
                          <TableRow key={b.clusterId}>
                            <TableCell className="cell-pinned font-medium">
                              <Link
                                to="/clusters"
                                search={{ cluster: b.clusterId, tab: "dns" }}
                                className="rounded-sm underline-offset-4 outline-none focus-ring hover:underline"
                                data-testid="dns-binding-open"
                                {...rowLink}
                              >
                                {b.clusterName}
                              </Link>
                            </TableCell>
                            {anyDomain ? (
                              <TableCell>
                                {b.domain ? (
                                  <ValueWell>{b.domain}</ValueWell>
                                ) : (
                                  <span className="text-muted-foreground">—</span>
                                )}
                              </TableCell>
                            ) : null}
                            <TableCell>
                              {b.mode === "auto" && b.revision ? (
                                <span className="flex flex-wrap items-center gap-2">
                                  <BindingState
                                    blocked={!!b.blocked}
                                    applied={b.applied}
                                    status={b.revision.status}
                                  />
                                  {b.blocked ? (
                                    <span className="text-xs text-muted-foreground">
                                      {m.dns_blocked_hint()}
                                    </span>
                                  ) : null}
                                  {b.revision.lastError && !b.blocked ? (
                                    <span className="text-xs text-muted-foreground">
                                      {revisionError(
                                        b.revision.lastError,
                                        b.revision.lastErrorParams,
                                      )}
                                    </span>
                                  ) : null}
                                </span>
                              ) : (
                                // Not managed, kept by hand, or automatic before its first
                                // publication: the mode is the state.
                                <StatusDot tone="idle">{modeLabel(b.mode)}</StatusDot>
                              )}
                            </TableCell>
                            <TableCell className="w-10 text-right text-muted-foreground">
                              <HugeiconsIcon
                                icon={ArrowRight01Icon}
                                strokeWidth={2}
                                className="ml-auto size-4"
                              />
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </CardTable>
                )}
              </Panel>
              <DnsProtectionCard />
            </>
          );
        }}
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
    <span className="inline-flex max-w-full rounded-md bg-well px-1.5 py-0.5 font-mono text-xs [overflow-wrap:anywhere] text-foreground">
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

/** An account's menu: test the connection (a toast says how it went), delete. */
function AccountMenu({
  id,
  zone,
  onDelete,
}: {
  id: string;
  zone: string;
  onDelete: () => Promise<unknown>;
}) {
  const test = useMutation({
    ...orpc.dns.testProvider.mutationOptions(),
    meta: { toastError: true },
    onSuccess: (result) => toast.success(m.dns_test_ok({ records: result.records })),
  });
  return (
    <ItemMenu
      testId="dns-account-actions"
      remove={{ title: m.common_delete(), note: zone, onConfirm: onDelete }}
    >
      <DropdownMenuItem
        disabled={test.isPending}
        data-testid="dns-account-test"
        onClick={() => test.mutate({ id })}
      >
        {m.dns_test_connection()}
      </DropdownMenuItem>
    </ItemMenu>
  );
}
