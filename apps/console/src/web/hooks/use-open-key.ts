import * as React from "react";

/**
 * A key that changes each time `open` turns true. A dialog that stays mounted between openings
 * (its state lives outside the popup) and is keyed with it starts fresh on every opening instead
 * of keeping what the last one left; the key holds while it closes, so the closing animation
 * shows the old content.
 */
export function useOpenKey(open: boolean): number {
  const [state, setState] = React.useState({ open, key: 0 });
  if (state.open === open) return state.key;
  const next = { open, key: open ? state.key + 1 : state.key };
  setState(next);
  return next.key;
}
