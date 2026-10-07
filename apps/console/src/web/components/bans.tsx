import type { Ban, BanScope, BanSource } from "@edgeweir/contract";
import { Add01Icon, BlockedIcon, Cancel01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { AccessTabs } from "@/components/access-tabs";
import { BAN_REASON_LABELS, BAN_SCOPE_LABELS, BanDialog } from "@/components/ban-dialog";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable, FilterBar } from "@/components/data-table";
import { FilterSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { EmptyState, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useDialogState } from "@/hooks/use-dialog-state";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";

const PAGE_SIZE = 50;

const SOURCES: Record<BanSource, () => string> = {
  manual: () => m.bans_source_manual(),
  auto: () => m.bans_source_auto(),
};

/** Time left until `iso`, rounded down ("3 h left"). */
function timeLeft(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  if (seconds < 3600) return m.bans_left_minutes({ count: Math.max(1, Math.floor(seconds / 60)) });
  if (seconds < 86400) return m.bans_left_hours({ count: Math.floor(seconds / 3600) });
  return m.bans_left_days({ count: Math.floor(seconds / 86400) });
}

/** Who or what created the ban: the operator, or the node and its trigger. */
function BanOrigin({ ban }: { ban: Ban }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <div className="flex flex-wrap items-center gap-1">
        <Badge variant={ban.source === "auto" ? "secondary" : "outline"} data-testid="ban-source">
          {SOURCES[ban.source]()}
        </Badge>
        {ban.distributed ? null : <Badge variant="outline">{m.bans_not_shared()}</Badge>}
      </div>
      {ban.source === "auto" ? (
        <span className="text-xs text-muted-foreground">
          {ban.node?.name || "—"}
          {ban.trigger
            ? ` · ${ban.trigger.metric} ${m.bans_trigger({
                observed: formatNumber(ban.trigger.observed),
                threshold: formatNumber(ban.trigger.threshold),
                window: ban.trigger.windowSeconds,
              })}`
            : ""}
        </span>
      ) : (
        <span className="text-xs text-muted-foreground">{ban.createdBy?.name || "—"}</span>
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
  const queryClient = useQueryClient();
  const unban = useMutation({ mutationFn: (id: string) => client.bans.delete({ id }) });
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="outline" data-testid="ban-unban">
          {m.bans_unban()}
        </Button>
      }
      destructive
      title={m.bans_unban_confirm({ address: ban.cidr })}
      confirmLabel={m.bans_unban()}
      onConfirm={async () => {
        await unban.mutateAsync(ban.id);
        await queryClient.invalidateQueries({ queryKey: orpc.bans.key() });
        toast.success(m.bans_unbanned());
      }}
    />
  );
}

/**
 * Dynamic IP bans of one site or of every site (platform bans). With `initialAddress` (a link
 * from a log row or an event) the list shows the bans of that address and the ban dialog opens
 * with it and the site.
 */
export function BansPage({
  initialSiteId,
  initialAddress,
}: {
  initialSiteId?: string;
  initialAddress?: string;
}) {
  const [page, setPage] = React.useState(1);
  const [siteId, setSiteId] = React.useState<string | undefined>(initialSiteId);
  const [address, setAddress] = React.useState<string | undefined>(initialAddress);
  const [source, setSource] = React.useState<BanSource | undefined>();
  const [scope, setScope] = React.useState<BanScope | undefined>();
  // The dialog and what it starts with; a link with an address opens it once.
  const dialog = useDialogState<{ address?: string; siteId?: string }>(
    initialAddress ? { address: initialAddress, siteId: initialSiteId } : undefined,
  );
  const bans = useQuery({
    ...orpc.bans.list.queryOptions({
      input: { scope, siteId, source, address, page, pageSize: PAGE_SIZE },
    }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const sites = useQuery(orpc.sites.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const filtered = !!(siteId || source || scope || address);
  const filter =
    <T,>(set: (value: T) => void) =>
    (value: T) => {
      set(value);
      setPage(1);
    };

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
            <Badge variant="outline">{m.bans_scope_platform()}</Badge>
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
        <FilterBar className="grid w-full grid-flow-dense grid-cols-2 sm:flex @3xl/main:ml-auto @3xl/main:w-auto @3xl/main:justify-end">
          <FilterSelect
            value={scope}
            onChange={filter((value) => setScope(value as BanScope | undefined))}
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
            onChange={filter(setSiteId)}
            allLabel={m.bans_all_sites()}
            options={(sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
            label={m.bans_filter_site()}
            testId="ban-filter-site"
            className="col-span-2 w-full sm:w-48"
          />
          <FilterSelect
            value={source}
            onChange={filter((value) => setSource(value as BanSource | undefined))}
            allLabel={m.bans_all_sources()}
            options={(["manual", "auto"] as const).map((value) => ({
              value,
              label: SOURCES[value](),
            }))}
            label={m.bans_filter_source()}
            testId="ban-filter-source"
          />
          {address ? (
            <Badge
              variant="secondary"
              className="col-span-2 h-8 gap-1 pr-1 pl-3 font-mono"
              data-testid="ban-filter-address"
            >
              {address}
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={m.bans_address_filter_clear()}
                onClick={filter(() => setAddress(undefined))}
              >
                <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
              </Button>
            </Badge>
          ) : null}
        </FilterBar>
      </div>
      <QueryView
        query={bans}
        isEmpty={(data) => data.total === 0}
        empty={
          <EmptyState
            icon={BlockedIcon}
            art="checkpoint"
            title={filtered ? m.bans_no_match() : m.bans_empty()}
          >
            {filtered ? null : (
              <Button onClick={() => dialog.show({})}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.bans_create()}
              </Button>
            )}
          </EmptyState>
        }
      >
        {({ items, total }) => (
          <>
            <DataTable
              data={items}
              columns={columns}
              getRowId={(ban) => ban.id}
              testId="bans-table"
              pinFirstColumn
            />
            <Pager page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />
          </>
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
