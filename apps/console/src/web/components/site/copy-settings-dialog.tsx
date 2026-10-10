import {
  SITE_COPY_PARTS,
  type SiteCopyChange,
  type SiteCopyPart,
  type SiteCopyPreview,
  type SiteCopyResult,
} from "@edgeweir/contract";
import { Alert02Icon, CheckmarkCircle02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { OptionSelect } from "@/components/form-select";
import { enterDelay } from "@/components/page";
import { SafetyNote } from "@/components/safety-note";
import { SiteMultiSelect } from "@/components/site-multi-select";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import { useAction } from "@/hooks/use-action";
import { m } from "@/lib/i18n";
import { client, errorMessage, orpc } from "@/lib/orpc";

/** Labels of the parts one copy can take, in the console's order. */
export const copyPartLabel = (part: SiteCopyPart): string =>
  ({
    cacheRules: m.copy_part_cache_rules,
    cacheKey: m.copy_part_cache_key,
    cacheTag: m.copy_part_cache_tag,
    compression: m.copy_part_compression,
    https: m.copy_part_https,
    rules: m.copy_part_rules,
    bulkRedirects: m.copy_part_bulk_redirects,
    errorPages: m.copy_part_error_pages,
    waf: m.copy_part_waf,
    protection: m.copy_part_protection,
    accessControl: m.copy_part_access_control,
    authRules: m.copy_part_auth_rules,
    originSettings: m.copy_part_origin_settings,
    logs: m.copy_part_logs,
  })[part]();

/** What a part's change looks like on one line: item counts, or how many settings change. */
function changeText(change: SiteCopyChange): string {
  if (!change.changed) return m.copy_unchanged();
  if (change.before !== null && change.after !== null && change.before !== change.after)
    return m.copy_change_items({ before: change.before, after: change.after });
  if (change.fields) return m.copy_change_fields({ count: change.fields });
  return m.copy_changed();
}

type Step =
  | { kind: "form" }
  | { kind: "preview"; preview: SiteCopyPreview }
  | { kind: "result"; result: SiteCopyResult };

/**
 * Copies parts of one site's settings to other sites: pick the source (unless given), the
 * targets (unless given) and the parts, preview each target's changes, then copy.
 */
export function CopySettingsDialog({
  open,
  onOpenChange,
  source,
  targets: fixedTargets,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The site the settings come from; without it the dialog asks. */
  source?: { id: string; name: string };
  /** The sites they go to (id to name); without them the dialog asks. */
  targets?: ReadonlyMap<string, string>;
}) {
  const queryClient = useQueryClient();
  const action = useAction();
  const [step, setStep] = React.useState<Step>({ kind: "form" });
  const [sourceId, setSourceId] = React.useState<string | null>(source?.id ?? null);
  const [targets, setTargets] = React.useState<ReadonlyMap<string, string>>(
    () => fixedTargets ?? new Map(),
  );
  const [parts, setParts] = React.useState<SiteCopyPart[]>([]);
  const [error, setError] = React.useState<string | null>(null);
  const sites = useQuery({
    ...orpc.sites.list.queryOptions({ input: { page: 1, pageSize: 100 } }),
    enabled: open && !source,
  });
  const targetIds = [...targets.keys()].filter((id) => id !== sourceId);
  const close = (next: boolean) => {
    if (!next) {
      setStep({ kind: "form" });
      setError(null);
    }
    onOpenChange(next);
  };
  const run = async <T,>(work: () => Promise<T>) => {
    setError(null);
    try {
      return await action.run(work);
    } catch (err) {
      setError(errorMessage(err));
      return undefined;
    }
  };
  const input = () => ({ id: sourceId ?? "", targetIds, parts });
  const allParts = parts.length === SITE_COPY_PARTS.length;

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{m.copy_title()}</DialogTitle>
          {step.kind === "form" ? <SafetyNote>{m.copy_note()}</SafetyNote> : null}
        </DialogHeader>
        {step.kind === "form" ? (
          <FieldGroup className="min-w-0">
            {source ? null : (
              <Field>
                <FieldLabel htmlFor="copy-source">{m.copy_source()}</FieldLabel>
                <OptionSelect
                  id="copy-source"
                  value={sourceId}
                  placeholder={m.copy_source()}
                  options={(sites.data?.items ?? [])
                    .filter((site) => !targets.has(site.id))
                    .map((site) => ({ value: site.id, label: site.name }))}
                  onChange={setSourceId}
                  testId="copy-source"
                />
              </Field>
            )}
            {fixedTargets ? (
              <Field>
                <FieldLabel>{m.copy_targets()}</FieldLabel>
                <p className="text-sm break-all" data-testid="copy-targets-fixed">
                  {[...fixedTargets.values()].join(", ")}
                </p>
              </Field>
            ) : (
              <SiteMultiSelect
                id="copy-targets"
                label={m.copy_targets()}
                searchLabel={m.copy_targets()}
                selected={targets}
                onChange={(next) =>
                  setTargets(new Map([...next].filter(([id]) => id !== sourceId)))
                }
              />
            )}
            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel id="copy-parts-label">{m.copy_parts()}</FieldLabel>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  onClick={() => setParts(allParts ? [] : [...SITE_COPY_PARTS])}
                  data-testid="copy-parts-all"
                >
                  {allParts ? m.copy_parts_none() : m.copy_parts_all()}
                </Button>
              </div>
              <fieldset
                aria-labelledby="copy-parts-label"
                className="grid gap-x-4 rounded-2xl px-3 py-1.5 sunk-well sm:grid-cols-2"
              >
                {SITE_COPY_PARTS.map((part) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: the Base UI checkbox inside is the control
                  <label
                    key={part}
                    className="flex cursor-pointer items-center gap-2.5 py-1.5 text-sm"
                    data-testid={`copy-part-${part}`}
                  >
                    <Checkbox
                      checked={parts.includes(part)}
                      onCheckedChange={(checked) =>
                        setParts(
                          SITE_COPY_PARTS.filter((p) => (p === part ? checked : parts.includes(p))),
                        )
                      }
                    />
                    {copyPartLabel(part)}
                  </label>
                ))}
              </fieldset>
            </Field>
            {error ? (
              <FieldError className="animate-in fade-in" data-testid="copy-error">
                {error}
              </FieldError>
            ) : null}
            <DialogFooter>
              <Button
                disabled={!sourceId || !targetIds.length || !parts.length || action.pending}
                onClick={async () => {
                  const preview = await run(() => client.sites.copySettingsPreview(input()));
                  if (preview) setStep({ kind: "preview", preview });
                }}
                data-testid="copy-preview"
              >
                {action.pending ? <Spinner /> : null}
                {m.copy_preview()}
              </Button>
            </DialogFooter>
          </FieldGroup>
        ) : step.kind === "preview" ? (
          <div className="flex min-w-0 flex-col gap-4">
            <ul className="flex flex-col gap-2" data-testid="copy-preview-list">
              {step.preview.targets.map((target, index) => (
                <li
                  key={target.id}
                  className="rounded-2xl px-3 py-2.5 sunk-well animate-enter"
                  style={enterDelay(index)}
                  data-testid="copy-preview-target"
                >
                  <p className="truncate text-sm font-medium">{target.name}</p>
                  {target.error ? (
                    <p
                      className="mt-1 flex items-start gap-1.5 text-sm text-destructive"
                      data-testid="copy-preview-error"
                    >
                      <HugeiconsIcon
                        icon={Alert02Icon}
                        strokeWidth={2}
                        className="mt-0.5 size-4 shrink-0"
                      />
                      {errorMessage(target.error)}
                    </p>
                  ) : (
                    <dl className="mt-1 grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-0.5 text-sm">
                      {target.changes.map((change) => (
                        <React.Fragment key={change.part}>
                          <dt className="text-muted-foreground">{copyPartLabel(change.part)}</dt>
                          <dd
                            className={change.changed ? "tabular-nums" : "text-muted-foreground"}
                            data-testid={`copy-change-${change.part}`}
                          >
                            {changeText(change)}
                          </dd>
                        </React.Fragment>
                      ))}
                    </dl>
                  )}
                </li>
              ))}
            </ul>
            {error ? (
              <FieldError className="animate-in fade-in" data-testid="copy-error">
                {error}
              </FieldError>
            ) : null}
            <DialogFooter>
              <Button variant="outline" onClick={() => setStep({ kind: "form" })}>
                {m.copy_back()}
              </Button>
              <Button
                disabled={action.pending}
                onClick={async () => {
                  const result = await run(() => client.sites.copySettings(input()));
                  if (!result) return;
                  setStep({ kind: "result", result });
                  const ok = result.targets.filter((target) => target.ok).length;
                  const failed = result.targets.length - ok;
                  (failed ? toast.warning : toast.success)(m.copy_done_toast({ ok, failed }));
                  await queryClient.invalidateQueries();
                }}
                data-testid="copy-apply"
              >
                {action.pending ? <Spinner /> : null}
                {m.copy_apply({ count: step.preview.targets.length })}
              </Button>
            </DialogFooter>
          </div>
        ) : (
          <div className="flex min-w-0 flex-col gap-4">
            <ul className="flex flex-col gap-2" data-testid="copy-result-list">
              {step.result.targets.map((target, index) => (
                <li
                  key={target.id}
                  className="flex items-start gap-2 rounded-2xl px-3 py-2.5 text-sm sunk-well animate-enter"
                  style={enterDelay(index)}
                  data-testid="copy-result-target"
                  data-ok={target.ok}
                >
                  <HugeiconsIcon
                    icon={target.ok ? CheckmarkCircle02Icon : Alert02Icon}
                    strokeWidth={2}
                    className={
                      target.ok ? "mt-0.5 size-4 text-state-good" : "mt-0.5 size-4 text-destructive"
                    }
                  />
                  <span className="flex min-w-0 flex-col">
                    <span className="truncate font-medium">{target.name}</span>
                    <span className={target.ok ? "text-muted-foreground" : "text-destructive"}>
                      {target.ok
                        ? target.changed.length
                          ? target.changed.map(copyPartLabel).join(", ")
                          : m.copy_unchanged()
                        : errorMessage(target.error)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
            <DialogFooter>
              <Button onClick={() => close(false)} data-testid="copy-done">
                {m.common_close()}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
