import { randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type BootstrapResult, bootstrapResult } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { BOOTSTRAP_KEY, readBootstrapToken } from "../../src/server/services/bootstrap";
import { grantIntegrationAuthorization } from "../../src/server/services/integration-authorization";
import { ensureSetupToken } from "../../src/server/services/setup";
import { createTestContext, PASSWORD, rpcClient, setupPlatform } from "./helpers";

describe("private installer bootstrap", async () => {
  const folder = await mkdtemp(join(tmpdir(), "edgeweir-bootstrap-"));
  const file = join(folder, "capability"),
    token = randomBytes(32).toString("base64url");
  await writeFile(file, token, { mode: 0o600 });
  const { ctx, client } = await createTestContext({ EDGEWEIR_BOOTSTRAP_TOKEN_FILE: file });
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const input = { installationId: randomUUID(), requestId: randomUUID(), token };
  const call = (path: string, body = input, headers = {}) =>
    app.request(`${origin}/api/v1/system/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  const stored = async () =>
    (
      await ctx.db
        .select()
        .from(schema.systemSetting)
        .where(eq(schema.systemSetting.key, BOOTSTRAP_KEY))
    )[0]?.value;
  afterAll(async () => {
    await client.close();
    await rm(folder, { recursive: true });
  });

  it("refuses symlinks and readable-by-others capability files", async () => {
    const alias = join(folder, "alias");
    await symlink(file, alias);
    await expect(readBootstrapToken(alias)).rejects.toThrow();
    await chmod(file, 0o644);
    await expect(readBootstrapToken(file)).rejects.toThrow("private regular file");
    await chmod(file, 0o600);
    expect(await readBootstrapToken(file)).toBe(token);
  });

  it("rejects a wrong capability, the log setup path and generic idempotency storage", async () => {
    expect(
      (await call("bootstrap", { ...input, token: randomBytes(32).toString("base64url") })).status,
    ).toBe(403);
    const classic = await call("setup", {
      setupToken: await ensureSetupToken(ctx),
      name: "Wrong path",
      email: "wrong@example.test",
      password: PASSWORD,
    } as never);
    expect(classic.status).toBe(409);
    const cached = await call("bootstrap", input, { "idempotency-key": randomUUID() });
    expect(cached.status).toBe(400);
    expect(await ctx.db.select().from(schema.idempotencyKey)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.user)).toHaveLength(0);
  });

  it("rolls back the identity, default cluster and key on a failure before commit", async () => {
    const seal = vi.spyOn(ctx.masterKey, "seal").mockImplementation(() => {
      throw new Error("interrupted bootstrap transaction");
    });
    try {
      expect((await call("bootstrap")).status).toBe(500);
    } finally {
      seal.mockRestore();
    }
    expect(await ctx.db.select().from(schema.user)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.cluster)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(0);
    expect(await stored()).toBeUndefined();
  });

  let result: BootstrapResult;
  it("creates an actual passwordless control identity and a sealed, replayable key", async () => {
    const response = await call("bootstrap");
    expect(response.status).toBe(200);
    result = bootstrapResult.parse(await response.json());
    expect(result.accessKey).toMatch(/^ewk_[A-Za-z]{64}$/);
    const state = JSON.stringify(await stored());
    expect(state).not.toContain(token);
    expect(state).not.toContain(result.accessKey);
    expect(await ctx.db.select().from(schema.user)).toHaveLength(1);
    expect(await ctx.db.select().from(schema.account)).toHaveLength(0);
    expect(await ctx.db.select().from(schema.cluster)).toHaveLength(1);
    const authenticated = await app.request(`${origin}/api/v1/me`, {
      headers: { "x-api-key": result.accessKey },
    });
    expect(authenticated.status).toBe(200);
    const restarted = createApp({ ...ctx });
    const replay = await restarted.request(`${origin}/api/v1/system/bootstrap`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
    expect(await replay.json()).toEqual(result);
    expect((await call("bootstrap", { ...input, installationId: randomUUID() })).status).toBe(409);
    expect((await call("bootstrap", { ...input, requestId: randomUUID() })).status).toBe(409);
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(1);
    const publicStatus = await rpcClient(app, origin).system.status();
    expect(publicStatus).toMatchObject({
      initialized: true,
      bootstrap: { enabled: true, phase: "pending" },
    });
  });

  it("erases the recovery envelope only after acknowledgement and keeps the actual key", async () => {
    await ctx.db
      .update(schema.systemSetting)
      .set({ value: { ...(await stored()), expiresAt: new Date(0).toISOString() } })
      .where(eq(schema.systemSetting.key, BOOTSTRAP_KEY));
    await rpcClient(app, origin).system.status();
    expect((await stored())?.envelope).toBeUndefined();
    expect((await call("bootstrap")).status).toBe(410);
    expect((await call("bootstrap/acknowledge")).status).toBe(401);
    expect(
      (await call("bootstrap/acknowledge", input, { "x-api-key": result.accessKey })).status,
    ).toBe(200);
    expect(
      (await call("bootstrap/acknowledge", input, { "x-api-key": result.accessKey })).status,
    ).toBe(200);
    expect((await stored())?.envelope).toBeUndefined();
    expect((await stored())?.acknowledgedAt).toBeTruthy();
    expect((await call("bootstrap")).status).toBe(409);
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(1);
    expect(
      await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "system.bootstrap_acknowledged")),
    ).toHaveLength(1);
    expect(await rpcClient(app, origin).system.status()).toMatchObject({
      bootstrap: { phase: "completed" },
    });
  });

  it("rotates the bootstrap key only after an explicit local reauthorization", async () => {
    const next = {
      ...input,
      requestId: randomUUID(),
      token: randomBytes(32).toString("base64url"),
    };
    await grantIntegrationAuthorization(ctx.pool, ctx.db, next, true);
    const [old] = await ctx.db
      .select()
      .from(schema.apikey)
      .where(eq(schema.apikey.id, result.accessKeyId));
    expect(old?.enabled).toBe(false);
    expect(await ctx.db.select().from(schema.user)).toHaveLength(1);
    expect(await ctx.db.select().from(schema.cluster)).toHaveLength(1);
  });
});

describe("existing instances", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());
  it("keeps normal setup and cannot be taken over by adding a bootstrap capability later", async () => {
    await setupPlatform(ctx);
    const folder = await mkdtemp(join(tmpdir(), "edgeweir-bootstrap-existing-"));
    try {
      const token = randomBytes(32).toString("base64url"),
        file = join(folder, "token");
      await writeFile(file, token, { mode: 0o600 });
      const app = createApp({ ...ctx, env: { ...ctx.env, EDGEWEIR_BOOTSTRAP_TOKEN_FILE: file } });
      const response = await app.request(`${ctx.env.EDGEWEIR_PUBLIC_URL}/api/v1/system/bootstrap`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ installationId: randomUUID(), requestId: randomUUID(), token }),
      });
      expect(response.status).toBe(403);
      expect(((await response.json()) as { code: string }).code).toBe("SETUP_DONE");
      expect(await ctx.db.select().from(schema.user)).toHaveLength(1);
      expect(await ctx.db.select().from(schema.apikey)).toHaveLength(0);
    } finally {
      await rm(folder, { recursive: true });
    }
  });
});
