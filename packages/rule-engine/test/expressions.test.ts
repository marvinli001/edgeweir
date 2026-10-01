import { describe, expect, it } from "vitest";
import {
  actionPhases,
  cacheConditionExpression,
  canonicalCidr,
  challengeTypes,
  ExpressionError,
  evaluate,
  evaluateValue,
  isRateLimitKey,
  needsRulesV2,
  type Phase,
  parseExpression,
  parseValueExpression,
  phases,
  structuredCacheCondition,
  usesGeo,
  usesJa4,
  validActionIr,
  validRedirectTarget,
  wildcardSegments,
} from "../src/index";

describe("typed rule expressions", () => {
  it.each([
    [
      'http.host eq "example.test" and not http.request.method in {"POST" "PUT"}',
      { "http.host": "example.test", "http.request.method": "GET" },
      true,
    ],
    ["ip.src in {192.0.2.0/24 2001:db8::/32}", { "ip.src": "192.0.2.12" }, true],
    ["ip.src in {192.0.2.0/24}", { "ip.src": "::ffff:192.0.2.12" }, true],
    [
      'http.request.uri.path matches "^/(api|assets)/"',
      { "http.request.uri.path": "/assets/app.js" },
      true,
    ],
    ['http.request.headers["X-Region"] eq "nz"', { "http.request.headers.x-region": "nz" }, true],
    [
      'ssl eq true and http.host contains "example"',
      { ssl: true, "http.host": "example.test" },
      true,
    ],
    ["true or false and false", {}, true],
  ] as const)("evaluates %s", (source, request, want) => {
    expect(evaluate(parseExpression(source), request)).toBe(want);
  });
  it.each([
    'unknown.field eq "x"',
    "http.host gt 4",
    "http.host eq 4",
    "ip.src in {127.1}",
    "ip.src in {010.0.0.1}",
    'http.host matches "(a+)+"',
    'http.host matches "(?=a)"',
    'http.host matches "(a)\\\\1"',
    "http.host in {}",
    "true trailing",
    'http.host matches "a{1001}"',
    'http.host matches "a{,2}"',
    'http.host matches "[]"',
    'http.request.headers.bad<name> eq "x"',
    "ip.src in {::ffff:010.0.0.1}",
  ])("rejects %s", (source) => expect(() => parseExpression(source)).toThrow(ExpressionError));
  it.each([
    ['http.host matches "a{,2}"', "{,2}", 0],
    ['http.host matches "x\\\\s"', "\\\\s", 0],
    ['http.host matches "\\u0078[:a:]"', "[:a:]", 0],
    ['http.host matches "(a)+"', "+", 0],
    ['http.host matches "(a"', '"', 1],
  ] as const)("positions the regular expression error in %s", (source, at, from) => {
    const error = (() => {
      try {
        parseExpression(source);
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(ExpressionError);
    expect((error as ExpressionError).position).toBe(
      source.indexOf(at, source.indexOf('"') + from),
    );
  });
  it("rejects response fields before the response phase", () => {
    expect(() => parseExpression("http.response.code ge 500")).toThrow();
    expect(
      evaluate(parseExpression("http.response.code ge 500", "response-transform"), {
        "http.response.code": 503,
      }),
    ).toBe(true);
  });
  it("bounds source size, nesting and sets", () => {
    expect(() => parseExpression("(".repeat(30) + "true" + ")".repeat(30))).toThrow();
    expect(() => parseExpression("x".repeat(4097))).toThrow();
    expect(() =>
      parseExpression(
        "http.host in {" +
          Array.from({ length: 257 }, (_, i) => JSON.stringify(String(i))).join(" ") +
          "}",
      ),
    ).toThrow();
  });
  it("types tls.ja4 as a string in every phase, empty when unset", () => {
    for (const phase of phases)
      expect(
        parseExpression('tls.ja4 eq "t13d1516h2_8daaf6152771_02713d6af862"', phase).field,
      ).toBe("tls.ja4");
    expect(() => parseExpression("tls.ja4 gt 1")).toThrow(ExpressionError);
    expect(() => parseExpression("tls.ja4 eq 1")).toThrow(ExpressionError);
    expect(() => parseExpression("tls.ja4 in $blocked")).toThrow(ExpressionError);
    expect(evaluate(parseExpression('tls.ja4 eq ""'), {})).toBe(true);
    expect(usesJa4(parseExpression('ssl eq true and not tls.ja4 contains "_"'))).toBe(true);
    expect(usesJa4(parseExpression('http.host eq "a"'))).toBe(false);
  });
  it("allows the challenge action in waf-custom with a known type only", () => {
    expect(actionPhases.challenge).toEqual(["waf-custom"]);
    for (const challenge of challengeTypes)
      expect(validActionIr("waf-custom", { kind: "challenge", challenge })).toBe(true);
    expect(validActionIr("waf-custom", { kind: "challenge", challenge: "slider" })).toBe(false);
    expect(validActionIr("waf-custom", { kind: "challenge" })).toBe(false);
    expect(validActionIr("redirect", { kind: "challenge", challenge: "js" })).toBe(false);
  });
  it("counts rate limits by tls.ja4", () => {
    expect(isRateLimitKey("tls.ja4")).toBe(true);
    expect(isRateLimitKey("http.request.headers.x-client")).toBe(true);
    expect(isRateLimitKey("tls.ja3")).toBe(false);
    expect(
      validActionIr("ratelimit", {
        kind: "rate_limit",
        statusCode: 429,
        limit: 10,
        windowSeconds: 10,
        key: "tls.ja4",
      }),
    ).toBe(true);
  });
  it("normalizes networks without widening ambiguous input", () => {
    expect(canonicalCidr("192.0.2.123/24")).toBe("192.0.2.0/24");
    expect(canonicalCidr("::ffff:192.0.2.12/120")).toBe("192.0.2.0/24");
    expect(() => canonicalCidr("0x7f000001")).toThrow();
  });
});

describe("rules-v2 functions, value expressions and cache conditions", () => {
  const position = (source: string, phase: Phase = "waf-custom", value = false) => {
    try {
      if (value) parseValueExpression(source, phase);
      else parseExpression(source, phase);
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressionError);
      return (error as ExpressionError).position;
    }
    throw new Error(`accepted: ${source}`);
  };
  it("points at the offending part of a call", () => {
    expect(position('trim(http.host) eq "a"')).toBe(0);
    expect(position('lower(ip.src) eq "a"')).toBe(6);
    expect(position('regex_replace(http.host, "(?i)a", "b")', "redirect", true)).toBe(26);
    expect(position('wildcard_replace(http.host, "/*", "${2}")', "redirect", true)).toBe(35);
    expect(position('starts_with(http.host, "a", "b")')).toBe(28);
  });
  it("allows the replacing functions only in value expressions, once each", () => {
    expect(() => parseExpression('regex_replace(http.host, "a", "b") eq "c"')).toThrow(
      "only available in value expressions",
    );
    expect(() =>
      parseValueExpression(
        'concat(wildcard_replace(http.host, "*", "${1}"), wildcard_replace(http.host, "*", "x"))',
        "redirect",
      ),
    ).toThrow("once per expression");
    expect(
      parseValueExpression(
        'concat(regex_replace(http.host, "a", "b"), wildcard_replace(http.host, "*", "x"))',
        "redirect",
      ).children,
    ).toHaveLength(2);
  });
  it("needs rules-v2 only for functions and the new fields", () => {
    expect(needsRulesV2(parseExpression('http.host eq "a" and ssl'.replace(" and ssl", "")))).toBe(
      false,
    );
    expect(needsRulesV2(parseExpression('lower(http.host) eq "a"'))).toBe(true);
    expect(needsRulesV2(parseExpression('http.request.uri.path.extension eq "png"'))).toBe(true);
    expect(needsRulesV2(parseValueExpression('"/x"', "redirect"))).toBe(true);
    expect(usesJa4(parseExpression('lower(tls.ja4) eq "x"'))).toBe(true);
    expect(usesGeo(parseExpression('lower(ip.geoip.country) eq "nz"'))).toBe(true);
  });
  it("accepts longer cache conditions only when asked", () => {
    const long = cacheConditionExpression({
      pathPrefixes: Array.from({ length: 32 }, (_, i) => `/${String(i).padStart(200, "x")}/`),
      paths: [],
      extensions: [],
    });
    expect(long.length).toBeGreaterThan(4096);
    expect(() => parseExpression(long, "cache")).toThrow("too long");
    const ir = parseExpression(long, "cache", { maxLength: 16384 });
    expect(structuredCacheCondition(ir)?.pathPrefixes).toHaveLength(32);
  });
  it("keeps expressions outside the builder's shape as expressions", () => {
    for (const source of [
      'starts_with(http.request.uri.path, "/a") or http.host eq "x"',
      'http.request.uri.path.extension in {"PNG"}',
      'starts_with(http.request.uri.path, "a")',
      'starts_with(http.request.uri.path, "/a") and starts_with(http.request.uri.path, "/b")',
      "false",
      'http.request.uri.path eq "/x"',
    ])
      expect(structuredCacheCondition(parseExpression(source, "cache")), source).toBeNull();
  });
  it("bounds computed values and splits wildcard patterns", () => {
    const big = parseValueExpression(
      "concat(http.request.uri.path, http.request.uri.path)",
      "redirect",
    );
    expect(() => evaluateValue(big, { "http.request.uri.path": "a".repeat(5000) })).toThrow(
      "too long",
    );
    expect(wildcardSegments("a\\*b*c\\\\")).toEqual(["a*b", "c\\"]);
    expect(() => wildcardSegments("a\\b")).toThrow(ExpressionError);
    expect(validRedirectTarget("https://example.test/a")).toBe(true);
    expect(validRedirectTarget("//example.test")).toBe(false);
  });
  it("runs compression rules after response-transform with response fields", () => {
    expect(phases.at(-1)).toBe("compression");
    expect(actionPhases.compression).toEqual(["compression"]);
    expect(actionPhases.origin).toEqual(["origin"]);
    expect(() =>
      parseExpression('http.response.content_type.media_type eq "text/html"', "compression"),
    ).not.toThrow();
  });
});
