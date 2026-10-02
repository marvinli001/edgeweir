import type { AuditLogEntry } from "@edgeweir/contract";
import { Audit01Icon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { type Columns, DataTable } from "@/components/data-table";
import { FilterSelect } from "@/components/form-select";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { auditActionLabel, auditTargetLabel } from "@/lib/audit";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const PAGE_SIZE = 50;
const RANGES = { "1h": 3600, "24h": 86400, "7d": 7 * 86400, "30d": 30 * 86400 } as const;
type Range = keyof typeof RANGES;

export const Route = createFileRoute("/_app/audit")({
  validateSearch: z.object({
    action: z.string().optional(),
    target: z.string().optional(),
    range: z.enum(["1h", "24h", "7d", "30d"]).optional(),
    page: z.number().int().min(1).optional(),
  }),
  component: AuditPage,
});

const actorLabels: Record<string, () => string> = {
  user: () => m.audit_actor_user(),
  api_key: () => m.audit_actor_api_key(),
  service_account: () => m.audit_actor_service_account(),
  node: () => m.audit_actor_node(),
  probe: () => m.audit_actor_probe(),
  system: () => m.audit_actor_system(),
};

const actorLabel = (type: string) => (actorLabels[type] ?? (() => type))();

const rangeLabels: Record<Range, () => string> = {
  "1h": () => m.audit_range_1h(),
  "24h": () => m.audit_range_24h(),
  "7d": () => m.audit_range_7d(),
  "30d": () => m.audit_range_30d(),
};

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 py-2.5 sm:grid-cols-[8rem_1fr] sm:gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 flex-col gap-0.5 break-all">{children}</dd>
    </div>
  );
}

/** Name, type and id of an entry's actor or target. */
function Party({ name, type, id }: { name: string; type: string; id: string }) {
  return (
    <>
      <span>
        {name || "—"}
        {type ? <span className="text-muted-foreground"> · {type}</span> : null}
      </span>
      {id ? <span className="font-mono text-xs text-muted-foreground">{id}</span> : null}
    </>
  );
}

/** Everything an entry holds: who, from where, what, and its metadata as JSON. */
function AuditDetails({ entry }: { entry: AuditLogEntry }) {
  const metadata = Object.keys(entry.metadata).length
    ? JSON.stringify(entry.metadata, null, 2)
    : "";
  return (
    <Dialog>
      <DialogTrigger
        render={
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={m.audit_details()}
            data-testid="audit-details"
          />
        }
      >
        <HugeiconsIcon icon={InformationCircleIcon} strokeWidth={2} />
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-2xl"
        data-testid="audit-detail"
      >
        <DialogHeader>
          <DialogTitle className="pr-8">{auditActionLabel(entry.action)}</DialogTitle>
        </DialogHeader>
        <dl className="min-w-0 divide-y">
          <Field label={m.audit_col_time()}>{formatDateTime(entry.occurredAt)}</Field>
          <Field label={m.audit_col_action()}>
            <code className="font-mono text-xs">{entry.action}</code>
          </Field>
          <Field label={m.audit_col_actor()}>
            <Party name={entry.actorName} type={actorLabel(entry.actorType)} id={entry.actorId} />
          </Field>
          <Field label={m.audit_col_target()}>
            <Party
              name={entry.targetName}
              type={entry.targetType ? auditTargetLabel(entry.targetType) : ""}
              id={entry.targetId}
            />
          </Field>
          <Field label={m.audit_field_ip()}>
            <span className="font-mono" data-testid="audit-detail-ip">
              {entry.ip || "—"}
            </span>
          </Field>
          <Field label={m.audit_field_user_agent()}>
            <span data-testid="audit-detail-user-agent">{entry.userAgent || "—"}</span>
          </Field>
          <Field label={m.audit_field_metadata()}>
            {metadata ? (
              <pre
                className="max-h-80 overflow-auto rounded-xl bg-muted p-3 font-mono text-xs break-normal whitespace-pre"
                data-testid="audit-detail-metadata"
              >
                {metadata}
              </pre>
            ) : (
              "—"
            )}
          </Field>
        </dl>
      </DialogContent>
    </Dialog>
  );
}

function AuditPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const page = search.page ?? 1;
  // Resolve the range once per filter change so the query key stays stable while paging.
  const from = React.useMemo(
    () =>
      search.range ? new Date(Date.now() - RANGES[search.range] * 1000).toISOString() : undefined,
    [search.range],
  );
  const entries = useQuery({
    ...orpc.auditLogs.list.queryOptions({
      input: {
        action: search.action,
        targetType: search.target,
        from,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
      },
    }),
    placeholderData: keepPreviousData,
  });
  const facets = useQuery(orpc.auditLogs.facets.queryOptions());
  const setFilter = (patch: Partial<typeof search>) =>
    navigate({ search: (prev) => ({ ...prev, ...patch, page: undefined }), replace: true });

  const columns = React.useMemo<Columns<AuditLogEntry>>(
    () => [
      {
        id: "time",
        header: () => m.audit_col_time(),
        cell: ({ row }) => (
          <span
            className="text-xs whitespace-nowrap text-muted-foreground"
            title={formatDateTime(row.original.occurredAt)}
          >
            {timeAgo(row.original.occurredAt)}
          </span>
        ),
      },
      {
        id: "actor",
        header: () => m.audit_col_actor(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium" data-testid="audit-actor">
              {row.original.actorName || "—"}
            </span>
            <span className="text-xs text-muted-foreground">
              {actorLabel(row.original.actorType)}
            </span>
          </div>
        ),
      },
      {
        id: "action",
        header: () => m.audit_col_action(),
        cell: ({ row }) => (
          <div className="flex flex-col">
            <span className="font-medium" data-testid="audit-action-label">
              {auditActionLabel(row.original.action)}
            </span>
            <span className="font-mono text-xs text-muted-foreground" data-testid="audit-action">
              {row.original.action}
            </span>
          </div>
        ),
      },
      {
        id: "target",
        header: () => m.audit_col_target(),
        cell: ({ row }) => (
          <div className="flex flex-col" title={row.original.targetId}>
            <span data-testid="audit-target">{row.original.targetName || "—"}</span>
            <span className="text-xs text-muted-foreground">
              {row.original.targetType ? auditTargetLabel(row.original.targetType) : null}
            </span>
          </div>
        ),
      },
      {
        id: "details",
        header: () => <span className="sr-only">{m.audit_details()}</span>,
        cell: ({ row }) => <AuditDetails entry={row.original} />,
      },
    ],
    [],
  );

  return (
    <Page title={m.audit_title()}>
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <FilterSelect
          value={search.action}
          onChange={(action) => setFilter({ action })}
          allLabel={m.audit_all_actions()}
          options={(facets.data?.actions ?? []).map((a) => ({
            label: auditActionLabel(a),
            value: a,
          }))}
          label={m.audit_col_action()}
          testId="audit-filter-action"
        />
        <FilterSelect
          value={search.target}
          onChange={(target) => setFilter({ target })}
          allLabel={m.audit_all_targets()}
          options={(facets.data?.targetTypes ?? []).map((t) => ({
            label: auditTargetLabel(t),
            value: t,
          }))}
          label={m.audit_col_target()}
          testId="audit-filter-target"
        />
        <FilterSelect
          value={search.range}
          onChange={(range) => setFilter({ range: range as Range | undefined })}
          allLabel={m.audit_range_all()}
          options={(Object.keys(RANGES) as Range[]).map((r) => ({
            label: rangeLabels[r](),
            value: r,
          }))}
          label={m.audit_col_time()}
          testId="audit-filter-range"
        />
      </div>
      {entries.isPending ? (
        <LoadingState />
      ) : entries.isLoadingError ? (
        <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
      ) : entries.data.total === 0 ? (
        <EmptyState icon={Audit01Icon} title={m.audit_empty()} />
      ) : (
        <>
          <DataTable
            data={entries.data.items}
            columns={columns}
            getRowId={(e) => String(e.id)}
            testId="audit-table"
          />
          <Pager
            page={page}
            pageSize={PAGE_SIZE}
            total={entries.data.total}
            onPageChange={(next) => navigate({ search: (prev) => ({ ...prev, page: next }) })}
          />
        </>
      )}
    </Page>
  );
}
