import type { Cluster } from "@edgeweir/contract";
import { Delete02Icon, MoreHorizontalIcon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { Meter } from "@/components/appica/meter";
import { ClusterDialog } from "@/components/clusters/cluster-dialog";
import { ClusterLinks } from "@/components/clusters/cluster-links";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { OptionSelect } from "@/components/form-select";
import { Dot } from "@/components/status-dot";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { formatNumber, m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { cn } from "@/lib/utils";

/** One labeled figure of the cluster summary: label, readout, an optional gauge under it. */
function SummaryStat({
  label,
  children,
  meter,
}: {
  label: string;
  children: React.ReactNode;
  meter?: React.ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 px-3 py-3 @2xl/main:px-4">
      <dt className="text-xs leading-tight text-muted-foreground">{label}</dt>
      <dd className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xl leading-tight font-semibold tracking-tight [font-stretch:112%] @2xl/main:text-[1.375rem]">
        {children}
      </dd>
      {meter ? <dd>{meter}</dd> : null}
    </div>
  );
}

/** The selected cluster: its name and actions, the cluster picker and its figures. */
export function ClusterSummary({
  clusters,
  selected,
  onSelect,
}: {
  clusters: Cluster[];
  selected: Cluster;
  onSelect: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const [editOpen, setEditOpen] = React.useState(false);
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  const remove = useMutation(orpc.clusters.delete.mutationOptions());
  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-center gap-3">
        <CardTitle
          className="min-w-32 flex-1 truncate text-lg font-semibold tracking-tight [font-stretch:106%]"
          data-testid="cluster-name"
        >
          {selected.name}
        </CardTitle>
        <div className="flex items-center gap-2">
          {clusters.length > 1 ? (
            <OptionSelect
              value={selected.id}
              options={clusters.map((c) => ({ label: c.name, value: c.id }))}
              onChange={onSelect}
              label={m.clusters_select()}
              className="w-48"
              testId="cluster-select"
            />
          ) : null}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  size="icon-sm"
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
      </CardHeader>
      {selected.nodeCount === 0 ? null : (
        <CardContent className="grid gap-3 @4xl/main:grid-cols-[minmax(0,16rem)_minmax(0,1fr)]">
          <dl className="grid grid-cols-1 divide-y divide-edge overflow-hidden rounded-xl sunk-well @xs/main:grid-cols-3 @xs/main:divide-x @xs/main:divide-y-0 @4xl/main:grid-cols-1 @4xl/main:divide-x-0 @4xl/main:divide-y">
            <SummaryStat
              label={m.clusters_nodes_online()}
              meter={
                <Meter
                  value={selected.onlineNodeCount}
                  max={selected.nodeCount}
                  low={0.5}
                  high={selected.nodeCount - 0.5}
                  optimum={selected.nodeCount}
                  label={m.clusters_nodes_count({
                    online: selected.onlineNodeCount,
                    total: selected.nodeCount,
                  })}
                />
              }
            >
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
            <SummaryStat
              label={m.clusters_latest_revision()}
              meter={
                selected.latestRevision && selected.liveNodeCount > 0 ? (
                  <Meter
                    value={selected.appliedNodeCount}
                    max={selected.liveNodeCount}
                    high={selected.liveNodeCount - 0.5}
                    optimum={selected.liveNodeCount}
                    label={m.clusters_applied({
                      applied: selected.appliedNodeCount,
                      total: selected.liveNodeCount,
                    })}
                  />
                ) : undefined
              }
            >
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
                  className="flex items-center gap-1.5 text-sm font-normal tracking-normal whitespace-nowrap text-muted-foreground [font-stretch:100%]"
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
          <ClusterLinks cluster={selected} />
        </CardContent>
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
          toast.success(m.common_deleted());
          await queryClient.invalidateQueries();
          const next = clusters.find((c) => c.id !== selected.id);
          if (next) onSelect(next.id);
        }}
      />
    </Card>
  );
}
