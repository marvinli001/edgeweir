import type { RuleDto, RuleVersion } from "@edgeweir/contract";
import type { Phase } from "@edgeweir/rule-engine";
import { HistoryIcon, RestoreBinIcon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import * as React from "react";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { SafetyNote } from "@/components/safety-note";
import { actionLabel, phaseLabel } from "@/components/site/rules/labels";
import { EmptyState, QueryView } from "@/components/states";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { formatDateTime, m } from "@/lib/i18n";
import { client, orpc } from "@/lib/orpc";
import type { Kind } from "@/lib/rule-actions";
import {
  actionText,
  changedFields,
  type DiffLine,
  lineDiff,
  type RuleField,
  type RuleState,
  ruleFields,
} from "@/lib/rule-history";
import { cn } from "@/lib/utils";

/** What the rules editor tells the history: the scope, its saved rules and unsaved edits. */
export const RuleHistoryContext = React.createContext<{
  siteId?: string;
  saved: ReadonlyMap<string, RuleDto>;
  dirty: boolean;
}>({ saved: new Map(), dirty: false });

const changeLabel: Record<RuleVersion["change"], () => string> = {
  created: m.rules_version_created,
  updated: m.rules_version_updated,
  deleted: m.rules_version_deleted,
};
function sourceLabel(version: RuleVersion): string {
  switch (version.source) {
    case "ui":
      return m.rules_source_ui();
    case "api":
      return m.rules_source_api();
    case "copy":
      return m.rules_source_copy();
    case "initial":
      return m.rules_source_initial();
    case "restore":
      return m.rules_source_restore({ version: version.restoredFrom ?? 0 });
  }
}
const fieldLabel: Record<RuleField, () => string> = {
  name: m.rules_name,
  enabled: m.rules_enabled,
  phase: m.rules_phase,
  expression: m.rules_expression,
  action: m.rules_action,
};
function fieldValue(rule: RuleState, field: Exclude<RuleField, "expression" | "action">) {
  if (field === "enabled") return rule.enabled ? m.rules_on() : m.rules_off();
  if (field === "phase") return phaseLabel(rule.phase as Phase);
  return rule.name;
}

function Lines({ lines }: { lines: DiffLine[] }) {
  return (
    <pre className="overflow-x-auto rounded-lg bg-wash py-2 font-mono text-xs leading-relaxed">
      {lines.map((line, index) => (
        <div
          // Lines repeat; their position is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: a diff's lines have no other key
          key={index}
          data-diff={line.kind}
          className={cn(
            "px-3 whitespace-pre",
            line.kind === "removed" && "bg-tint-destructive text-destructive",
            line.kind === "added" && "bg-tint-primary text-primary",
            line.kind === "same" && "text-muted-foreground",
          )}
        >
          {line.kind === "removed" ? "- " : line.kind === "added" ? "+ " : "  "}
          {line.text}
        </div>
      ))}
    </pre>
  );
}

/**
 * A version against the rule as saved now (`current`): the fields restoring it would change, the
 * current value struck through. Without `current` (a deleted rule), every field as it was.
 */
function RuleDiff({ current, version }: { current?: RuleState; version: RuleState }) {
  const fields = current ? changedFields(current, version) : [...ruleFields];
  if (!fields.length)
    return <p className="text-sm text-muted-foreground">{m.rules_version_same()}</p>;
  const text = (rule: RuleState | undefined, field: "expression" | "action") =>
    rule ? (field === "action" ? actionText(rule.action) : rule.expression).split("\n") : [];
  return (
    <dl className="grid gap-3 text-sm" data-testid="rule-version-diff">
      {fields.map((field) => (
        <div key={field} className="grid gap-1">
          <dt className="text-xs text-muted-foreground">{fieldLabel[field]()}</dt>
          <dd className="min-w-0">
            {field === "expression" || field === "action" ? (
              <Lines
                lines={
                  current
                    ? lineDiff(text(current, field), text(version, field))
                    : text(version, field).map((line) => ({ kind: "same", text: line }))
                }
              />
            ) : (
              <span className="flex flex-wrap items-center gap-2">
                {current ? (
                  <>
                    <del className="text-muted-foreground">{fieldValue(current, field)}</del>
                    <span aria-hidden className="text-muted-foreground">
                      →
                    </span>
                  </>
                ) : null}
                <span>{fieldValue(version, field)}</span>
              </span>
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** Restores a version of a rule (a save that publishes at once), confirmed first. */
function useRestore(siteId: string | undefined) {
  return useMutation({
    mutationFn: ({ ruleId, version }: { ruleId: string; version: number }) =>
      siteId
        ? client.rules.restore({ id: siteId, ruleId, version })
        : client.platformRules.restore({ ruleId, version }),
    // The editor reloads the rules; revisions and the sites' delivery change too.
    meta: { invalidates: "all", success: m.rules_restored },
  });
}

function RestoreConfirm({ target, onClose }: { target: RuleVersion | null; onClose: () => void }) {
  const history = React.useContext(RuleHistoryContext);
  const restore = useRestore(history.siteId);
  return (
    <ControlledConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      destructive={false}
      title={m.rules_restore_title({
        name: target?.rule.name ?? "",
        version: target?.version ?? 0,
      })}
      note={history.dirty ? m.rules_restore_discards() : m.rules_restore_note()}
      confirmLabel={m.rules_restore()}
      onConfirm={() =>
        target
          ? restore.mutateAsync({ ruleId: target.ruleId, version: target.version })
          : Promise.resolve()
      }
    />
  );
}

/** One version: what and who, opened to compare it with the rule as saved now. */
function VersionItem({
  version,
  current,
  open,
  onToggle,
  onRestore,
}: {
  version: RuleVersion;
  current?: RuleState;
  open: boolean;
  onToggle: () => void;
  onRestore: () => void;
}) {
  const same = current ? changedFields(current, version.rule).length === 0 : false;
  return (
    <li className="border-t border-edge first:border-t-0" data-testid="rule-version">
      <div className="flex items-center gap-3 px-6 py-3">
        <button
          type="button"
          className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
          aria-expanded={open}
          onClick={onToggle}
        >
          <span className="flex items-center gap-2 text-sm">
            <span className="font-mono">{m.rules_version({ version: version.version })}</span>
            <span className={cn(version.change === "deleted" && "text-destructive")}>
              {changeLabel[version.change]()}
            </span>
          </span>
          <span className="w-full truncate text-xs text-muted-foreground">
            {[sourceLabel(version), version.actor.name, formatDateTime(version.createdAt)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={same}
          data-testid="rule-version-restore"
          onClick={onRestore}
        >
          {m.rules_restore()}
        </Button>
      </div>
      {open ? (
        <div className="animate-enter px-6 pb-4">
          <RuleDiff current={current} version={version.rule} />
        </div>
      ) : null}
    </li>
  );
}

function VersionList({ versions, current }: { versions: RuleVersion[]; current?: RuleState }) {
  const [opened, setOpened] = React.useState<number | null>(versions[0]?.version ?? null);
  const [target, setTarget] = React.useState<RuleVersion | null>(null);
  return (
    <>
      <ul className="-mx-6 max-h-[60vh] overflow-y-auto border-t border-edge">
        {versions.map((version) => (
          <VersionItem
            key={`${version.ruleId}:${version.version}`}
            version={version}
            current={current}
            open={opened === version.version}
            onToggle={() => setOpened(opened === version.version ? null : version.version)}
            onRestore={() => setTarget(version)}
          />
        ))}
      </ul>
      <RestoreConfirm target={target} onClose={() => setTarget(null)} />
    </>
  );
}

/** The history button of a saved rule: its versions, compared with it and restorable. */
export function RuleHistoryButton({ ruleId }: { ruleId: string }) {
  const history = React.useContext(RuleHistoryContext);
  const [open, setOpen] = React.useState(false);
  const current = history.saved.get(ruleId);
  const versions = useQuery({
    ...(history.siteId
      ? orpc.rules.versions.queryOptions({ input: { id: history.siteId, ruleId } })
      : orpc.platformRules.versions.queryOptions({ input: { ruleId } })),
    enabled: open,
  });
  // A rule added in the editor has no versions until it is saved.
  if (!current) return null;
  return (
    <>
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={m.rules_history()}
        data-testid="rule-history"
        onClick={() => setOpen(true)}
      >
        <HugeiconsIcon icon={HistoryIcon} />
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader className="pr-8">
            <DialogTitle className="truncate">
              {m.rules_history_title({ name: current.name })}
            </DialogTitle>
          </DialogHeader>
          <QueryView query={versions} empty={<EmptyState title={m.rules_history_empty()} />}>
            {(list) => <VersionList versions={list} current={current} />}
          </QueryView>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** The scope's deleted rules, each restorable as it was when deleted; hidden while there are none. */
export function DeletedRules() {
  const history = React.useContext(RuleHistoryContext);
  const [open, setOpen] = React.useState(false);
  const [opened, setOpened] = React.useState<string | null>(null);
  const [target, setTarget] = React.useState<RuleVersion | null>(null);
  const deleted = useQuery(
    history.siteId
      ? orpc.rules.deleted.queryOptions({ input: { id: history.siteId } })
      : orpc.platformRules.deleted.queryOptions(),
  );
  const count = deleted.data?.length ?? 0;
  if (!count && !open) return null;
  return (
    <>
      <div className="flex justify-end animate-in fade-in">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          data-testid="rules-deleted"
          onClick={() => setOpen(true)}
        >
          <HugeiconsIcon icon={RestoreBinIcon} />
          {m.rules_deleted_count({ count })}
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader className="pr-8">
            <DialogTitle>{m.rules_deleted()}</DialogTitle>
            {history.dirty ? <SafetyNote>{m.rules_restore_discards()}</SafetyNote> : null}
          </DialogHeader>
          <QueryView query={deleted} empty={<EmptyState title={m.rules_deleted_empty()} />}>
            {(list) => (
              <ul className="-mx-6 max-h-[60vh] overflow-y-auto border-t border-edge">
                {list.map((version) => (
                  <li
                    key={version.ruleId}
                    className="border-t border-edge first:border-t-0"
                    data-testid="rule-deleted"
                  >
                    <div className="flex items-center gap-3 px-6 py-3">
                      <button
                        type="button"
                        className="flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-md text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
                        aria-expanded={opened === version.ruleId}
                        onClick={() => setOpened(opened === version.ruleId ? null : version.ruleId)}
                      >
                        <span className="w-full truncate text-sm">{version.rule.name}</span>
                        <span className="w-full truncate text-xs text-muted-foreground">
                          {[
                            phaseLabel(version.rule.phase as Phase),
                            actionLabel(version.rule.action.kind as Kind),
                            version.actor.name,
                            formatDateTime(version.createdAt),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </span>
                      </button>
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        data-testid="rule-deleted-restore"
                        onClick={() => setTarget(version)}
                      >
                        {m.rules_restore()}
                      </Button>
                    </div>
                    {opened === version.ruleId ? (
                      <div className="animate-enter px-6 pb-4">
                        <RuleDiff version={version.rule} />
                      </div>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </QueryView>
          <RestoreConfirm target={target} onClose={() => setTarget(null)} />
        </DialogContent>
      </Dialog>
    </>
  );
}
