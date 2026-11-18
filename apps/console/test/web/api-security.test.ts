import { API_SECURITY_DEFAULTS } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import {
  apiSecurityDraft,
  parseApiSecurityDraft,
  parsePublicJwks,
} from "../../src/web/lib/api-security";

const publicKey = { kid: "example", alg: "RS256", kty: "RSA", n: "AQ", e: "AQAB" };

describe("API security draft", () => {
  it("round-trips the default settings with every check and discovery off", () => {
    expect(parseApiSecurityDraft(apiSecurityDraft(API_SECURITY_DEFAULTS))).toEqual({
      success: true,
      settings: API_SECURITY_DEFAULTS,
    });
  });

  it("reads text lists without splitting an audience at a comma and preserves policy data", () => {
    const draft = apiSecurityDraft(API_SECURITY_DEFAULTS);
    draft.jwt.mode = "observe";
    draft.jwt.issuer = "https://issuer.example.test";
    draft.jwt.audiences = "urn:app,one\n urn:app:two \n";
    draft.jwt.jwks = JSON.stringify({ keys: [publicKey] });
    draft.jwt.scope.pathPrefixes = "/private/\n /admin/";
    draft.jwt.scope.extensions = "json, csv";
    draft.schema.endpoints = [{ method: "GET", path: "/items/{id}", parameters: [] }];
    draft.exceptions = [
      {
        id: "11111111-1111-4111-8111-111111111111",
        enabled: false,
        method: "GET",
        path: "/items/{id}",
        check: "schema",
        reason: "Compatibility",
      },
    ];
    const parsed = parseApiSecurityDraft(draft);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.settings.jwt.audiences).toEqual(["urn:app,one", "urn:app:two"]);
    expect(parsed.settings.jwt.scope.pathPrefixes).toEqual(["/private/", "/admin/"]);
    expect(parsed.settings.jwt.scope.extensions).toEqual(["json", "csv"]);
    expect(parsed.settings.schema.endpoints).toEqual(draft.schema.endpoints);
    expect(parsed.settings.exceptions).toEqual(draft.exceptions);
  });

  it("keeps import issues in observe and refuses enforce while they remain", () => {
    const draft = apiSecurityDraft(API_SECURITY_DEFAULTS);
    draft.schema = {
      ...draft.schema,
      mode: "observe",
      issues: [
        { location: "/paths/~1items/get/parameters/0/schema/format", code: "unsupported-keyword" },
      ],
    };
    const observed = parseApiSecurityDraft(draft);
    expect(observed.success && observed.settings.schema.issues).toEqual(draft.schema.issues);
    draft.schema = { ...draft.schema, mode: "enforce" };
    expect(parseApiSecurityDraft(draft)).toMatchObject({ success: false, code: "schemaIssues" });
  });

  it("does not turn an empty numeric input into a valid zero", () => {
    const draft = apiSecurityDraft(API_SECURITY_DEFAULTS);
    draft.graphql.maxAliases = "";
    expect(parseApiSecurityDraft(draft)).toEqual({
      success: false,
      code: "invalid",
      field: "graphql.maxAliases",
    });
    draft.graphql.maxAliases = "0";
    expect(parseApiSecurityDraft(draft).success).toBe(true);
  });

  it("requires issuer, audiences and keys before JWT observation", () => {
    const draft = apiSecurityDraft(API_SECURITY_DEFAULTS);
    draft.jwt.mode = "observe";
    expect(parseApiSecurityDraft(draft)).toMatchObject({ success: false, field: "jwt" });
  });
});

describe("public JWKS editor", () => {
  it("accepts only the public key structure the contract can save", () => {
    expect(parsePublicJwks(JSON.stringify({ keys: [publicKey] }))).toEqual({
      success: true,
      keys: [publicKey],
    });
    expect(parsePublicJwks("{")).toEqual({ success: false, code: "jwks" });
    expect(parsePublicJwks(JSON.stringify({ keys: [{ ...publicKey, use: "sig" }] }))).toEqual({
      success: false,
      code: "jwks",
    });
  });

  it("refuses private and symmetric material instead of selecting public fields", () => {
    for (const name of ["d", "p", "q", "dp", "dq", "qi", "oth", "k"]) {
      expect(
        parsePublicJwks(JSON.stringify({ keys: [{ ...publicKey, [name]: "not-a-real-key" }] })),
      ).toEqual({ success: false, code: "privateKey" });
    }
    const draft = apiSecurityDraft(API_SECURITY_DEFAULTS);
    draft.jwt.jwks = JSON.stringify({ keys: [{ ...publicKey, d: "not-a-real-key" }] });
    expect(parseApiSecurityDraft(draft)).toMatchObject({ success: false, code: "privateKey" });
  });
});
