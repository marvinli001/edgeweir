import type { MutationOptions, QueryOptionsBase } from "@orpc/tanstack-query";
import { type QueryKey, useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { Panel, PanelContent, PanelHeader, PanelTitle } from "@/components/layout/panel";
import { SaveBar } from "@/components/site/save-site";
import { QueryView } from "@/components/states";
import { type SettingsFormOptions, useSettingsForm } from "@/hooks/use-settings-form";
import { m } from "@/lib/i18n";
import { cn } from "@/lib/utils";

const SOURCE_LABEL = {
  setting: m.system_source_setting,
  environment: m.system_source_environment,
  default: m.system_source_default,
};

/** Where a setting with an environment fallback comes from: saved here, the environment or the default. */
export function SettingSourceBadge({
  source,
  testId,
  className,
}: {
  source: keyof typeof SOURCE_LABEL;
  testId: string;
  className?: string;
}) {
  return (
    <Badge size="sm" tone="neutral" className={className} data-testid={testId}>
      {SOURCE_LABEL[source]()}
    </Badge>
  );
}

/** What the fields of a settings card render from. */
interface SettingsFields<T, D, I> {
  /** The saved value. */
  value: T;
  /** The form's draft of it. */
  draft: D;
  /** Changes fields of the draft (and clears the last error). */
  set: (change: Partial<D>) => void;
  /** Why the last save failed, or why the draft cannot be saved. */
  error: string | null;
  /** A save is running. */
  pending: boolean;
  /** Saves `input` right away, outside the form (a confirmed switch); throws on failure. */
  apply: (input: I) => Promise<unknown>;
}

interface SettingsFormProps<T, D, I, O, E, C>
  extends Omit<SettingsFormOptions<T, D, I, O, E, C>, "value" | "mutation"> {
  /** The save, e.g. `orpc.settings.setUsage.mutationOptions()`. */
  mutation: MutationOptions<I, O, E, C>;
  /** Queries refreshed after a save: the card's own by default. */
  refresh?: QueryKey;
  /** Leaves the checks to `check` instead of the browser's. */
  noValidate?: boolean;
  /** A single setting can place its save action beside the field. */
  layout?: "stacked" | "grid" | "inline";
  /** Status or read-only details below a single setting and its save button. */
  details?: (value: T, draft: D) => React.ReactNode;
  contentClassName?: string;
  saveTestId: string;
  errorTestId?: string;
  children: (fields: SettingsFields<T, D, I>) => React.ReactNode;
}

/**
 * A card that loads a setting, edits a draft of it and saves it (useSettingsForm).
 */
export function SettingsCard<T, D, I, O, E, C, QE>({
  title,
  query,
  className,
  style,
  testId,
  ...form
}: SettingsFormProps<T, D, I, O, E, C> & {
  title: string;
  /** The setting, e.g. `orpc.settings.usage.queryOptions()`. */
  query: QueryOptionsBase<T, QE>;
  className?: string;
  style?: React.CSSProperties;
  testId?: string;
}) {
  const result = useQuery(query);
  return (
    <Panel className={className} style={style} data-testid={testId}>
      <PanelHeader>
        <PanelTitle>{title}</PanelTitle>
      </PanelHeader>
      <QueryView query={result} frame={PanelContent}>
        {(value) => (
          <SettingsForm {...form} value={value} refresh={form.refresh ?? query.queryKey} />
        )}
      </QueryView>
    </Panel>
  );
}

function SettingsForm<T, D, I, O, E, C>({
  value,
  mutation,
  refresh,
  noValidate,
  layout = "stacked",
  details,
  contentClassName,
  saveTestId,
  errorTestId,
  children,
  ...options
}: SettingsFormProps<T, D, I, O, E, C> & { value: T; refresh: QueryKey }) {
  const form = useSettingsForm({
    ...options,
    value,
    mutation: { ...mutation, meta: { invalidates: [refresh], ...mutation.meta } },
  });
  const fields = children({
    value,
    draft: form.draft,
    set: form.set,
    error: form.error,
    pending: form.pending,
    apply: form.apply,
  });
  return (
    <form className="flex min-w-0 flex-col gap-4" noValidate={noValidate} onSubmit={form.submit}>
      {layout === "inline" ? (
        <PanelContent className="flex flex-col items-start gap-2">
          <div className="flex w-full min-w-0 flex-wrap items-end gap-x-3 gap-y-2">
            <div className={cn("w-56 min-w-0 max-w-full", contentClassName)}>{fields}</div>
            <SaveBar
              inline
              dirty={form.dirty}
              pending={form.pending}
              error={form.error}
              testId={saveTestId}
              errorTestId={errorTestId}
            />
          </div>
          {details?.(value, form.draft)}
        </PanelContent>
      ) : (
        <>
          <PanelContent
            form="stacked"
            className={cn(
              layout === "grid" ? "form-grid items-end" : "flex flex-col gap-3",
              contentClassName,
            )}
          >
            {fields}
          </PanelContent>
          <SaveBar
            dirty={form.dirty}
            pending={form.pending}
            error={form.error}
            testId={saveTestId}
            errorTestId={errorTestId}
          />
        </>
      )}
    </form>
  );
}
