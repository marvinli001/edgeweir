import type * as React from "react";

/**
 * Whole-row activation for list rows and cards. The row's primary control (the link to its detail
 * page, or the button that opens its details) carries `rowLink`; a click anywhere else in the row
 * clicks it. The control stays the real link or button, so keyboard focus, middle click and
 * Cmd/Ctrl+click open a new tab as on any link; the row itself gets no role. `TableRow` wires this
 * up for every table (a row without a row link stays inert); other rows call `activateRow` from
 * their onClick and onAuxClick.
 */
export const rowLink = { "data-row-link": "" } as const;

/** Controls in a row that act on their own (checkbox, star, menu, copy button, other links). */
const OWN_ACTION =
  "a[href],button,input,select,textarea,label,summary,[role=button],[role=checkbox],[role=switch],[role=menuitem],[role=combobox],[role=tab],[contenteditable=true],[data-row-ignore]";

export type RowActivation = "ignore" | "open" | "open-in-new-tab";

/**
 * What a click in a row does: nothing when it lands outside the row's own DOM (a menu or dialog
 * opened from it renders in a portal, and React still bubbles its clicks here), on a control of
 * its own, while text in the row is selected, with a button other than the main or middle one, or
 * when the row has no row link; a new tab for the middle button or Cmd/Ctrl when the row link is a
 * link; otherwise the row link's own click.
 */
export function rowActivation({
  inside,
  onControl,
  selecting,
  button,
  newTabKey,
  linkKind,
}: {
  inside: boolean;
  onControl: boolean;
  selecting: boolean;
  button: number;
  newTabKey: boolean;
  linkKind: "link" | "button" | null;
}): RowActivation {
  if (!inside || onControl || selecting || linkKind === null) return "ignore";
  if (button !== 0 && button !== 1) return "ignore";
  if (linkKind === "link" && (button === 1 || newTabKey)) return "open-in-new-tab";
  // A middle click on a row whose details open in place has nothing to open in a tab.
  return button === 1 ? "ignore" : "open";
}

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
    button: event.button,
    newTabKey: event.metaKey || event.ctrlKey,
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
