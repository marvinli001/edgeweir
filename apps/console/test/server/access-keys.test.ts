import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
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

describe("M6 AccessKey scope, revocation and auth boundaries", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
  });
  afterAll(() => db.close());
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  it("creates a read-only key, records its use, and blocks every mutation surface", async () => {
    const key = await admin.accessKeys.create({ name: "readonly", scope: "read" });
    expect(key.key).toMatch(/^ewk_/);
    expect(key.lastUsedAt).toBeNull();
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    const denied = await api(key.key, "POST", "/sites", {
      name: "no",
      domains: ["no.test"],
      origins: [{ address: "origin.test" }],
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    expect(
      (await api(key.key, "POST", "/access-keys", { name: "elevated", scope: "write" })).status,
    ).toBe(403);
    const auth = await app.request(`${origin}/api/auth/api-key/create`, {
      method: "POST",
      headers: { "x-api-key": key.key, origin, "content-type": "application/json" },
      body: JSON.stringify({ name: "via-auth" }),
    });
    expect(auth.status).toBe(404);
    expect((await admin.accessKeys.list()).find((k) => k.id === key.id)?.lastUsedAt).not.toBeNull();
    expect(JSON.stringify(await admin.accessKeys.list())).not.toContain(key.key);
    expect((await rpcError(admin.accessKeys.revoke({ id: "missing" }))).code).toBe(
      "ACCESS_KEY_NOT_FOUND",
    );
    await admin.accessKeys.revoke({ id: key.id });
    expect((await api(key.key, "GET", "/sites")).status).toBe(401);
    expect((await admin.accessKeys.list()).find((k) => k.id === key.id)?.enabled).toBe(false);
  });
  it("allows a read-write key and keeps pre-M6 keys compatible", async () => {
    const key = await admin.accessKeys.create({ name: "writer", scope: "write" });
    const count = (await admin.accessKeys.list()).length;
    const denied = await api(key.key, "POST", "/access-keys", { name: "new", scope: "write" });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "ACCESS_KEY_SESSION_REQUIRED" });
    expect((await admin.accessKeys.list()).length).toBe(count);
    expect(
      (
        await api(key.key, "POST", "/sites", {
          name: "write",
          domains: ["write-key.test"],
          origins: [{ address: "origin.test" }],
        })
      ).status,
    ).toBe(201);
    await ctx.db
      .update(schema.apikey)
      .set({ permissions: null })
      .where(eq(schema.apikey.id, key.id));
    expect(
      (await api(key.key, "POST", "/access-keys", { name: "legacy-new", scope: "read" })).status,
    ).toBe(403);
    expect(
      (
        await api(key.key, "POST", "/sites", {
          name: "legacy",
          domains: ["legacy-key.test"],
          origins: [{ address: "origin.test" }],
        })
      ).status,
    ).toBe(201);
    await ctx.db
      .update(schema.apikey)
      .set({ permissions: "invalid-json" })
      .where(eq(schema.apikey.id, key.id));
    expect(
      (
        await api(key.key, "POST", "/sites", {
          name: "malformed",
          domains: ["malformed.test"],
          origins: [{ address: "origin.test" }],
        })
      ).status,
    ).toBe(403);
    await admin.accessKeys.revoke({ id: key.id });
  });
  it("answers a key over its request limit with 429, not as invalid credentials", async () => {
    const key = await admin.accessKeys.create({ name: "busy", scope: "read" });
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    const [row] = await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, key.id));
    await ctx.db
      .update(schema.apikey)
      .set({ requestCount: row?.rateLimitMax ?? 600, lastRequest: new Date() })
      .where(eq(schema.apikey.id, key.id));
    const limited = await api(key.key, "GET", "/sites");
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { code: string; data: { retryAfterSeconds: number } };
    expect(body).toMatchObject({ code: "API_KEY_RATE_LIMITED" });
    expect(body.data.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.data.retryAfterSeconds).toBeLessThanOrEqual(60);
    // The count starts over once the key has been idle for the window.
    await ctx.db
      .update(schema.apikey)
      .set({ lastRequest: new Date(Date.now() - 61_000) })
      .where(eq(schema.apikey.id, key.id));
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    await admin.accessKeys.revoke({ id: key.id });
  });
});
