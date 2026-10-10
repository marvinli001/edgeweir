import { MAX_BATCH_SITES } from "@edgeweir/contract";
import {
  Cancel01Icon,
  Copy01Icon,
  DatabaseSync01Icon,
  Delete02Icon,
  PauseIcon,
  PlayIcon,
  Tag01Icon,
} from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { FormDialog } from "@/components/form-dialog";
import { CopySettingsDialog } from "@/components/site/copy-settings-dialog";
import { TagPicker } from "@/components/site-tags";
import { Button } from "@/components/ui/button";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";

type Dialog = "enable" | "disable" | "purge" | "addTags" | "removeTags" | "copy" | "delete" | null;

/**
 * Actions on the selected sites (id to name): turn on or off, purge, add or remove tags, copy
 * settings from another site, delete (typing the number of sites). Each action is one request;
 * the server audits every site and publishes each cluster once.
 */
export function SitesBatchBar({
  selected,
  onClear,
}: {
  selected: ReadonlyMap<string, string>;
  onClear: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [dialog, setDialog] = React.useState<Dialog>(null);
  const [tags, setTags] = React.useState<string[]>([]);
  const [draft, setDraft] = React.useState("");
  const [typed, setTyped] = React.useState("");
  const ids = [...selected.keys()];
  const count = ids.length;
  const refresh = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.sites.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.siteTags.key() }),
    ]);
  const open = (next: Dialog) => {
    setTags([]);
    setDraft("");
    setTyped("");
    setDialog(next);
  };
  const close = (next: boolean) => {
    if (!next) setDialog(null);
  };
  const action = (
    kind: Exclude<Dialog, null>,
    icon: typeof PlayIcon,
    label: string,
    variant: "outline" | "destructive" = "outline",
  ) => (
    <Button size="sm" variant={variant} onClick={() => open(kind)} data-testid={`batch-${kind}`}>
      <HugeiconsIcon icon={icon} strokeWidth={2} />
      {label}
    </Button>
  );

  return (
    <div
      className="sticky bottom-3 z-10 flex flex-wrap items-center gap-2 rounded-2xl bg-overlay px-3 py-2 shadow-elev-2 edge-lit animate-enter"
      role="toolbar"
      aria-label={m.sites_selected({ count })}
      data-testid="sites-batch-bar"
    >
      <span className="me-1 text-sm font-medium tabular-nums" data-testid="batch-count">
        {m.sites_selected({ count })}
      </span>
      {count >= MAX_BATCH_SITES ? (
        <span className="text-xs text-muted-foreground" data-testid="batch-limit">
          {m.batch_limit({ max: MAX_BATCH_SITES })}
        </span>
      ) : null}
      {action("enable", PlayIcon, m.site_enable())}
      {action("disable", PauseIcon, m.site_disable())}
      {action("purge", DatabaseSync01Icon, m.sites_purge())}
      {action("addTags", Tag01Icon, m.batch_add_tags())}
      {action("removeTags", Tag01Icon, m.batch_remove_tags())}
      {action("copy", Copy01Icon, m.copy_title())}
      {action("delete", Delete02Icon, m.common_delete(), "destructive")}
      <Button
        size="sm"
        variant="ghost"
        className="ms-auto"
        onClick={onClear}
        data-testid="batch-clear"
      >
        <HugeiconsIcon icon={Cancel01Icon} strokeWidth={2} />
        {m.batch_clear()}
      </Button>

      <ControlledConfirmDialog
        open={dialog === "enable" || dialog === "disable"}
        onOpenChange={close}
        destructive={dialog === "disable"}
        title={
          dialog === "enable"
            ? m.batch_enable_confirm({ count })
            : m.batch_disable_confirm({ count })
        }
        note={dialog === "disable" ? m.site_disable_note() : undefined}
        confirmLabel={dialog === "enable" ? m.site_enable() : m.site_disable()}
        onConfirm={async () => {
          const enabled = dialog === "enable";
          const result = await client.sites.batchSetEnabled({ ids, enabled });
          toast.success(
            enabled
              ? m.batch_enabled_toast({ count: result.changed.length })
              : m.batch_disabled_toast({ count: result.changed.length }),
          );
          await refresh();
        }}
      >
        <SiteNames selected={selected} />
      </ControlledConfirmDialog>

      <ControlledConfirmDialog
        open={dialog === "purge"}
        onOpenChange={close}
        destructive={false}
        title={m.batch_purge_confirm({ count })}
        confirmLabel={m.sites_purge()}
        onConfirm={async () => {
          await client.cacheTasks.create({ type: "site", siteIds: ids });
          toast.success(m.sites_purged(), {
            action: {
              label: m.purge_view_tasks(),
              onClick: () => void navigate({ to: "/purge" }),
            },
          });
          await queryClient.invalidateQueries({ queryKey: orpc.cacheTasks.key() });
        }}
      >
        <SiteNames selected={selected} />
      </ControlledConfirmDialog>

      <FormDialog
        open={dialog === "addTags" || dialog === "removeTags"}
        onOpenChange={close}
        title={
          dialog === "addTags"
            ? m.batch_add_tags_title({ count })
            : m.batch_remove_tags_title({ count })
        }
        submitLabel={dialog === "addTags" ? m.batch_add_tags() : m.batch_remove_tags()}
        submitDisabled={tags.length === 0 && !draft.trim()}
        submitTestId="batch-tags-submit"
        onSubmit={async () => {
          const result = await client.sites.batchTags(
            dialog === "addTags" ? { ids, add: tags } : { ids, remove: tags },
          );
          toast.success(m.batch_tags_toast({ count: result.changed.length }));
          setDialog(null);
          await refresh();
        }}
      >
        <Field>
          <FieldLabel htmlFor="batch-tags">{m.tags_label()}</FieldLabel>
          <TagPicker
            id="batch-tags"
            value={tags}
            onChange={setTags}
            onDraftChange={setDraft}
            testId="batch-tags"
          />
        </Field>
      </FormDialog>

      <ControlledConfirmDialog
        open={dialog === "delete"}
        onOpenChange={close}
        title={m.batch_delete_confirm({ count })}
        confirmLabel={m.common_delete()}
        confirmDisabled={typed.trim() !== String(count)}
        onConfirm={async () => {
          const result = await client.sites.batchDelete({ ids });
          toast.success(m.batch_deleted_toast({ count: result.changed.length }));
          onClear();
          queryClient.removeQueries({
            predicate: (query) => ids.some((id) => JSON.stringify(query.queryKey).includes(id)),
          });
          await refresh();
        }}
      >
        <SiteNames selected={selected} />
        <Field>
          <FieldLabel htmlFor="batch-delete-confirm">{m.batch_delete_type({ count })}</FieldLabel>
          <Input
            id="batch-delete-confirm"
            inputMode="numeric"
            autoComplete="off"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            data-testid="batch-delete-confirm"
          />
        </Field>
      </ControlledConfirmDialog>

      {dialog === "copy" ? (
        <CopySettingsDialog open onOpenChange={close} targets={selected} />
      ) : null}
    </div>
  );
}

/** The sites an action touches, as one wrapped line under its title. */
function SiteNames({ selected }: { selected: ReadonlyMap<string, string> }) {
  return (
    <p
      className="max-h-24 min-w-0 overflow-y-auto text-sm break-all text-muted-foreground"
      data-testid="batch-sites"
    >
      {[...selected.values()].join(", ")}
    </p>
  );
}
