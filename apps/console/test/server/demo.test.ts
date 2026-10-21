import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  DEMO_USER_ID,
  demoAddress,
  type LogEntry,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { recordAudit } from "../../src/server/services/audit";
import { demoLogEntry } from "../../src/server/services/demo";
import { findOperator } from "../../src/server/services/recovery";
import { isInitialized } from "../../src/server/services/setup";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("demo account", async () => {
  const { ctx, client: db } = await createTestContext();
  const app = createApp(ctx),
    origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let demo: ApiClient;
  let demoCookie = "";
  const signInStatus = async (email: string, password: string) =>
    (
      await app.request(`${origin}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ email, password }),
      })
    ).status;
  const auth = (path: string, cookie: string, body: unknown = {}, method = "POST") =>
    app.request(`${origin}/api/auth${path}`, {
      method,
      headers: { origin, cookie, "content-type": "application/json" },
      body: method === "POST" ? JSON.stringify(body) : undefined,
    });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
  });
  afterAll(() => db.close());

  it("is off until the operator switches it on", async () => {
    expect(await admin.system.status()).toMatchObject({ initialized: true, demo: false });
    expect(await admin.settings.demo()).toEqual({ enabled: false });
    expect(await signInStatus(DEMO_EMAIL, DEMO_PASSWORD)).toBe(401);
  });

  it("refuses the switch while the operator's account uses the demo e-mail", async () => {
    await ctx.db
      .update(schema.user)
      .set({ email: DEMO_EMAIL })
      .where(eq(schema.user.email, "admin@example.com"));
    try {
      expect((await rpcError(admin.settings.setDemo({ enabled: true }))).code).toBe(
        "DEMO_EMAIL_TAKEN",
      );
    } finally {
      await ctx.db
        .update(schema.user)
        .set({ email: "admin@example.com" })
        .where(eq(schema.user.email, DEMO_EMAIL));
    }
    expect(await admin.settings.demo()).toEqual({ enabled: false });
  });

  it("signs the demo account in with its fixed password and leaves the operator as is", async () => {
    expect(await admin.settings.setDemo({ enabled: true })).toEqual({ enabled: true });
    expect(await admin.settings.setDemo({ enabled: true })).toEqual({ enabled: true });
    expect((await admin.system.status()).demo).toBe(true);
    demoCookie = await signIn(app, origin, DEMO_EMAIL, DEMO_PASSWORD);
    demo = rpcClient(app, origin, demoCookie);
    expect(await demo.account.me()).toMatchObject({
      user: { id: DEMO_USER_ID, email: DEMO_EMAIL },
      demo: true,
    });

    expect(await admin.account.me()).toMatchObject({
      user: { email: "admin@example.com" },
      demo: false,
    });
    expect(await signInStatus("admin@example.com", PASSWORD)).toBe(200);
    expect((await findOperator(ctx.db)).email).toBe("admin@example.com");
    expect(await isInitialized(ctx.db)).toBe(true);

    const audit = await admin.auditLogs.list({ action: "system.demo_update" });
    expect(audit.items.map((e) => e.metadata)).toEqual([{ from: false, to: true }]);
  });

  it("reads everything and changes nothing", async () => {
    expect((await demo.clusters.list()).length).toBeGreaterThan(0);
    expect((await demo.settings.get()).consoleUrl).toBe(origin);
    expect(await demo.settings.demo()).toEqual({ enabled: true });
    const clusterId = (await demo.clusters.list())[0]?.id ?? "";
    // One at a time: a call started early could reject before rpcError
    // handles it (an unhandled rejection).
    for (const call of [
      () => demo.settings.setDemo({ enabled: false }),
      () => demo.accessKeys.create({ name: "demo", scope: "write" }),
      () => demo.clusters.createEnrollmentToken({ clusterId }),
      () => demo.settings.setUsage({ retentionDays: 90, offlineThresholdMinutes: 30 }),
    ])
      expect((await rpcError(call())).code).toBe("DEMO_READ_ONLY");
    expect(await admin.settings.demo()).toEqual({ enabled: true });
    expect(await admin.accessKeys.list()).toEqual([]);
  });

  it("cannot change its password, second factor or passkeys", async () => {
    for (const [path, body, method] of [
      ["/change-password", { currentPassword: DEMO_PASSWORD, newPassword: "x".repeat(20) }],
      ["/two-factor/enable", { password: DEMO_PASSWORD }],
      ["/two-factor/disable", { password: DEMO_PASSWORD }],
      ["/passkey/generate-register-options", undefined, "GET"],
      ["/passkey/verify-registration", { response: {} }],
      ["/passkey/delete-passkey", { id: "x" }],
    ] as const) {
      const res = await auth(path, demoCookie, body, method);
      expect(res.status, path).toBe(403);
      expect(await res.json(), path).toMatchObject({ code: "DEMO_READ_ONLY" });
    }
    expect(await signInStatus(DEMO_EMAIL, DEMO_PASSWORD)).toBe(200);
    const [row] = await ctx.db
      .select({ twoFactorEnabled: schema.user.twoFactorEnabled })
      .from(schema.user)
      .where(eq(schema.user.id, DEMO_USER_ID));
    expect(row?.twoFactorEnabled).toBe(false);

    // The operator's own calls still reach better-auth (a wrong password, not DEMO_READ_ONLY).
    const operatorCookie = await signIn(app, origin, "admin@example.com");
    const operator = await auth("/two-factor/enable", operatorCookie, { password: "wrong" });
    expect(operator.status).not.toBe(403);
    expect(await operator.json()).not.toMatchObject({ code: "DEMO_READ_ONLY" });
  });

  it("sees client addresses as networks and no typed e-mails", async () => {
    await recordAudit(
      ctx.db,
      { type: "user", id: "x", name: "visitor", ip: "203.0.113.7", userAgent: "vitest" },
      {
        action: "auth.sign_in_failed",
        targetType: "user",
        targetName: "someone@example.org",
        metadata: {
          method: "email",
          code: "INVALID_EMAIL_OR_PASSWORD",
          email: "someone@example.org",
        },
      },
    );
    const asDemo = (await demo.auditLogs.list({ action: "auth.sign_in_failed" })).items[0];
    expect(asDemo).toMatchObject({ ip: "203.0.113.0/24", targetName: "" });
    expect(asDemo?.metadata).toEqual({ method: "email", code: "INVALID_EMAIL_OR_PASSWORD" });
    const asOperator = (await admin.auditLogs.list({ action: "auth.sign_in_failed" })).items[0];
    expect(asOperator).toMatchObject({ ip: "203.0.113.7", targetName: "someone@example.org" });

    expect(demoAddress("198.51.100.200")).toBe("198.51.100.0/24");
    expect(demoAddress("2001:db8:1:2::5")).toBe("2001:db8:1::/48");
    expect(demoAddress("")).toBe("");
    expect(demoAddress("unknown")).toBe("");
    const line = demoLogEntry({
      clientIp: "192.0.2.10",
      peerIp: "10.1.2.3",
      headers: { "x-forwarded-for": "192.0.2.10" },
    } as unknown as LogEntry);
    expect(line).toMatchObject({ clientIp: "192.0.2.0/24", peerIp: "10.1.2.0/24", headers: {} });
  });

  it("switching it off deletes the account and ends its sessions", async () => {
    expect(await admin.settings.setDemo({ enabled: false })).toEqual({ enabled: false });
    expect((await rpcError(demo.account.me())).code).toBe("UNAUTHORIZED");
    expect(await signInStatus(DEMO_EMAIL, DEMO_PASSWORD)).toBe(401);
    const left = await db.query<{ n: number }>(
      `select count(*)::int as n from "session" where user_id = '${DEMO_USER_ID}'`,
    );
    expect(left.rows[0]?.n).toBe(0);
    expect((await admin.system.status()).demo).toBe(false);
    expect(await signInStatus("admin@example.com", PASSWORD)).toBe(200);
  });
});
