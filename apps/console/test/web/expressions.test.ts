import { ExpressionError, parseExpression, phases } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  appendCondition,
  CONDITION_TEMPLATES,
  expressionErrorText,
  expressionReason,
} from "../../src/web/lib/expressions";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

const failure = (source: string) => {
  try {
    parseExpression(source);
  } catch (error) {
    if (error instanceof ExpressionError) return error;
  }
  throw new Error(`accepted: ${source}`);
};

describe("expression error texts", () => {
  it("names the reason and the character, counted from 1", () => {
    overwriteGetLocale(() => "en");
    expect(expressionErrorText(failure("http.host gt 4"))).toBe(
      "Character 11: Ordered comparisons need a number field",
    );
    expect(expressionErrorText(failure('(http.host eq "x" true'))).toBe("Character 19: Expected )");
    overwriteGetLocale(() => "zh-CN");
    expect(expressionErrorText(failure('unknown.field eq "x"'))).toBe("第 1 个字符：未知字段");
    expect(expressionReason({ code: "unknown_list", params: { list: "office" } })).toBe(
      "IP 名单 office 不存在",
    );
  });
});

describe("condition templates", () => {
  it("parse as conditions in every phase and keep an 'or' together", () => {
    for (const phase of phases)
      for (const condition of Object.values(CONDITION_TEMPLATES))
        expect(() => parseExpression(condition, phase), `${phase}: ${condition}`).not.toThrow();
    const method = CONDITION_TEMPLATES.method;
    expect(appendCondition("true", method, "waf-custom")).toBe(method);
    expect(appendCondition("  ", method, "waf-custom")).toBe(method);
    expect(appendCondition('http.host eq "a" ', method, "waf-custom")).toBe(
      `http.host eq "a" and ${method}`,
    );
    expect(appendCondition('http.host eq "a" or ssl eq true', method, "waf-custom")).toBe(
      `(http.host eq "a" or ssl eq true) and ${method}`,
    );
    expect(appendCondition("http.host eq", method, "waf-custom")).toBe(
      `http.host eq and ${method}`,
    );
    expect(parseExpression(appendCondition("ip.src in $office", method, "cache")).op).toBe("and");
  });
});
