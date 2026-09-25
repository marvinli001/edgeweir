import type { AuditLogEntry } from "@edgeweir/contract";
import { Audit01Icon } from "@hugeicons/core-free-icons";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { type Columns, DataTable } from "@/components/data-table";
import { Page } from "@/components/page";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/admin/audit")({
  component: AuditPage,
});

const short = (id: string) => (id.length > 12 ? `${id.slice(0, 8)}…` : id);

function AuditPage() {
  const entries = useQuery(orpc.auditLogs.list.queryOptions({ input: { limit: 200 } }));
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
        id: "action",
        header: () => m.audit_col_action(),
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono">
            {row.original.action}
          </Badge>
        ),
      },
      {
        id: "target",
        header: () => m.audit_col_target(),
        cell: ({ row }) => (
          <span className="font-mono text-xs" title={row.original.targetId}>
            {row.original.targetType}
            {row.original.targetId ? ` · ${short(row.original.targetId)}` : ""}
          </span>
        ),
      },
      {
        id: "actor",
        header: () => m.audit_col_actor(),
        cell: ({ row }) => (
          <span className="font-mono text-xs text-muted-foreground" title={row.original.actorId}>
            {row.original.actorType} · {short(row.original.actorId)}
          </span>
        ),
      },
    ],
    [],
  );

  return (
    <Page title={m.audit_title()}>
      {entries.isPending ? (
        <LoadingState />
      ) : entries.isError ? (
        <ErrorState error={entries.error} onRetry={() => entries.refetch()} />
      ) : entries.data.length === 0 ? (
        <EmptyState icon={Audit01Icon} title={m.audit_empty()} />
      ) : (
        <DataTable
          data={entries.data}
          columns={columns}
          getRowId={(e) => String(e.id)}
          testId="audit-table"
        />
      )}
    </Page>
  );
}
