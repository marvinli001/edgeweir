import { describe, expect, it } from "vitest";
import { importOpenApi } from "../../src/server/services/api-security-openapi";

const doc = (schema: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    openapi: "3.0.3",
    info: { title: "API", version: "1" },
    paths: {
      "/api/users": {
        post: {
          requestBody: {
            required: true,
            content: { "application/json": { schema } },
          },
        },
      },
    },
    ...extra,
  });

describe("bounded OpenAPI JSON importer", () => {
  it("locates Unicode constraints the node would otherwise normalize differently", () => {
    const imported = importOpenApi(doc({ type: "string", enum: ["\ud800"] }));
    expect(imported.issues.some((issue) => issue.location.endsWith("/enum/0"))).toBe(true);
  });
  it("reports overlapping templates with the same specificity", () => {
    const imported = importOpenApi(
      JSON.stringify({
        openapi: "3.1.0",
        paths: Object.fromEntries(
          ["/api/{x}/me", "/api/users/{y}"].map((path) => [
            path,
            {
              get: {
                parameters: [
                  {
                    in: "path",
                    name: path.includes("{x}") ? "x" : "y",
                    required: true,
                    schema: { type: "string" },
                  },
                ],
              },
            },
          ]),
        ),
      }),
    );
    expect(imported.issues.some((issue) => issue.code === "ambiguous-path-template")).toBe(true);
    expect(imported.endpoints).toHaveLength(1);
  });
  it("reports numeric precision loss and oversized exponents at the constraint location", () => {
    for (const literal of ["9007199254740993", "0.10000000000000001", "1e-100000000", "1e999"]) {
      const imported = importOpenApi(
        doc({ type: "number", minimum: "raw-number" }).replace('"raw-number"', literal),
      );
      expect(imported.issues.some((issue) => issue.location.endsWith("/minimum"))).toBe(true);
    }
    expect(importOpenApi(doc({ type: "number", minimum: 0.1, maximum: 0.3 })).issues).toEqual([]);
  });
  it.each(["3.0.0", "3.0.4", "3.1.0", "3.1.2"])(
    "imports the supported schema subset for %s",
    (openapi) => {
      const imported = importOpenApi(
        doc(
          {
            type: "object",
            additionalProperties: false,
            required: ["name", "active"],
            properties: {
              name: { type: "string", minLength: 1, maxLength: 40, enum: ["Alice", "Bob"] },
              age: { type: "integer", minimum: 0, maximum: 150 },
              active: { type: "boolean" },
              tags: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" } },
            },
          },
          { openapi },
        ),
      );
      expect(imported.issues).toEqual([]);
      expect(imported.openapiVersion).toBe(openapi);
      expect(imported.endpoints[0]?.body?.schema.properties?.tags?.items).toEqual({
        type: "string",
      });
    },
  );

  it("merges path parameters and lets operation parameters override by name and location", () => {
    const imported = importOpenApi(
      JSON.stringify({
        openapi: "3.1.0",
        components: {
          parameters: {
            User: {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "integer" },
            },
          },
          schemas: { "A/B~C": { type: "string", maxLength: 10 } },
        },
        paths: {
          "/api/users/{id}": {
            parameters: [
              { $ref: "#/components/parameters/User" },
              {
                in: "query",
                name: "page",
                schema: { type: "integer", minimum: 0 },
              },
            ],
            get: {
              parameters: [
                { in: "query", name: "page", schema: { type: "integer", minimum: 1 } },
                { in: "header", name: "X-Name", schema: { $ref: "#/components/schemas/A~1B~0C" } },
              ],
            },
          },
        },
      }),
    );
    expect(imported.issues).toEqual([]);
    expect(imported.endpoints[0]?.parameters).toEqual([
      { in: "path", name: "id", required: true, schema: { type: "integer" } },
      { in: "query", name: "page", required: false, schema: { type: "integer", minimum: 1 } },
      { in: "header", name: "X-Name", required: false, schema: { type: "string", maxLength: 10 } },
    ]);
  });

  it.each([
    "pattern",
    "format",
    "allOf",
    "oneOf",
    "anyOf",
    "not",
    "multipleOf",
    "uniqueItems",
    "readOnly",
  ])("reports %s instead of dropping the constraint", (keyword) => {
    const imported = importOpenApi(doc({ type: "string", [keyword]: "unsupported" }));
    expect(imported.issues).toContainEqual({
      location: `#/paths/~1api~1users/post/requestBody/content/application~1json/schema/${keyword}`,
      code: "unsupported-constraint",
    });
  });

  it("reports external refs, cycles and ref siblings at their use site", () => {
    expect(importOpenApi(doc({ $ref: "https://example.test/schema.json" })).issues[0]?.code).toBe(
      "external-reference",
    );
    const cycle = importOpenApi(
      doc(
        { $ref: "#/components/schemas/Cycle" },
        {
          components: {
            schemas: {
              Cycle: {
                type: "object",
                properties: {
                  again: { $ref: "#/components/schemas/Cycle" },
                },
              },
            },
          },
        },
      ),
    );
    expect(cycle.issues.some((entry) => entry.code === "reference-cycle")).toBe(true);
    const sibling = importOpenApi(
      doc(
        { $ref: "#/components/schemas/S", maxLength: 2 },
        {
          components: { schemas: { S: { type: "string" } } },
        },
      ),
    );
    expect(sibling.issues.some((entry) => entry.code === "reference-sibling-unsupported")).toBe(
      true,
    );
  });

  it("bounds reference depth, schema depth, expansion and document bytes", () => {
    const schemas: Record<string, unknown> = { end: { type: "string" } };
    for (let i = 40; i >= 0; i--)
      schemas[String(i)] = { $ref: `#/components/schemas/${i === 40 ? "end" : i + 1}` };
    expect(
      importOpenApi(
        doc({ $ref: "#/components/schemas/0" }, { components: { schemas } }),
      ).issues.some((entry) => entry.code === "reference-depth"),
    ).toBe(true);
    let nested: unknown = { type: "string" };
    for (let i = 0; i < 10; i++) nested = { type: "array", items: nested };
    expect(importOpenApi(doc(nested)).issues.some((entry) => entry.code === "schema-budget")).toBe(
      true,
    );
    const properties = Object.fromEntries(
      Array.from({ length: 2001 }, (_, i) => [`p${i}`, { type: "string" }]),
    );
    expect(
      importOpenApi(doc({ type: "object", properties })).issues.some(
        (entry) => entry.code === "schema-budget",
      ),
    ).toBe(true);
    expect(() =>
      importOpenApi(doc({ type: "string" }, { description: "字".repeat(180000) })),
    ).toThrow();
  });

  it("reports unsupported operations, non-root server bases and request serialization", () => {
    const imported = importOpenApi(
      JSON.stringify({
        openapi: "3.0.3",
        servers: [{ url: "https://api.example.test/base" }],
        paths: {
          "/api/users/{id}": {
            trace: {},
            get: {
              parameters: [
                {
                  in: "query",
                  name: "filter",
                  schema: { type: "array", items: { type: "string" } },
                },
                { in: "header", name: "x-options", style: "form", schema: { type: "string" } },
              ],
            },
          },
        },
      }),
    );
    expect(imported.issues.map((entry) => entry.code)).toEqual(
      expect.arrayContaining([
        "server-base-path",
        "unsupported-operation",
        "scalar-parameter-required",
        "unsupported-serialization",
        "missing-path-parameter",
      ]),
    );
    const body = importOpenApi(
      doc(
        { type: "string" },
        {
          paths: {
            "/api/upload": {
              post: {
                requestBody: { content: { "multipart/form-data": { schema: { type: "string" } } } },
              },
            },
          },
        },
      ),
    );
    expect(body.issues.some((entry) => entry.code === "unsupported-media-type")).toBe(true);
  });

  it("reports every operation beyond the endpoint limit and rejects YAML or unsupported versions", () => {
    const paths = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`/api/p${i}`, { get: {} }]),
    );
    const imported = importOpenApi(JSON.stringify({ openapi: "3.1.0", paths }));
    expect(imported.endpoints).toHaveLength(200);
    expect(imported.issues).toContainEqual({
      location: "#/paths/~1api~1p200/get",
      code: "endpoint-limit",
    });
    for (const document of [
      "openapi: 3.0.0",
      '{"openapi":"2.0","paths":{}}',
      "[]",
      '{"openapi":"3.1.0","paths":{},"paths":{"/hidden":{"get":{}}}}',
      '{"openapi":"3.1.0","paths":{},"\\u0070aths":{}}',
    ])
      expect(() => importOpenApi(document)).toThrow();
  });
});
