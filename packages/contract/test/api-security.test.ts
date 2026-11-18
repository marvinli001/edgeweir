import { describe, expect, it } from "vitest";
import {
  API_SECURITY_DEFAULTS,
  apiPath,
  apiSchema,
  apiSecurityLog,
  apiSecuritySettings,
} from "../src/api-security";

describe("API security policy boundary", () => {
  it("rejects unpaired Unicode that node parsers would replace", () => {
    const settings = structuredClone(API_SECURITY_DEFAULTS);
    settings.jwt.issuer = "\ud800";
    expect(apiSecuritySettings.safeParse(settings).success).toBe(false);
    settings.jwt.issuer = "https://issuer.test/😀";
    expect(apiSecuritySettings.safeParse(settings).success).toBe(true);
    expect(apiSchema.safeParse({ type: "string", enum: ["\ud800"] }).success).toBe(false);
  });
  it("starts disabled and keeps candidates separate from enforcement", () => {
    const settings = apiSecuritySettings.parse(API_SECURITY_DEFAULTS);
    expect(settings.discovery.enabled).toBe(false);
    expect([settings.schema.mode, settings.jwt.mode, settings.graphql.mode]).toEqual([
      "off",
      "off",
      "off",
    ]);
    expect(settings.schema.unknownEndpoints).toBe("allow");
  });

  it("rejects unsupported schema keywords and limits recursion before parsing", () => {
    expect(apiSchema.safeParse({ type: "string", pattern: ".*" }).success).toBe(false);
    let schema: unknown = { type: "string" };
    for (let i = 0; i < 10000; i++) schema = { type: "array", items: schema };
    expect(apiSchema.safeParse(schema).success).toBe(false);
    const recursive: Record<string, unknown> = { type: "array" };
    recursive.items = recursive;
    expect(apiSchema.safeParse(recursive).success).toBe(false);
  });

  it("rejects private keys and refuses enforcement after incomplete import", () => {
    const settings = structuredClone(API_SECURITY_DEFAULTS);
    settings.schema.mode = "enforce";
    settings.schema.issues = [{ location: "#/paths/~1items/post", code: "unsupported-keyword" }];
    expect(apiSecuritySettings.safeParse(settings).success).toBe(false);
    const privateKey = {
      kid: "test",
      alg: "EdDSA",
      kty: "OKP",
      crv: "Ed25519",
      x: "public",
      d: "private",
    };
    expect(
      apiSecuritySettings.safeParse({
        ...API_SECURITY_DEFAULTS,
        jwt: { ...API_SECURITY_DEFAULTS.jwt, keys: [privateKey] },
      }).success,
    ).toBe(false);
  });

  it("accepts canonical templates and rejects ambiguous exception paths", () => {
    expect(apiPath.safeParse("/api/items/{id}").success).toBe(true);
    for (const path of [
      "//api",
      "/api/../private",
      "/api/%2fprivate",
      "/api;x/private",
      "/api?key=secret",
    ])
      expect(apiPath.safeParse(path).success).toBe(false);
  });

  it("only accepts redacted, bounded log metadata", () => {
    expect(
      apiSecurityLog.safeParse({
        template: "/api/{id}",
        source: "traffic",
        issues: [],
        exceptionIds: [],
      }).success,
    ).toBe(true);
    expect(
      apiSecurityLog.safeParse({
        template: "/api/{id}",
        source: "traffic",
        issues: [],
        exceptionIds: [],
        authorization: "secret",
      }).success,
    ).toBe(false);
  });
});
