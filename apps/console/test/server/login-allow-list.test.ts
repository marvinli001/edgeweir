import { DEMO_EMAIL, DEMO_PASSWORD } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import type { AppContext } from "../../src/server/lib/context";
import type { Logger } from "../../src/server/lib/logger";
import { runRecover } from "../../src/server/recover-cli";
import type { Actor } from "../../src/server/services/audit";
import { demoAuditEntry } from "../../src/server/services/demo";
import {
  getLoginAllowList,
  LOGIN_ALLOW_LIST_KEY,
  loadLoginAllowList,
  logLoginRefusal,
  setLoginAllowList,
} from "../../src/server/services/login-allow-list";
import { recoverAccount } from "../../src/server/services/recovery";
import { type ApiClient, createTestContext, PASSWORD, rpcError, setupPlatform } from "./helpers";

/** Hono's node-server bindings as `app.request` receives them: the TCP peer. */
const peer = (remoteAddress: string) => ({ incoming: { socket: { remoteAddress } } });

const OFFICE = "1.2.3.7";
const ELSEWHERE = "5.6.7.8";
const actor: Actor = { type: "user", id: "user_admin", name: "Admin", ip: OFFICE };
const caller = (ip: string, more: { demo?: boolean; untrustedForwarding?: boolean } = {}) => ({
  ip,
  demo: more.demo ?? false,
  untrustedForwarding: more.untrustedForwarding ?? false,
});

/** A browser of the web console at `ip`: better-auth's endpoints and /rpc with its cookie. */
function browser(ctx: AppContext, ip: string, headers: Record<string, string> = {}) {
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let cookie = "";
  const auth = async (path: string, body?: unknown, init: { contentType?: string } = {}) => {
    const response = await app.request(
      `${origin}/api/auth${path}`,
      {
        method: body === undefined ? "GET" : "POST",
        headers: {
          origin,
          cookie,
          "content-type": init.contentType ?? "application/json",
          ...headers,
        },
        body:
          body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
      },
      peer(ip),
    );
    const set = response.headers.getSetCookie().map((c) => c.split(";")[0]);
    if (set.length > 0) cookie = set.join("; ");
    return response;
  };
  const rpc: ApiClient = createORPCClient(
    new RPCLink({
      url: `${origin}/rpc`,
      headers: () => ({ origin, cookie, ...headers }),
      fetch: (request) => Promise.resolve(app.fetch(request, peer(ip))),
      plugins: [new SimpleCsrfProtectionLinkPlugin()],
    }),
  );
  return {
    auth,
    rpc,
    signIn: (email = "admin@example.com", password = PASSWORD) =>
      auth("/sign-in/email", { email, password }),
    get cookie() {
      return cookie;
    },
    /** The same session from another address. */
    from: (other: string, otherHeaders: Record<string, string> = {}) => {
      const b = browser(ctx, other, otherHeaders);
      b.useCookie(cookie);
      return b;
    },
    useCookie: (value: string) => {
      cookie = value;
    },
  };
}

const refused = { code: "LOGIN_IP_NOT_ALLOWED", message: expect.any(String) };

describe("login allow list setting", async () => {
  const { ctx, client } = await createTestContext();
  afterAll(() => client.close());

  it("is off by default and shows the caller's address", async () => {
    expect(await getLoginAllowList(ctx.db, caller(OFFICE))).toEqual({
      cidrs: [],
      currentIp: OFFICE,
      proxyHint: false,
    });
  });

  it("hints at a proxy for special-purpose addresses and ignored forwarding headers", async () => {
    for (const ip of ["10.0.0.5", "172.18.0.1", "100.64.1.2", "fd00::1", "127.0.0.1"])
      expect((await getLoginAllowList(ctx.db, caller(ip))).proxyHint, ip).toBe(true);
    const forwarded = caller("8.8.8.8", { untrustedForwarding: true });
    expect((await getLoginAllowList(ctx.db, forwarded)).proxyHint).toBe(true);
    expect((await getLoginAllowList(ctx.db, caller("8.8.8.8"))).proxyHint).toBe(false);
  });

  it("refuses a list that leaves out the caller's own address", async () => {
    const error = await rpcError(
      setLoginAllowList(ctx.db, { cidrs: ["192.0.2.0/24"] }, actor, caller(OFFICE)),
    );
    expect(error.code).toBe("LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP");
    expect(error.data).toEqual({ ip: OFFICE });
    // An unknown address cannot be in any list.
    expect(
      (await rpcError(setLoginAllowList(ctx.db, { cidrs: ["0.0.0.0/0"] }, actor, caller("")))).code,
    ).toBe("LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP");
    // An IPv6 range does not cover an IPv4 caller.
    expect(
      (await rpcError(setLoginAllowList(ctx.db, { cidrs: ["::/0"] }, actor, caller(OFFICE)))).code,
    ).toBe("LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP");
    expect(await loadLoginAllowList(ctx.db)).toEqual([]);
  });

  it("stores the list sorted without duplicates and audits the change", async () => {
    const saved = await setLoginAllowList(
      ctx.db,
      { cidrs: ["2001:db8::/32", "1.2.3.0/24", "1.2.3.0/24"] },
      actor,
      caller(OFFICE),
    );
    expect(saved).toEqual({
      cidrs: ["1.2.3.0/24", "2001:db8::/32"],
      currentIp: OFFICE,
      proxyHint: false,
    });
    await setLoginAllowList(ctx.db, { cidrs: ["1.2.3.7/32"] }, actor, caller(OFFICE));
    const entries = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.login_allow_list_update"))
      .orderBy(schema.auditLog.id);
    expect(entries.map((e) => [e.targetId, e.metadata])).toEqual([
      [
        LOGIN_ALLOW_LIST_KEY,
        {
          cidrs: ["1.2.3.0/24", "2001:db8::/32"],
          added: ["1.2.3.0/24", "2001:db8::/32"],
          removed: [],
        },
      ],
      [
        LOGIN_ALLOW_LIST_KEY,
        {
          cidrs: ["1.2.3.7/32"],
          added: ["1.2.3.7/32"],
          removed: ["1.2.3.0/24", "2001:db8::/32"],
        },
      ],
    ]);
  });

  it("shows the demo account the ranges cut to /24 and /48", async () => {
    await setLoginAllowList(
      ctx.db,
      { cidrs: ["1.2.3.7/32", "1.2.3.128/25", "2001:db8:1:2::/64", "10.0.0.0/8"] },
      actor,
      caller(OFFICE),
    );
    expect((await getLoginAllowList(ctx.db, caller(ELSEWHERE, { demo: true }))).cidrs).toEqual([
      "1.2.3.0/24",
      "10.0.0.0/8",
      "2001:db8:1::/48",
    ]);
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.login_allow_list_update"))
      .orderBy(schema.auditLog.id)
      .limit(1);
    if (!entry) throw new Error("no audit entry");
    const seen = demoAuditEntry({
      ...entry,
      ip: entry.ip ?? "",
    } as unknown as Parameters<typeof demoAuditEntry>[0]);
    expect(seen.metadata).toEqual({
      cidrs: ["1.2.3.0/24", "2001:db8::/32"],
      added: ["1.2.3.0/24", "2001:db8::/32"],
      removed: [],
    });
  });

  it("turns off with an empty list, removing the setting", async () => {
    await setLoginAllowList(ctx.db, { cidrs: [] }, actor, caller(""));
    const rows = await ctx.db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, LOGIN_ALLOW_LIST_KEY));
    expect(rows).toEqual([]);
  });
});

describe("refused requests in the log", () => {
  it("logs an address once per minute and at most 20 lines, counting the rest", () => {
    const warn = vi.fn();
    const log = { warn } as unknown as Logger;
    const t = 1_000_000_000;
    logLoginRefusal(log, "203.0.113.1", "/api/auth/sign-in/email", t);
    logLoginRefusal(log, "203.0.113.1", "/rpc/account/me", t + 1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toEqual({
      component: "login-allow-list",
      ip: "203.0.113.1",
      path: "/api/auth/sign-in/email",
    });
    for (let i = 2; i < 40; i++) logLoginRefusal(log, `203.0.113.${i}`, "/x", t + i);
    expect(warn).toHaveBeenCalledTimes(20);
    // Each line counts the ones left out before it.
    expect(warn.mock.calls[1]?.[1]).toMatchObject({ ip: "203.0.113.2", suppressed: 1 });
    expect(warn.mock.calls[2]?.[1]).not.toHaveProperty("suppressed");
    logLoginRefusal(log, "203.0.113.1", "/x", t + 60_000);
    expect(warn).toHaveBeenCalledTimes(21);
    expect(warn.mock.calls[20]?.[1]).toMatchObject({ ip: "203.0.113.1", suppressed: 19 });
  });
});

describe("signing in and sessions outside the login allow list", async () => {
  const { ctx, client } = await createTestContext({
    EDGEWEIR_TRUSTED_PROXIES: "10.0.0.0/8",
  });
  const office = browser(ctx, OFFICE);
  let accessKey = "";
  afterAll(() => client.close());
  beforeAll(async () => {
    await setupPlatform(ctx);
    expect((await office.signIn()).status).toBe(200);
    accessKey = (await office.rpc.accessKeys.create({ name: "automation", scope: "read" })).key;
    expect(await office.rpc.settings.setLoginAllowList({ cidrs: ["1.2.3.0/24"] })).toEqual({
      cidrs: ["1.2.3.0/24"],
      currentIp: OFFICE,
      proxyHint: false,
    });
  });

  it("refuses a list without the address saving it", async () => {
    const error = await rpcError(
      office.rpc.settings.setLoginAllowList({ cidrs: ["192.0.2.0/24"] }),
    );
    expect(error.code).toBe("LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP");
    expect(error.status).toBe(400);
  });

  it("lets addresses in the list sign in and use their session", async () => {
    const b = browser(ctx, "1.2.3.200");
    expect((await b.signIn()).status).toBe(200);
    expect((await b.rpc.account.me()).demo).toBe(false);
    expect((await b.auth("/get-session")).status).toBe(200);
  });

  it("refuses sign-in elsewhere before checking the password", async () => {
    const b = browser(ctx, ELSEWHERE);
    for (const password of [PASSWORD, "not the password at all"]) {
      const response = await b.signIn("admin@example.com", password);
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual(refused);
      expect(response.headers.getSetCookie()).toEqual([]);
    }
    // No sign_in_failed entries: refusals are logged, not audited.
    const failed = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "auth.sign_in_failed"));
    expect(failed).toEqual([]);
  });

  it("refuses the second factor, passkeys and account changes elsewhere", async () => {
    const b = office.from(ELSEWHERE);
    for (const [path, body] of [
      ["/get-session", undefined],
      ["/two-factor/verify-totp", { code: "123456" }],
      ["/two-factor/verify-backup-code", { code: "abcde-fghij" }],
      ["/passkey/generate-authenticate-options", undefined],
      ["/passkey/verify-authentication", { response: {} }],
      ["/passkey/list-user-passkeys", undefined],
      ["/change-password", { currentPassword: PASSWORD, newPassword: "x".repeat(20) }],
      ["/two-factor/enable", { password: PASSWORD }],
    ] as const) {
      const response = await b.auth(path, body);
      expect(response.status, path).toBe(403);
      expect(await response.json(), path).toEqual(refused);
    }
  });

  it("refuses a session cookie on /rpc elsewhere but keeps public procedures", async () => {
    const stolen = office.from(ELSEWHERE);
    const error = await rpcError(stolen.rpc.account.me());
    expect(error.code).toBe("LOGIN_IP_NOT_ALLOWED");
    expect(error.status).toBe(403);
    expect((await stolen.rpc.system.status()).initialized).toBe(true);
    // The session itself still works from the office.
    expect((await office.rpc.account.me()).demo).toBe(false);
  });

  it("does not take a large /rpc body from a session elsewhere", async () => {
    const app = createApp(ctx);
    const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
    const send = (ip: string) =>
      app.request(
        `${origin}/rpc/settings/none`,
        {
          method: "POST",
          headers: {
            origin,
            cookie: office.cookie,
            "content-type": "application/json",
            "x-csrf-token": "orpc",
          },
          body: JSON.stringify({ json: { pad: "x".repeat(2 << 20) } }),
        },
        peer(ip),
      );
    expect((await send(ELSEWHERE)).status).toBe(413);
    expect((await send(OFFICE)).status).not.toBe(413);
  });

  it("lets a session sign out from anywhere", async () => {
    const b = browser(ctx, "1.2.3.201");
    expect((await b.signIn()).status).toBe(200);
    const away = b.from(ELSEWHERE);
    expect((await away.auth("/sign-out", {})).status).toBe(200);
    expect((await b.auth("/get-session")).status).toBe(200);
    expect(await (await b.auth("/get-session")).json()).toBeNull();
  });

  it("does not limit AccessKeys on /api/v1", async () => {
    const app = createApp(ctx);
    const response = await app.request(
      `${ctx.env.EDGEWEIR_PUBLIC_URL}/api/v1/settings/login-allow-list`,
      { headers: { "x-api-key": accessKey } },
      peer(ELSEWHERE),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      cidrs: ["1.2.3.0/24"],
      currentIp: ELSEWHERE,
    });
  });

  it("checks the client a trusted proxy forwards, never a spoofed header", async () => {
    // Through the trusted proxy: the forwarded client decides.
    expect((await browser(ctx, "10.0.0.2", { "x-forwarded-for": OFFICE }).signIn()).status).toBe(
      200,
    );
    expect(
      (await browser(ctx, "10.0.0.2", { "x-forwarded-for": `${OFFICE}, ${ELSEWHERE}` }).signIn())
        .status,
    ).toBe(403);
    // A client claiming an office address directly is judged by its own.
    const spoofed = browser(ctx, ELSEWHERE, { "x-forwarded-for": OFFICE, "x-real-ip": OFFICE });
    expect((await spoofed.signIn()).status).toBe(403);
    // IPv4-mapped peers count as their IPv4 address.
    expect((await browser(ctx, `::ffff:${OFFICE}`).signIn()).status).toBe(200);
  });

  it("shows the address it resolved and hints when forwarding headers were ignored", async () => {
    const proxied = browser(ctx, "10.0.0.2", { "x-forwarded-for": OFFICE });
    expect((await proxied.signIn()).status).toBe(200);
    expect(await proxied.rpc.settings.loginAllowList()).toEqual({
      cidrs: ["1.2.3.0/24"],
      currentIp: OFFICE,
      proxyHint: false,
    });
    const direct = browser(ctx, OFFICE, { "x-forwarded-for": "8.8.8.8" });
    expect((await direct.signIn()).status).toBe(200);
    expect((await direct.rpc.settings.loginAllowList()).proxyHint).toBe(true);
  });

  describe("the demo account", () => {
    beforeAll(async () => {
      await office.rpc.settings.setDemo({ enabled: true });
    });
    afterAll(async () => {
      await office.rpc.settings.setDemo({ enabled: false });
    });

    it("signs in and reads from anywhere, seeing the ranges cut down", async () => {
      const demo = browser(ctx, ELSEWHERE);
      expect((await demo.signIn(DEMO_EMAIL.toUpperCase(), DEMO_PASSWORD)).status).toBe(200);
      expect((await demo.rpc.account.me()).demo).toBe(true);
      expect((await demo.auth("/get-session")).status).toBe(200);
      expect(await demo.rpc.settings.loginAllowList()).toEqual({
        cidrs: ["1.2.3.0/24"],
        currentIp: ELSEWHERE,
        proxyHint: false,
      });
      expect((await rpcError(demo.rpc.settings.setLoginAllowList({ cidrs: [] }))).code).toBe(
        "DEMO_READ_ONLY",
      );
    });

    it("does not open the operator's sign-in", async () => {
      const b = browser(ctx, ELSEWHERE);
      // Only a JSON body naming the demo e-mail passes, as better-auth reads it.
      const form = `email=${encodeURIComponent(DEMO_EMAIL)}&password=${DEMO_PASSWORD}`;
      const asForm = await b.auth("/sign-in/email", form, {
        contentType: "application/x-www-form-urlencoded",
      });
      expect(asForm.status).toBe(403);
      expect((await b.signIn(` ${DEMO_EMAIL}`, DEMO_PASSWORD)).status).toBe(403);
      expect((await b.signIn("admin@example.com", PASSWORD)).status).toBe(403);
    });

    it("is limited like everyone once switched off", async () => {
      await office.rpc.settings.setDemo({ enabled: false });
      try {
        expect((await browser(ctx, ELSEWHERE).signIn(DEMO_EMAIL, DEMO_PASSWORD)).status).toBe(403);
      } finally {
        await office.rpc.settings.setDemo({ enabled: true });
      }
    });
  });

  it("is cleared by recover.js, which signs every session out", async () => {
    const stdout: string[] = [];
    const io = {
      stdin: process.stdin,
      stdout: { write: (text: string) => stdout.push(text) },
      stderr: { write: () => {} },
    };
    const connect = () => ({ db: ctx.db, auth: ctx.auth, close: async () => {} });
    expect(await runRecover(["--clear-login-allowlist"], io, connect)).toBe(0);
    expect(stdout.join("")).toMatch(
      /^Account: Platform Admin <admin@example\.com>\nLogin allow list cleared \(1 range\)\.\nSigned out \d+ sessions?\.\n$/,
    );
    expect(await loadLoginAllowList(ctx.db)).toEqual([]);
    const [entry] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "account.recover"));
    expect(entry?.metadata).toMatchObject({
      passwordReset: false,
      twoFactorDisabled: false,
      loginAllowListCleared: ["1.2.3.0/24"],
    });
    // The office's session is gone; everyone may sign in again.
    expect((await rpcError(office.rpc.account.me())).code).toBe("UNAUTHORIZED");
    expect((await browser(ctx, ELSEWHERE).signIn()).status).toBe(200);

    stdout.length = 0;
    expect(await runRecover(["--clear-login-allowlist"], io, connect)).toBe(0);
    expect(stdout.join("")).toContain("The login allow list was already off.\n");
    expect(
      (await recoverAccount(ctx, { clearLoginAllowList: true })).loginAllowListCleared,
    ).toEqual([]);
  });
});
