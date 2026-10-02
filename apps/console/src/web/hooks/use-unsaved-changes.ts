import * as React from "react";

/** Forms with unsaved changes that are mounted right now. */
const dirtyForms = new Set<symbol>();

/** Whether a mounted form holds changes that leaving the page would discard. */
export const hasUnsavedChanges = () => dirtyForms.size > 0;

/**
 * Marks the calling form as holding unsaved changes while `dirty`, so leaving the page (another
 * route, another tab of a tabbed page, closing or reloading the browser tab) asks first.
 */
export function useUnsavedChanges(dirty: boolean) {
  React.useEffect(() => {
    if (!dirty) return;
    const form = Symbol("dirty-form");
    dirtyForms.add(form);
    return () => {
      dirtyForms.delete(form);
    };
  }, [dirty]);
}
