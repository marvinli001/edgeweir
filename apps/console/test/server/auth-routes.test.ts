import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { AUTH_HTTP_ROUTES } from "../../src/server/lib/auth";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  setupPlatform,
  signIn,
} from "./helpers";

describe("/api/auth allow list", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let adminCookie: string;
  let operatorId: string;

  const auth = (
    path: string,
    init: { method?: string; cookie?: string; apiKey?: string; body?: unknown } = {},
  ) =>
    app.request(`${origin}/api/auth${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        origin,
        "content-type": "application/json",
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...(init.apiKey ? { "x-api-key": init.apiKey } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });

  beforeAll(async () => {
    ({ userId: operatorId } = await setupPlatform(ctx));
    adminCookie = await signIn(app, origin, "admin@example.com");
    admin = rpcClient(app, origin, adminCookie);
  });
  afterAll(() => pglite.close());

  it("refuses the admin plugin endpoints, even to the operator", async () => {
    const calls: [string, unknown][] = [
      ["/admin/impersonate-user", { userId: operatorId }],
      ["/admin/set-user-password", { userId: operatorId, newPassword: "hijacked password 1" }],
      ["/admin/remove-user", { userId: operatorId }],
      ["/admin/set-role", { userId: operatorId, role: "user" }],
      ["/admin/ban-user", { userId: operatorId }],
      [
        "/admin/create-user",
        { email: "ghost@example.com", password: "ghost password 1", name: "Ghost", role: "admin" },
      ],
      ["/admin/revoke-user-sessions", { userId: operatorId }],
    ];
    for (const [path, body] of calls) {
      expect((await auth(path, { cookie: adminCookie, body })).status, path).toBe(404);
    }
    expect((await auth("/admin/list-users", { cookie: adminCookie })).status).toBe(404);
    const [operator] = await ctx.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.id, operatorId));
    expect(operator).toMatchObject({ role: "admin", banned: false });
    const [ghost] = await ctx.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "ghost@example.com"));
    expect(ghost).toBeUndefined();
    // The password was not changed.
    await signIn(app, origin, "admin@example.com");
  });

  it("never turns an x-api-key into a session on /api/auth", async () => {
    const { key } = await admin.accessKeys.create({ name: "ci", scope: "write" });
    const keysBefore = await ctx.db.select().from(schema.apikey);

    const minted = await auth("/api-key/create", { apiKey: key, body: { name: "escalated" } });
    expect(minted.status).toBe(404);
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(keysBefore.length);
    expect((await auth("/api-key/list", { apiKey: key })).status).toBe(404);
    const session = await auth("/get-session", { apiKey: key });
    expect(await session.json()).toBeNull();
    const change = { currentPassword: PASSWORD, newPassword: "taken over password 1" };
    expect((await auth("/change-password", { apiKey: key, body: change })).status).toBe(401);

    // The key keeps working where it belongs.
    const sites = await app.request(`${origin}/api/v1/sites`, { headers: { "x-api-key": key } });
    expect(sites.status).toBe(200);
  });

  it("answers 404 for every path and method outside the list", async () => {
    const probes: [string, string][] = [
      ["GET", "/ok"],
      ["POST", "/sign-up/email"],
      ["POST", "/update-user"],
      ["POST", "/delete-user"],
      ["GET", "/list-sessions"],
      ["POST", "/revoke-sessions"],
      ["POST", "/request-password-reset"],
      ["POST", "/two-factor/get-totp-uri"],
      ["POST", "/passkey/update-passkey"],
      // AccessKeys are created and revoked with the accessKeys procedures only.
      ["POST", "/api-key/create"],
      ["GET", "/api-key/list"],
      ["POST", "/api-key/update"],
      ["POST", "/api-key/delete"],
      ["GET", "/sign-in/email"],
      ["GET", "/get-session/"],
      ["POST", "/admin%2Fremove-user"],
      ["GET", "//get-session"],
    ];
    for (const [method, path] of probes) {
      const res = await auth(path, {
        method,
        cookie: adminCookie,
        body: method === "POST" ? {} : undefined,
      });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
  });

  it("leaves server-side auth.api calls working", async () => {
    // setup -> auth.api.createUser (admin plugin), accessKeys.create -> auth.api.createApiKey.
    const users = await ctx.db.select().from(schema.user);
    expect(users).toMatchObject([{ id: operatorId, email: "admin@example.com", role: "admin" }]);
    await signIn(app, origin, "admin@example.com");
    const created = await admin.accessKeys.create({ name: "server side", scope: "read" });
    expect(created.key).toMatch(/^ewk_/);
    const [row] = await ctx.db.select().from(schema.apikey).where(eq(schema.apikey.id, created.id));
    expect(row).toMatchObject({ name: "server side", referenceId: operatorId });
  });

  it("keeps the flows the web console uses working", async () => {
    const cookie = await signIn(app, origin, "admin@example.com");
    const session = (await (await auth("/get-session", { cookie })).json()) as {
      user: { email: string };
    };
    expect(session.user.email).toBe("admin@example.com");
    expect((await auth("/passkey/list-user-passkeys", { cookie })).status).toBe(200);
    expect(
      (await auth("/passkey/generate-register-options", { cookie })).status,
      "passkey registration options",
    ).toBe(200);
    expect((await auth("/passkey/generate-authenticate-options")).status).toBe(200);

    const enabled = await auth("/two-factor/enable", { cookie, body: { password: PASSWORD } });
    expect(enabled.status).toBe(200);
    const changed = await auth("/change-password", {
      cookie,
      body: { currentPassword: PASSWORD, newPassword: `${PASSWORD} 2`, revokeOtherSessions: true },
    });
    expect(changed.status).toBe(200);
    const newCookie = (changed.headers.getSetCookie?.() ?? [])
      .map((c) => c.split(";")[0])
      .join("; ");
    expect((await auth("/sign-out", { cookie: newCookie, body: {} })).status).toBe(200);
    // The full list: every entry names a real better-auth endpoint and method.
    const endpoints = ctx.auth.api as unknown as Record<
      string,
      { path?: string; options?: { method?: string | string[] } }
    >;
    const known = new Map<string, string[]>();
    for (const endpoint of Object.values(endpoints)) {
      if (!endpoint.path) continue;
      const methods = endpoint.options?.method ?? [];
      known.set(endpoint.path, Array.isArray(methods) ? methods : [methods]);
    }
    for (const [path, methods] of Object.entries(AUTH_HTTP_ROUTES)) {
      for (const method of methods) expect(known.get(path), path).toContain(method);
    }
  });
});
