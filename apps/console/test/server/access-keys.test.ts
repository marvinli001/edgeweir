import { randomUUID } from "node:crypto";
import { defaultKeyHasher } from "@better-auth/api-key";
import { schema } from "@edgeweir/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { AccessKeyRateLimiter, hashAccessKey } from "../../src/server/services/access-keys";
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
  // The clock of the AccessKey request limits and last uses: tests move it forward.
  let clock = Date.now();
  ctx.accessKeyLimits = new AccessKeyRateLimiter(() => clock);
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
    // The rest of the key's 600 requests of this window.
    for (let i = 1; i < 600; i++) expect(ctx.accessKeyLimits.take(key.id, 600, 60_000)).toBeNull();
    clock += 20_000;
    const limited = await api(key.key, "GET", "/sites");
    expect(limited.status).toBe(429);
    const body = (await limited.json()) as { code: string; data: { retryAfterSeconds: number } };
    expect(body).toMatchObject({ code: "API_KEY_RATE_LIMITED" });
    expect(body.data.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.data.retryAfterSeconds).toBeLessThanOrEqual(60);
    // Until the window that began with the first request ends.
    expect(body.data.retryAfterSeconds).toBe(40);
    clock += 39_000;
    expect((await api(key.key, "GET", "/sites")).status).toBe(429);
    // The count starts over when the window ends, however busy the key was.
    clock += 1_000;
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    await admin.accessKeys.revoke({ id: key.id });
  });
  it("never refuses a key that stays under its limit, however long its traffic lasts", async () => {
    // 1 request per second against 600 per minute, for 11 minutes: past 600 requests in a row
    // without a minute's pause, which better-auth's own limit refused.
    const key = await admin.accessKeys.create({ name: "steady", scope: "read" });
    for (let second = 0; second < 660; second++) {
      const response = await api(key.key, "GET", "/clusters");
      if (response.status !== 200) expect({ second, status: response.status }).toBeNull();
      clock += 1_000;
    }
    // Exactly the limit: 10 per second (600 per minute) for 10 minutes; one more in a minute is
    // over it.
    let now = 0;
    const limiter = new AccessKeyRateLimiter(() => now);
    for (let i = 0; i < 6_000; i++, now += 100) expect(limiter.take("k", 600, 60_000)).toBeNull();
    now = 0;
    const refused = Array.from({ length: 601 }, () => limiter.take("other", 600, 60_000));
    expect(refused.slice(0, 600).every((wait) => wait === null)).toBe(true);
    expect(refused[600]).toBe(60_000);
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
    // Written to the plugin's own columns, which authenticateAccessKey reads on every request.
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
    // Far past the default limit within the window.
    for (let i = 0; i < 100_000; i++) ctx.accessKeyLimits.take(open.id, 600, 60_000);
    expect(ctx.accessKeyLimits.take(open.id, 600, 60_000)).not.toBeNull();
    for (let i = 0; i < 3; i++) expect((await api(open.key, "GET", "/sites")).status).toBe(200);
    for (const key of [limited, open]) await admin.accessKeys.revoke({ id: key.id });
  });
  it("stores keys as better-auth's defaultKeyHasher does and verifies the keys it creates", async () => {
    for (const sample of ["ewk_", "ewk_abc", `ewk_${"x".repeat(64)}`, "ünïcødé key"])
      expect(hashAccessKey(sample)).toBe(await defaultKeyHasher(sample));
    const key = await admin.accessKeys.create({ name: "hashed", scope: "read" });
    expect(key.key).toMatch(/^ewk_[A-Za-z]{64}$/);
    const [row] = await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, key.id));
    expect(row?.key).toBe(hashAccessKey(key.key));
    expect(row?.key).toBe(await defaultKeyHasher(key.key));
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    await admin.accessKeys.revoke({ id: key.id });
  });

  it("refuses wrong, disabled, expired and quota keys and keys of a deleted account", async () => {
    const key = await admin.accessKeys.create({ name: "guarded", scope: "read" });
    const status = async (value: string) => (await api(value, "GET", "/sites")).status;
    expect(await status(key.key)).toBe(200);
    const last = key.key.at(-1) === "a" ? "b" : "a";
    const [row] = await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, key.id));
    for (const wrong of [
      `ewx_${key.key.slice(4)}`, // another prefix
      key.key.slice(4), // no prefix
      `${key.key.slice(0, -1)}${last}`, // another key of the same form
      key.key.slice(0, -1), // shorter
      `${key.key}a`, // longer
      key.key.toUpperCase().replace("EWK_", "ewk_"), // another case
      row?.key ?? "", // the stored hash itself
      `${key.key.slice(0, 4)}${"A".repeat(64)}`,
    ]) {
      const response = await api(wrong, "GET", "/sites");
      expect(response.status).toBe(401);
      expect(response.headers.get("retry-after")).toBeNull();
    }
    const set = (values: Partial<typeof schema.apikey.$inferInsert>) =>
      ctx.db.update(schema.apikey).set(values).where(eq(schema.apikey.id, key.id));
    await set({ enabled: null });
    expect(await status(key.key)).toBe(401);
    await set({ enabled: true, expiresAt: new Date(clock - 1_000) });
    expect(await status(key.key)).toBe(401);
    await set({ expiresAt: new Date(clock + 3_600_000) });
    expect(await status(key.key)).toBe(200);
    // Usage quotas are not Edgeweir's: a key with one fails closed.
    await set({ expiresAt: null, remaining: 5 });
    expect(await status(key.key)).toBe(401);
    await set({ remaining: null });
    expect(await status(key.key)).toBe(200);
    await admin.accessKeys.revoke({ id: key.id });
    expect(await status(key.key)).toBe(401);

    // A key whose account is gone authenticates nobody.
    const userId = `user_${randomUUID()}`;
    await ctx.db
      .insert(schema.user)
      .values({ id: userId, name: "Gone", email: `${userId}@example.com` });
    const orphan = await ctx.auth.api.createApiKey({
      body: { userId, name: "orphan", permissions: { edgeweir: ["read"] } },
    });
    expect(await status(orphan.key)).toBe(200);
    await ctx.db.delete(schema.user).where(eq(schema.user.id, userId));
    expect(await status(orphan.key)).toBe(401);
    await ctx.db.delete(schema.apikey).where(eq(schema.apikey.id, orphan.id));
  });

  it("keeps a key's scope: read keys read, write keys write, none on /rpc", async () => {
    const reader = await admin.accessKeys.create({ name: "scope-read", scope: "read" });
    const writer = await admin.accessKeys.create({ name: "scope-write", scope: "write" });
    const site = (name: string) => ({
      name,
      domains: [`${name}.test`],
      origins: [{ address: "origin.test" }],
    });
    expect((await api(reader.key, "GET", "/clusters")).status).toBe(200);
    expect((await api(reader.key, "POST", "/sites", site("scope-read"))).status).toBe(403);
    expect((await api(writer.key, "POST", "/sites", site("scope-write"))).status).toBe(201);
    // A read key that is made a write key in the database writes; scope is read per request.
    await ctx.db
      .update(schema.apikey)
      .set({ permissions: JSON.stringify({ edgeweir: ["read", "write"] }) })
      .where(eq(schema.apikey.id, reader.id));
    expect((await api(reader.key, "POST", "/sites", site("scope-raised"))).status).toBe(201);
    await ctx.db
      .update(schema.apikey)
      .set({ permissions: JSON.stringify({ other: ["write"] }) })
      .where(eq(schema.apikey.id, reader.id));
    expect((await api(reader.key, "POST", "/sites", site("scope-other"))).status).toBe(403);
    expect((await api(reader.key, "GET", "/sites")).status).toBe(200);
    // Keys never work on /rpc.
    const rpc = await app.request(`${origin}/rpc/accessKeys/list`, {
      method: "POST",
      headers: {
        "x-api-key": writer.key,
        "x-csrf-token": "orpc",
        "content-type": "application/json",
      },
      body: JSON.stringify({ json: {} }),
    });
    expect(rpc.status).toBe(401);
    for (const key of [reader, writer]) await admin.accessKeys.revoke({ id: key.id });
  });

  it("records a key's last use at most once a minute", async () => {
    const key = await admin.accessKeys.create({ name: "last-use", scope: "read" });
    const lastUse = async () =>
      (
        await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, key.id))
      )[0]?.lastRequest?.getTime() ?? null;
    expect(await lastUse()).toBeNull();
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    const first = clock;
    expect(await lastUse()).toBe(first);
    clock += 59_000;
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    expect(await lastUse()).toBe(first);
    clock += 2_000;
    expect((await api(key.key, "GET", "/sites")).status).toBe(200);
    expect(await lastUse()).toBe(clock);
    // The request counter of better-auth's own limit is no longer kept.
    const [row] = await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, key.id));
    expect(row?.requestCount).toBe(0);
    await admin.accessKeys.revoke({ id: key.id });
  });
});
