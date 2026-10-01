import type { AuditLogEntry } from "@edgeweir/contract";
import { Audit01Icon } from "@hugeicons/core-free-icons";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import * as z from "zod";
import { type Columns, DataTable } from "@/components/data-table";
import { Page } from "@/components/page";
import { Pager } from "@/components/pager";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const PAGE_SIZE = 50;
const ALL = "__all__";
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

const rangeLabels: Record<Range, () => string> = {
  "1h": () => m.audit_range_1h(),
  "24h": () => m.audit_range_24h(),
  "7d": () => m.audit_range_7d(),
  "30d": () => m.audit_range_30d(),
};

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
              {(actorLabels[row.original.actorType] ?? (() => row.original.actorType))()}
            </span>
          </div>
        ),
      },
      {
        id: "action",
        header: () => m.audit_col_action(),
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono" data-testid="audit-action">
            {row.original.action}
          </Badge>
        ),
      },
      {
        id: "target",
        header: () => m.audit_col_target(),
        cell: ({ row }) => (
          <div className="flex flex-col" title={row.original.targetId}>
            <span data-testid="audit-target">{row.original.targetName || "—"}</span>
            <span className="font-mono text-xs text-muted-foreground">
              {row.original.targetType}
            </span>
          </div>
        ),
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
          options={(facets.data?.actions ?? []).map((a) => ({ label: a, value: a }))}
          label={m.audit_col_action()}
          testId="audit-filter-action"
        />
        <FilterSelect
          value={search.target}
          onChange={(target) => setFilter({ target })}
          allLabel={m.audit_all_targets()}
          options={(facets.data?.targetTypes ?? []).map((t) => ({ label: t, value: t }))}
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
      ) : entries.isError ? (
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
