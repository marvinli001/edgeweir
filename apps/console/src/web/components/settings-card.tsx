import type { MutationOptions, QueryOptionsBase } from "@orpc/tanstack-query";
import { type QueryKey, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { SaveBar } from "@/components/site/save-site";
import { QueryView } from "@/components/states";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useDraft } from "@/hooks/use-draft";
import { m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";

/** What the fields of a settings card render from. */
export interface SettingsFields<T, D, I> {
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
  apply: (input: I) => Promise<void>;
}

interface SettingsFormProps<T, D, I, O, E, C> {
  /** The save, e.g. `orpc.settings.setUsage.mutationOptions()`. */
  mutation: MutationOptions<I, O, E, C>;
  /** The form state of a saved value (numbers stay text while editing). */
  toDraft: (value: T) => D;
  /** What saving the draft sends. */
  toInput: (draft: D, value: T) => I;
  /** A message when the input cannot be saved as it is. */
  check?: (input: I) => string | null | undefined;
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
 * A card that loads a setting, edits a draft of it and saves it. Background refreshes follow the
 * server while the form is unchanged and leave unsaved changes alone (useDraft); a save starts the
 * form over from the saved value.
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
  // Bumped by every save, so the form starts over from what was saved.
  const [saves, setSaves] = React.useState(0);
  return (
    <Card className={className} style={style} data-testid={testId}>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <QueryView query={result} frame={CardContent}>
        {(value) => (
          <SettingsForm
            key={saves}
            {...form}
            value={value}
            refresh={form.refresh ?? query.queryKey}
            onSaved={() => setSaves((n) => n + 1)}
          />
        )}
      </QueryView>
    </Card>
  );
}

function SettingsForm<T, D, I, O, E, C>({
  value,
  mutation,
  toDraft,
  toInput,
  check,
  refresh,
  noValidate,
  contentClassName,
  saveTestId,
  errorTestId,
  onSaved,
  children,
}: SettingsFormProps<T, D, I, O, E, C> & { value: T; refresh: QueryKey; onSaved: () => void }) {
  const queryClient = useQueryClient();
  const save = useMutation(mutation);
  const { draft, setDraft, dirty } = useDraft(toDraft(value), JSON.stringify(value));
  const [error, setError] = React.useState<string | null>(null);
  const apply = async (input: I) => {
    await save.mutateAsync(input);
    await queryClient.invalidateQueries({ queryKey: refresh });
    toast.success(m.common_saved());
  };
  return (
    <form
      className="flex flex-col gap-(--card-spacing)"
      noValidate={noValidate}
      onSubmit={async (event) => {
        event.preventDefault();
        const input = toInput(draft, value);
        const refused = check?.(input);
        setError(refused || null);
        if (refused) return;
        try {
          await apply(input);
          onSaved();
        } catch (err) {
          setError(errorMessage(err));
        }
      }}
    >
      <CardContent className={contentClassName}>
        {children({
          value,
          draft,
          set: (change) => {
            setDraft({ ...draft, ...change });
            setError(null);
          },
          error,
          pending: save.isPending,
          apply,
        })}
      </CardContent>
      <SaveBar
        dirty={dirty}
        pending={save.isPending}
        error={error}
        testId={saveTestId}
        errorTestId={errorTestId}
      />
    </form>
  );
}
