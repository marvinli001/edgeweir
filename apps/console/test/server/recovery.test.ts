import { PassThrough } from "node:stream";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import type { AppContext } from "../../src/server/lib/context";
import { type RecoverIo, runRecover } from "../../src/server/recover-cli";
import { RecoveryError, recoverAccount } from "../../src/server/services/recovery";
import { CookieJar, createTestContext, PASSWORD, setupPlatform, totp } from "./helpers";

const NEW_PASSWORD = "a brand new passphrase";

/** A browser of the web console: better-auth's endpoints with a cookie jar. */
function browser(ctx: AppContext) {
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const jar = new CookieJar();
  const call = async (path: string, body?: unknown) =>
    jar.store(
      await app.request(`${origin}/api/auth${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: { origin, cookie: jar.header, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  return {
    call,
    signIn: (password: string) => call("/sign-in/email", { email: "admin@example.com", password }),
    /** The signed-in user's id, or null without a valid session. */
    session: async () =>
      ((await (await call("/get-session")).json()) as { user: { id: string } } | null)?.user.id ??
      null,
  };
}

/** Signs in and switches TOTP on; returns the TOTP secret. */
async function enableTotp(ctx: AppContext, password = PASSWORD): Promise<string> {
  const b = browser(ctx);
  expect((await b.signIn(password)).status).toBe(200);
  const enable = await b.call("/two-factor/enable", { password });
  expect(enable.status).toBe(200);
  const { totpURI } = (await enable.json()) as { totpURI: string };
  const secret = new URL(totpURI).searchParams.get("secret") ?? "";
  expect((await b.call("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(200);
  return secret;
}

async function tableCount(ctx: AppContext, table: "session" | "two_factor", userId: string) {
  const t = table === "session" ? schema.session : schema.twoFactor;
  return (await ctx.db.select().from(t).where(eq(t.userId, userId))).length;
}

const recoveries = (ctx: AppContext) =>
  ctx.db
    .select()
    .from(schema.auditLog)
    .where(eq(schema.auditLog.action, "account.recover"))
    .orderBy(schema.auditLog.id);

/** Verification rows that stand in for a session or a second factor. */
async function standIns(ctx: AppContext): Promise<string[]> {
  const rows = await ctx.db
    .select({ identifier: schema.verification.identifier })
    .from(schema.verification);
  return rows
    .map(({ identifier }) =>
      identifier.startsWith("trust-device-")
        ? "trusted device"
        : identifier.startsWith("2fa-attempts-")
          ? "attempt counter"
          : identifier.startsWith("2fa-")
            ? "pending second factor"
            : "other",
    )
    .sort();
}

describe("recovering the account with two-factor on", async () => {
  const { ctx, client } = await createTestContext();
  let userId: string;
  let secret: string;
  afterAll(() => client.close());
  beforeAll(async () => {
    ({ userId } = await setupPlatform(ctx));
    secret = await enableTotp(ctx);
  });

  it("resets the password, turns two-factor off and signs out everywhere", async () => {
    // A signed-in browser, one that trusts its device, and a sign-in waiting for its code.
    const signedIn = browser(ctx);
    expect(await (await signedIn.signIn(PASSWORD)).json()).toMatchObject({
      twoFactorRedirect: true,
    });
    expect(
      (await signedIn.call("/two-factor/verify-totp", { code: totp(secret), trustDevice: true }))
        .status,
    ).toBe(200);
    expect(await signedIn.session()).toBe(userId);
    const pending = browser(ctx);
    expect(await (await pending.signIn(PASSWORD)).json()).toMatchObject({
      twoFactorRedirect: true,
    });
    expect(await standIns(ctx)).toEqual([
      "attempt counter",
      "pending second factor",
      "trusted device",
    ]);
    const sessions = await tableCount(ctx, "session", userId);
    expect(sessions).toBe(2);

    const result = await recoverAccount(ctx, { password: NEW_PASSWORD, disableTwoFactor: true });
    expect(result).toEqual({
      user: { id: userId, name: "Platform Admin", email: "admin@example.com" },
      passwordReset: true,
      twoFactorDisabled: true,
      sessionsRevoked: sessions,
    });

    expect(await tableCount(ctx, "session", userId)).toBe(0);
    expect(await tableCount(ctx, "two_factor", userId)).toBe(0);
    expect(await standIns(ctx)).toEqual([]);
    const [user] = await ctx.db.select().from(schema.user).where(eq(schema.user.id, userId));
    expect(user?.twoFactorEnabled).toBe(false);

    expect(await signedIn.session()).toBeNull();
    // The second factor of the earlier sign-in no longer completes it.
    expect((await pending.call("/two-factor/verify-totp", { code: totp(secret) })).status).toBe(
      401,
    );
    // The old password no longer works, not even on the trusted device.
    expect((await signedIn.signIn(PASSWORD)).status).toBe(401);
    const fresh = browser(ctx);
    const signIn = await fresh.signIn(NEW_PASSWORD);
    expect(signIn.status).toBe(200);
    expect(await signIn.json()).not.toHaveProperty("twoFactorRedirect");
    expect(await fresh.session()).toBe(userId);
  });

  it("records what changed, without the password or its hash", async () => {
    const [entry] = await recoveries(ctx);
    expect(entry).toMatchObject({
      actorType: "system",
      actorId: "",
      actorName: "recover",
      targetType: "user",
      targetId: userId,
      targetName: "Platform Admin",
      metadata: { passwordReset: true, twoFactorDisabled: true },
    });
    expect(entry?.metadata.sessionsRevoked).toBe(2);
    const [credential] = await ctx.db
      .select({ password: schema.account.password })
      .from(schema.account)
      .where(eq(schema.account.userId, userId));
    const text = JSON.stringify(entry);
    expect(text).not.toContain(NEW_PASSWORD);
    expect(text).not.toContain(credential?.password ?? "no hash");
  });
});

describe("recovering one factor", async () => {
  const { ctx, client } = await createTestContext();
  let userId: string;
  afterAll(() => client.close());
  beforeAll(async () => {
    ({ userId } = await setupPlatform(ctx));
    await enableTotp(ctx);
  });

  it("resets the password and keeps two-factor on", async () => {
    const result = await recoverAccount(ctx, { password: NEW_PASSWORD });
    expect(result).toMatchObject({ passwordReset: true, twoFactorDisabled: false });
    expect(await tableCount(ctx, "two_factor", userId)).toBe(1);
    expect((await browser(ctx).signIn(PASSWORD)).status).toBe(401);
    expect(await (await browser(ctx).signIn(NEW_PASSWORD)).json()).toMatchObject({
      twoFactorRedirect: true,
    });
  });

  it("turns two-factor off and keeps the password", async () => {
    const result = await recoverAccount(ctx, { disableTwoFactor: true });
    expect(result).toMatchObject({ passwordReset: false, twoFactorDisabled: true });
    const b = browser(ctx);
    expect((await b.signIn(NEW_PASSWORD)).status).toBe(200);
    expect(await b.session()).toBe(userId);
  });

  it("reports two-factor that was already off", async () => {
    const result = await recoverAccount(ctx, { disableTwoFactor: true });
    expect(result).toMatchObject({ twoFactorDisabled: false, sessionsRevoked: 1 });
    expect((await recoveries(ctx)).map((e) => e.metadata)).toEqual([
      { passwordReset: true, twoFactorDisabled: false, sessionsRevoked: 1 },
      { passwordReset: false, twoFactorDisabled: true, sessionsRevoked: 0 },
      { passwordReset: false, twoFactorDisabled: false, sessionsRevoked: 1 },
    ]);
  });

  it("creates the credential account when the account has none", async () => {
    await ctx.db.delete(schema.account).where(eq(schema.account.userId, userId));
    await recoverAccount(ctx, { password: PASSWORD });
    expect((await browser(ctx).signIn(PASSWORD)).status).toBe(200);
  });
});

describe("recoveries that change nothing", async () => {
  const { ctx, client } = await createTestContext();
  let userId: string;
  afterAll(() => client.close());

  it("finds no account before setup, and refuses several", async () => {
    await expect(recoverAccount(ctx, { disableTwoFactor: true })).rejects.toThrow(/no account yet/);
    await ctx.db.insert(schema.user).values([
      { id: "u1", name: "One", email: "one@example.com" },
      { id: "u2", name: "Two", email: "two@example.com" },
    ]);
    await expect(recoverAccount(ctx, { disableTwoFactor: true })).rejects.toThrow(
      /more than one account/,
    );
    await ctx.db.delete(schema.user);
    expect(await recoveries(ctx)).toEqual([]);
  });

  it("needs something to do", async () => {
    ({ userId } = await setupPlatform(ctx));
    await expect(recoverAccount(ctx, {})).rejects.toBeInstanceOf(RecoveryError);
  });

  it("keeps better-auth's password length policy", async () => {
    const b = browser(ctx);
    await b.signIn(PASSWORD);
    for (const password of ["too short", "x".repeat(129)]) {
      await expect(recoverAccount(ctx, { password })).rejects.toThrow(
        "the password must be 12–128 characters long",
      );
    }
    expect(await b.session()).toBe(userId);
    expect(await recoveries(ctx)).toEqual([]);
  });

  it("commits nothing when the audit entry cannot be written", async () => {
    await enableTotp(ctx);
    const sessions = await tableCount(ctx, "session", userId);
    await client.exec(`
      create function test_fail_recover_audit() returns trigger language plpgsql as $$
      begin
        if new.action = 'account.recover' then raise exception 'audit write failed (test)'; end if;
        return new;
      end $$;
      create trigger test_fail_recover_audit before insert on audit_log
        for each row execute function test_fail_recover_audit();
    `);
    try {
      await expect(
        recoverAccount(ctx, { password: NEW_PASSWORD, disableTwoFactor: true }),
      ).rejects.toThrow(/audit_log/);
    } finally {
      await client.exec("drop trigger test_fail_recover_audit on audit_log");
    }
    expect(await tableCount(ctx, "session", userId)).toBe(sessions);
    expect(await tableCount(ctx, "two_factor", userId)).toBe(1);
    expect((await browser(ctx).signIn(NEW_PASSWORD)).status).toBe(401);
    expect(await (await browser(ctx).signIn(PASSWORD)).json()).toMatchObject({
      twoFactorRedirect: true,
    });
  });
});

/** Standard streams of a test run; `answers` are typed into the terminal at each prompt. */
function terminal(opts: { tty: true; answers: string[] } | { tty: false; input: string }) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const stdin = new PassThrough();
  const setRawMode = vi.fn();
  if (opts.tty) {
    Object.assign(stdin, { isTTY: true, setRawMode });
  } else {
    stdin.end(opts.input);
  }
  const io: RecoverIo = {
    stdin,
    stdout: { write: (text: string) => stdout.push(text) },
    stderr: {
      write: (text: string) => {
        stderr.push(text);
        // Each answer arrives one keystroke after another, like a person typing.
        if (opts.tty && text.endsWith(": ")) {
          const answer = opts.answers.shift();
          if (answer !== undefined) {
            setImmediate(() => {
              for (const ch of answer) stdin.write(ch);
            });
          }
        }
      },
    },
  };
  return {
    io,
    setRawMode,
    get stdout() {
      return stdout.join("");
    },
    get stderr() {
      return stderr.join("");
    },
  };
}

describe("recover.js", async () => {
  const { ctx, client } = await createTestContext();
  let userId: string;
  const close = vi.fn(async () => {});
  const connect = vi.fn(() => ({ db: ctx.db, auth: ctx.auth, close }));
  afterAll(() => client.close());
  beforeAll(async () => {
    ({ userId } = await setupPlatform(ctx));
  });

  it.each([
    [["--help"], 0],
    [["-h"], 0],
    [[], 2],
    [["--reset-password", "now"], 2],
    [["--password=correct horse battery"], 2],
    [["--new-password", "correct horse battery"], 2],
  ])("%j exits with %i before connecting", async (argv, code) => {
    const t = terminal({ tty: false, input: "" });
    expect(await runRecover(argv, t.io, connect)).toBe(code);
    expect(t.stdout + t.stderr).toContain("Usage: node dist/server/recover.js");
    expect(connect).not.toHaveBeenCalled();
  });

  it("reads the password from standard input and prints nothing secret", async () => {
    await enableTotp(ctx);
    const t = terminal({ tty: false, input: `${NEW_PASSWORD}\r\nignored\n` });
    expect(await runRecover(["--reset-password", "--disable-two-factor"], t.io, connect)).toBe(0);
    expect(t.stdout).toBe(
      [
        "Account: Platform Admin <admin@example.com>",
        "Password reset.",
        "Two-factor authentication turned off.",
        "Signed out 1 session.",
        "",
      ].join("\n"),
    );
    expect(t.stderr).toBe("");
    expect(close).toHaveBeenCalledOnce();
    expect((await browser(ctx).signIn(NEW_PASSWORD)).status).toBe(200);
  });

  it("asks twice on a terminal, without echo", async () => {
    const t = terminal({ tty: true, answers: [`${PASSWORD}x\u007f\r`, `${PASSWORD}\r`] });
    expect(await runRecover(["--reset-password"], t.io, connect)).toBe(0);
    expect(t.stderr).toBe("New password: \nRepeat new password: \n");
    expect(t.stdout).not.toContain(PASSWORD);
    expect(t.setRawMode.mock.calls).toEqual([[true], [false], [true], [false]]);
    expect((await browser(ctx).signIn(PASSWORD)).status).toBe(200);
  });

  it.each([
    [
      "passwords that differ",
      [`${NEW_PASSWORD}\r`, `${NEW_PASSWORD}!\r`],
      "the passwords do not match",
    ],
    ["a short password", ["short\r"], "the password must be 12–128 characters long"],
    ["Ctrl-C", [`${NEW_PASSWORD}\u0003`], "cancelled"],
  ])("changes nothing after %s", async (_, answers, message) => {
    const recovered = (await recoveries(ctx)).length;
    const t = terminal({ tty: true, answers });
    expect(await runRecover(["--reset-password"], t.io, connect)).toBe(1);
    expect(t.stderr.endsWith(`\nerror: ${message}\n`)).toBe(true);
    expect(t.setRawMode.mock.calls.at(-1)).toEqual([false]);
    expect(await recoveries(ctx)).toHaveLength(recovered);
    expect((await browser(ctx).signIn(PASSWORD)).status).toBe(200);
  });

  it("refuses an empty standard input", async () => {
    const t = terminal({ tty: false, input: "" });
    expect(await runRecover(["--reset-password"], t.io, connect)).toBe(1);
    expect(t.stderr).toBe("error: no password on standard input\n");
  });

  it("reports a failed query without its parameters", async () => {
    await client.exec(`
      create function test_fail_password() returns trigger language plpgsql as $$
      begin raise exception 'account update failed (test)'; end $$;
      create trigger test_fail_password before update on account
        for each row execute function test_fail_password();
    `);
    const t = terminal({ tty: false, input: `${NEW_PASSWORD}\n` });
    try {
      expect(await runRecover(["--reset-password"], t.io, connect)).toBe(1);
    } finally {
      await client.exec("drop trigger test_fail_password on account");
    }
    expect(t.stderr).toBe("error: account update failed (test)\n");
    expect((await browser(ctx).signIn(PASSWORD)).status).toBe(200);
  });

  it("reports a configuration it cannot use", async () => {
    const t = terminal({ tty: false, input: "" });
    const broken = () => {
      throw new Error("invalid configuration:\n  DATABASE_URL: required");
    };
    expect(await runRecover(["--disable-two-factor"], t.io, broken)).toBe(1);
    expect(t.stderr).toBe("error: invalid configuration:\n  DATABASE_URL: required\n");
  });

  it("signs out the account's sessions when only turning two-factor off", async () => {
    const b = browser(ctx);
    await b.signIn(PASSWORD);
    expect(await b.session()).toBe(userId);
    const t = terminal({ tty: false, input: "" });
    expect(await runRecover(["--disable-two-factor"], t.io, connect)).toBe(0);
    expect(t.stdout).toContain("Two-factor authentication was already off.\n");
    expect(await b.session()).toBeNull();
  });
});
