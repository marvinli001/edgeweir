import { cacheConditionExpression } from "@edgeweir/rule-engine";
import { describe, expect, it } from "vitest";
import {
  BULK_REDIRECT_LIMIT,
  bulkRedirect,
  bulkRedirectSourceParts,
  bulkRedirectsInput,
  cacheRuleExpression,
  cacheRuleInput,
  contract,
  expressionIssue,
  ruleAction,
  ruleInput,
  siteCreateInput,
  siteUpdateInput,
} from "../src/index";

const rule = (phase: string, action: unknown, expression = "true") =>
  ruleInput.safeParse({ name: "r", phase, expression, action });
const issuePaths = (result: ReturnType<typeof rule>) =>
  result.success ? [] : result.error.issues.map((issue) => issue.path.join("."));

describe("rule inputs", () => {
  it("leave a rule disabled unless it says otherwise", () => {
    const action = { kind: "block" };
    expect(
      ruleInput.parse({ name: "r", phase: "waf-custom", expression: "true", action }).enabled,
    ).toBe(false);
    expect(
      ruleInput.parse({ name: "r", phase: "waf-custom", expression: "true", enabled: true, action })
        .enabled,
    ).toBe(true);
  });
});

describe("rule actions", () => {
  it("accepts redirects and rewrites with a static value or a value expression target and their query edits", () => {
    expect(ruleAction.parse({ kind: "redirect", value: "/new" })).toEqual({
      kind: "redirect",
      value: "/new",
      target: "",
      statusCode: 301,
      preserveQuery: false,
      setQuery: [],
      removeQuery: [],
    });
    expect(ruleAction.parse({ kind: "rewrite", value: "/index.html" })).toEqual({
      kind: "rewrite",
      value: "/index.html",
      target: "",
      preserveQuery: true,
      setQuery: [],
      removeQuery: [],
    });
    const dynamic = rule(
      "redirect",
      {
        kind: "redirect",
        target: 'concat("https://", lower(http.host), http.request.uri.path)',
        statusCode: 308,
        preserveQuery: true,
        setQuery: [
          { name: "utm_source", value: "edge cdn" },
          { name: "v", value: "" },
        ],
        removeQuery: ["fbclid", "gclid"],
      },
      'starts_with(http.request.uri.path, "/go/")',
    );
    expect(dynamic.success).toBe(true);
    expect(
      rule("request-transform", {
        kind: "rewrite",
        target: 'regex_replace(http.request.uri.path, "^/old/", "/new/")',
        preserveQuery: false,
      }).success,
    ).toBe(true);
  });

  it("refuses both or neither of value and target, invalid static values and conflicting query edits", () => {
    for (const action of [
      { kind: "redirect" },
      { kind: "redirect", value: "/a", target: "http.host" },
      { kind: "redirect", value: "//evil.test" },
      { kind: "redirect", value: "https://user@evil.test/" },
      { kind: "redirect", value: "/a b\u0001" },
      { kind: "rewrite", value: "/a?b" },
      { kind: "rewrite", target: "" },
      {
        kind: "redirect",
        value: "/a",
        setQuery: [
          { name: "a", value: "1" },
          { name: "a", value: "2" },
        ],
      },
      { kind: "redirect", value: "/a", setQuery: [{ name: "a", value: "1" }], removeQuery: ["a"] },
      { kind: "redirect", value: "/a", setQuery: [{ name: "a b", value: "1" }] },
      { kind: "redirect", value: "/a", setQuery: [{ name: "a", value: "é" }] },
      { kind: "redirect", value: "/a", setQuery: [{ name: "a", value: "x".repeat(257) }] },
      { kind: "redirect", value: "/a", removeQuery: ["a&b"] },
      {
        kind: "redirect",
        value: "/a",
        removeQuery: Array.from({ length: 17 }, (_, i) => `p${i}`),
      },
      { kind: "redirect", value: "/a", statusCode: 303 },
    ])
      expect(ruleAction.safeParse(action).success, JSON.stringify(action)).toBe(false);
  });

  it("parses targets as value expressions of the rule's phase and reports them at action.target", () => {
    const invalid = rule("redirect", { kind: "redirect", target: 'lower(http.host) eq "a"' });
    expect(invalid.success).toBe(false);
    expect(issuePaths(invalid)).toEqual(["action.target"]);
    // Response fields only exist in response phases; replacements only in values.
    expect(
      issuePaths(
        rule("redirect", { kind: "redirect", target: "http.response.content_type.media_type" }),
      ),
    ).toEqual(["action.target"]);
    expect(
      issuePaths(rule("waf-custom", { kind: "log" }, 'regex_replace(http.host, "a", "b") eq "b"')),
    ).toEqual(["expression"]);
  });

  it("accepts origin actions with at least one valid override in the origin phase only", () => {
    expect(
      ruleAction.parse({ kind: "origin", originGroup: "eu-west", hostHeader: "Media.Example.com" }),
    ).toEqual({
      kind: "origin",
      originGroup: "eu-west",
      hostHeader: "media.example.com",
      sni: "",
      port: 0,
    });
    expect(rule("origin", { kind: "origin", port: 8443 }).success).toBe(true);
    expect(issuePaths(rule("request-transform", { kind: "origin", port: 8443 }))).toEqual([
      "action",
    ]);
    for (const action of [
      { kind: "origin" },
      { kind: "origin", originGroup: "EU" },
      { kind: "origin", originGroup: "x".repeat(33) },
      { kind: "origin", hostHeader: "a.test:8080" },
      { kind: "origin", sni: "*.a.test" },
      { kind: "origin", port: 65536 },
      { kind: "origin", port: -1 },
    ])
      expect(ruleAction.safeParse(action).success, JSON.stringify(action)).toBe(false);
  });

  it("accepts gzip on and the new config fields in the config phase only, within their ranges", () => {
    const config = {
      kind: "config",
      gzip: true,
      brotli: false,
      zstd: true,
      websocket: false,
      underAttack: true,
      ccEnabled: true,
      ccMaxLevel: "captcha",
      originConnectTimeoutMs: 120_000,
      originSendTimeoutMs: 3_600_000,
      originReadTimeoutMs: 100,
      logSampleRate: 0,
    };
    expect(rule("config", config).success).toBe(true);
    expect(rule("cache", { kind: "config", gzip: true, cacheBypass: false }).success).toBe(true);
    for (const field of ["websocket", "underAttack", "logSampleRate"] as const)
      expect(issuePaths(rule("cache", { kind: "config", [field]: config[field] })), field).toEqual([
        "action",
      ]);
    for (const patch of [
      { originConnectTimeoutMs: 120_001 },
      { originSendTimeoutMs: 99 },
      { originReadTimeoutMs: 3_600_001 },
      { logSampleRate: 10_001 },
      { ccMaxLevel: "ban" },
      {},
    ])
      expect(
        ruleAction.safeParse({ kind: "config", ...patch }).success,
        JSON.stringify(patch),
      ).toBe(false);
  });

  it("accepts compression codings in preference order, unique and possibly none, in the compression phase", () => {
    expect(
      rule(
        "compression",
        { kind: "compression", algorithms: ["zstd", "gzip"] },
        'http.response.content_type.media_type eq "text/html"',
      ).success,
    ).toBe(true);
    expect(rule("compression", { kind: "compression", algorithms: [] }).success).toBe(true);
    expect(issuePaths(rule("response-transform", { kind: "compression", algorithms: [] }))).toEqual(
      ["action"],
    );
    for (const algorithms of [["br", "br"], ["deflate"], undefined])
      expect(ruleAction.safeParse({ kind: "compression", algorithms }).success).toBe(false);
    // Response phases may read response fields; compression is one of them.
    expect(
      issuePaths(rule("config", { kind: "config", gzip: false }, "http.response.code eq 200")),
    ).toEqual(["expression"]);
  });

  it("keeps parsing the actions stored by earlier versions", () => {
    for (const action of [
      { kind: "redirect", value: "https://a.test/", statusCode: 302 },
      { kind: "rewrite", value: "/b" },
      { kind: "config", gzip: false, cacheBypass: true },
      { kind: "challenge", type: "pow" },
    ])
      expect(ruleAction.safeParse(action).success, JSON.stringify(action)).toBe(true);
  });

  it("validates conditions, values and cache rule conditions through rules.validate", () => {
    const input = contract.rules.validate["~orpc"].inputSchema;
    expect(input?.["~standard"].validate({ expression: "true", phase: "cache" })).toMatchObject({
      value: { kind: "condition" },
    });
    expect(
      input?.["~standard"].validate({ expression: "x".repeat(16385), phase: "cache" }),
    ).toHaveProperty("issues");
  });
});

describe("expression issues", () => {
  const failures = (result: { success: boolean; error?: { issues: unknown[] } }) =>
    (result.error?.issues ?? []).map((issue) => ({
      path: (issue as { path: unknown[] }).path.join("."),
      failure: expressionIssue(issue as Parameters<typeof expressionIssue>[0]),
    }));

  it("carry the parser's code, position and parameters for conditions and targets", () => {
    expect(failures(rule("waf-custom", { kind: "block" }, "http.host gt 4"))).toEqual([
      {
        path: "expression",
        failure: { code: "ordered_comparison", position: 10, params: {} },
      },
    ]);
    const redirect = rule("redirect", {
      kind: "redirect",
      value: "",
      target: 'concat("/", lower(http.host)',
    });
    expect(failures(redirect)).toEqual([
      {
        path: "action.target",
        failure: { code: "unexpected_end", position: 28, params: {} },
      },
    ]);
  });

  it("carry them for cache rule conditions and leave other issues alone", () => {
    const cache = cacheRuleInput.safeParse({
      action: "cache",
      edgeTtlSeconds: 60,
      expression: "ip.src in $Bad-name",
    });
    expect(failures(cache)).toMatchObject([
      { path: "expression", failure: { code: "list_reference", position: 10 } },
    ]);
    expect(failures(rule("waf-custom", { kind: "redirect", value: "/" }))).toMatchObject([
      { path: "action", failure: null },
    ]);
  });
});

describe("cache rule inputs", () => {
  const base = { action: "cache", edgeTtlSeconds: 60 };

  it("takes a non-empty expression as the condition and its structured form beside it only when equal", () => {
    const expression =
      '(starts_with(http.request.uri.path, "/a/") or starts_with(http.request.uri.path, "/b/")) and http.request.uri.path.extension in {"png" "css"}';
    expect(cacheRuleInput.parse({ ...base, expression })).toMatchObject({
      expression,
      pathPrefixes: [],
      browserTtlSeconds: 0,
    });
    // What sites.get returns round-trips: lists equal to the expression's structured form.
    expect(
      cacheRuleInput.safeParse({
        ...base,
        expression,
        pathPrefixes: ["/a/", "/b/"],
        extensions: ["css", "png"],
      }).success,
    ).toBe(true);
    const mismatch = cacheRuleInput.safeParse({
      ...base,
      expression,
      pathPrefixes: ["/b/", "/a/"],
    });
    expect(mismatch.success).toBe(false);
    expect(
      cacheRuleInput.safeParse({
        ...base,
        expression: 'lower(http.host) eq "a.test"',
        paths: ["/x"],
      }).success,
    ).toBe(false);
    expect(
      cacheRuleInput.safeParse({ ...base, expression: 'lower(http.host) eq "a.test"' }).success,
    ).toBe(true);
  });

  it("refuses invalid and too long conditions and bounds the browser TTL", () => {
    for (const expression of [
      "http.host eq",
      "http.response.code eq 200",
      'regex_replace(http.host, "a", "b") eq "b"',
      `http.host eq "${"x".repeat(16384)}"`,
    ])
      expect(
        cacheRuleInput.safeParse({ ...base, expression }).success,
        expression.slice(0, 40),
      ).toBe(false);
    expect(cacheRuleInput.parse({ ...base, browserTtlSeconds: 31_536_000 }).browserTtlSeconds).toBe(
      31_536_000,
    );
    expect(cacheRuleInput.safeParse({ ...base, browserTtlSeconds: 31_536_001 }).success).toBe(
      false,
    );
    expect(cacheRuleInput.safeParse({ ...base, browserTtlSeconds: -1 }).success).toBe(false);
  });

  it("stores the structured lists as the builder's expression", () => {
    const parsed = cacheRuleInput.parse({
      ...base,
      pathPrefixes: ["/static/"],
      paths: ["/index.html"],
      extensions: [".PNG"],
    });
    expect(cacheRuleExpression(parsed)).toBe(
      'starts_with(http.request.uri.path, "/static/") and http.request.uri.path in {"/index.html"} and http.request.uri.path.extension in {"png"}',
    );
    expect(cacheRuleExpression(cacheRuleInput.parse(base))).toBe("true");
    expect(cacheRuleExpression({ ...parsed, expression: "ssl" + " eq true" })).toBe("ssl eq true");
    expect(cacheRuleExpression(parsed)).toBe(cacheConditionExpression(parsed));
  });
});

describe("origin groups", () => {
  const site = { name: "s", domains: ["s.test"] };

  it("defaults origins to the default group and requires one default-group origin", () => {
    const parsed = siteCreateInput.parse({
      ...site,
      origins: [{ address: "a.test" }, { address: "b.test", group: "eu_1" }],
    });
    expect(parsed.origins.map((origin) => origin.group)).toEqual(["", "eu_1"]);
    expect(
      siteCreateInput.safeParse({ ...site, origins: [{ address: "b.test", group: "eu" }] }).success,
    ).toBe(false);
    expect(
      siteUpdateInput.safeParse({
        id: "00000000-0000-4000-8000-000000000000",
        origins: [{ address: "b.test", group: "eu" }],
      }).success,
    ).toBe(false);
    for (const group of ["EU", "a.b", "x".repeat(33)])
      expect(
        siteCreateInput.safeParse({
          ...site,
          origins: [{ address: "a.test" }, { address: "b.test", group }],
        }).success,
        group,
      ).toBe(false);
  });
});

describe("bulk redirects", () => {
  const id = "00000000-0000-4000-8000-000000000000";

  it("accepts path and host/path sources with static targets and defaults", () => {
    expect(bulkRedirect.parse({ source: "/old", target: "/new" })).toEqual({
      source: "/old",
      target: "/new",
      statusCode: 301,
      preserveQuery: false,
    });
    expect(
      bulkRedirect.safeParse({
        source: "www.a.test/产品",
        target: "https://b.test/products",
        statusCode: 308,
        preserveQuery: true,
      }).success,
    ).toBe(true);
    expect(bulkRedirectSourceParts("www.a.test/x/y")).toEqual({ host: "www.a.test", path: "/x/y" });
    expect(bulkRedirectSourceParts("/x")).toEqual({ host: "", path: "/x" });
  });

  it("refuses invalid sources and targets, duplicate sources and more than 5000 entries", () => {
    for (const source of [
      "/",
      "x",
      "old",
      "/a b",
      "/a?b=1",
      "/a\u0007",
      "WWW.a.test/x",
      "a.test:8080/x",
      "*.a.test/x",
      `/${"x".repeat(512)}`,
      `/${"é".repeat(256)}`,
    ])
      expect(bulkRedirect.safeParse({ source, target: "/" }).success, source).toBe(false);
    for (const target of [
      "",
      "//a.test/",
      "ftp://a.test/",
      "https://u:p@a.test/",
      "/a\\b",
      `/${"x".repeat(1024)}`,
    ])
      expect(bulkRedirect.safeParse({ source: "/a", target }).success, target).toBe(false);
    expect(
      bulkRedirectsInput.safeParse({
        id,
        redirects: [
          { source: "/a", target: "/1" },
          { source: "/a", target: "/2" },
        ],
      }).success,
    ).toBe(false);
    const many = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ source: `/p${i}`, target: "/" }));
    expect(bulkRedirectsInput.safeParse({ id, redirects: many(BULK_REDIRECT_LIMIT) }).success).toBe(
      true,
    );
    expect(
      bulkRedirectsInput.safeParse({ id, redirects: many(BULK_REDIRECT_LIMIT + 1) }).success,
    ).toBe(false);
  });

  it("routes get and save under the site", () => {
    expect(contract.bulkRedirects.get["~orpc"].route).toMatchObject({
      method: "GET",
      path: "/sites/{id}/bulk-redirects",
    });
    expect(contract.bulkRedirects.save["~orpc"].route).toMatchObject({
      method: "PUT",
      path: "/sites/{id}/bulk-redirects",
    });
  });
});
