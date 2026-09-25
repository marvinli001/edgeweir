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
  let ownerCookie: string;
  let tenantOrgId: string;
  let victimId: string;

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
    await setupPlatform(ctx);
    adminCookie = await signIn(app, origin, "admin@example.com");
    admin = rpcClient(app, origin, adminCookie);
    tenantOrgId = (await admin.organizations.create({ name: "Tenant" })).id;
    await admin.users.create({
      name: "Olivia Owner",
      email: "owner@tenant.test",
      password: PASSWORD,
      organizationId: tenantOrgId,
      role: "owner",
    });
    victimId = (
      await admin.users.create({
        name: "Victor Victim",
        email: "victim@tenant.test",
        password: PASSWORD,
        organizationId: tenantOrgId,
        role: "member",
      })
    ).id;
    ownerCookie = await signIn(app, origin, "owner@tenant.test");
  });
  afterAll(() => pglite.close());

  it("does not let an organization owner delete the organization through better-auth", async () => {
    for (const path of [
      "/organization/delete",
      "/organization/update",
      "/organization/remove-member",
      "/organization/update-member-role",
      "/organization/invite-member",
      "/organization/set-active",
    ]) {
      const res = await auth(path, {
        cookie: ownerCookie,
        body: { organizationId: tenantOrgId, memberIdOrEmail: "victim@tenant.test" },
      });
      expect(res.status, path).toBe(404);
    }
    const [org] = await ctx.db
      .select()
      .from(schema.organization)
      .where(eq(schema.organization.id, tenantOrgId));
    expect(org?.name).toBe("Tenant");
    expect(await admin.organizations.members({ id: tenantOrgId })).toMatchObject({
      members: expect.arrayContaining([expect.objectContaining({ email: "victim@tenant.test" })]),
    });
  });

  it("refuses the admin plugin endpoints, even to a platform administrator", async () => {
    const calls: [string, unknown][] = [
      ["/admin/impersonate-user", { userId: victimId }],
      ["/admin/set-user-password", { userId: victimId, newPassword: "hijacked password 1" }],
      ["/admin/remove-user", { userId: victimId }],
      ["/admin/set-role", { userId: victimId, role: "admin" }],
      ["/admin/ban-user", { userId: victimId }],
      [
        "/admin/create-user",
        { email: "ghost@example.com", password: "ghost password 1", name: "Ghost", role: "admin" },
      ],
      ["/admin/revoke-user-sessions", { userId: victimId }],
    ];
    for (const [path, body] of calls) {
      expect((await auth(path, { cookie: adminCookie, body })).status, path).toBe(404);
    }
    expect((await auth("/admin/list-users", { cookie: adminCookie })).status).toBe(404);
    const [victim] = await ctx.db.select().from(schema.user).where(eq(schema.user.id, victimId));
    expect(victim).toMatchObject({ role: "user", banned: false });
    const [ghost] = await ctx.db
      .select()
      .from(schema.user)
      .where(eq(schema.user.email, "ghost@example.com"));
    expect(ghost).toBeUndefined();
    // The password was not changed.
    await signIn(app, origin, "victim@tenant.test");
  });

  it("never turns an x-api-key into a session on /api/auth", async () => {
    const created = await auth("/api-key/create", { cookie: adminCookie, body: { name: "ci" } });
    expect(created.status).toBe(200);
    const { key } = (await created.json()) as { key: string };
    const keysBefore = await ctx.db.select().from(schema.apikey);

    const minted = await auth("/api-key/create", { apiKey: key, body: { name: "escalated" } });
    expect(minted.status).toBe(401);
    expect(await ctx.db.select().from(schema.apikey)).toHaveLength(keysBefore.length);
    expect((await auth("/api-key/list", { apiKey: key })).status).toBe(401);
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
      ["POST", "/api-key/update"],
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

  it("keeps the flows the web console uses working", async () => {
    const cookie = await signIn(app, origin, "owner@tenant.test");
    const session = (await (await auth("/get-session", { cookie })).json()) as {
      user: { email: string };
    };
    expect(session.user.email).toBe("owner@tenant.test");
    expect((await auth("/passkey/list-user-passkeys", { cookie })).status).toBe(200);
    expect(
      (await auth("/passkey/generate-register-options", { cookie })).status,
      "passkey registration options",
    ).toBe(200);
    expect((await auth("/passkey/generate-authenticate-options")).status).toBe(200);

    const key = await auth("/api-key/create", { cookie, body: { name: "terraform" } });
    expect(key.status).toBe(200);
    const { id } = (await key.json()) as { id: string };
    expect((await auth("/api-key/list", { cookie })).status).toBe(200);
    expect((await auth("/api-key/delete", { cookie, body: { keyId: id } })).status).toBe(200);

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

  it("leaves server-side auth.api calls working", async () => {
    // users.create -> auth.api.createUser (admin plugin), setup -> createOrganization.
    const created = await admin.users.create({
      name: "Server Side",
      email: "server@tenant.test",
      password: PASSWORD,
      organizationId: tenantOrgId,
      role: "member",
    });
    expect(created.email).toBe("server@tenant.test");
    await signIn(app, origin, "server@tenant.test");
    const orgs = await ctx.db.select().from(schema.organization);
    expect(orgs.map((o) => o.name)).toEqual(expect.arrayContaining(["Default", "Tenant"]));
  });
});
