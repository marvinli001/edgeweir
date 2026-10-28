import type * as React from "react";
import { rowActivation } from "@/lib/row-activation";

/**
 * Whole-row activation for list rows and cards. The row's primary control (the link to its detail
 * page, or the button that opens its details) carries `rowLink`; a click anywhere else in the row
 * clicks it. The control stays the real link or button, so keyboard focus, middle click and
 * Cmd/Ctrl/Shift+click open a new tab; the row itself gets no role. `TableRow` wires this
 * up for every table (a row without a row link stays inert); other rows call `activateRow` from
 * their onClick and onAuxClick.
 */
export const rowLink = { "data-row-link": "" } as const;

/** Controls in a row that act on their own (checkbox, star, menu, copy button, other links). */
const OWN_ACTION =
  "a[href],button,input,select,textarea,label,summary,[role=button],[role=checkbox],[role=switch],[role=menuitem],[role=combobox],[role=tab],[contenteditable=true],[data-row-ignore]";

/** onClick / onAuxClick of a row: see `rowActivation`. */
export function activateRow(event: React.MouseEvent<HTMLElement>) {
  if (event.defaultPrevented) return;
  const row = event.currentTarget;
  const target = event.target instanceof Element ? event.target : null;
  const control = target?.closest(OWN_ACTION);
  const link = row.querySelector<HTMLElement>("[data-row-link]");
  const selection = window.getSelection();
  const action = rowActivation({
    inside: !!target && row.contains(target),
    onControl: !!control && row.contains(control),
    selecting:
      !!selection &&
      !selection.isCollapsed &&
      selection.toString().trim() !== "" &&
      row.contains(selection.anchorNode),
    repeat: event.detail > 1,
    button: event.button,
    newTabKey: event.metaKey || event.ctrlKey || event.shiftKey,
    linkKind: !link ? null : link instanceof HTMLAnchorElement && link.href ? "link" : "button",
  });
  if (action === "ignore" || !link) return;
  if (action === "open-in-new-tab" && link instanceof HTMLAnchorElement) {
    window.open(link.href, "_blank", "noopener");
    return;
  }
  link.click();
}

/** The handlers a clickable row spreads (TableRow does this itself). */
export const rowActivationHandlers = { onClick: activateRow, onAuxClick: activateRow } as const;

/**
 * Classes of a clickable row or card outside a table (TableRow has its own): the pointer, the wash
 * on hover and while its row link has keyboard focus.
 */
export const rowClickable =
  "cursor-pointer transition-colors hover:bg-wash has-[[data-row-link]:focus-visible]:bg-wash";

/** A row link that is a button (details open in place): text styling, the focus ring. */
export const rowLinkButton =
  "w-fit max-w-full rounded-md text-left outline-none focus-lit underline-offset-4 hover:underline";
