import type { Cluster } from "@edgeweir/contract";
import { Delete02Icon, MoreHorizontalIcon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "@/components/arc/button/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/arc/dropdown-menu/dropdown-menu";
import { ClusterDialog } from "@/components/clusters/cluster-dialog";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { Dot } from "@/components/status-dot";
import { formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** One figure of the cluster's summary line: a label over a readout. */
function SummaryStat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-base leading-tight font-medium">
        {children}
      </dd>
    </div>
  );
}

/**
 * The selected cluster (the picker sits beside the view switch): its name and actions, then one
 * line of figures
 * (nodes online, sites, the latest revision and how many nodes applied it). The nodes themselves
 * are the table below.
 */
export function ClusterSummary({
  clusters,
  selected,
  onSelect,
}: {
  clusters: Cluster[];
  selected: Cluster;
  onSelect: (id: string) => void;
}) {
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const remove = useMutation({
    ...orpc.clusters.delete.mutationOptions(),
    meta: { invalidates: "all", success: m.common_deleted },
  });
  return (
    <Panel>
      <PanelHeader className="flex flex-row flex-wrap items-center gap-3">
        <PanelTitle
          className="min-w-32 flex-1 truncate text-lg font-medium"
          data-testid="cluster-name"
        >
          {selected.name}
        </PanelTitle>
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  className="icon-button"
                  size="sm"
                  variant="ghost"
                  aria-label={m.common_actions()}
                  data-testid="cluster-actions"
                />
              }
            >
              <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setEditOpen(true)}>
                <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
                {m.clusters_edit()}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onClick={() => setDeleteOpen(true)}
                data-testid="cluster-delete"
              >
                <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
                {m.common_delete()}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PanelHeader>
      {selected.nodeCount === 0 ? null : (
        <PanelContent>
          <dl className="flex flex-wrap gap-x-10 gap-y-3">
            <SummaryStat label={m.clusters_nodes_online()}>
              <Dot
                tone={selected.onlineNodeCount < selected.nodeCount ? "bad" : "good"}
                glow={selected.onlineNodeCount > 0}
              />
              <span data-testid="cluster-nodes-online" className="readout">
                {selected.onlineNodeCount}/{selected.nodeCount}
              </span>
            </SummaryStat>
            <SummaryStat label={m.clusters_sites()}>
              <span className="readout">{formatNumber(selected.siteCount)}</span>
            </SummaryStat>
            <SummaryStat label={m.clusters_latest_revision()}>
              <span
                className={cn(selected.latestRevision && "readout font-mono")}
                data-testid="cluster-latest-revision"
              >
                {selected.latestRevision
                  ? `#${selected.latestRevision.revision}`
                  : m.clusters_no_revision()}
              </span>
              {selected.latestRevision && selected.liveNodeCount > 0 ? (
                <span
                  className="flex items-center gap-1.5 text-sm font-normal whitespace-nowrap text-muted-foreground"
                  data-testid="cluster-applied"
                >
                  <Dot
                    tone={selected.appliedNodeCount < selected.liveNodeCount ? "warn" : "good"}
                    small
                  />
                  {m.clusters_applied({
                    applied: selected.appliedNodeCount,
                    total: selected.liveNodeCount,
                  })}
                </span>
              ) : null}
            </SummaryStat>
          </dl>
        </PanelContent>
      )}
      <ClusterDialog
        key={selected.id}
        cluster={selected}
        open={editOpen}
        onOpenChange={setEditOpen}
      />
      <ControlledConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={m.clusters_delete_confirm({ name: selected.name })}
        onConfirm={async () => {
          await remove.mutateAsync({ id: selected.id });
          const next = clusters.find((c) => c.id !== selected.id);
          if (next) onSelect(next.id);
        }}
      />
    </Panel>
  );
}
