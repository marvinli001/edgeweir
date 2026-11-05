import type { Cluster, Revision } from "@edgeweir/contract";
import { useInfiniteQuery, useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import { SiteChangeList } from "@/components/config-changes";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { FieldError } from "@/components/layout/form";
import { Spinner } from "@/components/layout/spinner";
import { EmptyState, ErrorState, QueryView } from "@/components/states";
import { TimeAgo } from "@/components/time-ago";
import { formatDateTime, formatNumber, m } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";
import { revisionReason } from "@/lib/revisions";
import { toast } from "@/lib/toast";

const PAGE_SIZE = 20;

/**
 * Rollback with what it changes: the sites it adds, changes and removes
 * against the latest revision, or why it cannot be done, before confirming.
 */
function RollbackAction({ clusterId, revision }: { clusterId: string; revision: number }) {
  const rollback = useMutation({
    ...orpc.clusters.rollback.mutationOptions(),
    meta: { invalidates: "all" },
  });
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
      }}
    >
      <QueryView
        query={preview}
        error={(error) => (
          <FieldError data-testid="rollback-preview-error">{errorMessage(error)}</FieldError>
        )}
      >
        {({ sites, unchanged }) => (
          <div className="animate-enter rounded-md p-3 faint-well">
            <SiteChangeList changes={sites} unchanged={unchanged} testId="rollback-preview" />
          </div>
        )}
      </QueryView>
    </ConfirmDialog>
  );
}

/** The cluster's retained revisions, newest first, each but the latest with its rollback. */
export function RevisionsSection({ cluster }: { cluster: Cluster }) {
  const revisions = useInfiniteQuery(
    orpc.clusters.revisions.infiniteOptions({
      input: (before: number | undefined) => ({ id: cluster.id, before, limit: PAGE_SIZE }),
      initialPageParam: undefined,
      getNextPageParam: (page) => (page.length === PAGE_SIZE ? page.at(-1)?.revision : undefined),
    }),
  );
  const section = React.useRef<HTMLElement>(null);
  const focusAfter = React.useRef<number | undefined>(undefined);
  const loadMore = () => {
    focusAfter.current = revisions.data?.pages.flat().length;
    void revisions.fetchNextPage();
  };
  React.useEffect(() => {
    const index = focusAfter.current;
    if (index === undefined || revisions.isFetching || revisions.isFetchNextPageError) return;
    const rows = section.current?.querySelectorAll<HTMLTableRowElement>("tbody tr");
    // Appended rows precede the load button; keep them reachable in the forward tab order.
    (rows?.[index] ?? rows?.[index - 1])
      ?.querySelector<HTMLButtonElement>('[data-testid="revision-rollback"]')
      ?.focus();
    focusAfter.current = undefined;
  }, [revisions.isFetching, revisions.isFetchNextPageError]);
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
            <TimeAgo at={row.original.createdAt} />
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
    <section ref={section} className="flex min-w-0 flex-col gap-3">
      <h2 className="text-sm font-medium">{m.revisions_title()}</h2>
      <QueryView
        query={revisions}
        isEmpty={(data) => data.pages.every((page) => page.length === 0)}
        empty={<EmptyState compact title={m.revisions_empty()} />}
      >
        {(data) => (
          <>
            <DataTable
              data={data.pages.flat()}
              columns={columns}
              getRowId={(r) => String(r.revision)}
              testId="revisions-table"
              pinFirstColumn
              footer={
                <>
                  <span className="sr-only" role="status">
                    {m.revisions_loaded({ count: formatNumber(data.pages.flat().length) })}
                  </span>
                  {revisions.hasNextPage ? (
                    <Button
                      size="sm"
                      variant="secondary"
                      disabled={revisions.isFetching}
                      onClick={loadMore}
                      data-testid="revisions-more"
                    >
                      {revisions.isFetchingNextPage ? <Spinner /> : null}
                      {revisions.isFetchNextPageError ? m.common_retry() : m.revisions_more()}
                    </Button>
                  ) : null}
                </>
              }
            />
            {revisions.isFetchNextPageError ? <ErrorState error={revisions.error} /> : null}
          </>
        )}
      </QueryView>
    </section>
  );
}
