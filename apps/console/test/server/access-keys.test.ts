import { schema } from "@edgeweir/db";
import { and, desc, eq } from "drizzle-orm";
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
  it("gives a new key 600 requests per minute unless it names another limit", async () => {
    const plain = await admin.accessKeys.create({ name: "default-limit" });
    const custom = await admin.accessKeys.create({ name: "custom-limit", requestsPerMinute: 5000 });
    const open = await admin.accessKeys.create({ name: "no-limit", requestsPerMinute: null });
    expect([plain, custom, open].map((k) => k.requestsPerMinute)).toEqual([600, 5000, null]);
    const listed = new Map((await admin.accessKeys.list()).map((k) => [k.id, k.requestsPerMinute]));
    expect([listed.get(plain.id), listed.get(custom.id), listed.get(open.id)]).toEqual([
      600,
      5000,
      null,
    ]);
    // Written to the plugin's own columns, which it checks on every request.
    const rows = new Map(
      (await ctx.db.select().from(schema.apikey)).map((row) => [row.id, row] as const),
    );
    expect(rows.get(custom.id)).toMatchObject({
      rateLimitEnabled: true,
      rateLimitMax: 5000,
      rateLimitTimeWindow: 60_000,
    });
    expect(rows.get(open.id)?.rateLimitEnabled).toBe(false);
    const [audit] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, "api_key.create"), eq(schema.auditLog.targetId, open.id)),
      );
    expect(audit?.metadata).toMatchObject({ requestsPerMinute: null });
    for (const key of [plain, custom, open]) await admin.accessKeys.revoke({ id: key.id });
  });

  it("lists keys created before the setting at 600 requests per minute", async () => {
    const key = await admin.accessKeys.create({ name: "older", requestsPerMinute: 10 });
    // The columns every key got from the plugin's defaults before.
    await ctx.db
      .update(schema.apikey)
      .set({ rateLimitEnabled: true, rateLimitMax: 600, rateLimitTimeWindow: 60_000 })
      .where(eq(schema.apikey.id, key.id));
    expect((await admin.accessKeys.list()).find((k) => k.id === key.id)?.requestsPerMinute).toBe(
      600,
    );
    await admin.accessKeys.revoke({ id: key.id });
  });

  it("changes a key's name and limit and audits both values", async () => {
    const key = await admin.accessKeys.create({ name: "tuned", scope: "read" });
    const raised = await admin.accessKeys.update({ id: key.id, requestsPerMinute: 20_000 });
    expect(raised).toMatchObject({
      id: key.id,
      name: "tuned",
      scope: "read",
      requestsPerMinute: 20_000,
    });
    const lifted = await admin.accessKeys.update({
      id: key.id,
      name: "tuned-2",
      requestsPerMinute: null,
    });
    expect(lifted).toMatchObject({ name: "tuned-2", requestsPerMinute: null });
    const renamed = await admin.accessKeys.update({ id: key.id, name: "tuned-3" });
    expect(renamed).toMatchObject({ name: "tuned-3", requestsPerMinute: null });
    expect((await admin.accessKeys.list()).find((k) => k.id === key.id)).toMatchObject({
      name: "tuned-3",
      requestsPerMinute: null,
    });
    const entries = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(eq(schema.auditLog.action, "api_key.update"), eq(schema.auditLog.targetId, key.id)),
      )
      .orderBy(desc(schema.auditLog.id));
    expect(entries.map((e) => e.metadata)).toEqual([
      {
        from: { name: "tuned-2", requestsPerMinute: null },
        to: { name: "tuned-3", requestsPerMinute: null },
      },
      {
        from: { name: "tuned", requestsPerMinute: 20_000 },
        to: { name: "tuned-2", requestsPerMinute: null },
      },
      {
        from: { name: "tuned", requestsPerMinute: 600 },
        to: { name: "tuned", requestsPerMinute: 20_000 },
      },
    ]);
    expect(entries[0]).toMatchObject({ targetType: "api_key", targetName: "tuned-3" });
    expect(JSON.stringify(entries)).not.toContain(key.key);

    expect((await rpcError(admin.accessKeys.update({ id: "missing", name: "x" }))).code).toBe(
      "ACCESS_KEY_NOT_FOUND",
    );
    await admin.accessKeys.revoke({ id: key.id });
    expect(
      (await rpcError(admin.accessKeys.update({ id: key.id, requestsPerMinute: 5 }))).code,
    ).toBe("ACCESS_KEY_REVOKED");
  });

  it("lets only the signed-in operator change a key's limit", async () => {
    const key = await admin.accessKeys.create({ name: "self-raise", requestsPerMinute: 5 });
    const denied = await api(key.key, "PATCH", `/access-keys/${key.id}`, {
      requestsPerMinute: null,
    });
    expect(denied.status).toBe(403);
    expect(await denied.json()).toMatchObject({ code: "ACCESS_KEY_SESSION_REQUIRED" });
    expect((await admin.accessKeys.list()).find((k) => k.id === key.id)?.requestsPerMinute).toBe(5);
    const invalid = await api(key.key, "PATCH", `/access-keys/${key.id}`, { requestsPerMinute: 0 });
    expect(invalid.status).toBe(400);
    await admin.accessKeys.revoke({ id: key.id });
  });

  it("answers 429 over a key's own limit and never for an unlimited key", async () => {
    const limited = await admin.accessKeys.create({
      name: "three",
      scope: "read",
      requestsPerMinute: 3,
    });
    for (let i = 0; i < 3; i++) expect((await api(limited.key, "GET", "/sites")).status).toBe(200);
    const over = await api(limited.key, "GET", "/sites");
    expect(over.status).toBe(429);
    expect(await over.json()).toMatchObject({ code: "API_KEY_RATE_LIMITED" });

    // A new limit starts a fresh count.
    await admin.accessKeys.update({ id: limited.id, requestsPerMinute: 4 });
    for (let i = 0; i < 4; i++) expect((await api(limited.key, "GET", "/sites")).status).toBe(200);
    expect((await api(limited.key, "GET", "/sites")).status).toBe(429);

    // Lifting the limit lets the same key through at once.
    await admin.accessKeys.update({ id: limited.id, requestsPerMinute: null });
    expect((await api(limited.key, "GET", "/sites")).status).toBe(200);

    const open = await admin.accessKeys.create({
      name: "open",
      scope: "read",
      requestsPerMinute: null,
    });
    // Far past the default limit within the minute.
    await ctx.db
      .update(schema.apikey)
      .set({ requestCount: 1_000_000, lastRequest: new Date() })
      .where(eq(schema.apikey.id, open.id));
    for (let i = 0; i < 3; i++) expect((await api(open.key, "GET", "/sites")).status).toBe(200);
    for (const key of [limited, open]) await admin.accessKeys.revoke({ id: key.id });
  });
});
