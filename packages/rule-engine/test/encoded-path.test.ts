import { describe, expect, it } from "vitest";
import {
  authRuleIndex,
  classifyRawPath,
  grantInScope,
  pathInScope,
  rawPathAmbiguous,
  validEncodedPathPrefix,
} from "../src/index.ts";
import vectors from "./encoded_path_vectors.json" with { type: "json" };

// The node's Lua (test/lua/uripath.lua) runs the same file.
describe("encoded path vectors", () => {
  it("ambiguous raw paths", () => {
    for (const v of vectors.ambiguous) expect(rawPathAmbiguous(v.raw), v.raw).toBe(v.result);
  });
  it("exemption prefixes", () => {
    for (const v of vectors.prefixes)
      expect(validEncodedPathPrefix(v.prefix), v.prefix).toBe(v.valid);
  });
  it("classifies raw paths", () => {
    for (const v of vectors.classify)
      expect(classifyRawPath(v.raw, v.exemptions), v.name).toEqual({
        ambiguous: v.ambiguous,
        noExemption: v.noExemption,
        views: v.views,
        keyPath: v.keyPath,
      });
  });
  it("path scopes", () => {
    for (const v of vectors.scope)
      expect(
        pathInScope(v.uri, v.prefixes, v.excluded, classifyRawPath(v.raw, v.exemptions)),
        v.name,
      ).toBe(v.result);
  });
  it("grants", () => {
    for (const v of vectors.grant)
      expect(grantInScope(v.uri, v.prefixes, classifyRawPath(v.raw, v.exemptions)), v.name).toBe(
        v.result,
      );
  });
  it("access authentication rules", () => {
    for (const v of vectors.auth)
      expect(authRuleIndex(v.rules, v.uri, classifyRawPath(v.raw, v.exemptions)), v.name).toBe(
        v.result,
      );
  });
});

describe("encoded path exemptions", () => {
  it("never let a dot segment through, whatever is allowed", () => {
    const all = [{ prefix: "/", encodedSlash: true, semicolon: true }];
    for (const raw of [
      "/admin%2F..",
      "/admin%2F..%2Fx",
      "/x%2F.%2Fadmin",
      "/x/..;/admin",
      "/x/..;a=b/admin",
      "/x;a/../admin",
      "/x%2F..;/admin",
      "/x/.;/admin",
    ])
      expect(classifyRawPath(raw, all).ambiguous, raw).toBe(true);
  });

  it("keeps views equal to $uri out of plain paths", () => {
    expect(classifyRawPath("/a/b", [{ prefix: "/", encodedSlash: true, semicolon: true }])).toEqual(
      { ambiguous: false, noExemption: false, views: null, keyPath: null },
    );
  });

  it("keeps the old scope behaviour without a class", () => {
    expect(pathInScope("/admin/public/x", ["/admin/"], ["/admin/public/"])).toBe(false);
    expect(
      pathInScope("/admin/public/x", ["/admin/"], ["/admin/public/"], {
        ambiguous: false,
        noExemption: true,
        views: null,
      }),
    ).toBe(true);
  });
});
