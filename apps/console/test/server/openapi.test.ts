import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { createTestContext } from "./helpers";

/** Procedures anyone may call: the first-run setup. */
const PUBLIC_OPERATIONS = ["system.status", "system.setup"];

type Schema = {
  enum?: unknown[];
  properties?: Record<string, Schema>;
  items?: Schema;
  default?: unknown;
  maximum?: number;
  maxItems?: number;
};
type Operation = {
  operationId: string;
  security?: Record<string, string[]>[];
  parameters?: { name: string; in: string }[];
  requestBody?: { content: Record<string, { schema: Schema }> };
};
type Spec = {
  security?: Record<string, string[]>[];
  paths: Record<string, Record<string, Operation>>;
};

describe("OpenAPI security requirements", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  afterAll(() => client.close());

  const spec = (await (await app.request(`${origin}/api/v1/openapi.json`)).json()) as Spec;
  const operations = Object.entries(spec.paths).flatMap(([path, methods]) =>
    Object.entries(methods).map(([method, op]) => ({ path, method, op })),
  );

  it("requires the API key by default and not for public procedures", () => {
    expect(spec.security).toEqual([{ apiKey: [] }]);
    const publicIds = operations
      .filter(({ op }) => op.security !== undefined && op.security.length === 0)
      .map(({ op }) => op.operationId)
      .sort();
    expect(publicIds).toEqual([...PUBLIC_OPERATIONS].sort());
    for (const { op } of operations) {
      if (!PUBLIC_OPERATIONS.includes(op.operationId)) {
        expect(op.security, op.operationId).toBeUndefined();
      }
    }
  });

  it("documents the error page routes, the new cache task inputs and the request id filter", () => {
    const routes = operations.map(({ path, method, op }) => `${method} ${path} ${op.operationId}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        "get /sites/{id}/error-pages errorPages.get",
        "put /sites/{id}/error-pages errorPages.update",
        "get /settings/error-pages settings.errorPages",
        "put /settings/error-pages settings.setErrorPages",
      ]),
    );
    const body = (path: string, method: string) =>
      spec.paths[path]?.[method]?.requestBody?.content["application/json"]?.schema;
    const task = body("/cache-tasks", "post")?.properties ?? {};
    expect(task.type?.enum).toEqual([
      "url",
      "prefix",
      "site",
      "prefetch",
      "host",
      "tag",
      "sitemap",
    ]);
    expect(task.hosts?.maxItems).toBe(500);
    expect(task.tags?.maxItems).toBe(500);
    expect(task.variants).toMatchObject({
      default: ["desktop"],
      items: { enum: ["desktop", "mobile"] },
    });
    expect(task.maxUrls).toMatchObject({ default: 1000, maximum: 10000 });
    expect(
      body("/sites/{id}/error-pages", "put")?.properties?.pages?.items?.properties?.status?.enum,
    ).toEqual([403, 429, 502, 503, 504]);
    expect(Object.keys(body("/settings/error-pages", "put")?.properties ?? {})).toEqual([
      "unknownHost",
      "siteDisabled",
    ]);
    expect(
      spec.paths["/sites/{siteId}/logs"]?.get?.parameters?.map((parameter) => parameter.name),
    ).toContain("requestId");
  });

  it("documents the bulk redirect routes and the rules.validate kinds", () => {
    const routes = operations.map(({ path, method, op }) => `${method} ${path} ${op.operationId}`);
    expect(routes).toEqual(
      expect.arrayContaining([
        "get /sites/{id}/bulk-redirects bulkRedirects.get",
        "put /sites/{id}/bulk-redirects bulkRedirects.save",
      ]),
    );
    const body = (path: string, method: string) =>
      spec.paths[path]?.[method]?.requestBody?.content["application/json"]?.schema;
    expect(body("/sites/{id}/bulk-redirects", "put")?.properties?.redirects?.maxItems).toBe(5000);
    expect(body("/rules/validate", "post")?.properties?.kind).toMatchObject({
      default: "condition",
      enum: ["condition", "value", "cacheRule"],
    });
  });

  it("matches what the API enforces without credentials", async () => {
    const uuid = "00000000-0000-4000-8000-000000000000";
    for (const { path, method, op } of operations) {
      const url = `${origin}/api/v1${path.replace(/\{[^}]+\}/g, uuid)}`;
      const res = await app.request(url, {
        method: method.toUpperCase(),
        headers: { "content-type": "application/json" },
        body: method === "get" || method === "delete" ? undefined : "{}",
      });
      if (PUBLIC_OPERATIONS.includes(op.operationId)) {
        expect(res.status, op.operationId).not.toBe(401);
      } else {
        expect(res.status, op.operationId).toBe(401);
      }
    }
  });
});
