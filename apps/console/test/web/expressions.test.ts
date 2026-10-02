import { ExpressionError, parseExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import { expressionErrorText, expressionReason } from "../../src/web/lib/expressions";
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
