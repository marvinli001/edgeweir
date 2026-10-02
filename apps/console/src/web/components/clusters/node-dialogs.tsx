import type { Node } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { OptionSelect } from "@/components/form-select";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import type { DialogProps } from "@/hooks/use-dialog-state";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** What the node menu opens a dialog for. */
export type NodeAction = { kind: "rename" | "move" | "delete"; node: Node };

/** The dialog of a node menu action. */
export function NodeActionDialog({ action, ...dialog }: { action: NodeAction } & DialogProps) {
  switch (action.kind) {
    case "rename":
      return <RenameNodeDialog node={action.node} {...dialog} />;
    case "move":
      return <MoveNodeDialog node={action.node} {...dialog} />;
    case "delete":
      return <DeleteNodeDialog node={action.node} {...dialog} />;
  }
}

function RenameNodeDialog({ node, open, onOpenChange }: { node: Node } & DialogProps) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.nodes.update.mutationOptions());
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.nodes_rename()}
      submitLabel={m.common_save()}
      onSubmit={async (data) => {
        await update.mutateAsync({
          id: node.id,
          name: String(data.get("nodeNewName") ?? "").trim(),
        });
        await queryClient.invalidateQueries();
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="nodeNewName">{m.nodes_col_name()}</FieldLabel>
        <Input
          id="nodeNewName"
          name="nodeNewName"
          required
          maxLength={64}
          defaultValue={node.name}
        />
      </Field>
    </FormDialog>
  );
}

function MoveNodeDialog({ node, open, onOpenChange }: { node: Node } & DialogProps) {
  const queryClient = useQueryClient();
  const groups = useQuery(
    orpc.nodeGroups.list.queryOptions({ input: { clusterId: node.clusterId } }),
  );
  const update = useMutation(orpc.nodes.update.mutationOptions());
  const [groupId, setGroupId] = React.useState(node.nodeGroupId ?? "");
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.nodes_move_title({ name: node.name })}
      submitLabel={m.nodes_move()}
      submitTestId="move-submit"
      onSubmit={async () => {
        await update.mutateAsync({ id: node.id, nodeGroupId: groupId });
        await queryClient.invalidateQueries();
        toast.success(m.nodes_moved({ name: node.name }));
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel>{m.nodes_col_group()}</FieldLabel>
        <OptionSelect
          value={groupId}
          options={(groups.data ?? []).map((g) => ({
            label: g.regionName ? `${g.name} · ${g.regionName}` : g.name,
            value: g.id,
          }))}
          onChange={setGroupId}
          testId="move-group-select"
        />
      </Field>
    </FormDialog>
  );
}

function DeleteNodeDialog({ node, open, onOpenChange }: { node: Node } & DialogProps) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.nodes.delete.mutationOptions());
  return (
    <ControlledConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.nodes_delete_confirm({ name: node.name })}
      onConfirm={async () => {
        await remove.mutateAsync({ id: node.id });
        await queryClient.invalidateQueries();
        toast.success(m.common_deleted());
      }}
    />
  );
}
