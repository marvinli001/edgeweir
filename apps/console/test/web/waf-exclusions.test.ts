import { wafExclusions } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import {
  addExclusion,
  type Exclusion,
  exclusionPath,
  needsWafV2,
  parseRuleIds,
  parseTargets,
  readExclusionForm,
  siteWideRuleIds,
  toExclusionForm,
  unexcludable,
  withSiteWideRuleIds,
} from "../../src/web/lib/waf-exclusions";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

const everyPath = (ruleIds: number[]): Exclusion => ({
  path: "",
  exact: false,
  ruleIds,
  targets: [],
});
const onPath = (path: string, ruleIds: number[], exact = false, targets: string[] = []) => ({
  path,
  exact,
  ruleIds,
  targets,
});

describe("CRS exclusion lists", () => {
  it("reads rule ids and targets as typed", () => {
    expect(parseRuleIds("942100, 920350 941100 942100")).toEqual([920350, 941100, 942100]);
    expect(parseRuleIds("  ")).toEqual([]);
    expect(parseRuleIds("94210")).toBeNull();
    expect(parseRuleIds("942100 abc")).toBeNull();
    expect(parseTargets("ARGS:q, REQUEST_COOKIES:s ARGS:q")).toEqual([
      "ARGS:q",
      "REQUEST_COOKIES:s",
    ]);
  });

  it("edits the rule ids every path skips in the first site-wide entry, created first", () => {
    const byPath = onPath("/search", [942100], false, ["ARGS:q"]);
    // A site-wide entry with targets is not the one every rule skips everywhere.
    const targeted = onPath("", [941100], false, ["ARGS:html"]);
    expect(siteWideRuleIds([byPath, targeted])).toEqual([]);
    const added = withSiteWideRuleIds([byPath, targeted], [942430, 920300, 942430]);
    expect(added).toEqual([everyPath([920300, 942430]), byPath, targeted]);
    expect(siteWideRuleIds(added)).toEqual([920300, 942430]);
    expect(withSiteWideRuleIds(added, [920300])).toEqual([everyPath([920300]), byPath, targeted]);
    // Without ids the entry goes; the others stay as they were.
    expect(withSiteWideRuleIds(added, [])).toEqual([byPath, targeted]);
    expect(withSiteWideRuleIds([byPath], [])).toEqual([byPath]);
  });

  it("adds an exclusion to the entry of the same path, match and targets, else appends it", () => {
    const list = [everyPath([920300]), onPath("/search", [942100], false, ["ARGS:q"])];
    // The same path and targets (in another order): the rules join that entry, sorted.
    expect(addExclusion(list, onPath("/search", [941100, 942100], false, ["ARGS:q"]))).toEqual([
      everyPath([920300]),
      onPath("/search", [941100, 942100], false, ["ARGS:q"]),
    ]);
    // Exact is another entry, and so are other targets.
    expect(addExclusion(list, onPath("/search", [941100], true))).toHaveLength(3);
    expect(addExclusion(list, onPath("/search", [941100], false, ["ARGS:p"]))).toHaveLength(3);
    // Every path: the site-wide entry, which is never exact.
    expect(addExclusion(list, onPath("", [942430], true))).toEqual([
      everyPath([920300, 942430]),
      list[1],
    ]);
    expect(addExclusion([], onPath("/upload", [942100, 942100]))).toEqual([
      onPath("/upload", [942100]),
    ]);
    expect(wafExclusions.safeParse(addExclusion(list, onPath("/upload", [942100]))).success).toBe(
      true,
    );
  });

  it("tells what needs waf-v2 and what cannot be excluded", () => {
    expect(needsWafV2(everyPath([942100]))).toBe(false);
    expect(needsWafV2(onPath("/a", [942100]))).toBe(true);
    expect(needsWafV2(onPath("", [942100], false, ["ARGS:q"]))).toBe(true);
    expect(unexcludable([942100, 949110, 901001, 980170])).toEqual([949110, 901001, 980170]);
  });

  it("turns a logged request's path into an exclusion path", () => {
    expect(exclusionPath("/search?q=1")).toBe("/search");
    expect(exclusionPath("/a#b")).toBe("/a");
    expect(exclusionPath("/a b")).toBe("");
    expect(exclusionPath("*")).toBe("");
    expect(exclusionPath("")).toBe("");
  });

  it("reads the exclusion form and names the field that is wrong", () => {
    overwriteGetLocale(() => "en");
    const form = toExclusionForm(onPath("/search", [942100, 942200], true, ["ARGS:q"]));
    expect(form).toEqual({
      path: "/search",
      exact: true,
      ruleIds: "942100, 942200",
      targets: "ARGS:q",
    });
    expect(readExclusionForm(form)).toEqual({
      entry: onPath("/search", [942100, 942200], true, ["ARGS:q"]),
    });
    // Every path is never exact; a path is needed where the dialog asks for one.
    expect(readExclusionForm({ ...form, path: " " })).toEqual({
      entry: onPath("", [942100, 942200], false, ["ARGS:q"]),
    });
    expect(readExclusionForm({ ...form, path: "" }, { requirePath: true })).toEqual({
      field: "path",
      message: "Enter a path",
    });
    expect(readExclusionForm({ ...form, path: "/a?b" }).field).toBe("path");
    expect(readExclusionForm({ ...form, ruleIds: "" }).field).toBe("ruleIds");
    expect(readExclusionForm({ ...form, ruleIds: "12345" }).field).toBe("ruleIds");
    expect(readExclusionForm({ ...form, ruleIds: "949110" })).toEqual({
      field: "ruleIds",
      message: expect.stringContaining("949110"),
    });
    expect(readExclusionForm({ ...form, targets: "ARGS_NAMES:q" }).field).toBe("targets");
    expect(
      readExclusionForm({
        ...form,
        targets: Array.from({ length: 17 }, (_, i) => `ARGS:a${i}`).join(","),
      }).field,
    ).toBe("targets");
    overwriteGetLocale(() => "zh-CN");
    expect(readExclusionForm({ ...form, path: "" }, { requirePath: true })).toEqual({
      field: "path",
      message: "请填写路径",
    });
  });
});
