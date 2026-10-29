import type { Cluster } from "@edgeweir/contract";
import { useMutation } from "@tanstack/react-query";
import { Input } from "@/components/arc/input/input";
import { FormDialog } from "@/components/form-dialog";
import { Field, FieldLabel } from "@/components/layout/form";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/** Create a cluster, or rename one when `cluster` is given. */
export function ClusterDialog({
  cluster,
  open,
  onOpenChange,
  onSaved,
}: {
  cluster?: Cluster;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: (cluster: Cluster) => void;
}) {
  const meta = { invalidates: "all", success: m.common_saved } as const;
  const create = useMutation({ ...orpc.clusters.create.mutationOptions(), meta });
  const update = useMutation({ ...orpc.clusters.update.mutationOptions(), meta });
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={cluster ? m.clusters_edit() : m.clusters_create()}
      submitLabel={cluster ? m.common_save() : m.common_create()}
      submitTestId="cluster-submit"
      onSubmit={async (data) => {
        const input = {
          name: String(data.get("clusterName") ?? "").trim(),
          description: String(data.get("clusterDescription") ?? "").trim(),
        };
        const saved = cluster
          ? await update.mutateAsync({ id: cluster.id, ...input })
          : await create.mutateAsync(input);
        onSaved?.(saved);
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="clusterName">{m.clusters_name()}</FieldLabel>
        <Input
          id="clusterName"
          name="clusterName"
          required
          maxLength={64}
          pattern="[a-z0-9][a-z0-9\-]*"
          defaultValue={cluster?.name}
          placeholder="edge-cn"
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="clusterDescription">{m.clusters_description()}</FieldLabel>
        <Input
          id="clusterDescription"
          name="clusterDescription"
          maxLength={500}
          defaultValue={cluster?.description}
        />
      </Field>
    </FormDialog>
  );
}
