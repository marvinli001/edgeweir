import { describe, expect, it } from "vitest";
import {
  ERROR_PAGE_PLACEHOLDERS,
  expressionIssue,
  RULES_V3_PLACEHOLDERS,
  ruleAction,
  ruleInput,
  usesRulesV3Placeholders,
} from "../src/index";

const rule = (phase: string, action: unknown, expression = "true") =>
  ruleInput.safeParse({ name: "r", phase, expression, action });
const issuePaths = (result: ReturnType<typeof rule>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));

describe("rules-v3 actions", () => {
  it("computes header values with an expression instead of a static value", () => {
    expect(
      ruleAction.parse({ kind: "request_header", header: "X-Req", expression: "http.request.id" }),
    ).toEqual({
      kind: "request_header",
      header: "x-req",
      value: "",
      expression: "http.request.id",
      remove: false,
    });
    expect(ruleAction.parse({ kind: "response_header", header: "link", value: "<a>" })).toEqual({
      kind: "response_header",
      header: "link",
      value: "<a>",
      expression: "",
      remove: false,
      append: false,
    });
    expect(
      rule("origin", { kind: "request_header", header: "x-c", expression: "ip.geoip.country" })
        .success,
    ).toBe(true);
    expect(
      rule("response-transform", {
        kind: "response_header",
        header: "x-cache",
        expression: "http.response.cache_status",
        append: true,
      }).success,
    ).toBe(true);
  });
  it("refuses a value and an expression together, and expressions or append with remove", () => {
    for (const action of [
      { kind: "request_header", header: "x-a", value: "a", expression: '"b"' },
      { kind: "request_header", header: "x-a", remove: true, expression: '"b"' },
      { kind: "response_header", header: "x-a", remove: true, append: true },
    ])
      expect(ruleAction.safeParse(action).success, JSON.stringify(action)).toBe(false);
  });
  it("points at the header or query parameter expression the parser refuses", () => {
    const header = rule("request-transform", {
      kind: "request_header",
      header: "x-a",
      expression: "http.response.cache_status",
    });
    expect(issuePaths(header)).toEqual(["action.expression"]);
    expect(header.success ? null : expressionIssue(header.error.issues[0] as never)).toMatchObject({
      code: "response_field",
      position: 0,
    });
    const query = rule("redirect", {
      kind: "redirect",
      value: "/a",
      setQuery: [
        { name: "a", value: "1" },
        { name: "b", value: "", expression: "md5(ip.src)" },
      ],
    });
    expect(issuePaths(query)).toEqual(["action.setQuery.1.expression"]);
    expect(query.success ? null : expressionIssue(query.error.issues[0] as never)).toMatchObject({
      code: "argument_not_string",
      position: 4,
    });
  });
  it("accepts computed query parameters, but not with a static value as well", () => {
    expect(
      rule("redirect", {
        kind: "redirect",
        value: "/signin",
        statusCode: 303,
        setQuery: [{ name: "next", value: "", expression: 'http.request.uri.args["next"]' }],
      }).success,
    ).toBe(true);
    expect(
      rule("redirect", {
        kind: "redirect",
        value: "/a",
        setQuery: [{ name: "a", value: "1", expression: '"2"' }],
      }).success,
    ).toBe(false);
    expect(ruleAction.parse({ kind: "redirect", value: "/a" }).statusCode).toBe(301);
  });
  it("lists the error page placeholders, {{time}} and {{path}} needing rules-v3", () => {
    expect(ERROR_PAGE_PLACEHOLDERS).toEqual([
      "{{status}}",
      "{{request_id}}",
      "{{client_ip}}",
      "{{host}}",
      "{{time}}",
      "{{path}}",
    ]);
    expect(RULES_V3_PLACEHOLDERS).toEqual(["{{time}}", "{{path}}"]);
    expect(usesRulesV3Placeholders("<p>{{status}} {{request_id}}</p>")).toBe(false);
    expect(usesRulesV3Placeholders("<p>{{path}}</p>")).toBe(true);
    expect(usesRulesV3Placeholders("<p>{{ time }}</p>")).toBe(false);
  });
});
