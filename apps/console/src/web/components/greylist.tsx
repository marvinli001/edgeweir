import {
  BAN_DURATIONS,
  GREYLIST_CHALLENGES,
  GREYLIST_RATE_REQUESTS,
  GREYLIST_RATE_WINDOW,
  type GreylistAction,
  type GreylistEntry,
  MANUAL_BAN_REASONS,
} from "@edgeweir/contract";
import { Add01Icon, Cancel01Icon, SecurityCheckIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { AccessTabs } from "@/components/access-tabs";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import {
  BAN_REASON_LABELS,
  BAN_SCOPE_LABELS,
  durationLabel,
  type SiteChoice,
  SiteSelect,
} from "@/components/ban-dialog";
import { timeLeft } from "@/components/bans";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable, FilterBar } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { FilterSelect, FormSelect } from "@/components/form-select";
import { Field, FieldLabel } from "@/components/layout/form";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { SafetyNote } from "@/components/safety-note";
import { EmptyState, NoMatch, QueryView } from "@/components/states";
import { StatusDot } from "@/components/status-dot";
import { type DialogProps, useDialogState } from "@/hooks/use-dialog-state";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import { challengeLabel } from "@/lib/protection";

const PAGE_SIZE = 50;

type Scope = GreylistEntry["scope"];

/** "Proof of work" or "60 per 60 s". */
function greylistActionText(action: GreylistAction): string {
  return action.kind === "challenge"
    ? challengeLabel(action.challenge)
    : m.greylist_rate_text({
        requests: formatNumber(action.requests),
        seconds: formatNumber(action.windowSeconds),
      });
}

function Expiry({ expiresAt }: { expiresAt: string }) {
  const expired = Date.parse(expiresAt) <= Date.now();
  return (
    <StatusDot tone={expired ? "idle" : "good"} title={formatDateTime(expiresAt)}>
      <span className={expired ? "text-muted-foreground" : undefined}>
        {expired ? m.bans_expired() : timeLeft(expiresAt)}
      </span>
    </StatusDot>
  );
}

function RemoveAction({ entry }: { entry: GreylistEntry }) {
  const remove = useMutation({
    mutationFn: (id: string) => client.greylist.delete({ id }),
    meta: { invalidates: [orpc.greylist.key()], success: m.greylist_removed },
  });
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="secondary" data-testid="greylist-remove">
          {m.greylist_remove()}
        </Button>
      }
      destructive
      title={m.greylist_remove_confirm({ address: entry.cidr })}
      confirmLabel={m.greylist_remove()}
      onConfirm={async () => {
        await remove.mutateAsync(entry.id);
      }}
    />
  );
}

/**
 * Greylists an address on one site or on every site: challenged or rate-limited until it
 * expires. Greylisting the same address again replaces the entry.
 */
function GreylistDialog({ open, onOpenChange }: DialogProps) {
  const queryClient = useQueryClient();
  const [scope, setScope] = React.useState<Scope>("site");
  const [site, setSite] = React.useState<SiteChoice | null>(null);
  const [kind, setKind] = React.useState<GreylistAction["kind"]>("challenge");
  const [challenge, setChallenge] = React.useState<string>("js");
  const [reason, setReason] = React.useState<string>(MANUAL_BAN_REASONS[0]);
  const [duration, setDuration] = React.useState(String(24 * 3600));
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.greylist_create()}
      submitLabel={m.greylist_submit()}
      submitTestId="greylist-submit"
      onSubmit={async (data) => {
        if (scope === "site" && !site) throw new Error(m.bans_site_required());
        const action: GreylistAction =
          kind === "challenge"
            ? { kind, challenge: challenge as (typeof GREYLIST_CHALLENGES)[number] }
            : {
                kind,
                requests: Number(data.get("requests")),
                windowSeconds: Number(data.get("window")),
              };
        const fields = {
          cidr: String(data.get("cidr") ?? "").trim(),
          reason: reason as (typeof MANUAL_BAN_REASONS)[number],
          durationSeconds: Number(duration),
          action,
        };
        await client.greylist.create(
          scope === "site" ? { ...fields, scope, siteId: site?.id } : { ...fields, scope },
        );
        await queryClient.invalidateQueries({ queryKey: orpc.greylist.key() });
        onOpenChange(false);
      }}
    >
      <FormSelect
        id="greylist-scope"
        label={m.bans_scope()}
        value={scope}
        options={(["site", "platform"] as const).map((value) => ({
          value,
          label: BAN_SCOPE_LABELS[value](),
        }))}
        onChange={(value) => setScope(value as Scope)}
      />
      {scope === "site" ? (
        <SiteSelect id="greylist-site" value={site} onChange={setSite} testId="greylist-site" />
      ) : null}
      <Field>
        <FieldLabel htmlFor="greylist-cidr">{m.bans_address()}</FieldLabel>
        <Input
          id="greylist-cidr"
          name="cidr"
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
          className="font-mono"
          placeholder="203.0.113.0/24"
          data-testid="greylist-cidr"
        />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect
          id="greylist-action"
          label={m.greylist_action()}
          value={kind}
          options={[
            { value: "challenge", label: m.greylist_action_challenge() },
            { value: "rate_limit", label: m.greylist_action_rate_limit() },
          ]}
          onChange={(value) => setKind(value as GreylistAction["kind"])}
          testId="greylist-action"
        />
        {kind === "challenge" ? (
          <FormSelect
            id="greylist-challenge"
            label={m.greylist_challenge()}
            value={challenge}
            options={GREYLIST_CHALLENGES.map((value) => ({
              value,
              label: challengeLabel(value),
            }))}
            onChange={setChallenge}
            testId="greylist-challenge"
          />
        ) : null}
      </div>
      {kind === "rate_limit" ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field>
            <FieldLabel htmlFor="greylist-requests">{m.greylist_requests()}</FieldLabel>
            <Input
              id="greylist-requests"
              name="requests"
              type="number"
              required
              min={GREYLIST_RATE_REQUESTS.min}
              max={GREYLIST_RATE_REQUESTS.max}
              defaultValue={GREYLIST_RATE_REQUESTS.default}
              data-testid="greylist-requests"
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="greylist-window">{m.greylist_window()}</FieldLabel>
            <Input
              id="greylist-window"
              name="window"
              type="number"
              required
              min={GREYLIST_RATE_WINDOW.min}
              max={GREYLIST_RATE_WINDOW.max}
              defaultValue={GREYLIST_RATE_WINDOW.default}
              data-testid="greylist-window"
            />
          </Field>
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <FormSelect
          id="greylist-reason"
          label={m.bans_reason()}
          value={reason}
          options={MANUAL_BAN_REASONS.map((value) => ({
            value,
            label: BAN_REASON_LABELS[value](),
          }))}
          onChange={setReason}
        />
        <FormSelect
          id="greylist-duration"
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

/** The greylist's filters and page, kept in the URL (`/greylist`). */
export interface GreylistSearch {
  site?: string;
  /** The entries of an address (a link from the IP check). */
  ip?: string;
  scope?: Scope;
  page?: number;
}

/** The greylist: addresses challenged or rate-limited on one site or every site. */
export function GreylistPage({
  search,
  onSearch,
}: {
  search: GreylistSearch;
  onSearch: (patch: Partial<GreylistSearch>) => void;
}) {
  const { site: siteId, ip: address, scope } = search;
  const page = search.page ?? 1;
  const setPage = (next: number) => onSearch({ page: next > 1 ? next : undefined });
  // A filter change starts again on the first page.
  const setFilter = (patch: Partial<GreylistSearch>) => onSearch({ ...patch, page: undefined });
  const dialog = useDialogState<Record<string, never>>();
  const list = useQuery({
    ...orpc.greylist.list.queryOptions({
      input: { scope, siteId, address, page, pageSize: PAGE_SIZE },
    }),
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
    meta: { background: true },
  });
  const sites = useQuery(orpc.sites.list.queryOptions({ input: { page: 1, pageSize: 100 } }));
  const filtered = !!(siteId || scope || address);

  const columns = React.useMemo<Columns<GreylistEntry>>(
    () => [
      {
        id: "address",
        header: () => m.bans_col_address(),
        cell: ({ row }) => (
          <div className="flex flex-col gap-1">
            <span className="font-mono text-sm break-all" data-testid="greylist-cidr-cell">
              {row.original.cidr}
            </span>
            {row.original.unappliedNodes > 0 ? (
              <StatusDot tone="warn">
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
        id: "action",
        header: () => m.greylist_action(),
        cell: ({ row }) => (
          <span className="text-sm" data-testid="greylist-action-cell">
            {greylistActionText(row.original.action)}
          </span>
        ),
      },
      {
        id: "reason",
        header: () => m.bans_col_reason(),
        cell: ({ row }) => (
          <div className="flex flex-col gap-0.5">
            <span className="text-sm">{BAN_REASON_LABELS[row.original.reason]()}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.createdBy?.name || "—"}
            </span>
          </div>
        ),
      },
      {
        id: "expires",
        header: () => m.bans_col_expires(),
        cell: ({ row }) => <Expiry expiresAt={row.original.expiresAt} />,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <RemoveAction entry={row.original} />
          </div>
        ),
      },
    ],
    [],
  );

  const createButton = (
    <Button onClick={() => dialog.show({})} data-testid="greylist-create">
      <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
      {m.greylist_create()}
    </Button>
  );

  return (
    <Page title={m.greylist_title()} actions={createButton}>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
        <AccessTabs value="greylist" />
        <FilterBar className="grid w-full grid-flow-dense grid-cols-2 sm:flex @3xl/main:w-auto">
          <FilterSelect
            value={scope}
            onChange={(value) => setFilter({ scope: value as Scope | undefined })}
            allLabel={m.bans_all_scopes()}
            options={(["platform", "site"] as const).map((value) => ({
              value,
              label: BAN_SCOPE_LABELS[value](),
            }))}
            label={m.bans_filter_scope()}
            testId="greylist-filter-scope"
          />
          <FilterSelect
            value={siteId}
            onChange={(value) => setFilter({ site: value })}
            allLabel={m.bans_all_sites()}
            options={(sites.data?.items ?? []).map((s) => ({ value: s.id, label: s.name }))}
            label={m.bans_filter_site()}
            testId="greylist-filter-site"
            className="col-span-2 w-full sm:w-48"
          />
          {address ? (
            <Badge size="sm" tone="neutral" className="col-span-2 h-8 gap-1 pr-1 pl-3 font-mono">
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
      {list.data && list.data.unsupportedNodes > 0 ? (
        <SafetyNote className="animate-enter" data-testid="greylist-unsupported-note">
          {m.greylist_unsupported_nodes({ count: list.data.unsupportedNodes })}
        </SafetyNote>
      ) : null}
      <QueryView
        query={list}
        isEmpty={(data) => data.total === 0}
        empty={
          filtered ? (
            <NoMatch
              title={m.greylist_no_match()}
              onClear={() => setFilter({ site: undefined, ip: undefined, scope: undefined })}
            />
          ) : (
            <EmptyState icon={SecurityCheckIcon} title={m.greylist_empty()}>
              <Button onClick={() => dialog.show({})}>
                <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
                {m.greylist_create()}
              </Button>
            </EmptyState>
          )
        }
      >
        {({ items, total }) => (
          <DataTable
            data={items}
            columns={columns}
            getRowId={(entry) => entry.id}
            testId="greylist-table"
            pinFirstColumn
            total={total}
            footer={<Pager page={page} pageSize={PAGE_SIZE} total={total} onPageChange={setPage} />}
          />
        )}
      </QueryView>
      {dialog.value ? (
        <GreylistDialog key={dialog.key} open={dialog.open} onOpenChange={dialog.onOpenChange} />
      ) : null}
    </Page>
  );
}
