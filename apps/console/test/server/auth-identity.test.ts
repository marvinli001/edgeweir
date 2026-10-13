import { describe, expect, it } from "vitest";
import {
  FORMER_IDENTITY_HEADERS_MAX,
  identityHeadersOf,
  MAX_SITE_IDENTITY_HEADERS,
  nextIdentityHistory,
  siteIdentityHeaders,
} from "../../src/server/services/auth-identity";

const forward = (names: string[]) => ({ kind: "forward", settings: { responseHeaders: names } });
const basic = (userHeader: boolean) => ({ kind: "basic", settings: { userHeader } });

describe("identity headers of access authentication rules", () => {
  it("are x-auth-user for Basic with the user header and a forward rule's copied headers", () => {
    expect(identityHeadersOf(basic(true))).toEqual(["x-auth-user"]);
    expect(identityHeadersOf(basic(false))).toEqual([]);
    expect(identityHeadersOf(forward(["X-User", "x-groups"]))).toEqual(["x-user", "x-groups"]);
    expect(identityHeadersOf({ kind: "url_a", settings: {} })).toEqual([]);
  });

  it("keep those of former rules, the oldest unused ones dropped past the limit", () => {
    const history = nextIdentityHistory([], [basic(true)], [forward(["x-user"])]);
    expect(history).toEqual(["x-auth-user", "x-user"]);
    const many = Array.from({ length: FORMER_IDENTITY_HEADERS_MAX + 5 }, (_, i) => `x-h${i}`);
    const next = nextIdentityHistory(many, [], [forward(["x-now"])]);
    expect(next).toHaveLength(FORMER_IDENTITY_HEADERS_MAX + 1);
    expect(next).toContain("x-now");
    expect(next).not.toContain("x-h0");
    expect(next).toContain(`x-h${FORMER_IDENTITY_HEADERS_MAX + 4}`);
  });

  it("send only names a rule may set, the current rules' first, at most the nodes' limit", () => {
    expect(siteIdentityHeaders(["cookie", "X-Bad", "x-old"], [forward(["x-user"])])).toEqual([
      "x-user",
      "x-old",
    ]);
    const huge = Array.from({ length: 300 }, (_, i) => `x-h${i}`);
    const sent = siteIdentityHeaders(huge, [forward(["x-user"])]);
    expect(sent).toHaveLength(MAX_SITE_IDENTITY_HEADERS);
    expect(sent[0]).toBe("x-user");
  });
});
