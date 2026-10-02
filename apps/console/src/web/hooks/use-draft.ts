import * as React from "react";

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * A form's draft of a server value. While the form is unchanged it follows the server; with unsaved
 * changes it keeps them, and `version` stays the one they started from, so a save is checked
 * against what the user saw. The server coming back with the draft's value (the form's own save)
 * makes the form clean again. `version` defaults to the value itself.
 */
export function useDraft<T>(server: T, version: string = JSON.stringify(server)) {
  const [state, setState] = React.useState({ base: server, version, draft: server });
  let current = state;
  if (version !== state.version && (same(state.draft, state.base) || same(state.draft, server))) {
    current = { base: server, version, draft: server };
    setState(current);
  }
  const setDraft = React.useCallback((draft: T) => setState((s) => ({ ...s, draft })), []);
  return {
    draft: current.draft,
    setDraft,
    version: current.version,
    dirty: !same(current.draft, current.base),
  };
}
