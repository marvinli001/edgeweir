import { describe, expect, it } from "vitest";
import { canonicalCidr, ExpressionError, evaluate, parseExpression } from "../src/index";

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
  it("normalizes networks without widening ambiguous input", () => {
    expect(canonicalCidr("192.0.2.123/24")).toBe("192.0.2.0/24");
    expect(canonicalCidr("::ffff:192.0.2.12/120")).toBe("192.0.2.0/24");
    expect(() => canonicalCidr("0x7f000001")).toThrow();
  });
});
