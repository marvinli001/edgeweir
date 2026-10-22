import { type UseMutationOptions, useMutation } from "@tanstack/react-query";
import * as React from "react";
import { useDraft } from "@/hooks/use-draft";
import { m } from "@/lib/i18n";
import { errorMessage } from "@/lib/orpc";

export interface SettingsFormOptions<T, D, I, O, E = unknown, C = unknown> {
  /** The saved value. */
  value: T;
  /** The form state of a saved value (numbers stay text while editing). */
  toDraft: (value: T) => D;
  /** What saving the draft sends. */
  toInput: (draft: D, value: T) => I;
  /** A message when the input cannot be saved as it is. */
  check?: (input: I) => string | null | undefined;
  /**
   * The save, e.g. `orpc.settings.setUsage.mutationOptions()`. Its `meta` says what it refreshes;
   * a "Saved" toast is added unless it names its own.
   */
  mutation: UseMutationOptions<O, E, I, C>;
  onSaved?: (output: O) => void;
}

/**
 * A form's draft of a saved value and its save. Background refreshes follow the server while the
 * form is unchanged and leave unsaved changes alone (useDraft); `submit` checks the input, saves
 * it and keeps why it failed in `error`; `set` clears that.
 */
export function useSettingsForm<T, D, I, O, E = unknown, C = unknown>({
  value,
  toDraft,
  toInput,
  check,
  mutation,
  onSaved,
}: SettingsFormOptions<T, D, I, O, E, C>) {
  const save = useMutation({ ...mutation, meta: { success: m.common_saved, ...mutation.meta } });
  const { draft, setDraft, markSaved, dirty } = useDraft(toDraft(value), JSON.stringify(value));
  const [error, setError] = React.useState<string | null>(null);
  /** Saves `input` right away, outside the draft (a confirmed switch); throws on failure. */
  const apply = (input: I) => save.mutateAsync(input);
  /** Resolves true once saved. */
  const submit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    const input = toInput(draft, value);
    const refused = check?.(input);
    setError(refused || null);
    if (refused) return false;
    try {
      const output = await apply(input);
      markSaved();
      onSaved?.(output);
      return true;
    } catch (err) {
      setError(errorMessage(err));
      return false;
    }
  };
  return {
    draft,
    setDraft,
    /** Changes fields of the draft and clears the last error. */
    set: (change: Partial<D>) => {
      setDraft({ ...draft, ...change });
      setError(null);
    },
    dirty,
    error,
    setError,
    pending: save.isPending,
    apply,
    submit,
  };
}
