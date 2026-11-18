import { generateKeyPairSync } from "node:crypto";
import { API_SECURITY_DEFAULTS, type ApiSchema } from "@edgeweir/contract";
import { describe, expect, it } from "vitest";
import { validateApiSecurity } from "../../src/server/lib/api-security";

describe("API security input boundary", () => {
  const settings = () => structuredClone(API_SECURITY_DEFAULTS);
  it("rejects ambiguous paths and missing or repeated path parameters", () => {
    const value = settings();
    value.schema.endpoints = ["id", "name"].map((name) => ({
      method: "GET",
      path: `/api/users/{${name}}`,
      parameters: [{ in: "path", name, required: true, schema: { type: "integer" } }],
    }));
    expect(() => validateApiSecurity(value)).toThrow();
    value.schema.endpoints = ["/api/{x}/me", "/api/users/{y}"].map((path) => ({
      method: "GET",
      path,
      parameters: [
        {
          in: "path",
          name: path.includes("{x}") ? "x" : "y",
          required: true,
          schema: { type: "string" },
        },
      ],
    }));
    expect(() => validateApiSecurity(value)).toThrow();
    value.schema.endpoints = [{ method: "GET", path: "/api/users/{id}", parameters: [] }];
    expect(() => validateApiSecurity(value)).toThrow();
  });

  it("rejects unsupported import issues in enforce and budgets schema before recursive parsing", () => {
    const value = settings();
    value.schema.mode = "enforce";
    value.schema.issues = [{ location: "#/unsupported", code: "unsupported-constraint" }];
    expect(() => validateApiSecurity(value)).toThrow();
    value.schema.mode = "observe";
    expect(validateApiSecurity(value).schema.issues).toHaveLength(1);
    let schema: ApiSchema = { type: "string" };
    for (let i = 0; i < 10000; i++) schema = { type: "array", items: schema };
    value.schema.endpoints = [
      { method: "POST", path: "/api", parameters: [], body: { required: true, schema } },
    ];
    expect(() => validateApiSecurity(value)).toThrow(
      expect.objectContaining({ code: "API_SECURITY_INVALID" }),
    );
    schema = { type: "array" };
    schema.items = schema;
    if (value.schema.endpoints[0]?.body) value.schema.endpoints[0].body.schema = schema;
    expect(() => validateApiSecurity(value)).toThrow(
      expect.objectContaining({ code: "API_SECURITY_INVALID" }),
    );
  });

  it("accepts valid RSA, P-256 and Ed25519 public keys and rejects private material or algorithm confusion", () => {
    const keys = [
      { alg: "RS256", ...generateKeyPairSync("rsa", { modulusLength: 2048 }) },
      { alg: "ES256", ...generateKeyPairSync("ec", { namedCurve: "prime256v1" }) },
      { alg: "EdDSA", ...generateKeyPairSync("ed25519") },
    ] as const;
    for (const [index, key] of keys.entries()) {
      const value = settings();
      value.jwt.mode = "enforce";
      value.jwt.issuer = "https://issuer.example.test";
      value.jwt.audiences = ["service"];
      value.jwt.algorithms = [key.alg];
      value.jwt.keys = [
        { ...key.publicKey.export({ format: "jwk" }), kid: `key-${index}`, alg: key.alg },
      ] as typeof value.jwt.keys;
      expect(validateApiSecurity(value).jwt.keys).toHaveLength(1);
      const mixed = structuredClone(value);
      if (mixed.jwt.keys[0]) mixed.jwt.keys[0].kty = key.alg === "RS256" ? "EC" : "RSA";
      expect(() => validateApiSecurity(mixed)).toThrow();
      value.jwt.keys = [
        { ...key.privateKey.export({ format: "jwk" }), kid: "private", alg: key.alg },
      ] as typeof value.jwt.keys;
      expect(() => validateApiSecurity(value)).toThrow();
    }
    const short = settings();
    short.jwt.keys = [
      {
        ...generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "jwk" }),
        kid: "short",
        alg: "RS256",
      },
    ] as typeof short.jwt.keys;
    expect(() => validateApiSecurity(short)).toThrow();
  });
});
