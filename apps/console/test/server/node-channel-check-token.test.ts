import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  acceptCheckToken,
  CHECK_TOKEN_TTL_MS,
  issueCheckToken,
} from "../../src/server/node-channel/check-token";

const masterKey = randomBytes(32).toString("base64");
const otherKey = randomBytes(32).toString("base64");

describe("the token of the console's own check of the WebSocket entry", () => {
  it("is taken once, by a console with the same master key", () => {
    const now = Date.now();
    const token = issueCheckToken(masterKey, now);
    expect(acceptCheckToken(otherKey, token, now)).toBe(false);
    expect(acceptCheckToken(masterKey, token, now + 1000)).toBe(true);
    expect(acceptCheckToken(masterKey, token, now + 2000)).toBe(false);
    expect(acceptCheckToken(masterKey, issueCheckToken(masterKey, now), now)).toBe(true);
  });

  it("expires, and is never dated further ahead than its lifetime", () => {
    const now = Date.now();
    const token = issueCheckToken(masterKey, now);
    expect(acceptCheckToken(masterKey, token, now + CHECK_TOKEN_TTL_MS)).toBe(false);
    // Issued "later" than the clock allows (a forged expiry would need the key anyway).
    const ahead = issueCheckToken(masterKey, now + 60_000);
    expect(acceptCheckToken(masterKey, ahead, now)).toBe(false);
  });

  it("refuses anything else", () => {
    const now = Date.now();
    const [expires, nonce, mac] = issueCheckToken(masterKey, now).split(".") as [
      string,
      string,
      string,
    ];
    for (const value of [
      undefined,
      ["a", "b"],
      "",
      `${expires}.${nonce}`,
      `${Number(expires) + 1}.${nonce}.${mac}`,
      `${expires}.${nonce}x.${mac}`,
      `${expires}.${nonce}.${mac.slice(0, -1)}`,
      `${expires}.${nonce}.${mac}.x`,
    ])
      expect(acceptCheckToken(masterKey, value, now)).toBe(false);
  });
});
