import { contract, serviceAccountProcedures, serviceAccountScope } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { count, desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  parseIdempotencyKey,
  pruneIdempotencyKeys,
  withIdempotency,
} from "../../src/server/lib/idempotency";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

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
  let siteId: string;

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
  /** Each time a site is switched off, one audit entry is written. */
  const switchesOff = async () =>
    (
      await ctx.db
        .select({ n: count() })
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "site.disable"))
    )[0]?.n ?? 0;

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
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.sa.test"],
        origins: [{ address: "o.test" }],
      })
    ).site.id;
  });
  afterAll(() => pglite.close());

  it("lists only procedures that exist, with scopes from the initial set", () => {
    const names = new Set(procedureNames(contract));
    for (const name of Object.keys(serviceAccountProcedures))
      expect(names.has(name), name).toBe(true);
    expect(serviceAccountScope.options).toEqual([
      "clusters:read",
      "system:read",
      "sites:read",
      "sites:write",
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
      user: { id: accountId, name: "billing", email: "" },
      serviceAccount: { id: accountId, name: "billing" },
    });
    expect((await api(full, "GET", "/settings")).status).toBe(200);
    const clusters = await api(full, "GET", "/clusters");
    expect(clusters.status).toBe(200);
    const [cluster] = clusters.json as unknown as { id: string }[];
    expect((await api(full, "GET", `/clusters/${cluster?.id}`)).status).toBe(200);
    expect((await api(full, "GET", "/sites")).status).toBe(200);
    const site = await api(full, "GET", `/sites/${siteId}`);
    expect(site.status).toBe(200);
    const to = Math.floor(Date.now() / 300_000) * 300_000;
    const range = new URLSearchParams({
      from: new Date(to - 300_000).toISOString(),
      to: new Date(to).toISOString(),
    });
    expect((await api(full, "GET", `/usage?${range}`)).status).toBe(200);
    expect((await api(full, "GET", "/usage/changes")).status).toBe(200);
    const disabled = await api(full, "PUT", `/sites/${siteId}/enabled`, {
      enabled: false,
      expectedUpdatedAt: site.json.updatedAt,
    });
    expect(disabled.status).toBe(200);
    expect(disabled.json).toMatchObject({ site: { id: siteId, enabled: false } });
    // The audit log names the service account.
    const [entry] = (await admin.auditLogs.list({ action: "site.disable" })).items;
    expect(entry).toMatchObject({
      actorType: "service_account",
      actorId: accountId,
      actorName: "billing",
    });
    // Optimistic concurrency on sites.
    const stale = await api(full, "PUT", `/sites/${siteId}/enabled`, {
      enabled: true,
      expectedUpdatedAt: site.json.updatedAt,
    });
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({
      code: "UPDATED_AT_MISMATCH",
      data: { updatedAt: (disabled.json.site as { updatedAt: string }).updatedAt },
    });
    expect((await api(full, "PUT", `/sites/${siteId}/enabled`, { enabled: true })).status).toBe(
      200,
    );
  });

  it("refuses a missing scope with 403 SCOPE_REQUIRED naming the scope", async () => {
    const res = await api(narrow, "GET", "/clusters");
    expect(res.status).toBe(403);
    expect(res.json).toMatchObject({ code: "SCOPE_REQUIRED", data: { scope: "clusters:read" } });
    const disable = await api(narrow, "PUT", `/sites/${siteId}/enabled`, { enabled: false });
    expect(disable.json).toMatchObject({
      code: "SCOPE_REQUIRED",
      data: { scope: "sites:write" },
    });
    expect((await api(narrow, "GET", "/sites")).status).toBe(200);
    // DNS: the catalog needs no scope, a site's CNAME target needs sites:read.
    expect((await api(narrow, "GET", "/dns/catalog")).status).toBe(200);
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await api(narrow, "GET", `/sites/${missing}/cname`)).json.code).toBe("SITE_NOT_FOUND");
    const clusters = await admin.serviceAccounts.create({
      name: "infra",
      scopes: ["clusters:read"],
    });
    const infra = (await admin.serviceAccounts.createKey({ id: clusters.id })).secret;
    expect((await api(infra, "GET", `/sites/${missing}/cname`)).json).toMatchObject({
      code: "SCOPE_REQUIRED",
      data: { scope: "sites:read" },
    });
    const me = await api(narrow, "GET", "/me");
    expect(me.json.serviceAccount).toMatchObject({ scopes: ["sites:read"] });
  });

  it("refuses procedures outside the service account list", async () => {
    for (const [method, path, body] of [
      ["GET", "/service-accounts", undefined],
      ["POST", "/service-accounts", { name: "escalate", scopes: [] }],
      ["GET", "/audit-logs", undefined],
      ["GET", "/bans", undefined],
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
      ["GET", "/sites/00000000-0000-4000-8000-000000000000/waf", undefined],
      ["PATCH", "/sites/00000000-0000-4000-8000-000000000000/waf", { mode: "block" }],
      ["GET", "/sites/00000000-0000-4000-8000-000000000000/waf/rules", undefined],
      ["GET", "/sites/00000000-0000-4000-8000-000000000000/features", undefined],
      [
        "PUT",
        "/sites/00000000-0000-4000-8000-000000000000/https",
        { settings: { brotli: true, zstd: true } },
      ],
      ["GET", "/sites/00000000-0000-4000-8000-000000000000/error-pages", undefined],
      [
        "PUT",
        "/sites/00000000-0000-4000-8000-000000000000/error-pages",
        { pages: [{ status: 503, template: "<p>later</p>" }] },
      ],
      ["GET", "/settings/error-pages", undefined],
      ["PUT", "/settings/error-pages", { unknownHost: "<p>nobody</p>" }],
      ["GET", "/sites/00000000-0000-4000-8000-000000000000/bulk-redirects", undefined],
      [
        "PUT",
        "/sites/00000000-0000-4000-8000-000000000000/bulk-redirects",
        { redirects: [{ source: "/old", target: "/new" }] },
      ],
      [
        "POST",
        "/cache-tasks",
        { type: "tag", siteIds: ["00000000-0000-4000-8000-000000000000"], tags: ["product"] },
      ],
      ["GET", "/dns/providers", undefined],
      ["GET", "/dns/bindings", undefined],
      ["PUT", "/clusters/00000000-0000-4000-8000-000000000000/dns", { binding: { mode: "off" } }],
      ["POST", "/dns/reconcile", {}],
      ["POST", "/dns/zones", { id: "00000000-0000-4000-8000-000000000000" }],
      ["GET", "/dns-credentials", undefined],
      ["POST", "/sites", { name: "x", domains: ["x.test"], origins: [{ address: "o.test" }] }],
      ["GET", "/probes", undefined],
      ["POST", "/probe-tokens", { name: "p", regionId: "00000000-0000-4000-8000-000000000000" }],
      ["PATCH", "/probes/00000000-0000-4000-8000-000000000000", { enabled: false }],
      ["DELETE", "/probes/00000000-0000-4000-8000-000000000000", undefined],
      ["GET", "/probe-results", undefined],
      ["GET", "/settings/probes", undefined],
      [
        "PUT",
        "/settings/probes",
        {
          intervalSeconds: 10,
          timeoutMs: 3000,
          attempts: 3,
          lossPercent: 50,
          ipDownSeconds: 30,
          ipUpSeconds: 60,
        },
      ],
      ["PUT", "/nodes/00000000-0000-4000-8000-000000000000/probe", { enabled: true }],
      ["PUT", "/nodes/00000000-0000-4000-8000-000000000000/addresses", { addresses: [] }],
      ["GET", "/scheduling/rules", undefined],
      [
        "POST",
        "/scheduling/rules",
        {
          clusterId: "00000000-0000-4000-8000-000000000000",
          name: "r",
          conditions: [{ metric: "cpu_percent", comparator: "gt", threshold: 90 }],
          action: "remove_node",
        },
      ],
      ["PATCH", "/scheduling/rules/00000000-0000-4000-8000-000000000000", { name: "r" }],
      ["DELETE", "/scheduling/rules/00000000-0000-4000-8000-000000000000", undefined],
      ["GET", "/clusters/00000000-0000-4000-8000-000000000000/scheduling/preview", undefined],
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

  it("keeps the 403 matrix: missing scopes and read-only keys", async () => {
    const site = await admin.sites.create({
      name: "s",
      domains: ["s.sa.test"],
      origins: [{ address: "o.test" }],
    });
    // A read-only user AccessKey cannot write.
    const readKey = await admin.accessKeys.create({ name: "ro", scope: "read" });
    const write = await api(readKey.key, "PUT", `/sites/${site.site.id}/enabled`, {
      enabled: false,
    });
    expect(write.status).toBe(403);
    expect(write.json.code).toBe("ACCESS_KEY_READ_ONLY");
    // A service account without the scope cannot switch a site off.
    const disable = await api(narrow, "PUT", `/sites/${site.site.id}/enabled`, {
      enabled: false,
    });
    expect(disable.status).toBe(403);
    expect(disable.json).toMatchObject({
      code: "SCOPE_REQUIRED",
      data: { scope: "sites:write" },
    });
    expect((await admin.sites.get({ id: site.site.id })).enabled).toBe(true);
  });

  it("replays a repeated Idempotency-Key and switches the site once", async () => {
    const path = `/sites/${siteId}/enabled`;
    const before = await switchesOff();
    const first = await api(
      full,
      "PUT",
      path,
      { enabled: false },
      {
        "idempotency-key": "site-off-1",
      },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("idempotent-replayed")).toBeNull();
    // Switched back on in between: running the request again would switch it off again.
    await admin.sites.setEnabled({ id: siteId, enabled: true });
    const second = await api(
      full,
      "PUT",
      path,
      { enabled: false },
      {
        "idempotency-key": "site-off-1",
      },
    );
    expect(second.status).toBe(200);
    expect(second.headers.get("idempotent-replayed")).toBe("true");
    expect(second.text).toBe(first.text);
    expect((await admin.sites.get({ id: siteId })).enabled).toBe(true);
    expect(await switchesOff()).toBe(before + 1);
    // Same key, another body: 422.
    const other = await api(
      full,
      "PUT",
      path,
      { enabled: true },
      {
        "idempotency-key": "site-off-1",
      },
    );
    expect(other.status).toBe(422);
    expect(other.json.code).toBe("IDEMPOTENCY_KEY_MISMATCH");
    // Same key, another path: 422 too.
    const otherPath = await api(
      full,
      "PUT",
      `/sites/${crypto.randomUUID()}/enabled`,
      { enabled: false },
      {
        "idempotency-key": "site-off-1",
      },
    );
    expect(otherPath.status).toBe(422);
    // The structured-field form is the same key.
    const quoted = await api(
      full,
      "PUT",
      path,
      { enabled: false },
      {
        "idempotency-key": '"site-off-1"',
      },
    );
    expect(quoted.headers.get("idempotent-replayed")).toBe("true");
    expect(await switchesOff()).toBe(before + 1);
    expect((await admin.sites.get({ id: siteId })).enabled).toBe(true);
  });

  it("stores refusals (4xx) and keeps keys per caller", async () => {
    const stale = { enabled: false, expectedUpdatedAt: "2020-01-01T00:00:00.000Z" };
    const refused = await api(full, "PUT", `/sites/${siteId}/enabled`, stale, {
      "idempotency-key": "stale-switch",
    });
    expect(refused.status).toBe(409);
    expect(refused.json.code).toBe("UPDATED_AT_MISMATCH");
    const replay = await api(full, "PUT", `/sites/${siteId}/enabled`, stale, {
      "idempotency-key": "stale-switch",
    });
    expect(replay.status).toBe(409);
    expect(replay.headers.get("idempotent-replayed")).toBe("true");
    // Another caller's key with the same value is a different key.
    const adminKey = await admin.accessKeys.create({ name: "rw", scope: "write" });
    const byUser = await api(
      adminKey.key,
      "PUT",
      `/sites/${siteId}/enabled`,
      { enabled: false },
      {
        "idempotency-key": "stale-switch",
      },
    );
    expect(byUser.status).toBe(200);
    expect(byUser.headers.get("idempotent-replayed")).toBeNull();
    expect((await admin.sites.get({ id: siteId })).enabled).toBe(false);
    await admin.sites.setEnabled({ id: siteId, enabled: true });
  });

  it("runs concurrent requests with one key exactly once (409 while in progress)", async () => {
    const before = await switchesOff();
    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        api(
          full,
          "PUT",
          `/sites/${siteId}/enabled`,
          { enabled: false },
          { "idempotency-key": "race" },
        ),
      ),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(await switchesOff()).toBe(before + 1);
    expect(statuses.filter((s) => s === 200).length).toBeGreaterThanOrEqual(1);
    for (const r of results) {
      if (r.status === 409) expect(r.json.code).toBe("IDEMPOTENCY_IN_PROGRESS");
      else if (r.status === 200 && r.headers.get("idempotent-replayed") === null)
        expect(r.json).toMatchObject({ site: { id: siteId, enabled: false } });
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
        "PUT",
        `/sites/${siteId}/enabled`,
        { enabled: true },
        {
          "idempotency-key": bad,
        },
      );
      expect(res.status, JSON.stringify(bad)).toBe(400);
      expect(res.json.code).toBe("IDEMPOTENCY_KEY_INVALID");
    }
    expect((await admin.sites.get({ id: siteId })).enabled).toBe(false);
    expect(parseIdempotencyKey('"a\\"b"')).toBe('a"b');
    expect(parseIdempotencyKey("  token  ")).toBe("token");
    const read = await api(full, "GET", "/sites", undefined, { "idempotency-key": "é" });
    expect(read.status).toBe(200);
  });

  it("does not keep 5xx responses and forgets keys after 24 hours", async () => {
    const principalKey = full;
    let calls = 0;
    const request = () =>
      new Request(`${origin}/api/v1/sites/${siteId}/enabled`, {
        method: "PUT",
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
  it("refuses an Idempotency-Key where the response carries a credential, and keeps none", async () => {
    const operator = await admin.accessKeys.create({ name: "issuer", scope: "write" });
    const [cluster] = await admin.clusters.list();
    const keysBefore = (await ctx.db.select().from(schema.serviceAccountKey)).length;
    const tokensBefore = (await ctx.db.select().from(schema.enrollmentToken)).length;
    for (const [path, body] of [
      [`/service-accounts/${accountId}/keys`, { name: "retried" }],
      ["/enrollment-tokens", { clusterId: cluster?.id }],
      ["/access-keys", { name: "minted", scope: "read" }],
    ] as const) {
      for (const attempt of [1, 2]) {
        const res = await api(operator.key, "POST", path, body, { "idempotency-key": path });
        expect(res.status, `${path} #${attempt}`).toBe(400);
        expect(res.json.code, path).toBe("IDEMPOTENCY_KEY_UNSUPPORTED");
      }
    }
    expect((await ctx.db.select().from(schema.serviceAccountKey)).length).toBe(keysBefore);
    expect((await ctx.db.select().from(schema.enrollmentToken)).length).toBe(tokensBefore);
    // Without the header the credential is returned once and only its hash is kept.
    const issued = await api(operator.key, "POST", `/service-accounts/${accountId}/keys`, {
      name: "once",
    });
    expect(issued.status).toBe(201);
    const token = await api(operator.key, "POST", "/enrollment-tokens", { clusterId: cluster?.id });
    expect(token.status).toBe(200);
    const secrets = [issued.json.secret, token.json.token] as string[];
    expect(secrets[0]).toMatch(/^ews_/);
    expect(secrets[1]).toMatch(/^ewt_/);
    const stored = JSON.stringify(await ctx.db.select().from(schema.idempotencyKey));
    for (const secret of secrets) {
      expect(stored).not.toContain(secret);
      expect(stored).not.toContain(Buffer.from(secret).toString("base64").slice(0, 24));
    }
  });

  it("records the operator behind AccessKey changes and nobody behind service accounts", async () => {
    const operator = await admin.accessKeys.create({ name: "recorder", scope: "write" });
    const operatorId = (await admin.account.me()).user.id;
    const [cluster] = await admin.clusters.list();
    await admin.sites.setEnabled({ id: siteId, enabled: true });
    const created = await api(operator.key, "POST", "/service-accounts", {
      name: "made-with-key",
      scopes: [],
    });
    expect(created.status).toBe(201);
    const token = await api(operator.key, "POST", "/enrollment-tokens", { clusterId: cluster?.id });
    expect(token.status).toBe(200);
    const task = await api(operator.key, "POST", "/cache-tasks", {
      type: "site",
      siteIds: [siteId],
    });
    expect(task.status).toBe(201);
    const off = await api(operator.key, "PUT", `/sites/${siteId}/enabled`, { enabled: false });
    expect(off.status).toBe(200);
    const latestRevision = async () =>
      (
        await ctx.db
          .select()
          .from(schema.configRevision)
          .where(eq(schema.configRevision.clusterId, cluster?.id ?? ""))
          .orderBy(desc(schema.configRevision.revision))
          .limit(1)
      )[0];
    expect((await latestRevision())?.createdByUserId).toBe(operatorId);
    const [account] = await ctx.db
      .select()
      .from(schema.serviceAccount)
      .where(eq(schema.serviceAccount.id, created.json.id as string));
    expect(account?.createdByUserId).toBe(operatorId);
    const [enrollment] = await ctx.db
      .select()
      .from(schema.enrollmentToken)
      .where(eq(schema.enrollmentToken.id, token.json.tokenId as string));
    expect(enrollment?.createdByUserId).toBe(operatorId);
    const [cacheTask] = await ctx.db
      .select()
      .from(schema.cacheTask)
      .where(eq(schema.cacheTask.id, task.json.id as string));
    expect(cacheTask?.createdByUserId).toBe(operatorId);
    // A service account's id is not a user: its publishes record nobody.
    const on = await api(full, "PUT", `/sites/${siteId}/enabled`, { enabled: true });
    expect(on.status).toBe(200);
    expect((await latestRevision())?.createdByUserId).toBeNull();
  });
});
