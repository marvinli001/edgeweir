import type { L4App } from "@edgeweir/contract";
import {
  ChartLineData01Icon,
  Delete02Icon,
  MoreHorizontalIcon,
  PencilEdit01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { m } from "@/lib/i18n";
import { orpc } from "@/lib/orpc";

/**
 * The application's enabled switch: turning it either way asks first. A component of its own
 * with its own mutation, so a table's cells keep their identity (f626d5f).
 */
export function L4EnabledSwitch({ app }: { app: L4App }) {
  const queryClient = useQueryClient();
  const setEnabled = useMutation(orpc.l4Apps.setEnabled.mutationOptions());
  const [open, setOpen] = React.useState(false);
  const enable = !app.enabled;
  return (
    <>
      <Switch
        checked={app.enabled}
        disabled={setEnabled.isPending}
        onCheckedChange={() => setOpen(true)}
        aria-label={m.l4_enabled()}
        data-testid="l4-app-enabled"
      />
      <ControlledConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={
          enable
            ? m.l4_enable_confirm({ name: app.name })
            : m.l4_disable_confirm({ name: app.name })
        }
        note={enable ? undefined : m.l4_disable_note()}
        confirmLabel={enable ? m.site_enable() : m.site_disable()}
        destructive={!enable}
        onConfirm={async () => {
          const result = await setEnabled.mutateAsync({
            id: app.id,
            enabled: enable,
            expectedUpdatedAt: app.updatedAt,
          });
          queryClient.setQueryData(orpc.l4Apps.get.queryKey({ input: { id: app.id } }), result.app);
          await queryClient.invalidateQueries({ queryKey: orpc.l4Apps.key() });
          await queryClient.invalidateQueries({ queryKey: orpc.clusters.key() });
          toast.success(
            result.app.enabled
              ? m.l4_enabled_toast({ revision: result.revision.revision })
              : m.l4_disabled_toast({ revision: result.revision.revision }),
          );
        }}
      />
    </>
  );
}

/** Delete with confirmation; a refusal stays in the dialog. */
export function DeleteL4AppDialog({
  app,
  open,
  onOpenChange,
  onDeleted,
}: {
  app: L4App;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted?: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation(orpc.l4Apps.delete.mutationOptions());
  return (
    <ControlledConfirmDialog
      open={open}
      onOpenChange={onOpenChange}
      title={m.l4_delete_confirm({ name: app.name })}
      confirmLabel={m.common_delete()}
      onConfirm={async () => {
        const result = await remove.mutateAsync({ id: app.id });
        toast.success(m.sites_deleted({ revision: result.revision.revision }));
        onDeleted?.();
        await queryClient.invalidateQueries({ queryKey: orpc.l4Apps.list.key() });
        await queryClient.invalidateQueries({ queryKey: orpc.clusters.key() });
      }}
    />
  );
}

/** Row menu of an application: edit, statistics, delete. */
export function L4AppActions({ app, onEdit }: { app: L4App; onEdit: (app: L4App) => void }) {
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = React.useState(false);
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={m.common_actions()}
              data-testid="l4-app-actions"
            />
          }
        >
          <HugeiconsIcon icon={MoreHorizontalIcon} strokeWidth={2} />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => onEdit(app)} data-testid="l4-app-edit">
            <HugeiconsIcon icon={PencilEdit01Icon} strokeWidth={2} />
            {m.common_edit()}
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() =>
              navigate({ to: "/l4/$id", params: { id: app.id }, search: { tab: "stats" } })
            }
            data-testid="l4-app-stats"
          >
            <HugeiconsIcon icon={ChartLineData01Icon} strokeWidth={2} />
            {m.analytics_title()}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleteOpen(true)}
            data-testid="l4-app-delete"
          >
            <HugeiconsIcon icon={Delete02Icon} strokeWidth={2} />
            {m.common_delete()}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <DeleteL4AppDialog app={app} open={deleteOpen} onOpenChange={setDeleteOpen} />
    </>
  );
}
