import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkSignedUri, signUri, type UrlAuthKind, urlAuthHash } from "../src/index";

// edgeweir-node keeps an identical copy in test/lua/url_auth_vectors.json
// (test/lua/auth.lua checks every case with edgeweir.auth).
const vectors = JSON.parse(
  readFileSync(new URL("./url_auth_vectors.json", import.meta.url), "utf8"),
) as {
  sign: {
    kind: UrlAuthKind;
    uri: string;
    key: string;
    ts: number;
    rand: string;
    signParam: string;
    timeParam: string;
    expected: string;
    note: string;
  }[];
  check: {
    kind: UrlAuthKind;
    uri: string;
    now: number;
    outcome: "ok" | "expired" | "denied";
    stripped: string;
    keys: string[];
    validitySeconds: number;
    skewSeconds: number;
    signParam: string;
    timeParam: string;
    note: string;
  }[];
};

describe("signed URLs", () => {
  it("hashes the specification's example", () => {
    const path = "/images/test.jpg";
    expect(urlAuthHash(path, "1661824870", "123456", "c6d1a57067b21f7b")).toBe(
      "0baac47b6c2ad519bb1bfe7babff37a3",
    );
    expect(urlAuthHash(path, "1661824870", "123456")).toBe("64bf8671521f2a61a3b64691fde82729");
  });

  it("signs every shared vector", () => {
    expect(vectors.sign.length).toBeGreaterThanOrEqual(28);
    for (const v of vectors.sign) {
      expect(signUri(v.kind, v.uri, v), `${v.kind} ${v.uri} ${v.note}`).toBe(v.expected);
    }
  });

  it("checks every shared vector", () => {
    const outcomes = new Set(vectors.check.map((v) => v.outcome));
    expect(outcomes).toEqual(new Set(["ok", "expired", "denied"]));
    for (const v of vectors.check) {
      expect(checkSignedUri(v.kind, v.uri, v), `${v.kind} ${v.uri} ${v.note}`).toEqual({
        outcome: v.outcome,
        stripped: v.stripped,
      });
    }
  });

  it("accepts what it signs and nothing once the key changes", () => {
    for (const kind of ["url_a", "url_b", "url_c", "url_d"] as const) {
      const names = { signParam: "sign", timeParam: "t" };
      const uri = signUri(kind, "/a/b.mp4?x=1", {
        ...names,
        key: "k".repeat(16),
        ts: 1000,
        rand: "r1",
      });
      const check = { ...names, validitySeconds: 60, skewSeconds: 0, now: 1030 };
      expect(checkSignedUri(kind, uri, { ...check, keys: ["k".repeat(16)] })).toEqual({
        outcome: "ok",
        stripped: "/a/b.mp4?x=1",
      });
      expect(checkSignedUri(kind, uri, { ...check, keys: ["j".repeat(16)] }).outcome).toBe(
        "denied",
      );
    }
  });

  it("refuses to sign what nodes could not check", () => {
    const names = { signParam: "sign", timeParam: "t", key: "k".repeat(16) };
    expect(() => signUri("url_b", "a.jpg", { ...names, ts: 1 })).toThrow();
    expect(() => signUri("url_a", "/a.jpg", { ...names, ts: 1, rand: "a-b" })).toThrow();
    expect(() => signUri("url_d", "/a.jpg", { ...names, ts: 1e13 })).toThrow();
  });
});
