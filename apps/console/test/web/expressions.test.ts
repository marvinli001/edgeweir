import { ExpressionError, type Phase, parseExpression, phases } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  appendCondition,
  CONDITION_TEMPLATES,
  type ConditionTemplate,
  expressionErrorText,
  expressionReason,
  insertCondition,
  REQUEST_PHASE_TEMPLATES,
  TEMPLATE_VALUES,
  templateInPhase,
} from "../../src/web/lib/expressions";
import { overwriteGetLocale } from "../../src/web/paraglide/runtime.js";

const failure = (source: string, phase?: Phase) => {
  try {
    parseExpression(source, phase);
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
  it("parse as conditions in every phase that offers them and keep an 'or' together", () => {
    for (const phase of phases)
      for (const [template, condition] of Object.entries(CONDITION_TEMPLATES) as [
        ConditionTemplate,
        string,
      ][])
        if (templateInPhase(template, phase))
          expect(() => parseExpression(condition, phase), `${phase}: ${condition}`).not.toThrow();
        else expect(failure(condition, phase).code, `${phase}: ${condition}`).toBe("request_field");
    // Request body and crawler templates: the request phases only.
    expect(phases.filter((phase) => templateInPhase("json_value", phase))).toEqual([
      "request-transform",
      "redirect",
      "config",
      "waf-custom",
      "ratelimit",
      "origin",
    ]);
    expect([...REQUEST_PHASE_TEMPLATES].sort()).toEqual([
      "body_contains",
      "form_value",
      "json_value",
      "upload_name",
      "verified_bot",
    ]);
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

  it("select their example value once inserted, so typing replaces it", () => {
    for (const template of Object.keys(CONDITION_TEMPLATES) as ConditionTemplate[]) {
      const value = TEMPLATE_VALUES[template];
      for (const source of ["true", 'http.host eq "a" or ssl eq true']) {
        const inserted = insertCondition(
          source,
          CONDITION_TEMPLATES[template],
          "waf-custom",
          value,
        );
        expect(inserted.source.slice(...inserted.selection), template).toBe(value);
      }
    }
    const asn = insertCondition("ssl", CONDITION_TEMPLATES.asn, "waf-custom", TEMPLATE_VALUES.asn);
    expect(asn).toEqual({ source: "ssl and ip.geoip.asnum in {64496}", selection: [27, 32] });
    // Without a value (an IP list), the caret goes to the end.
    expect(insertCondition("", "ip.src in $office", "waf-custom")).toEqual({
      source: "ip.src in $office",
      selection: [17, 17],
    });
  });
});
