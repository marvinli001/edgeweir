import type { Node } from "@edgeweir/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

export function RenameNodeDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const queryClient = useQueryClient();
  const update = useMutation(orpc.nodes.update.mutationOptions());
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.nodes_rename()}
      submitLabel={m.common_save()}
      onSubmit={async (data) => {
        await update.mutateAsync({
          id: node.id,
          name: String(data.get("nodeNewName") ?? "").trim(),
        });
        await queryClient.invalidateQueries();
        onClose();
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

export function MoveNodeDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const queryClient = useQueryClient();
  const groups = useQuery(
    orpc.nodeGroups.list.queryOptions({ input: { clusterId: node.clusterId } }),
  );
  const update = useMutation(orpc.nodes.update.mutationOptions());
  const [groupId, setGroupId] = React.useState(node.nodeGroupId ?? "");
  const items = (groups.data ?? []).map((g) => ({
    label: g.regionName ? `${g.name} · ${g.regionName}` : g.name,
    value: g.id,
  }));
  return (
    <FormDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.nodes_move_title({ name: node.name })}
      submitLabel={m.nodes_move()}
      submitTestId="move-submit"
      onSubmit={async () => {
        await update.mutateAsync({ id: node.id, nodeGroupId: groupId });
        await queryClient.invalidateQueries();
        toast.success(m.nodes_moved({ name: node.name }));
        onClose();
      }}
    >
      <Field>
        <FieldLabel>{m.nodes_col_group()}</FieldLabel>
        <Select value={groupId} onValueChange={(v) => v && setGroupId(String(v))} items={items}>
          <SelectTrigger className="w-full" data-testid="move-group-select">
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
      </Field>
    </FormDialog>
  );
}

export function DeleteNodeDialog({ node, onClose }: { node: Node; onClose: () => void }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.nodes.delete.mutationOptions());
  return (
    <ControlledConfirmDialog
      open
      onOpenChange={(open) => !open && onClose()}
      title={m.nodes_delete_confirm({ name: node.name })}
      onConfirm={async () => {
        await remove.mutateAsync({ id: node.id });
        await queryClient.invalidateQueries();
        toast.success(m.common_deleted());
      }}
    />
  );
}
