import type { MutationOptions, QueryOptionsBase } from "@orpc/tanstack-query";
import { type QueryKey, useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { Badge } from "@/components/arc/badge/badge";
import { SaveBar } from "@/components/site/save-site";
import { QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { type SettingsFormOptions, useSettingsForm } from "@/hooks/use-settings-form";
import { m } from "@/lib/i18n";

const SOURCE_LABEL = {
  setting: m.system_source_setting,
  environment: m.system_source_environment,
  default: m.system_source_default,
};

/** Where a setting with an environment fallback comes from: saved here, the environment or the default. */
export function SettingSourceBadge({
  source,
  testId,
}: {
  source: keyof typeof SOURCE_LABEL;
  testId: string;
}) {
  return (
    <Badge size="sm" tone="neutral" data-testid={testId}>
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
    <Card className={className} style={style} data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <QueryView query={result} frame={CardContent}>
        {(value) => (
          <SettingsForm {...form} value={value} refresh={form.refresh ?? query.queryKey} />
        )}
      </QueryView>
    </Card>
  );
}

function SettingsForm<T, D, I, O, E, C>({
  value,
  mutation,
  refresh,
  noValidate,
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
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      noValidate={noValidate}
      onSubmit={form.submit}
    >
      <CardContent className={contentClassName}>
        {children({
          value,
          draft: form.draft,
          set: form.set,
          error: form.error,
          pending: form.pending,
          apply: form.apply,
        })}
      </CardContent>
      <SaveBar
        dirty={form.dirty}
        pending={form.pending}
        error={form.error}
        testId={saveTestId}
        errorTestId={errorTestId}
      />
    </form>
  );
}
