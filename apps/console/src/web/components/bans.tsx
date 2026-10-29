import type { Ban, BanScope, BanSource } from "@edgeweir/contract";
import { Add01Icon, BlockedIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { AccessTabs } from "@/components/access-tabs";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { BAN_REASON_LABELS, BAN_SCOPE_LABELS, BanDialog } from "@/components/ban-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable, FilterBar } from "@/components/data-table";
import { FilterSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, NoMatch, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { useDialogState } from "@/hooks/use-dialog-state";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import { metricLabel } from "@/lib/protection";

const PAGE_SIZE = 50;

const SOURCES: Record<BanSource, () => string> = {
  manual: () => m.bans_source_manual(),
  auto: () => m.bans_source_auto(),
  rule: () => m.bans_source_rule(),
};

/** Time left until `iso`, rounded down ("3 h left"). */
export function timeLeft(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  if (seconds < 3600) return m.bans_left_minutes({ count: Math.max(1, Math.floor(seconds / 60)) });
  if (seconds < 86400) return m.bans_left_hours({ count: Math.floor(seconds / 3600) });
  return m.bans_left_days({ count: Math.floor(seconds / 86400) });
}

/** "ip_qps 412 / 40, 10 s window": what the node counted; a rate limit's own count has no metric. */
function triggerText(trigger: NonNullable<Ban["trigger"]>): string {
  const counted = m.bans_trigger({
    observed: formatNumber(trigger.observed),
    threshold: formatNumber(trigger.threshold),
    window: trigger.windowSeconds,
  });
  return trigger.metric ? `${metricLabel(trigger.metric)} ${counted}` : counted;
}

/** The rule that banned: its name (a platform rule's marked), or its id once it is deleted. */
function BanRule({ rule }: { rule: NonNullable<Ban["rule"]> }) {
  return rule.name === null ? (
    <span className="min-w-0 text-xs break-all" data-testid="ban-rule" data-rule-id={rule.id}>
      <span className="text-muted-foreground">{m.bans_rule_deleted()}</span>{" "}
      <span className="font-mono">{rule.id}</span>
    </span>
  ) : (
    <span
      className="min-w-0 text-sm font-medium break-all"
      data-testid="ban-rule"
      data-rule-id={rule.id}
    >
      {rule.platform ? m.rules_logged_platform({ name: rule.name }) : rule.name}
    </span>
  );
}

/**
 * Who or what created the ban: the operator, the node and its trigger, or the rule (with the
 * node, and a rate limit's count).
 */
function BanOrigin({ ban }: { ban: Ban }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1">
        <Badge
          size="sm"
          tone={ban.source === "manual" ? "neutral" : "neutral"}
          data-testid="ban-source"
        >
          {SOURCES[ban.source]()}
        </Badge>
        {ban.distributed ? null : (
          <Badge size="sm" tone="neutral">
            {m.bans_not_shared()}
          </Badge>
        )}
      </div>
      {ban.source === "rule" && ban.rule ? <BanRule rule={ban.rule} /> : null}
      {ban.source === "manual" ? (
        <span className="text-xs text-muted-foreground">{ban.createdBy?.name || "—"}</span>
      ) : (
        <span className="text-xs text-muted-foreground" data-testid="ban-node">
          {ban.node?.name || "—"}
          {ban.trigger && (ban.source === "auto" || ban.reason === "rate_limit")
            ? ` · ${triggerText(ban.trigger)}`
            : ""}
        </span>
      )}
    </div>
  );
}

/**
 * The ban's light and the time it has left: in force (lit), or expired since the list was last
 * fetched (the list holds active bans only, so this lasts until the next poll).
 */
function BanExpiry({ expiresAt }: { expiresAt: string }) {
  const expired = Date.parse(expiresAt) <= Date.now();
  return (
    <StatusDot tone={expired ? "idle" : "good"} title={formatDateTime(expiresAt)}>
      <span className={expired ? "text-muted-foreground" : undefined}>
        {expired ? m.bans_expired() : timeLeft(expiresAt)}
      </span>
    </StatusDot>
  );
}

/**
 * Unban with confirmation. A component of its own: column templates are plain
 * functions (DataTable) and hold no hooks.
 */
function UnbanAction({ ban }: { ban: Ban }) {
  const unban = useMutation({
    mutationFn: (id: string) => client.bans.delete({ id }),
    meta: { invalidates: [orpc.bans.key()], success: m.bans_unbanned },
  });
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary" data-testid="ban-unban">
          {m.bans_unban()}
        </Button>
      }
      destructive
      title={m.bans_unban_confirm({ address: ban.cidr })}
      confirmLabel={m.bans_unban()}
      onConfirm={async () => {
        await unban.mutateAsync(ban.id);
      }}
    />
  );
}

/** The bans list's filters and page, kept in the URL (`/bans`). */
export interface BansSearch {
  /** The bans of one site (the site's security tab links here). */
  site?: string;
  /** The bans of an address, and the ban dialog opened with it (and the site). */
  ip?: string;
  source?: BanSource;
  scope?: BanScope;
  page?: number;
}

/**
 * Dynamic IP bans of one site or of every site (platform bans), filtered by `search` (the URL).
 * An address arriving in it (a link from a log row or an event) filters the list by that address
 * and opens the ban dialog with it and the site.
 */
export function BansPage({
  search,
  onSearch,
}: {
  search: BansSearch;
  onSearch: (patch: Partial<BansSearch>) => void;
}) {
  const { site: siteId, ip: address, source, scope } = search;
  const page = search.page ?? 1;
  const setPage = (next: number) => onSearch({ page: next > 1 ? next : undefined });
  // A filter change starts again on the first page.
  const setFilter = (patch: Partial<BansSearch>) => onSearch({ ...patch, page: undefined });
  // The dialog and what it starts with; a link with an address opens it.
  const dialog = useDialogState<{ address?: string; siteId?: string }>(
    address ? { address, siteId } : undefined,
  );
  const linked = React.useRef(address);
  React.useEffect(() => {
    if (address === linked.current) return;
    linked.current = address;
    if (address) dialog.show({ address, siteId });
  }, [address, siteId, dialog.show]);
  const bans = useQuery({
    ...orpc.bans.list.queryOptions({
      input: { scope, siteId, source, address, page, pageSize: PAGE_SIZE },
    }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const sites = useQuery(orpc.sites.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  // Kernel bans see the TCP peer: behind proxies that is the proxy, not the client.
  const clusters = useQuery(orpc.clusters.list.queryOptions());
  const proxied = (clusters.data ?? []).filter((c) => c.clientIpMode !== "direct");
  const filtered = !!(siteId || source || scope || address);

  const columns = React.useMemo<Columns<Ban>>(
    () => [
      {
        id: "address",
        header: () => m.bans_col_address(),
        cell: ({ row }) => (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-sm break-all" data-testid="ban-cidr-cell">
              {row.original.cidr}
            </span>
            {row.original.unappliedNodes > 0 ? (
              <StatusDot tone="warn" data-testid="ban-unapplied">
                {m.bans_unapplied({ count: row.original.unappliedNodes })}
              </StatusDot>
            ) : null}
          </div>
        ),
      },
      {
        id: "site",
        header: () => m.bans_col_site(),
        cell: ({ row }) =>
          row.original.scope === "platform" ? (
            <Badge size="sm" tone="neutral">
              {m.bans_scope_platform()}
            </Badge>
          ) : (
            <span className="font-medium">{row.original.siteName ?? "—"}</span>
          ),
      },
      {
        id: "reason",
        header: () => m.bans_col_reason(),
        cell: ({ row }) => (
          <span className="text-sm">{BAN_REASON_LABELS[row.original.reason]()}</span>
        ),
      },
      {
        id: "source",
        header: () => m.bans_col_source(),
        cell: ({ row }) => <BanOrigin ban={row.original} />,
      },
      {
        id: "expires",
        header: () => m.bans_col_expires(),
        cell: ({ row }) => <BanExpiry expiresAt={row.original.expiresAt} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <UnbanAction ban={row.original} />
          </div>
        ),
      },
    ],
    [],
  );

  const createButton = (
    <Button onClick={() => dialog.show({})} data-testid="ban-create">
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {m.bans_create()}
    </Button>
  );

  return (
    <Page title={m.bans_title()} actions={createButton}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <AccessTabs value="bans" />
        {/* Narrow: scope and source share a row, the site picker and an address get their own. */}
        <FilterBar className="grid w-full grid-flow-dense grid-cols-2 sm:flex @3xl/main:w-auto">
          <FilterSelect
            value={scope}
            onChange={(value) => setFilter({ scope: value as BanScope | undefined })}
            allLabel={m.bans_all_scopes()}
            options={(["platform", "site"] as const).map((value) => ({
              value,
              label: BAN_SCOPE_LABELS[value](),
            }))}
            label={m.bans_filter_scope()}
            testId="ban-filter-scope"
          />
          <FilterSelect
            value={siteId}
            onChange={(value) => setFilter({ site: value })}
            allLabel={m.bans_all_sites()}
            options={(sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
            label={m.bans_filter_site()}
            testId="ban-filter-site"
            className="col-span-2 w-full sm:w-48"
          />
          <FilterSelect
            value={source}
            onChange={(value) => setFilter({ source: value as BanSource | undefined })}
            allLabel={m.bans_all_sources()}
            options={(["manual", "auto", "rule"] as const).map((value) => ({
              value,
              label: SOURCES[value](),
            }))}
            label={m.bans_filter_source()}
            testId="ban-filter-source"
          />
          {address ? (
            <Badge
              size="sm"
              tone="neutral"
              className="col-span-2 h-8 gap-1 pr-1 pl-3 font-mono"
              data-testid="ban-filter-address"
            >
              {address}
              <Button
                className="icon-button size-6 min-h-6"
                type="button"
                size="sm"
                variant="ghost"
                aria-label={m.bans_address_filter_clear()}
                onClick={() => setFilter({ ip: undefined })}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </Badge>
          ) : null}
        </FilterBar>
      </div>
      {proxied.length ? (
        <SafetyNote className="animate-enter" data-testid="bans-kernel-peer-note">
          {m.bans_kernel_peer_note({ clusters: proxied.map((c) => c.name).join(", ") })}
        </SafetyNote>
      ) : null}
      <QueryView
        query={bans}
        isEmpty={(data) => data.total === 0}
        empty={
          filtered ? (
            <NoMatch
              title={m.bans_no_match()}
              onClear={() =>
                setFilter({ site: undefined, ip: undefined, source: undefined, scope: undefined })
              }
            />
          ) : (
            <EmptyState icon={BlockedIcon} title={m.bans_empty()}>
              <Button onClick={() => dialog.show({})}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.bans_create()}
              </Button>
            </EmptyState>
          )
        }
      >
        {({ items, total }) => (
          <DataTable
            data={items}
            columns={columns}
            getRowId={(ban) => ban.id}
            testId="bans-table"
            pinFirstColumn
            total={total}
            footer={<Pager page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />}
          />
        )}
      </QueryView>
      {dialog.value ? (
        <BanDialog
          key={dialog.key}
          address={dialog.value.address}
          siteId={dialog.value.siteId}
          open={dialog.open}
          onOpenChange={dialog.onOpenChange}
        />
      ) : null}
    </Page>
  );
}
