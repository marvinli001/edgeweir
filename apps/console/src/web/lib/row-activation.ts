/**
 * The decision behind whole-row activation (lib/row-link), kept free of DOM and React types so the
 * Node test project can import it.
 */
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
