import type { Cluster, Revision } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SiteChangeList } from "@/components/config-changes";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { formatDateTime, m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { revisionReason } from "@/lib/revisions";

/**
 * Rollback with what it changes: the sites it adds, changes and removes
 * against the latest revision, or why it cannot be done, before confirming.
 */
function RollbackAction({ clusterId, revision }: { clusterId: string; revision: number }) {
  const queryClient = useQueryClient();
  const rollback = useMutation(orpc.clusters.rollback.mutationOptions());
  const [open, setOpen] = React.useState(false);
  const preview = useQuery({
    ...orpc.clusters.rollbackPreview.queryOptions({ input: { id: clusterId, revision } }),
    enabled: open,
    // Always against the latest revision; a refusal is an answer, not a hiccup.
    staleTime: 0,
    gcTime: 0,
    retry: false,
  });
  return (
    <ConfirmDialog
      trigger={
        <Button size="sm" variant="ghost" data-testid="revision-rollback">
          {m.revisions_rollback()}
        </Button>
      }
      title={m.revisions_rollback()}
      note={m.revisions_rollback_confirm({ revision })}
      onOpenChange={setOpen}
      confirmDisabled={!preview.data}
      onConfirm={async () => {
        const result = await rollback.mutateAsync({ id: clusterId, revision });
        toast.success(m.revisions_rolled_back({ revision: result.revision }));
        await queryClient.invalidateQueries();
      }}
    >
      {preview.isPending ? (
        <LoadingState />
      ) : preview.isLoadingError ? (
        <FieldError data-testid="rollback-preview-error">{errorMessage(preview.error)}</FieldError>
      ) : (
        <div className="animate-enter rounded-xl border p-3">
          <SiteChangeList
            changes={preview.data.sites}
            unchanged={preview.data.unchanged}
            testId="rollback-preview"
          />
        </div>
      )}
    </ConfirmDialog>
  );
}

/** The cluster's latest revisions, each but the latest with its rollback. */
export function RevisionsSection({ cluster }: { cluster: Cluster }) {
  const revisions = useQuery(orpc.clusters.revisions.queryOptions({ input: { id: cluster.id } }));
  const latest = cluster.latestRevision?.revision ?? 0;
  const columns = React.useMemo<Columns<Revision>>(
    () => [
      {
        id: "revision",
        header: () => m.revisions_col_revision(),
        cell: ({ row }) => <span className="font-mono">#{row.original.revision}</span>,
      },
      {
        id: "hash",
        header: () => m.revisions_col_hash(),
        cell: ({ row }) => (
          <code className="text-xs text-muted-foreground">
            {row.original.contentHash.slice(0, 16)}
          </code>
        ),
      },
      {
        id: "sites",
        header: () => m.revisions_col_sites(),
        cell: ({ row }) => row.original.siteCount,
      },
      {
        id: "reason",
        header: () => m.revisions_col_reason(),
        cell: ({ row }) => (
          <span className="text-sm" data-testid="revision-reason">
            {revisionReason(row.original)}
          </span>
        ),
      },
      {
        id: "time",
        header: () => m.revisions_col_time(),
        cell: ({ row }) => (
          <span
            className="text-xs text-muted-foreground"
            title={formatDateTime(row.original.createdAt)}
          >
            {timeAgo(row.original.createdAt)}
          </span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) =>
          row.original.revision === latest ? null : (
            <RollbackAction clusterId={cluster.id} revision={row.original.revision} />
          ),
      },
    ],
    [cluster.id, latest],
  );

  return (
    <section className="flex flex-col gap-3">
      <h2 className="text-sm font-medium">{m.revisions_title()}</h2>
      {revisions.isPending ? (
        <LoadingState />
      ) : revisions.isLoadingError ? (
        <ErrorState error={revisions.error} onRetry={() => revisions.refetch()} />
      ) : revisions.data.length === 0 ? (
        <EmptyState title={m.revisions_empty()} />
      ) : (
        <DataTable
          data={revisions.data.slice(0, 20)}
          columns={columns}
          getRowId={(r) => String(r.revision)}
          testId="revisions-table"
        />
      )}
    </section>
  );
}
