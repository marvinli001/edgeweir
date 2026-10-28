import { describe, expect, it } from "vitest";
import { rowActivation } from "../../src/web/lib/row-activation";

const click = {
  inside: true,
  onControl: false,
  selecting: false,
  button: 0,
  newTabKey: false,
  linkKind: "link" as const,
};

describe("whole-row activation", () => {
  it("opens the row link on a plain click anywhere in the row", () => {
    expect(rowActivation(click)).toBe("open");
    expect(rowActivation({ ...click, linkKind: "button" })).toBe("open");
  });

  it("opens a link in a new tab on a middle click or with Cmd/Ctrl", () => {
    expect(rowActivation({ ...click, button: 1 })).toBe("open-in-new-tab");
    expect(rowActivation({ ...click, newTabKey: true })).toBe("open-in-new-tab");
  });

  it("leaves controls of their own, selections, portals and rows without a link alone", () => {
    // A checkbox, star, menu, copy button or another link in the row.
    expect(rowActivation({ ...click, onControl: true })).toBe("ignore");
    // The user is selecting text in the row.
    expect(rowActivation({ ...click, selecting: true })).toBe("ignore");
    // A dialog or menu opened from the row (a portal: React bubbles its clicks to the row).
    expect(rowActivation({ ...click, inside: false })).toBe("ignore");
    expect(rowActivation({ ...click, linkKind: null })).toBe("ignore");
    // The secondary button (context menu) and a middle click without a link to open.
    expect(rowActivation({ ...click, button: 2 })).toBe("ignore");
    expect(rowActivation({ ...click, button: 1, linkKind: "button" })).toBe("ignore");
  });
});
