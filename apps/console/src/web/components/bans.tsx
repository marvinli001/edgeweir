import {
  BAN_DURATIONS,
  type Ban,
  type BanReason,
  type BanScope,
  type BanSource,
  MANUAL_BAN_REASONS,
} from "@edgeweir/contract";
import { Add01Icon, BlockedIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouteContext } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { FormSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

const PAGE_SIZE = 50;
const ALL = "__all__";

const REASONS: Record<BanReason, () => string> = {
  abuse: () => m.bans_reason_abuse(),
  attack: () => m.bans_reason_attack(),
  scanner: () => m.bans_reason_scanner(),
  spam: () => m.bans_reason_spam(),
  other: () => m.bans_reason_other(),
  cc_ip_rate: () => m.bans_reason_cc_ip_rate(),
};

const SOURCES: Record<BanSource, () => string> = {
  manual: () => m.bans_source_manual(),
  auto: () => m.bans_source_auto(),
};

const SCOPES: Record<BanScope, () => string> = {
  platform: () => m.bans_scope_platform(),
  site: () => m.bans_scope_site(),
};

function durationLabel(seconds: number): string {
  return seconds % 86400 === 0
    ? m.bans_duration_days({ count: seconds / 86400 })
    : m.bans_duration_hours({ count: seconds / 3600 });
}

/** Time left until `iso`, rounded down ("3 h left"). */
function timeLeft(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.floor((Date.parse(iso) - now) / 1000));
  if (seconds < 3600) return m.bans_left_minutes({ count: Math.max(1, Math.floor(seconds / 60)) });
  if (seconds < 86400) return m.bans_left_hours({ count: Math.floor(seconds / 3600) });
  return m.bans_left_days({ count: Math.floor(seconds / 86400) });
}

function FilterSelect({
  value,
  onChange,
  allLabel,
  options,
  label,
  testId,
}: {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  allLabel: string;
  options: { label: string; value: string }[];
  label: string;
  testId: string;
}) {
  const items = [{ label: allLabel, value: ALL }, ...options];
  return (
    <Select
      value={value ?? ALL}
      onValueChange={(v) => onChange(!v || v === ALL ? undefined : String(v))}
      items={items}
    >
      <SelectTrigger className="w-full sm:w-48" aria-label={label} data-testid={testId}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
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

/** Sites the caller can ban in: a search box and a select over the matches. */
function SiteSelect({
  value,
  onChange,
}: {
  value: { id: string; name: string } | null;
  onChange: (site: { id: string; name: string }) => void;
}) {
  const [search, setSearch] = React.useState("");
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({
      input: { search: search.trim() || undefined, page: 1, pageSize: 100 },
    }),
    placeholderData: keepPreviousData,
  });
  const choices = (sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }));
  if (value && !choices.some((c) => c.value === value.id))
    choices.unshift({ value: value.id, label: value.name });
  return (
    <>
      <Field>
        <FieldLabel htmlFor="ban-site-search">{m.bans_site_search()}</FieldLabel>
        <Input
          id="ban-site-search"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
      </Field>
      {sites.isPending ? (
        <LoadingState className="min-h-16" />
      ) : sites.isError ? (
        <ErrorState error={sites.error} onRetry={() => void sites.refetch()} />
      ) : (
        <FormSelect
          id="ban-site"
          label={m.bans_site()}
          value={value?.id ?? ""}
          options={choices}
          onChange={(id) =>
            onChange({ id, name: choices.find((c) => c.value === id)?.label ?? "" })
          }
        />
      )}
    </>
  );
}

function BanDialog({ platform, onClose }: { platform: boolean; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [scope, setScope] = React.useState<BanScope>(platform ? "platform" : "site");
  const [site, setSite] = React.useState<{ id: string; name: string } | null>(null);
  const [reason, setReason] = React.useState<string>(MANUAL_BAN_REASONS[0]);
  const [duration, setDuration] = React.useState(String(24 * 3600));
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.bans_create()}
      submitLabel={m.bans_submit()}
      submitTestId="ban-submit"
      onSubmit={async (data) => {
        const cidr = String(data.get("cidr") ?? "").trim();
        const fields = {
          cidr,
          reason: reason as (typeof MANUAL_BAN_REASONS)[number],
          durationSeconds: Number(duration),
        };
        if (scope === "site" && !site) throw new Error(m.bans_site_required());
        if (platform)
          await client.admin.bans.create(
            scope === "site" ? { ...fields, scope, siteId: site?.id } : { ...fields, scope },
          );
        else await client.bans.create({ ...fields, siteId: site?.id ?? "" });
        await queryClient.invalidateQueries({ queryKey: orpc.bans.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.admin.bans.key() });
        toast.success(m.bans_created());
        onClose();
      }}
    >
      {platform ? (
        <FormSelect
          id="ban-scope"
          label={m.bans_scope()}
          value={scope}
          options={(["platform", "site"] as const).map((value) => ({
            value,
            label: SCOPES[value](),
          }))}
          onChange={(value) => setScope(value as BanScope)}
        />
      ) : null}
      {scope === "site" ? <SiteSelect value={site} onChange={setSite} /> : null}
      <Field>
        <FieldLabel htmlFor="ban-cidr">{m.bans_address()}</FieldLabel>
        <Input
          id="ban-cidr"
          name="cidr"
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder="203.0.113.7"
          data-testid="ban-cidr"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect
          id="ban-reason"
          label={m.bans_reason()}
          value={reason}
          options={MANUAL_BAN_REASONS.map((value) => ({ value, label: REASONS[value]() }))}
          onChange={setReason}
        />
        <FormSelect
          id="ban-duration"
          label={m.bans_duration()}
          value={duration}
          options={BAN_DURATIONS.map((seconds) => ({
            value: String(seconds),
            label: durationLabel(seconds),
          }))}
          onChange={setDuration}
        />
      </div>
    </FormDialog>
  );
}

/**
 * Dynamic IP bans. The console page shows the site bans of the organization
 * (owners and admins ban and unban); the admin page (`platform`) shows every
 * ban and also creates platform bans.
 */
export function BansPage({ platform = false }: { platform?: boolean }) {
  const queryClient = useQueryClient();
  const { isAdmin } = useRouteContext({ from: "/_app" });
  const me = useQuery(orpc.account.me.queryOptions());
  const role = me.data?.activeOrganization?.role;
  const canManage = platform || isAdmin || role === "owner" || role === "admin";
  const [page, setPage] = React.useState(1);
  const [siteId, setSiteId] = React.useState<string | undefined>();
  const [source, setSource] = React.useState<BanSource | undefined>();
  const [scope, setScope] = React.useState<BanScope | undefined>();
  const [creating, setCreating] = React.useState(false);
  const input = { siteId, source, page, pageSize: PAGE_SIZE };
  const bans = useQuery({
    ...(platform
      ? orpc.admin.bans.list.queryOptions({ input: { ...input, scope } })
      : orpc.bans.list.queryOptions({ input })),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const sites = useQuery(orpc.sites.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const unban = useMutation({
    mutationFn: (id: string) =>
      platform ? client.admin.bans.delete({ id }) : client.bans.delete({ id }),
  });
  const filtered = !!(siteId || source || scope);
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
            <div className="flex flex-col">
              <span className="font-medium">{row.original.siteName ?? "—"}</span>
              {platform ? (
                <span className="text-xs text-muted-foreground">
                  {row.original.organizationName ?? ""}
                </span>
              ) : null}
            </div>
          ),
      },
      {
        id: "reason",
        header: () => m.bans_col_reason(),
        cell: ({ row }) => <span className="text-sm">{REASONS[row.original.reason]()}</span>,
      },
      {
        id: "source",
        header: () => m.bans_col_source(),
        cell: ({ row }) => <BanOrigin ban={row.original} />,
      },
      {
        id: "expires",
        header: () => m.bans_col_expires(),
        cell: ({ row }) => (
          <span
            className="text-sm whitespace-nowrap text-muted-foreground"
            title={formatDateTime(row.original.expiresAt)}
          >
            {timeLeft(row.original.expiresAt)}
          </span>
        ),
      },
      ...(canManage
        ? [
            {
              id: "actions",
              header: () => <span className="sr-only">{m.common_actions()}</span>,
              cell: ({ row }: { row: { original: Ban } }) => (
                <div className="flex justify-end">
                  <ConfirmDialog
                    trigger={
                      <Button size="sm" variant="outline" data-testid="ban-unban">
                        {m.bans_unban()}
                      </Button>
                    }
                    destructive
                    title={m.bans_unban_confirm({ address: row.original.cidr })}
                    confirmLabel={m.bans_unban()}
                    onConfirm={async () => {
                      try {
                        await unban.mutateAsync(row.original.id);
                        await queryClient.invalidateQueries({ queryKey: orpc.bans.key() });
                        await queryClient.invalidateQueries({ queryKey: orpc.admin.bans.key() });
                        toast.success(m.bans_unbanned());
                      } catch (err) {
                        toast.error(errorMessage(err));
                      }
                    }}
                  />
                </div>
              ),
            } satisfies Columns<Ban>[number],
          ]
        : []),
    ],
    [canManage, platform, queryClient, unban],
  );

  const createButton = canManage ? (
    <Button size="sm" onClick={() => setCreating(true)} data-testid="ban-create">
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {m.bans_create()}
    </Button>
  ) : null;

  return (
    <Page title={m.bans_title()} actions={createButton}>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        {platform ? (
          <FilterSelect
            value={scope}
            onChange={filter((value) => setScope(value as BanScope | undefined))}
            allLabel={m.bans_all_scopes()}
            options={(["platform", "site"] as const).map((value) => ({
              value,
              label: SCOPES[value](),
            }))}
            label={m.bans_filter_scope()}
            testId="ban-filter-scope"
          />
        ) : null}
        <FilterSelect
          value={siteId}
          onChange={filter(setSiteId)}
          allLabel={m.bans_all_sites()}
          options={(sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
          label={m.bans_filter_site()}
          testId="ban-filter-site"
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
      </div>
      {bans.isPending ? (
        <LoadingState />
      ) : bans.isError ? (
        <ErrorState error={bans.error} onRetry={() => bans.refetch()} />
      ) : bans.data.total === 0 ? (
        <EmptyState icon={BlockedIcon} title={filtered ? m.bans_no_match() : m.bans_empty()}>
          {filtered ? null : createButton}
        </EmptyState>
      ) : (
        <>
          <DataTable
            data={bans.data.items}
            columns={columns}
            getRowId={(ban) => ban.id}
            testId="bans-table"
          />
          <Pager page={page} pageSize={PAGE_SIZE} total={bans.data.total} onPageChange={setPage} />
        </>
      )}
      {creating ? <BanDialog platform={platform} onClose={() => setCreating(false)} /> : null}
    </Page>
  );
}
