import { randomBytes, randomUUID } from "node:crypto";
import { integrationAuthorizationResult } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import {
  grantIntegrationAuthorization,
  INTEGRATION_GRANT_KEY,
} from "../../src/server/services/integration-authorization";
import { createTestContext, setupPlatform } from "./helpers";

describe("explicit local integration authorization", async () => {
  const { ctx, client } = await createTestContext();
  await setupPlatform(ctx);
  const originalUsers = await ctx.db.select().from(schema.user);
  const originalAccounts = await ctx.db.select().from(schema.account);
  const originalClusters = await ctx.db.select().from(schema.cluster);
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const input = {
    installationId: randomUUID(),
    requestId: randomUUID(),
    token: randomBytes(32).toString("base64url"),
  };
  const call = (suffix = "", body = input, headers = {}) =>
    app.request(`${origin}/api/v1/system/authorize-integration${suffix}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const state = async () =>
    (
      await ctx.db
        .select()
        .from(schema.systemSetting)
        .where(eq(schema.systemSetting.key, INTEGRATION_GRANT_KEY))
    )[0]?.value;
  afterAll(() => client.close());

  it("requires the local deployment authorization, independently of ordinary API keys", async () => {
    expect((await call()).status).toBe(403);
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(0);
    await grantIntegrationAuthorization(ctx.pool, ctx.db, input);
    await grantIntegrationAuthorization(ctx.pool, ctx.db, input);
    await expect(
      grantIntegrationAuthorization(ctx.pool, ctx.db, { ...input, installationId: randomUUID() }),
    ).rejects.toMatchObject({ code: "BOOTSTRAP_CONFLICT" });
    expect(
      (await call("", { ...input, token: randomBytes(32).toString("base64url") })).status,
    ).toBe(403);
    expect((await call("", input, { "idempotency-key": randomUUID() })).status).toBe(400);
    expect(await ctx.db.select().from(schema.idempotencyKey)).toHaveLength(0);
  });

  it("expires unused authorization and rolls back failed credential delivery", async () => {
    const before = await state();
    await ctx.db
      .update(schema.systemSetting)
      .set({ value: { ...before, expiresAt: new Date(0).toISOString() } })
      .where(eq(schema.systemSetting.key, INTEGRATION_GRANT_KEY));
    expect((await call()).status).toBe(410);
    await ctx.db
      .update(schema.systemSetting)
      .set({ value: before ?? {} })
      .where(eq(schema.systemSetting.key, INTEGRATION_GRANT_KEY));
    const seal = vi.spyOn(ctx.masterKey, "seal").mockImplementation(() => {
      throw new Error("interrupted integration result");
    });
    try {
      expect((await call()).status).toBe(500);
    } finally {
      seal.mockRestore();
    }
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(0);
    expect((await state())?.envelope).toBeUndefined();
  });

  let keyId: string, key: string;
  it("replays one sealed result without modifying accounts, clusters or configuration", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    const result = integrationAuthorizationResult.parse(await response.json());
    keyId = result.accessKeyId;
    key = result.accessKey;
    expect(await (await call()).json()).toEqual(result);
    expect(JSON.stringify(await state())).not.toContain(key);
    expect(JSON.stringify(await state())).not.toContain(input.token);
    expect(await ctx.db.select().from(schema.user)).toEqual(originalUsers);
    expect(await ctx.db.select().from(schema.account)).toEqual(originalAccounts);
    expect(await ctx.db.select().from(schema.cluster)).toEqual(originalClusters);
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(1);
    expect(
      (
        await call(
          "",
          { ...input, token: randomBytes(32).toString("base64url") },
          { "x-api-key": key },
        )
      ).status,
    ).toBe(403);
    expect((await call("/acknowledge")).status).toBe(401);
    expect((await call("/acknowledge", input, { "x-api-key": key })).status).toBe(200);
    expect((await call("/acknowledge", input, { "x-api-key": key })).status).toBe(200);
    expect((await state())?.envelope).toBeUndefined();
    expect((await call()).status).toBe(409);
  });

  it("requires an explicit local renewal and revokes only the old integration key", async () => {
    const next = {
      ...input,
      requestId: randomUUID(),
      token: randomBytes(32).toString("base64url"),
    };
    await expect(grantIntegrationAuthorization(ctx.pool, ctx.db, next)).rejects.toMatchObject({
      code: "BOOTSTRAP_CONFLICT",
    });
    await grantIntegrationAuthorization(ctx.pool, ctx.db, next, true);
    const [old] = await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, keyId));
    expect(old?.enabled).toBe(false);
    const response = await call("", next);
    expect(response.status).toBe(200);
    const fresh = integrationAuthorizationResult.parse(await response.json());
    expect(fresh.accessKey).not.toBe(key);
    expect(await ctx.db.select().from(schema.user)).toEqual(originalUsers);
    expect(await ctx.db.select().from(schema.account)).toEqual(originalAccounts);
  });
});
