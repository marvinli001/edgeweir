import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  actionPhases,
  bindLists,
  cacheConditionExpression,
  canonicalCidr,
  challengeTypes,
  ExpressionError,
  type ExpressionErrorCode,
  evaluate,
  evaluateHeaderValue,
  evaluateValue,
  expressionErrorCodes,
  expressionErrorDefs,
  isRateLimitKey,
  needsRulesV2,
  needsRulesV3,
  type Phase,
  parseExpression,
  parseValueExpression,
  phases,
  structuredCacheCondition,
  usesGeo,
  usesJa4,
  validActionIr,
  validExpressionIr,
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

describe("expression error codes", () => {
  const failure = (parse: () => unknown) => {
    try {
      parse();
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressionError);
      return error as ExpressionError;
    }
    throw new Error("accepted");
  };
  it.each([
    ["http.host gt 4", "ordered_comparison", 10, {}],
    ['unknown.field eq "x"', "unknown_field", 0, {}],
    ['http.host eq "x" and', "unexpected_end", 20, {}],
    ['(http.host eq "x" true', "expected_token", 18, { token: ")" }],
    ["http.host eq 4", "expected_string", 13, {}],
    ["ip.src in {10.0.0.300}", "expected_ip", 11, {}],
    ["http.host in {}", "set_empty", 10, {}],
    ['http.host is "x"', "unknown_operator", 10, {}],
    ["http.host in $list", "list_reference", 13, {}],
    ['http.host matches "a{,2}"', "regex_repetition", 20, {}],
    ['http.host matches "(?=a)"', "regex_group", 19, {}],
    ['http.host matches "[]"', "regex_class_empty", 19, {}],
    ["http.response.code ge 500", "response_field", 0, {}],
    ['regex_replace(http.host, "a", "b") eq "c"', "value_only_function", 0, {}],
    ['starts_with(http.host, "a", "b")', "too_many_arguments", 28, {}],
    ['"x', "string_invalid", 0, {}],
    ['true "x"', "unexpected_token", 5, {}],
  ] as const)("refuses %s with %s", (source, code, position, params) => {
    const error = failure(() => parseExpression(source));
    expect(error).toMatchObject({ code, position, params });
  });
  it("keeps the code and parameters of value expressions and literal arguments", () => {
    expect(failure(() => parseValueExpression("ssl", "redirect"))).toMatchObject({
      code: "value_not_string",
      position: 0,
    });
    expect(
      failure(() => parseValueExpression('wildcard_replace(http.host, "/*", "${2}")', "redirect")),
    ).toMatchObject({ code: "replacement_capture", position: 35 });
    expect(failure(() => parseExpression("x".repeat(4097)))).toMatchObject({
      code: "too_long",
      params: { max: "4096" },
    });
  });
  it("names the unknown list when binding", () => {
    const error = failure(() => bindLists(parseExpression("ip.src in $office"), {}));
    expect(error).toMatchObject({ code: "unknown_list", params: { list: "office" } });
    expect(error.message).toBe("unknown IP list office");
  });
  it("interpolates every code's parameters into its English text", () => {
    for (const code of expressionErrorCodes) {
      const def = expressionErrorDefs[code as ExpressionErrorCode];
      const params = Object.fromEntries(def.params.map((name) => [name, `<${name}>`]));
      const error = new ExpressionError(code, 3, params);
      expect(error.message, code).not.toMatch(/\{\w+\}/);
      expect(error.at(7)).toMatchObject({ code, position: 7, params, message: error.message });
    }
  });
});

describe("rules-v3 fields, functions, wildcard comparisons and header values", () => {
  const failure = (parse: () => unknown) => {
    try {
      parse();
    } catch (error) {
      expect(error).toBeInstanceOf(ExpressionError);
      return error as ExpressionError;
    }
    throw new Error("accepted");
  };
  it.each([
    ['http.request.cookies["a b"] eq ""', "cookie_name", 21, {}],
    ["http.request.cookies.a=b eq 1", "cookie_name", 0, {}],
    ['http.request.uri.args["a&b"] eq ""', "argument_name", 22, {}],
    ['http.request.uri.args["x"] eq ""', undefined, 0, {}],
    ['http.host wildcard "a\\\\b"', "wildcard_escape", 21, {}],
    ['http.host strict contains "a"', "expected_token", 17, { token: "wildcard" }],
    ['ip.src wildcard "1*"', "string_operator", 7, {}],
    ['substring(http.host, "1") eq ""', "integer_argument", 21, { min: "-65536", max: "65536" }],
    ['substring(http.host, 0, -1) eq ""', "integer_argument", 24, { min: "0", max: "65536" }],
    ['substring(http.host, 01) eq ""', "integer_argument", 21, { min: "-65536", max: "65536" }],
    ['md5(ip.src) eq ""', "argument_not_string", 4, {}],
    ['http.response.cache_status eq "HIT"', "response_field", 0, {}],
  ] as const)("parses %s (%s)", (source, code, position, params) => {
    if (!code) {
      expect(parseExpression(source).field).toBe("http.request.uri.args.x");
      return;
    }
    expect(failure(() => parseExpression(source))).toMatchObject({ code, position, params });
  });
  it("keeps cookie and parameter names as written and lowercases nothing else", () => {
    expect(parseExpression('http.request.cookies["Session_ID"] eq "x"').field).toBe(
      "http.request.cookies.Session_ID",
    );
    expect(parseExpression('http.request.uri.args["utm[Source]"] ne ""').field).toBe(
      "http.request.uri.args.utm[Source]",
    );
    expect(parseExpression('http.request.headers["X-A"] eq ""').field).toBe(
      "http.request.headers.x-a",
    );
  });
  it("compiles integer arguments as number constants and to_string over any type", () => {
    const e = parseValueExpression("substring(http.host, -0, 3)", "redirect");
    expect(e.children.slice(1)).toEqual([
      expect.objectContaining({ op: "const", valueType: "number", value: "0" }),
      expect.objectContaining({ op: "const", valueType: "number", value: "3" }),
    ]);
    for (const field of ["ip.src", "ssl", "ip.geoip.asnum", "http.host"])
      expect(parseValueExpression(`to_string(${field})`, "redirect").valueType).toBe("string");
    expect(validExpressionIr(e, "redirect", true)).toBe(true);
  });
  it("needs rules-v3 only for the new fields, functions, comparisons and integers", () => {
    const v3 = (source: string, phase: Phase = "waf-custom") =>
      needsRulesV3(parseExpression(source, phase));
    expect(v3('http.user_agent wildcard "*bot*"')).toBe(true);
    expect(v3('http.request.cookies["a"] eq "b"')).toBe(true);
    expect(v3('http.request.uri.args["a"] eq "b"')).toBe(true);
    expect(v3('md5(http.host) eq ""')).toBe(true);
    expect(v3('http.response.cache_status eq "HIT"', "response-transform")).toBe(true);
    expect(v3('ip.geoip.as_name eq ""')).toBe(true);
    expect(v3('http.request.headers["user-agent"] contains "bot"')).toBe(false);
    expect(v3('lower(http.host) eq "a"')).toBe(false);
    expect(needsRulesV2(parseExpression('http.user_agent wildcard "*bot*"'))).toBe(false);
    expect(usesGeo(parseExpression('ip.geoip.as_name eq ""'))).toBe(true);
  });
  it("computes MD5, SHA-1 and SHA-256 like node:crypto across block boundaries", () => {
    for (const length of [0, 1, 55, 56, 63, 64, 65, 119, 120, 128, 1000]) {
      // Printable ASCII with a three-byte character every 20 positions (valid UTF-8).
      const text = Array.from({ length }, (_, i) =>
        i % 20 === 19 ? "中" : String.fromCharCode(32 + ((i * 37) % 95)),
      ).join("");
      for (const name of ["md5", "sha1", "sha256"] as const) {
        const want = createHash(name).update(text, "utf8").digest("hex");
        const e = parseValueExpression(`${name}(http.host)`, "redirect");
        expect(evaluateValue(e, { "http.host": text }), `${name} ${length}`).toBe(want);
      }
    }
  });
  it("skips header values that are too long or carry control characters", () => {
    const e = parseValueExpression('http.request.headers["x"]', "request-transform");
    expect(evaluateHeaderValue(e, { "http.request.headers.x": "ok" })).toBe("ok");
    expect(evaluateHeaderValue(e, { "http.request.headers.x": "a\u0000b" })).toBeNull();
    expect(evaluateHeaderValue(e, { "http.request.headers.x": "a".repeat(4097) })).toBeNull();
  });
  it("accepts header targets, response header lines, 303 and computed query parameters", () => {
    const target = parseValueExpression("http.request.id", "origin");
    expect(validActionIr("origin", { kind: "request_header", header: "x-req", target })).toBe(true);
    expect(
      validActionIr("request-transform", {
        kind: "request_header",
        header: "x-req",
        target,
        append: true,
      }),
    ).toBe(false);
    expect(
      validActionIr("response-transform", {
        kind: "response_header",
        header: "link",
        value: "<a>",
        append: true,
      }),
    ).toBe(true);
    expect(validActionIr("redirect", { kind: "redirect", value: "/a", statusCode: 303 })).toBe(
      true,
    );
    expect(
      validActionIr("redirect", {
        kind: "redirect",
        value: "/a",
        statusCode: 302,
        setQuery: [{ name: "n", value: "", expression: target }],
      }),
    ).toBe(true);
  });
});
