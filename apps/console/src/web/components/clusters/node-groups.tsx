import type { Cluster, NodeGroup, Region } from "@edgeweir/contract";
import { Add01Icon, Delete02Icon, PencilEdit01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { SwitchField } from "@/components/site/fields";
import { ErrorState, LoadingState } from "@/components/states";
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
import { useOpenKey } from "@/hooks/use-open-key";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

const NO_REGION = "__none__";

function RegionSelect({
  regions,
  value,
  onChange,
}: {
  regions: Region[];
  value: string | null;
  onChange: (value: string | null) => void;
}) {
  const items = [
    { label: m.node_groups_no_region(), value: NO_REGION },
    ...regions.map((r) => ({ label: `${r.name} (${r.code})`, value: r.id })),
  ];
  return (
    <Select
      value={value ?? NO_REGION}
      onValueChange={(v) => onChange(!v || v === NO_REGION ? null : String(v))}
      items={items}
    >
      <SelectTrigger
        className="w-full"
        aria-label={m.node_groups_region()}
        data-testid="region-select"
      >
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

function NodeGroupDialog({
  cluster,
  group,
  open,
  onOpenChange,
}: {
  cluster: Cluster;
  group?: NodeGroup;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const regions = useQuery({ ...orpc.regions.list.queryOptions(), enabled: open });
  const create = useMutation(orpc.nodeGroups.create.mutationOptions());
  const update = useMutation(orpc.nodeGroups.update.mutationOptions());
  const [regionId, setRegionId] = React.useState<string | null>(group?.regionId ?? null);
  const [isCanary, setIsCanary] = React.useState(group?.isCanary ?? false);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={group ? m.node_groups_edit() : m.node_groups_create()}
      submitLabel={group ? m.common_save() : m.common_create()}
      submitTestId="node-group-submit"
      onSubmit={async (data) => {
        const name = String(data.get("groupName") ?? "").trim();
        if (group) await update.mutateAsync({ id: group.id, name, regionId, isCanary });
        else await create.mutateAsync({ clusterId: cluster.id, name, regionId, isCanary });
        await queryClient.invalidateQueries();
        toast.success(m.common_saved());
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="groupName">{m.node_groups_name()}</FieldLabel>
        <Input
          id="groupName"
          name="groupName"
          required
          maxLength={64}
          defaultValue={group?.name}
          placeholder="shanghai"
        />
      </Field>
      <Field>
        <FieldLabel>{m.node_groups_region()}</FieldLabel>
        <RegionSelect regions={regions.data ?? []} value={regionId} onChange={setRegionId} />
      </Field>
      <SwitchField
        id="groupCanary"
        label={m.node_groups_canary_label()}
        checked={isCanary}
        onCheckedChange={setIsCanary}
        className="self-start"
        testId="node-group-canary"
      />
    </FormDialog>
  );
}

/**
 * Delete with confirmation. The row actions of the tables below are components of their own:
 * column templates are plain functions (DataTable) and hold no hooks.
 */
function DeleteNodeGroupAction({ group }: { group: NodeGroup }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.nodeGroups.delete.mutationOptions());
  return (
    <ConfirmDialog
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label={m.common_delete()}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      }
      destructive
      title={m.node_groups_delete_confirm({ name: group.name })}
      confirmLabel={m.common_delete()}
      onConfirm={async () => {
        await remove.mutateAsync({ id: group.id });
        await queryClient.invalidateQueries();
      }}
    />
  );
}

/** The cluster's node groups, with their regions and canary marks. */
export function NodeGroupsSection({ cluster }: { cluster: Cluster }) {
  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: { clusterId: cluster.id } }));
  const [createOpen, setCreateOpen] = React.useState(false);
  const createKey = useOpenKey(createOpen);
  const [editing, setEditing] = React.useState<NodeGroup | null>(null);
  const columns = React.useMemo<Columns<NodeGroup>>(
    () => [
      {
        id: "name",
        header: () => m.node_groups_name(),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <span className="font-medium" data-testid="node-group-name">
              {row.original.name}
            </span>
            {row.original.isDefault ? (
              <Badge variant="outline">{m.node_groups_default()}</Badge>
            ) : null}
            {row.original.isCanary ? (
              <Badge variant="secondary" data-testid="node-group-canary-badge">
                {m.node_groups_canary()}
              </Badge>
            ) : null}
          </div>
        ),
      },
      {
        id: "region",
        header: () => m.node_groups_region(),
        cell: ({ row }) =>
          row.original.regionName ? (
            <Badge variant="secondary">
              {row.original.regionName} · {row.original.regionCode}
            </Badge>
          ) : (
            <span className="text-muted-foreground">—</span>
          ),
      },
      {
        id: "nodes",
        header: () => m.node_groups_nodes(),
        cell: ({ row }) => <span className="tabular-nums">{row.original.nodeCount}</span>,
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.node_groups_edit()}
              onClick={() => setEditing(row.original)}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            </Button>
            {row.original.isDefault ? null : <DeleteNodeGroupAction group={row.original} />}
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">{m.node_groups_title()}</h2>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setCreateOpen(true)}
          data-testid="create-node-group"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.node_groups_create()}
        </Button>
      </div>
      {groups.isPending ? (
        <LoadingState />
      ) : groups.isLoadingError ? (
        <ErrorState error={groups.error} onRetry={() => groups.refetch()} />
      ) : (
        <DataTable
          data={groups.data}
          columns={columns}
          getRowId={(g) => g.id}
          testId="node-groups-table"
        />
      )}
      <NodeGroupDialog
        key={`create-${cluster.id}-${createKey}`}
        cluster={cluster}
        open={createOpen}
        onOpenChange={setCreateOpen}
      />
      {editing ? (
        <NodeGroupDialog
          key={editing.id}
          cluster={cluster}
          group={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
    </section>
  );
}
