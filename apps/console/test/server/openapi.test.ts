import { afterAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { createTestContext } from "./helpers";

/** Procedures anyone may call: first-run setup and invitation links. */
const PUBLIC_OPERATIONS = [
  "system.status",
  "system.setup",
  "invitations.get",
  "invitations.accept",
];

type Operation = { operationId: string; security?: Record<string, string[]>[] };
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
