import * as React from "react";

/** A dialog's open state, as its parent hands it down. */
export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * A dialog's open state and what it was opened with (the row it edits, which of several dialogs).
 * That stays while the dialog closes, so the closing animation shows the old content; `key`
 * changes on every opening (like `useOpenKey`, which covers an `open` held elsewhere, e.g. in the
 * URL), so a dialog keyed with it starts fresh instead of keeping what the last one left.
 * `initial` opens it on mount (a link that opens a prefilled dialog).
 */
export function useDialogState<T = void>(initial?: T) {
  const [state, setState] = React.useState<{ open: boolean; value: T | undefined; key: number }>({
    open: initial !== undefined,
    value: initial,
    key: 0,
  });
  const show = React.useCallback(
    (value: T) => setState((prev) => ({ open: true, value, key: prev.key + 1 })),
    [],
  );
  const onOpenChange = React.useCallback(
    (open: boolean) =>
      setState((prev) =>
        prev.open === open ? prev : { ...prev, open, key: open ? prev.key + 1 : prev.key },
      ),
    [],
  );
  return { ...state, show, onOpenChange };
}
