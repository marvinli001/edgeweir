import { contract, serviceAccountProcedures, serviceAccountScope } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  parseIdempotencyKey,
  pruneIdempotencyKeys,
  withIdempotency,
} from "../../src/server/lib/idempotency";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

function procedureNames(node: unknown, prefix = ""): string[] {
  if (node && typeof node === "object" && "~orpc" in node) return [prefix];
  return Object.entries(node as Record<string, unknown>).flatMap(([key, child]) =>
    procedureNames(child, prefix ? `${prefix}.${key}` : key),
  );
}

describe("service accounts, scopes and idempotency keys", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let adminCookie: string;
  let full: string;
  let narrow: string;
  let accountId: string;
  let narrowId: string;

  const api = async (
    key: string,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json", ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      text,
      json: text ? (JSON.parse(text) as Record<string, unknown> & { data?: unknown }) : {},
    };
  };
  const orgCount = async () =>
    (await ctx.db.select({ n: count() }).from(schema.organization))[0]?.n ?? 0;

  beforeAll(async () => {
    await setupPlatform(ctx);
    adminCookie = await signIn(app, origin, "admin@example.com");
    admin = rpcClient(app, origin, adminCookie);
    const account = await admin.serviceAccounts.create({
      name: "billing",
      scopes: [...serviceAccountScope.options],
    });
    accountId = account.id;
    full = (await admin.serviceAccounts.createKey({ id: account.id, name: "primary" })).secret;
    const limited = await admin.serviceAccounts.create({ name: "reader", scopes: ["sites:read"] });
    narrowId = limited.id;
    narrow = (await admin.serviceAccounts.createKey({ id: limited.id })).secret;
  });
  afterAll(() => pglite.close());

  it("lists only procedures that exist, with scopes from the initial set", () => {
    const names = new Set(procedureNames(contract));
    for (const name of Object.keys(serviceAccountProcedures))
      expect(names.has(name), name).toBe(true);
    expect(serviceAccountScope.options).toEqual([
      "organizations:read",
      "organizations:write",
      "members:read",
      "invitations:write",
      "clusters:read",
      "system:read",
      "sites:read",
      "sites:write",
      "sites:suspend",
      "limits:read",
      "limits:write",
      "usage:read",
    ]);
  });

  it("shows a key once and stores only its hash", async () => {
    expect(full).toMatch(/^ews_[A-Za-z0-9_-]{43}$/);
    const [listed] = (await admin.serviceAccounts.list()).filter((a) => a.id === accountId);
    expect(listed?.keys).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(full);
    expect(listed?.keys[0]?.prefix).toBe(full.slice(0, 12));
    const rows = await ctx.db.select().from(schema.serviceAccountKey);
    expect(JSON.stringify(rows)).not.toContain(full);
    const [entry] = (await admin.auditLogs.list({ action: "service_account.key_create" })).items;
    expect(JSON.stringify(entry)).not.toContain(full);
  });

  it("answers every endpoint the integration calls with a full-scope service account", async () => {
    expect((await api(full, "GET", "/system/status")).status).toBe(200);
    const me = await api(full, "GET", "/me");
    expect(me.status).toBe(200);
    expect(me.json).toMatchObject({
      user: { id: accountId, name: "billing", isAdmin: false },
      organizations: [],
      activeOrganization: null,
      serviceAccount: { id: accountId, name: "billing" },
    });
    expect((await api(full, "GET", "/clusters")).status).toBe(200);
    expect((await api(full, "GET", "/organizations")).status).toBe(200);
    const created = await api(full, "POST", "/organizations", { name: "Customer A" });
    expect(created.status).toBe(200);
    const orgId = created.json.id as string;
    const patched = await api(full, "PATCH", `/organizations/${orgId}`, {
      name: "Customer A1",
      expectedUpdatedAt: created.json.updatedAt,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.name).toBe("Customer A1");
    expect((await api(full, "GET", `/organizations/${orgId}/members`)).status).toBe(200);
    const invited = await api(full, "POST", `/organizations/${orgId}/invitations`, {
      email: "owner@customer-a.test",
      role: "owner",
    });
    expect(invited.status).toBe(200);
    expect(invited.json).toMatchObject({ invitation: { inviterName: "billing", role: "owner" } });
    // The audit log names the service account.
    const [entry] = (await admin.auditLogs.list({ action: "invitation.create" })).items;
    expect(entry).toMatchObject({
      actorType: "service_account",
      actorId: accountId,
      actorName: "billing",
    });
    // Optimistic concurrency on organizations.
    const stale = await api(full, "PATCH", `/organizations/${orgId}`, {
      name: "Customer A2",
      expectedUpdatedAt: created.json.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      code: "UPDATED_AT_MISMATCH",
      data: { updatedAt: patched.json.updatedAt },
    });
  });

  it("refuses a missing scope with 403 SCOPE_REQUIRED naming the scope", async () => {
    const res = await api(narrow, "GET", "/clusters");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "SCOPE_REQUIRED", data: { scope: "clusters:read" } });
    const create = await api(narrow, "POST", "/organizations", { name: "Nope" });
    expect(create.json).toMatchObject({
      code: "SCOPE_REQUIRED",
      data: { scope: "organizations:write" },
    });
    expect((await api(narrow, "GET", "/sites")).status).toBe(200);
    const me = await api(narrow, "GET", "/me");
    expect(me.json.serviceAccount).toMatchObject({ scopes: ["sites:read"] });
  });

  it("refuses procedures outside the service account list", async () => {
    for (const [method, path, body] of [
      ["GET", "/users", undefined],
      ["GET", "/service-accounts", undefined],
      ["POST", "/service-accounts", { name: "escalate", scopes: [] }],
      ["GET", "/audit-logs", undefined],
      ["GET", "/members", undefined],
      ["GET", "/bans", undefined],
      ["GET", "/admin/bans", undefined],
      [
        "POST",
        "/admin/bans",
        { scope: "platform", cidr: "203.0.113.0/24", reason: "attack", durationSeconds: 3600 },
      ],
      ["GET", "/settings/bans", undefined],
      ["GET", "/settings/protection", undefined],
      [
        "PUT",
        "/settings/protection",
        { underAttack: true, underAttackChallenge: "js", eventRetentionDays: 30 },
      ],
      ["GET", "/settings/cc-template", undefined],
      ["PATCH", "/sites/00000000-0000-4000-8000-000000000000/protection", { underAttack: true }],
      ["GET", "/sites/00000000-0000-4000-8000-000000000000/security", undefined],
      ["GET", "/sites/00000000-0000-4000-8000-000000000000/security/events", undefined],
      ["POST", "/sites", { name: "x", domains: ["x.test"], origins: [{ address: "o.test" }] }],
    ] as const) {
      const res = await api(full, method, path, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.json.code, `${method} ${path}`).toBe("SERVICE_ACCOUNT_FORBIDDEN");
    }
  });

  it("only works on /api/v1, never as a session", async () => {
    const res = await app.request(`${origin}/rpc/account/me`, {
      method: "POST",
      headers: { "x-api-key": full, "x-csrf-token": "orpc", "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
    });
    expect(res.status).toBe(401);
    const session = await app.request(`${origin}/api/auth/get-session`, {
      headers: { "x-api-key": full },
    });
    expect(await session.json()).toBeNull();
  });

  it("stops a revoked key and a disabled account, and records the last use", async () => {
    const key = await admin.serviceAccounts.createKey({ id: narrowId, name: "temp" });
    expect((await api(key.secret, "GET", "/sites")).status).toBe(200);
    const listed = (await admin.serviceAccounts.list()).find((a) => a.id === narrowId);
    expect(listed?.keys.find((k) => k.id === key.key.id)?.lastUsedAt).not.toBeNull();
    const revoked = await admin.serviceAccounts.revokeKey({ id: narrowId, keyId: key.key.id });
    expect(revoked.revokedAt).not.toBeNull();
    expect((await api(key.secret, "GET", "/sites")).status).toBe(401);
    await admin.serviceAccounts.update({ id: narrowId, enabled: false });
    expect((await api(narrow, "GET", "/sites")).status).toBe(401);
    await admin.serviceAccounts.update({ id: narrowId, enabled: true });
    expect((await api(narrow, "GET", "/sites")).status).toBe(200);
    expect((await admin.auditLogs.list({ action: "service_account.key_revoke" })).total).toBe(1);
    expect((await admin.auditLogs.list({ action: "service_account.update" })).total).toBe(2);
  });

  it("keeps the 403 matrix: tenant members, missing scopes and read-only keys", async () => {
    // A tenant member cannot manage service accounts or reach the admin procedures.
    const [org] = await admin.organizations.list();
    await admin.users.create({
      name: "Member",
      email: "member@sa.test",
      password: PASSWORD,
      organizationId: org?.id ?? "",
    });
    const member = rpcClient(app, origin, await signIn(app, origin, "member@sa.test"));
    for (const call of [
      () => member.serviceAccounts.list(),
      () => member.serviceAccounts.create({ name: "x", scopes: [] }),
      () => member.serviceAccounts.createKey({ id: accountId }),
      () => member.serviceAccounts.revokeKey({ id: accountId, keyId: accountId }),
      () => member.serviceAccounts.update({ id: accountId, enabled: false }),
      () => member.serviceAccounts.delete({ id: accountId }),
    ])
      expect((await rpcError(call())).status).toBe(403);
    // A read-only user AccessKey cannot write.
    const readKey = await admin.accessKeys.create({ name: "ro", scope: "read" });
    const write = await api(readKey.key, "POST", "/organizations", { name: "RO" });
    expect(write.status).toBe(403);
    expect(write.json.code).toBe("ACCESS_KEY_READ_ONLY");
    // A service account without the scope cannot suspend.
    const site = await admin.sites.create({
      name: "s",
      domains: ["s.sa.test"],
      origins: [{ address: "o.test" }],
    });
    const suspend = await api(narrow, "POST", `/admin/sites/${site.site.id}/suspend`, {
      reason: "billing",
    });
    expect(suspend.status).toBe(403);
    expect(suspend.json).toMatchObject({
      code: "SCOPE_REQUIRED",
      data: { scope: "sites:suspend" },
    });
  });

  it("replays a repeated Idempotency-Key and creates the organization once", async () => {
    const before = await orgCount();
    const first = await api(
      full,
      "POST",
      "/organizations",
      { name: "Idem" },
      {
        "idempotency-key": "org-create-1",
      },
    );
    const second = await api(
      full,
      "POST",
      "/organizations",
      { name: "Idem" },
      {
        "idempotency-key": "org-create-1",
      },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.text).toBe(first.text);
    expect(await orgCount()).toBe(before + 1);
    // Same key, another body: 422.
    const other = await api(
      full,
      "POST",
      "/organizations",
      { name: "Idem 2" },
      {
        "idempotency-key": "org-create-1",
      },
    );
    expect(other.status).toBe(422);
    expect(other.json.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
    // Same key, another path: 422 too.
    const path = await api(
      full,
      "PATCH",
      `/organizations/${first.json.id}`,
      { name: "Idem" },
      {
        "idempotency-key": "org-create-1",
      },
    );
    expect(path.status).toBe(422);
    // The structured-field form is the same key.
    const quoted = await api(
      full,
      "POST",
      "/organizations",
      { name: "Idem" },
      {
        "idempotency-key": '"org-create-1"',
      },
    );
    expect(quoted.headers.get("idempotent-replayed")).toBe("true");
    expect(await orgCount()).toBe(before + 1);
  });

  it("stores refusals (4xx) and keeps keys per caller", async () => {
    const taken = await api(
      full,
      "POST",
      "/organizations",
      { name: "Dup", slug: "idem" },
      {
        "idempotency-key": "dup-slug",
      },
    );
    expect(taken.status).toBe(409);
    const replay = await api(
      full,
      "POST",
      "/organizations",
      { name: "Dup", slug: "idem" },
      {
        "idempotency-key": "dup-slug",
      },
    );
    expect(replay.status).toBe(409);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    // Another caller's key with the same value is a different key.
    const adminKey = await admin.accessKeys.create({ name: "rw", scope: "write" });
    const byUser = await api(
      adminKey.key,
      "POST",
      "/organizations",
      { name: "Dup", slug: "dup-user" },
      {
        "idempotency-key": "dup-slug",
      },
    );
    expect(byUser.status).toBe(200);
    expect(byUser.headers.get("idempotent-replayed")).toBeNull();
  });

  it("runs concurrent requests with one key exactly once (409 while in progress)", async () => {
    const before = await orgCount();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api(full, "POST", "/organizations", { name: "Concurrent" }, { "idempotency-key": "race" }),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(await orgCount()).toBe(before + 1);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === 409) expect(r.json.code).toBe("IDEMPOTENCY_IN_PROGRESS");
      else if (r.status === 200 && r.headers.get("idempotent-replayed") === null)
        expect(r.json.name).toBe("Concurrent");
      else expect(r.headers.get("idempotent-replayed")).toBe("true");
    }
    expect(
      results.filter((r) => r.status === 200 && r.headers.get("idempotent-replayed") === null),
    ).toHaveLength(1);
  });

  it("validates the key and ignores it on reads", async () => {
    for (const bad of ["", "x".repeat(256), "é", '"unterminated']) {
      const res = await api(
        full,
        "POST",
        "/organizations",
        { name: "Bad" },
        {
          "idempotency-key": bad,
        },
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("IDEMPOTENCY_KEY_INVALID");
    }
    expect(parseIdempotencyKey('"a\\"b"')).toBe('a"b');
    expect(parseIdempotencyKey("  token  ")).toBe("token");
    const read = await api(full, "GET", "/organizations", undefined, { "idempotency-key": "é" });
    expect(read.status).toBe(200);
  });

  it("does not keep 5xx responses and forgets keys after 24 hours", async () => {
    const principalKey = full;
    let calls = 0;
    const request = () =>
      new Request(`${origin}/api/v1/organizations`, {
        method: "POST",
        headers: { "idempotency-key": "flaky", "x-api-key": principalKey },
        body: "{}",
      });
    const failing = await withIdempotency(ctx.db, request(), principalKey, async () => {
      calls++;
      return new Response("boom", { status: 503 });
    });
    expect(failing?.status).toBe(503);
    const ok = await withIdempotency(ctx.db, request(), principalKey, async () => {
      calls++;
      return Response.json({ ok: true });
    });
    expect(ok?.status).toBe(200);
    expect(calls).toBe(2);
    const later = new Date(Date.now() + 25 * 3600 * 1000);
    const again = await withIdempotency(
      ctx.db,
      request(),
      principalKey,
      async () => {
        calls++;
        return Response.json({ ok: true });
      },
      () => later,
    );
    expect(again?.headers.get("idempotent-replayed")).toBeNull();
    expect(calls).toBe(3);
    expect(
      await pruneIdempotencyKeys(ctx.db, new Date(Date.now() + 50 * 3600 * 1000)),
    ).toBeGreaterThan(0);
    const [left] = await ctx.db
      .select({ n: count() })
      .from(schema.idempotencyKey)
      .where(eq(schema.idempotencyKey.key, "flaky"));
    expect(left?.n).toBe(0);
  });
});
