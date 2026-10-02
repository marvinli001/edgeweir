import { hkdfSync, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import {
  AUTH_SECRET_CHANGED,
  AUTH_SECRET_CHECK_KEY,
  AUTH_SECRET_HKDF,
  assertAuthSecret,
  deriveAuthSecret,
  resolveAuthSecret,
} from "../../src/server/lib/auth-secret";
import { loadEnv } from "../../src/server/lib/env";
import { MasterKey } from "../../src/server/lib/envelope";
import { assertMasterKey, MASTER_KEY_MISMATCH } from "../../src/server/lib/master-key";
import { loadOrCreateNodeCa } from "../../src/server/pki/store";
import {
  createTestContext,
  createTestDatabase,
  rpcClient,
  setupPlatform,
  signIn,
  TEST_MASTER_KEY,
} from "./helpers";

const repo = resolve(import.meta.dirname, "../../../..");
const base = {
  DATABASE_URL: "postgres://example.invalid/test",
  EDGEWEIR_MASTER_KEY: TEST_MASTER_KEY,
  EDGEWEIR_PUBLIC_URL: "https://console.example.com",
};
const otherKey = Buffer.alloc(32, 9).toString("base64");

describe("session secret derived from the master key", () => {
  it("is HKDF-SHA256 with its own salt and info, independent of the envelope KEK", () => {
    const raw = Buffer.from(TEST_MASTER_KEY, "base64");
    const secret = deriveAuthSecret(TEST_MASTER_KEY);
    expect(AUTH_SECRET_HKDF).toEqual({
      salt: "edgeweir/auth-secret/v1",
      info: "better-auth.secret",
      length: 32,
    });
    expect(secret).toBe(
      Buffer.from(
        hkdfSync("sha256", raw, "edgeweir/auth-secret/v1", "better-auth.secret", 32),
      ).toString("base64url"),
    );
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Same master key, same secret: every instance and restart agrees.
    expect(deriveAuthSecret(TEST_MASTER_KEY)).toBe(secret);
    expect(deriveAuthSecret(otherKey)).not.toBe(secret);
    const kek = Buffer.from(hkdfSync("sha256", raw, "edgeweir/kek/v1", "envelope", 32));
    expect(Buffer.from(secret, "base64url").equals(kek)).toBe(false);
    expect(Buffer.from(secret, "base64url").equals(raw)).toBe(false);
  });

  it("refuses a master key that is too short, like the envelope key", () => {
    expect(() => deriveAuthSecret(Buffer.alloc(16).toString("base64"))).toThrow(
      /at least 32 bytes/,
    );
  });

  it("lets an explicit BETTER_AUTH_SECRET win and treats empty as unset", () => {
    const explicit = "e".repeat(20) + "f".repeat(20);
    expect(resolveAuthSecret(loadEnv({ ...base, BETTER_AUTH_SECRET: explicit }))).toEqual({
      value: explicit,
      source: "environment",
    });
    for (const value of [undefined, ""]) {
      expect(resolveAuthSecret(loadEnv({ ...base, BETTER_AUTH_SECRET: value }))).toEqual({
        value: deriveAuthSecret(TEST_MASTER_KEY),
        source: "master_key",
      });
    }
    expect(() => loadEnv({ ...base, BETTER_AUTH_SECRET: "too short" })).toThrow(
      /BETTER_AUTH_SECRET/,
    );
  });

  it("meets better-auth's secret checks for any master key", () => {
    // better-auth 1.7.6 (context/create-context.ts, validateSecret) warns below
    // 32 characters or an entropy estimate of log2(unique^length) < 120 bits.
    // It skips the check under test runners, so the rule is applied here.
    const estimate = (text: string) => text.length * Math.log2(new Set(text).size);
    expect(estimate("x".repeat(40))).toBeLessThan(120);
    for (let i = 0; i < 200; i++) {
      const secret = deriveAuthSecret(randomBytes(32).toString("base64"));
      expect(secret.length).toBeGreaterThanOrEqual(32);
      expect(estimate(secret), secret).toBeGreaterThanOrEqual(120);
    }
  });

  it("is documented with the same labels in SECURITY.md", () => {
    const security = readFileSync(resolve(repo, "SECURITY.md"), "utf8");
    const [chinese = "", english = ""] = security.split('<a id="english"></a>');
    for (const text of [chinese, english]) {
      expect(text).toContain("BETTER_AUTH_SECRET");
      expect(text).toContain(AUTH_SECRET_HKDF.salt);
      expect(text).toContain(AUTH_SECRET_HKDF.info);
    }
  });
});

describe("console with the derived session secret", async () => {
  const { ctx, client } = await createTestContext({ BETTER_AUTH_SECRET: "" });
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  afterAll(() => client.close());

  it("signs in and keeps the session", async () => {
    expect(ctx.env.BETTER_AUTH_SECRET).toBeUndefined();
    await setupPlatform(ctx);
    const admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    expect((await admin.account.me()).user.email).toBe("admin@example.com");
  });
});

describe("master key check at startup", () => {
  const log = { warn: vi.fn() };

  it("names a wrong master key before the session secret check can store anything", async () => {
    const { db, client } = await createTestDatabase();
    const right = new MasterKey(TEST_MASTER_KEY);
    const wrong = new MasterKey(otherKey);
    // A database a console has started on: the CA is sealed, the check stored.
    await assertMasterKey(db, right);
    await assertAuthSecret(db, resolveAuthSecret({ EDGEWEIR_MASTER_KEY: TEST_MASTER_KEY }), log);
    await loadOrCreateNodeCa(db, right);
    const checkValue = await storedCheck(db);

    // Before this check, the derived secret was refused as "BETTER_AUTH_SECRET
    // is not set", and setting one stored a new check value.
    await expect(
      assertAuthSecret(db, resolveAuthSecret({ EDGEWEIR_MASTER_KEY: otherKey }), log),
    ).rejects.toThrow(AUTH_SECRET_CHANGED);
    const error = await assertMasterKey(db, wrong).catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(MASTER_KEY_MISMATCH);
    expect((error as Error).message).toContain(right.kid);
    expect((error as Error).message).toContain(wrong.kid);
    expect((error as Error).message).not.toContain(otherKey);
    expect(await storedCheck(db)).toEqual(checkValue);

    // The right key passes both checks.
    await assertMasterKey(db, right);
    await assertAuthSecret(db, resolveAuthSecret({ EDGEWEIR_MASTER_KEY: TEST_MASTER_KEY }), log);
    await client.close();
  });

  it("passes on a new database", async () => {
    const { db, client } = await createTestDatabase();
    await assertMasterKey(db, new MasterKey(otherKey));
    await client.close();
  });

  it("refuses a damaged master key as invalid configuration", () => {
    const spaced = Buffer.alloc(33, 0xfb).toString("base64").replaceAll("+", " ");
    for (const value of [spaced, `'${TEST_MASTER_KEY}'`, `${TEST_MASTER_KEY} `]) {
      expect(() => loadEnv({ ...base, EDGEWEIR_MASTER_KEY: value }), value).toThrow(
        /^invalid configuration:\n {2}EDGEWEIR_MASTER_KEY: is not valid base64/,
      );
    }
    expect(() =>
      loadEnv({ ...base, EDGEWEIR_MASTER_KEY: Buffer.alloc(16).toString("base64") }),
    ).toThrow(/^invalid configuration:\n {2}EDGEWEIR_MASTER_KEY: must be at least 32 bytes/);
  });
});

async function storedCheck(db: Awaited<ReturnType<typeof createTestDatabase>>["db"]) {
  return (
    await db
      .select()
      .from(schema.systemSetting)
      .where(eq(schema.systemSetting.key, AUTH_SECRET_CHECK_KEY))
  )[0]?.value;
}

describe("session secret check at startup", () => {
  const log = { warn: vi.fn() };
  const derived = { value: deriveAuthSecret(TEST_MASTER_KEY), source: "master_key" } as const;
  const explicit = (value: string) => ({ value, source: "environment" }) as const;
  const stored = async (db: Awaited<ReturnType<typeof createTestDatabase>>["db"]) =>
    (
      await db
        .select()
        .from(schema.systemSetting)
        .where(eq(schema.systemSetting.key, AUTH_SECRET_CHECK_KEY))
    )[0]?.value;

  it("records a check value for a new database, never the secret", async () => {
    const { db, client } = await createTestDatabase();
    await assertAuthSecret(db, derived, log);
    const value = await stored(db);
    expect(Object.keys(value ?? {})).toEqual(["check"]);
    expect(JSON.stringify(value)).not.toContain(derived.value);
    // Restarting with the same master key passes.
    await assertAuthSecret(db, derived, log);
    expect(log.warn).not.toHaveBeenCalled();
    await client.close();
  });

  it("refuses to fall back to the derived secret once BETTER_AUTH_SECRET was used", async () => {
    const { db, client } = await createTestDatabase();
    const secret = explicit("s".repeat(16) + "t".repeat(16) + "u".repeat(16));
    await assertAuthSecret(db, secret, log);
    await expect(assertAuthSecret(db, derived, log)).rejects.toThrow(AUTH_SECRET_CHANGED);
    // Setting the variable again is enough.
    await assertAuthSecret(db, secret, log);
    // Another master key derives another secret: refused as well.
    await expect(
      assertAuthSecret(db, { value: deriveAuthSecret(otherKey), source: "master_key" }, log),
    ).rejects.toThrow(AUTH_SECRET_CHANGED);
    expect(log.warn).not.toHaveBeenCalled();
    await client.close();
  });

  it("refuses the derived secret on a database from before this check that has users", async () => {
    const { db, client } = await createTestDatabase();
    await db.insert(schema.user).values({ id: "u1", name: "Old", email: "old@example.com" });
    await expect(assertAuthSecret(db, derived, log)).rejects.toThrow(AUTH_SECRET_CHANGED);
    expect(await stored(db)).toBeUndefined();
    // Such a database always ran with an explicit secret; keeping it passes.
    await assertAuthSecret(db, explicit("k".repeat(40)), log);
    expect(await stored(db)).toBeDefined();
    await client.close();
  });

  it("accepts a deliberately changed BETTER_AUTH_SECRET with a warning", async () => {
    log.warn.mockClear();
    const { db, client } = await createTestDatabase();
    await assertAuthSecret(db, derived, log);
    const next = explicit("n".repeat(20) + "m".repeat(20));
    await assertAuthSecret(db, next, log);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(String(log.warn.mock.calls[0]?.[0])).toMatch(/BETTER_AUTH_SECRET changed/);
    // From now on the explicit value is the one to keep.
    await expect(assertAuthSecret(db, derived, log)).rejects.toThrow(AUTH_SECRET_CHANGED);
    await client.close();
  });
});
