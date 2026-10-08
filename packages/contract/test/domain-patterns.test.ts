import { validatePattern } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  domainPatternError,
  MAX_PATTERN_BRANCHES,
  patternBranches,
  repeatingQuantifiers,
} from "../src/domains";

// Nodes match pattern domains with PCRE's backtracking engine and no match
// limit: the bounds read the pattern by tokens, so an escaped quantifier
// character or a class is a character like any letter.
describe("pattern domain bounds", () => {
  it("counts a ? after an escape or a class as an optional part", () => {
    for (const atom of [
      "a",
      "\\?",
      "\\*",
      "\\+",
      "\\}",
      "\\{",
      "\\-",
      "\\d",
      "\\x2d",
      "[?]",
      "[*]",
    ]) {
      expect(() => validatePattern(`${atom}?`), atom).not.toThrow();
      expect(patternBranches(`${atom}?`), atom).toBe(2);
      // Lazy after its quantifier, like a letter's "??".
      expect(patternBranches(`${atom}??`), atom).toBe(2);
      expect(patternBranches(`${atom}?${atom}?`), atom).toBe(4);
    }
    expect(patternBranches("\\??\\*?[?]?\\}?\\-?")).toBe(32);
  });

  it("keeps a ? after a quantifier lazy", () => {
    for (const lazy of [
      "a*?",
      "a+?",
      "a{2}?",
      "a{2,}?",
      "a{1,3}?",
      "\\+*?",
      "\\*+?",
      "[?]+?",
      "\\}{2}?",
    ]) {
      expect(() => validatePattern(lazy), lazy).not.toThrow();
      expect(patternBranches(lazy), lazy).toBe(1);
    }
    expect(patternBranches("a{0,1}")).toBe(2);
    expect(patternBranches("a{0,1}?")).toBe(2);
    expect(patternBranches("\\?{0,1}?")).toBe(2);
    expect(patternBranches("a*?b?")).toBe(2);
    expect(patternBranches("a+?\\??")).toBe(2);
  });

  it("refuses escaped optional parts past the bound as it refuses letters", () => {
    const letters = `${"a?".repeat(24)}a{24}\\.a\\.com`;
    const escaped = `${"\\+?".repeat(24)}\\+{24}\\.a\\.com`;
    for (const pattern of [letters, escaped]) {
      // In the subset: only the bound refuses them.
      expect(() => validatePattern(pattern), pattern).not.toThrow();
      expect(repeatingQuantifiers(pattern), pattern).toBe(0);
      expect(patternBranches(pattern), pattern).toBe(2 ** 24);
      expect(domainPatternError(pattern), pattern).toBe("too_complex");
    }
    expect(MAX_PATTERN_BRANCHES).toBe(16);
    expect(domainPatternError(`${"\\+?".repeat(4)}\\.a\\.com`)).toBeNull();
    expect(domainPatternError(`${"\\+?".repeat(5)}\\.a\\.com`)).toBe("too_complex");
    expect(domainPatternError("\\??\\*?[?]?\\}?\\.a\\.com")).toBeNull();
    expect(domainPatternError("\\??\\*?[?]?\\}?\\-?\\.a\\.com")).toBe("too_complex");
  });

  it("keeps the guide's branch examples", () => {
    expect(patternBranches("(a|b)(c|d)e?")).toBe(8);
    expect(domainPatternError("(a|b)(c|d)e?")).toBeNull();
    expect(patternBranches("(a|b)c?d?")).toBe(8);
    expect(domainPatternError("(a|b)c?d?")).toBeNull();
    expect(patternBranches("(www|m)\\.a\\.com")).toBe(2);
    expect(patternBranches("(api|cdn)\\d+\\.a\\.com")).toBe(2);
  });

  it("counts repeating quantifiers after escapes and classes, never escaped characters", () => {
    const counts: [string, number][] = [
      ["\\+*", 1],
      ["\\*+", 1],
      ["\\+\\*", 0],
      ["[*]+", 1],
      ["[+*]", 0],
      ["[\\]]+", 1],
      ["\\x2a+", 1],
      ["\\{2,\\}", 0],
      ["a{2}", 0],
      ["a{0,1}", 0],
      ["a{2,}", 1],
      ["a{1,3}?", 1],
      ["a+?b*?", 2],
    ];
    for (const [pattern, count] of counts)
      expect(repeatingQuantifiers(pattern), pattern).toBe(count);
  });
});
