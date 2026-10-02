import type { Region } from "@edgeweir/contract";
import {
  Add01Icon,
  Delete02Icon,
  Location01Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { EmptyState, QueryView } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { useDialogState } from "@/hooks/use-dialog-state";
import { m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

function RegionDialog({
  region,
  open,
  onOpenChange,
}: {
  region?: Region;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const create = useMutation(orpc.regions.create.mutationOptions());
  const update = useMutation(orpc.regions.update.mutationOptions());
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={region ? m.regions_edit() : m.regions_create()}
      submitLabel={region ? m.common_save() : m.common_create()}
      submitTestId="region-submit"
      onSubmit={async (data) => {
        const input = {
          name: String(data.get("regionName") ?? "").trim(),
          code: String(data.get("regionCode") ?? "").trim(),
        };
        if (region) await update.mutateAsync({ id: region.id, ...input });
        else await create.mutateAsync(input);
        await queryClient.invalidateQueries();
        toast.success(m.common_saved());
        onOpenChange(false);
      }}
    >
      <Field>
        <FieldLabel htmlFor="regionName">{m.regions_name()}</FieldLabel>
        <Input
          id="regionName"
          name="regionName"
          required
          maxLength={64}
          defaultValue={region?.name}
          placeholder={m.regions_name_placeholder()}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="regionCode">{m.regions_code()}</FieldLabel>
        <Input
          id="regionCode"
          name="regionCode"
          required
          maxLength={32}
          pattern="[a-zA-Z0-9][a-zA-Z0-9\-]*"
          defaultValue={region?.code}
          placeholder="cn-east"
          className="font-mono"
        />
      </Field>
    </FormDialog>
  );
}

/**
 * Delete with confirmation. A component of its own: column templates are plain
 * functions (DataTable) and hold no hooks.
 */
function DeleteRegionAction({ region }: { region: Region }) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.regions.delete.mutationOptions());
  return (
    <ConfirmDialog
      trigger={
        <Button size="icon-sm" variant="ghost" aria-label={m.common_delete()}>
          <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
        </Button>
      }
      destructive
      title={m.regions_delete_confirm({ name: region.name })}
      confirmLabel={m.common_delete()}
      onConfirm={async () => {
        await remove.mutateAsync({ id: region.id });
        await queryClient.invalidateQueries();
      }}
    />
  );
}

/**
 * The regions node groups and probes are placed in (a view of the clusters
 * page). `createOpen` is the page's "new region" dialog.
 */
export function RegionsPanel({
  createOpen,
  onCreateOpenChange,
}: {
  createOpen: boolean;
  onCreateOpenChange: (open: boolean) => void;
}) {
  return (
    <>
      <RegionsList onCreate={() => onCreateOpenChange(true)} />
      <RegionDialog open={createOpen} onOpenChange={onCreateOpenChange} />
    </>
  );
}

function RegionsList({ onCreate }: { onCreate: () => void }) {
  const regions = useQuery(orpc.regions.list.queryOptions());
  const edit = useDialogState<Region>();
  const columns = React.useMemo<Columns<Region>>(
    () => [
      {
        id: "name",
        header: () => m.regions_name(),
        cell: ({ row }) => (
          <span className="font-medium" data-testid="region-name">
            {row.original.name}
          </span>
        ),
      },
      {
        id: "code",
        header: () => m.regions_code(),
        cell: ({ row }) => (
          <Badge variant="outline" className="font-mono">
            {row.original.code}
          </Badge>
        ),
      },
      {
        id: "groups",
        header: () => m.regions_node_groups(),
        cell: ({ row }) => <span className="tabular-nums">{row.original.nodeGroupCount}</span>,
      },
      {
        id: "created",
        header: () => m.revisions_col_time(),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{timeAgo(row.original.createdAt)}</span>
        ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end gap-1">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.regions_edit()}
              onClick={() => edit.show(row.original)}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            </Button>
            <DeleteRegionAction region={row.original} />
          </div>
        ),
      },
    ],
    [edit.show],
  );

  return (
    <>
      <QueryView
        query={regions}
        empty={
          <EmptyState icon={Location01Icon} title={m.regions_empty()}>
            <Button onClick={onCreate}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.regions_create()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          <DataTable data={list} columns={columns} getRowId={(r) => r.id} testId="regions-table" />
        )}
      </QueryView>
      {edit.value ? (
        <RegionDialog
          key={edit.key}
          region={edit.value}
          open={edit.open}
          onOpenChange={edit.onOpenChange}
        />
      ) : null}
    </>
  );
}
