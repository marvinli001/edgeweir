import { useBlocker } from "@tanstack/react-router";
import * as React from "react";
import { ControlledConfirmDialog } from "@/components/confirm-dialog";
import { hasUnsavedChanges } from "@/hooks/use-unsaved-changes";
import { m } from "@/lib/i18n";

/** The `tab` search parameter of tabbed pages: switching tabs unmounts the previous tab's forms. */
const tabOf = (search: unknown) => (search as { tab?: unknown } | undefined)?.tab;

/**
 * Asks before a navigation or a browser unload discards unsaved changes (useUnsavedChanges).
 * Navigations within a page that keep its forms (filters, pages) pass without asking.
 */
export function UnsavedChangesGuard() {
  const blocker = useBlocker({
    shouldBlockFn: ({ current, next }) =>
      hasUnsavedChanges() &&
      (current.pathname !== next.pathname || tabOf(current.search) !== tabOf(next.search)),
    enableBeforeUnload: hasUnsavedChanges,
    withResolver: true,
  });
  const leaving = React.useRef(false);
  return (
    <ControlledConfirmDialog
      open={blocker.status === "blocked"}
      onOpenChange={(open) => {
        if (open) return;
        if (!leaving.current) blocker.reset?.();
        leaving.current = false;
      }}
      title={m.unsaved_leave_title()}
      confirmLabel={m.unsaved_discard()}
      onConfirm={async () => {
        leaving.current = true;
        blocker.proceed?.();
      }}
    />
  );
}
