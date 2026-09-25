import { schema } from "@edgeweir/db";
import { and, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  CookieJar,
  createTestContext,
  PASSWORD,
  rpcClient,
  setupPlatform,
  signIn,
  totp,
} from "./helpers";
import { SoftAuthenticator } from "./webauthn";

describe("audit entries for better-auth account events", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const jar = new CookieJar();
  let userId: string;
  let password = PASSWORD;
  let totpSecret = "";

  /** A request from 203.0.113.9 with the jar's cookies, like the web console makes. */
  const auth = async (path: string, body?: unknown) =>
    jar.store(
      await app.request(
        `${origin}/api/auth${path}`,
        {
          method: body === undefined ? "GET" : "POST",
          headers: {
            origin,
            cookie: jar.header,
            "content-type": "application/json",
            "user-agent": "audit-test",
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
        { incoming: { socket: { remoteAddress: "203.0.113.9" } } },
      ),
    );

  const entries = (action: string) =>
    ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, action))
      .orderBy(desc(schema.auditLog.id));
  const latest = async (action: string) => (await entries(action))[0];

  beforeAll(async () => {
    const { organizationId } = await setupPlatform(ctx);
    const admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    userId = (
      await admin.users.create({
        name: "Ada Lovelace",
        email: "ada@example.com",
        password: PASSWORD,
        organizationId,
        role: "member",
      })
    ).id;
  });
  afterAll(() => pglite.close());

  it("records successful and failed password sign-ins with the client address", async () => {
    const bad = await auth("/sign-in/email", {
      email: "ada@example.com",
      password: "wrong one here",
    });
    expect(bad.status).toBe(401);
    expect(await latest("auth.sign_in_failed")).toMatchObject({
      actorId: "",
      ip: "203.0.113.9",
      targetName: "ada@example.com",
      metadata: { method: "password", code: "INVALID_EMAIL_OR_PASSWORD", email: "ada@example.com" },
    });
    // The password never appears in the entry.
    expect(JSON.stringify(await latest("auth.sign_in_failed"))).not.toContain("wrong one here");

    expect((await auth("/sign-in/email", { email: "ada@example.com", password })).status).toBe(200);
    expect(await latest("auth.sign_in")).toMatchObject({
      actorType: "user",
      actorId: userId,
      actorName: "Ada Lovelace",
      ip: "203.0.113.9",
      userAgent: "audit-test",
      targetId: userId,
      metadata: { method: "password" },
    });
  });

  it("records a password change", async () => {
    const next = `${PASSWORD} changed`;
    const res = await auth("/change-password", {
      currentPassword: password,
      newPassword: next,
      revokeOtherSessions: true,
    });
    expect(res.status).toBe(200);
    password = next;
    const entry = await latest("account.password_change");
    expect(entry).toMatchObject({
      actorId: userId,
      targetType: "user",
      targetId: userId,
      ip: "203.0.113.9",
      metadata: { revokeOtherSessions: true },
    });
    expect(JSON.stringify(entry)).not.toContain(next);
  });

  it("records enabling TOTP, the second-factor sign-in, and disabling it", async () => {
    const enable = await auth("/two-factor/enable", { password });
    expect(enable.status).toBe(200);
    // Generating the secret alone does not switch two-factor on.
    expect(await latest("account.two_factor_enable")).toBeUndefined();
    const { totpURI } = (await enable.json()) as { totpURI: string };
    totpSecret = new URL(totpURI).searchParams.get("secret") ?? "";
    expect((await auth("/two-factor/verify-totp", { code: totp(totpSecret) })).status).toBe(200);
    expect(await latest("account.two_factor_enable")).toMatchObject({
      actorId: userId,
      targetId: userId,
      ip: "203.0.113.9",
    });
    // Enrollment is not a sign-in.
    expect(await entries("auth.sign_in")).toHaveLength(2); // admin + Ada's password sign-in

    jar.clear();
    const first = await auth("/sign-in/email", { email: "ada@example.com", password });
    expect(await first.json()).toMatchObject({ twoFactorRedirect: true });
    expect(await entries("auth.sign_in")).toHaveLength(2);
    expect((await auth("/two-factor/verify-totp", { code: "000000" })).status).not.toBe(200);
    expect(await latest("auth.sign_in_failed")).toMatchObject({
      metadata: { method: "totp", code: "INVALID_CODE" },
    });
    expect((await auth("/two-factor/verify-totp", { code: totp(totpSecret) })).status).toBe(200);
    expect(await latest("auth.sign_in")).toMatchObject({
      actorId: userId,
      metadata: { method: "totp" },
    });

    expect((await auth("/two-factor/disable", { password })).status).toBe(200);
    expect(await latest("account.two_factor_disable")).toMatchObject({
      actorId: userId,
      targetId: userId,
    });
    expect(await entries("account.two_factor_enable")).toHaveLength(1);
  });

  it("records API key creation and deletion without the key", async () => {
    const created = await auth("/api-key/create", { name: "terraform" });
    expect(created.status).toBe(200);
    const { id, key } = (await created.json()) as { id: string; key: string };
    const entry = await latest("api_key.create");
    expect(entry).toMatchObject({
      actorId: userId,
      targetType: "api_key",
      targetId: id,
      targetName: "terraform",
      ip: "203.0.113.9",
    });
    expect(JSON.stringify(entry)).not.toContain(key);
    expect((entry?.metadata as { start?: string } | undefined)?.start).toMatch(/^ewk_/);

    expect((await auth("/api-key/delete", { keyId: id })).status).toBe(200);
    expect(await latest("api_key.delete")).toMatchObject({
      actorId: userId,
      targetType: "api_key",
      targetId: id,
      targetName: "terraform",
    });
  });

  it("records adding a passkey, signing in with it and deleting it", async () => {
    const authenticator = new SoftAuthenticator("console.test", origin);
    const options = await auth("/passkey/generate-register-options");
    expect(options.status).toBe(200);
    const registered = await auth("/passkey/verify-registration", {
      response: authenticator.register((await options.json()) as { challenge: string }),
      name: "Ada's laptop",
    });
    expect(registered.status).toBe(200);
    const [row] = await ctx.db
      .select()
      .from(schema.passkey)
      .where(eq(schema.passkey.userId, userId));
    expect(row).toBeDefined();
    expect(await latest("account.passkey_add")).toMatchObject({
      actorId: userId,
      targetId: userId,
      ip: "203.0.113.9",
      metadata: { passkeyId: row?.id, name: "Ada's laptop" },
    });

    jar.clear();
    const challenge = await auth("/passkey/generate-authenticate-options");
    expect(challenge.status).toBe(200);
    const verified = await auth("/passkey/verify-authentication", {
      response: authenticator.authenticate((await challenge.json()) as { challenge: string }),
    });
    expect(verified.status).toBe(200);
    expect(await latest("auth.sign_in")).toMatchObject({
      actorId: userId,
      metadata: { method: "passkey" },
    });

    expect((await auth("/passkey/delete-passkey", { id: row?.id })).status).toBe(200);
    expect(await latest("account.passkey_delete")).toMatchObject({
      actorId: userId,
      targetId: userId,
      metadata: { passkeyId: row?.id, name: "Ada's laptop" },
    });
    const left = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.actorId, userId), eq(schema.auditLog.action, "auth.sign_in")));
    expect(left.map((e) => (e.metadata as { method: string }).method).sort()).toEqual([
      "passkey",
      "password",
      "totp",
    ]);
  });
});
