import type { Region } from "@edgeweir/contract";
import { Add01Icon, Location01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Button } from "@/components/arc/button/button";
import { Input } from "@/components/arc/input/input";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { ItemMenu } from "@/components/row-menu";
import { EmptyState, QueryView } from "@/components/states";
import { Field, FieldLabel } from "@/components/ui/field";
import { useDialogState } from "@/hooks/use-dialog-state";
import { placeOf } from "@/lib/edge-map";
import { m, timeAgo } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";
import { rowLink, rowLinkButton } from "@/lib/row-link";
import { cn } from "@/lib/utils";

const RegionMap = React.lazy(() => import("@/components/effects/region-map"));

/** The regions on the dot map (placed by city); the table below lists them in words. */
function RegionMapCard({ regions }: { regions: Region[] }) {
  if (!regions.some((r) => placeOf(r.code, r.name))) return null;
  return (
    <section
      className="overflow-hidden rounded-2xl bg-card px-3 py-5 shadow-elev-1 edge-lit animate-enter @3xl/main:px-8 @3xl/main:py-7"
      data-testid="regions-map"
    >
      <React.Suspense fallback={<div className="aspect-[173/66] w-full" />}>
        <RegionMap regions={regions} />
      </React.Suspense>
    </section>
  );
}

function RegionDialog({
  region,
  open,
  onOpenChange,
}: {
  region?: Region;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  // Node groups, probes and scheduling show regions.
  const meta = { invalidates: "all", success: m.common_saved } as const;
  const create = useMutation({ ...orpc.regions.create.mutationOptions(), meta });
  const update = useMutation({ ...orpc.regions.update.mutationOptions(), meta });
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
function RegionMenu({ region }: { region: Region }) {
  const remove = useMutation({
    ...orpc.regions.delete.mutationOptions(),
    meta: { invalidates: "all" },
  });
  return (
    <ItemMenu
      testId="region-actions"
      remove={{
        title: m.regions_delete_confirm({ name: region.name }),
        onConfirm: () => remove.mutateAsync({ id: region.id }),
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
        stack: "lead",
        header: () => m.regions_name(),
        cell: ({ row }) => (
          <button
            type="button"
            className={cn(rowLinkButton, "font-medium")}
            onClick={() => edit.show(row.original)}
            data-testid="region-name"
            {...rowLink}
          >
            {row.original.name}
          </button>
        ),
      },
      {
        id: "code",
        header: () => m.regions_code(),
        cell: ({ row }) => (
          <Badge size="sm" tone="neutral" className="font-mono">
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
        hideBelow: "lg",
        header: () => m.revisions_col_time(),
        cell: ({ row }) => (
          <span className="text-xs text-muted-foreground">{timeAgo(row.original.createdAt)}</span>
        ),
      },
      {
        id: "actions",
        stack: "end",
        header: () => <span className="sr-only">{m.common_actions()}</span>,
        cell: ({ row }) => (
          <div className="flex justify-end">
            <RegionMenu region={row.original} />
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
          <EmptyState icon={Location01Icon} art="node" title={m.regions_empty()}>
            <Button onClick={onCreate}>
              <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
              {m.regions_create()}
            </Button>
          </EmptyState>
        }
      >
        {(list) => (
          <>
            <RegionMapCard regions={list} />
            <DataTable
              data={list}
              columns={columns}
              getRowId={(r) => r.id}
              testId="regions-table"
              pinFirstColumn
              stack
            />
          </>
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
