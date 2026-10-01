import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("stored rules the validator no longer accepts", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let siteId: string;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    siteId = (
      await admin.sites.create({
        name: "legacy",
        domains: ["legacy.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
  });
  afterAll(() => pglite.close());

  it("refuses to publish with RULE_INVALID instead of failing with a server error", async () => {
    // Accepted by the validator of earlier versions; \s now reads differently per engine.
    await ctx.db.insert(schema.edgeRule).values({
      siteId,
      name: "legacy-space",
      phase: "waf-custom",
      expression: 'http.request.uri.path matches "^/a\\\\s"',
      priority: 1,
      action: { kind: "block", statusCode: 403 },
    });
    const error = await rpcError(admin.sites.update({ id: siteId, name: "legacy-2" }));
    expect(error.code).toBe("RULE_INVALID");
    expect(error.status).toBe(400);
    expect(error.message).toContain("legacy-space");
  });
});
