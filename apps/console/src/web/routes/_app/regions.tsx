import type { Region } from "@edgeweir/contract";
import {
  Add01Icon,
  Delete02Icon,
  Location01Icon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import * as z from "zod";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { type Columns, DataTable } from "@/components/data-table";
import { FormDialog } from "@/components/form-dialog";
import { Page } from "@/components/page";
import { ProbesPanel } from "@/components/probes";
import { EmptyState, ErrorState, LoadingState } from "@/components/states";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { m, timeAgo } from "@/lib/i18n";
import { errorMessage, orpc } from "@/lib/orpc";

export const Route = createFileRoute("/_app/regions")({
  validateSearch: z.object({
    tab: z.enum(["regions", "probes"]).optional(),
    addProbe: z.boolean().optional(),
  }),
  component: RegionsPage,
});

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
        try {
          await remove.mutateAsync({ id: region.id });
          await queryClient.invalidateQueries();
        } catch (error) {
          toast.error(errorMessage(error));
        }
      }}
    />
  );
}

/** Regions, and the probes that measure the nodes from them. */
function RegionsPage() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const [createOpen, setCreateOpen] = React.useState(false);
  const tab = search.tab ?? "regions";
  const setAddProbe = (open: boolean) =>
    navigate({ search: (prev) => ({ ...prev, addProbe: open || undefined }), replace: true });
  return (
    <Page
      title={m.regions_title()}
      actions={
        tab === "probes" ? (
          <Button size="sm" onClick={() => setAddProbe(true)} data-testid="add-probe">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.probes_add()}
          </Button>
        ) : (
          <Button size="sm" onClick={() => setCreateOpen(true)} data-testid="create-region">
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.regions_create()}
          </Button>
        )
      }
    >
      <Tabs
        value={tab}
        onValueChange={(value) =>
          navigate({
            search: (prev) => ({ ...prev, tab: value === "probes" ? "probes" : undefined }),
            replace: true,
          })
        }
      >
        <TabsList>
          <TabsTrigger value="regions" data-testid="regions-tab-regions">
            {m.regions_tab_regions()}
          </TabsTrigger>
          <TabsTrigger value="probes" data-testid="regions-tab-probes">
            {m.regions_tab_probes()}
          </TabsTrigger>
        </TabsList>
        <TabsContent value="regions" className="flex flex-col gap-4 animate-enter">
          <RegionsList onCreate={() => setCreateOpen(true)} />
        </TabsContent>
        <TabsContent value="probes" className="animate-enter">
          <ProbesPanel addOpen={search.addProbe === true} onAddOpenChange={setAddProbe} />
        </TabsContent>
      </Tabs>
      <RegionDialog open={createOpen} onOpenChange={setCreateOpen} />
    </Page>
  );
}

function RegionsList({ onCreate }: { onCreate: () => void }) {
  const regions = useQuery(orpc.regions.list.queryOptions());
  const [editing, setEditing] = React.useState<Region | null>(null);
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
              onClick={() => setEditing(row.original)}
            >
              <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            </Button>
            <DeleteRegionAction region={row.original} />
          </div>
        ),
      },
    ],
    [],
  );

  return (
    <>
      {regions.isPending ? (
        <LoadingState />
      ) : regions.isError ? (
        <ErrorState error={regions.error} onRetry={() => regions.refetch()} />
      ) : regions.data.length === 0 ? (
        <EmptyState icon={Location01Icon} title={m.regions_empty()}>
          <Button onClick={onCreate}>
            <HugeiconsIcon icon={Add01Icon} strokeWidth={2} />
            {m.regions_create()}
          </Button>
        </EmptyState>
      ) : (
        <DataTable
          data={regions.data}
          columns={columns}
          getRowId={(r) => r.id}
          testId="regions-table"
        />
      )}
      {editing ? (
        <RegionDialog
          key={editing.id}
          region={editing}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      ) : null}
    </>
  );
}
