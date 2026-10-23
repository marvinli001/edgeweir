import { describe, expect, it } from "vitest";
import { actionText, changedFields, lineDiff } from "../../src/web/lib/rule-history";

const rule = {
  name: "a",
  phase: "waf-custom",
  expression: "true",
  enabled: true,
  action: { kind: "block" },
};

describe("rule history comparison", () => {
  it("diffs lines, keeping the common ones in order", () => {
    expect(lineDiff(["a", "b", "c"], ["a", "x", "c", "d"])).toEqual([
      { kind: "same", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "x" },
      { kind: "same", text: "c" },
      { kind: "added", text: "d" },
    ]);
    expect(lineDiff([], ["a"])).toEqual([{ kind: "added", text: "a" }]);
    expect(lineDiff(["a"], [])).toEqual([{ kind: "removed", text: "a" }]);
    expect(lineDiff([], [])).toEqual([]);
  });

  it("compares actions whatever their key order", () => {
    expect(actionText({ b: 1, a: { d: 2, c: 3 } })).toBe(actionText({ a: { c: 3, d: 2 }, b: 1 }));
    expect(
      changedFields(rule, { ...rule, action: { kind: "block" }, enabled: false, name: "b" }),
    ).toEqual(["name", "enabled"]);
    expect(changedFields(rule, { ...rule, action: { kind: "log" } })).toEqual(["action"]);
    expect(changedFields(rule, { ...rule })).toEqual([]);
  });
});
