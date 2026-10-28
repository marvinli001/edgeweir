import type { Cluster, NodeGroup } from "@edgeweir/contract";
import { Add01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { OptionSelect } from "@/components/form-select";
import { RowMenu } from "@/components/row-menu";
import { SwitchField } from "@/components/site/fields";
import { QueryView } from "@/components/states";
import { Field, FieldLabel } from "@/components/ui/field";
import { useDialogState } from "@/hooks/use-dialog-state";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { rowLink, rowLinkButton } from "@/lib/row-link";
import { cn } from "@/lib/utils";

const NO_REGION = "__none__";

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
  const regions = useQuery({ ...orpc.regions.list.queryOptions(), enabled: open });
  const meta = { invalidates: "all", success: m.common_saved } as const;
  const create = useMutation({ ...orpc.nodeGroups.create.mutationOptions(), meta });
  const update = useMutation({ ...orpc.nodeGroups.update.mutationOptions(), meta });
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
        <OptionSelect
          value={regionId ?? NO_REGION}
          options={[
            { label: m.node_groups_no_region(), value: NO_REGION },
            ...(regions.data ?? []).map((r) => ({ label: `${r.name} (${r.code})`, value: r.id })),
          ]}
          onChange={(value) => setRegionId(value === NO_REGION ? null : value)}
          label={m.node_groups_region()}
          testId="region-select"
        />
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
 * The row's menu: delete with confirmation. The row actions of the tables below are components of
 * their own: column templates are plain functions (DataTable) and hold no hooks.
 */
function NodeGroupMenu({ group }: { group: NodeGroup }) {
  const remove = useMutation({
    ...orpc.nodeGroups.delete.mutationOptions(),
    meta: { invalidates: "all" },
  });
  return (
    <RowMenu
      testId="node-group-actions"
      remove={{
        title: m.node_groups_delete_confirm({ name: group.name }),
        onConfirm: () => remove.mutateAsync({ id: group.id }),
      }}
    />
  );
}

/** The cluster's node groups, with their regions and canary marks. */
export function NodeGroupsSection({ cluster }: { cluster: Cluster }) {
  const groups = useQuery(orpc.nodeGroups.list.queryOptions({ input: { clusterId: cluster.id } }));
  const create = useDialogState();
  const edit = useDialogState<NodeGroup>();
  const columns = React.useMemo<Columns<NodeGroup>>(
    () => [
      {
        id: "name",
        stack: "lead",
        header: () => m.node_groups_name(),
        cell: ({ row }) => (
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={cn(rowLinkButton, "font-medium")}
              onClick={() => edit.show(row.original)}
              data-testid="node-group-name"
              {...rowLink}
            >
              {row.original.name}
            </button>
            {row.original.isDefault ? (
              <Badge size="sm" tone="neutral">
                {m.node_groups_default()}
              </Badge>
            ) : null}
            {row.original.isCanary ? (
              <Badge size="sm" tone="neutral" data-testid="node-group-canary-badge">
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
            <Badge size="sm" tone="neutral">
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
        stack: "end",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            {row.original.isDefault ? null : <NodeGroupMenu group={row.original} />}
          </div>
        ),
      },
    ],
    [edit.show],
  );

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-sm font-medium">{m.node_groups_title()}</h2>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => create.show()}
          data-testid="create-node-group"
        >
          <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
          {m.node_groups_create()}
        </Button>
      </div>
      <QueryView query={groups}>
        {(list) => (
          <DataTable
            data={list}
            columns={columns}
            getRowId={(g) => g.id}
            testId="node-groups-table"
            pinFirstColumn
            stack
          />
        )}
      </QueryView>
      <NodeGroupDialog
        key={`create-${cluster.id}-${create.key}`}
        cluster={cluster}
        open={create.open}
        onOpenChange={create.onOpenChange}
      />
      {edit.value ? (
        <NodeGroupDialog
          key={`edit-${edit.key}`}
          cluster={cluster}
          group={edit.value}
          open={edit.open}
          onOpenChange={edit.onOpenChange}
        />
      ) : null}
    </section>
  );
}
