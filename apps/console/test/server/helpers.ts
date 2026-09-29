import { createHmac } from "node:crypto";
import type { Contract } from "@edgeweir/contract";
import { type Database, defaultMigrationsFolder, schema } from "@edgeweir/db";
import { PGlite } from "@electric-sql/pglite";
import { createORPCClient, ORPCError } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { SimpleCsrfProtectionLinkPlugin } from "@orpc/client/plugins";
import type { ContractRouterClient } from "@orpc/contract";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type pg from "pg";
import { expect } from "vitest";
import type { createApp } from "../../src/server/app";
import { createAuth } from "../../src/server/lib/auth";
import { resolveAuthSecret } from "../../src/server/lib/auth-secret";
import type { AppContext } from "../../src/server/lib/context";
import { loadEnv } from "../../src/server/lib/env";
import { MasterKey } from "../../src/server/lib/envelope";
import { ConfigEventBus } from "../../src/server/lib/events";
import { createLogger, setLogLevel } from "../../src/server/lib/logger";
import { CertificateAuthority, generateCa } from "../../src/server/pki/ca";
import { ensureSetupToken, runSetup } from "../../src/server/services/setup";

export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
export const PASSWORD = "correct horse battery";

/** An in-process PostgreSQL (PGlite) with the real migrations applied. */
export async function createTestDatabase() {
  const client = new PGlite();
  const pgliteDb = drizzle({ client, schema, casing: "snake_case" });
  await migrate(pgliteDb, {
    migrationsFolder: defaultMigrationsFolder,
    migrationsSchema: "drizzle",
  });
  // Same query builder API as node-postgres; only the driver differs.
  return { client, db: pgliteDb as unknown as Database };
}

export async function createTestContext(
  overrides: Record<string, string> = {},
  opts: { rateLimit?: boolean } = {},
) {
  const { client, db } = await createTestDatabase();
  const env = loadEnv({
    NODE_ENV: "test",
    DATABASE_URL: "postgres://unused",
    EDGEWEIR_MASTER_KEY: TEST_MASTER_KEY,
    BETTER_AUTH_SECRET: "x".repeat(40),
    EDGEWEIR_PUBLIC_URL: "http://console.test:3000",
    EDGEWEIR_NODE_API_URL: "https://localhost:8443",
    HOST: "127.0.0.1",
    NODE_API_PORT: "0",
    LOG_LEVEL: "error",
    ...overrides,
  });
  setLogLevel("error");
  const log = createLogger({ test: true });
  // PGlite is a single connection; the pool only has to hand it out.
  const pool = {
    connect: async () => ({
      query: (text: string) => client.query(text),
      release: () => {},
    }),
  } as unknown as pg.Pool;
  const ctx: AppContext = {
    env,
    db,
    pool,
    auth: createAuth({
      db,
      secret: resolveAuthSecret(env).value,
      publicUrl: env.EDGEWEIR_PUBLIC_URL,
      rateLimit: opts.rateLimit,
    }),
    masterKey: new MasterKey(TEST_MASTER_KEY),
    nodeCa: await CertificateAuthority.load(await generateCa("Test CA")),
    events: new ConfigEventBus("postgres://unused", log),
    log,
  };
  return { ctx, client };
}

export async function seedOrganization(db: Database, id = "org_test") {
  await db
    .insert(schema.user)
    .values({ id: "user_admin", name: "Admin", email: "admin@example.com", role: "admin" });
  await db
    .insert(schema.organization)
    .values({ id, name: "Test", slug: "test", createdAt: new Date() });
  await db.insert(schema.member).values({
    id: "member_1",
    organizationId: id,
    userId: "user_admin",
    role: "owner",
    createdAt: new Date(),
  });
  return { organizationId: id, userId: "user_admin" };
}

/** Runs the real first-run setup (platform admin, first organization, default cluster). */
export async function setupPlatform(ctx: AppContext) {
  const setupToken = await ensureSetupToken(ctx);
  if (!setupToken) throw new Error("already initialized");
  return runSetup(
    ctx,
    {
      setupToken,
      name: "Platform Admin",
      email: "admin@example.com",
      password: PASSWORD,
      organizationName: "Default",
    },
    { ip: "127.0.0.1", userAgent: "vitest" },
  );
}

type App = ReturnType<typeof createApp>;
export type ApiClient = ContractRouterClient<Contract>;

export async function signIn(app: App, origin: string, email: string, password = PASSWORD) {
  const res = await app.request(`${origin}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  expect(res.status, `sign in ${email}`).toBe(200);
  return (res.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
}

/** The typed oRPC client the web UI uses, talking to the in-process app over /rpc. */
export function rpcClient(app: App, origin: string, cookie = ""): ApiClient {
  const link = new RPCLink({
    url: `${origin}/rpc`,
    headers: () => ({ origin, ...(cookie ? { cookie } : {}) }),
    fetch: (request) => Promise.resolve(app.fetch(request)),
    plugins: [new SimpleCsrfProtectionLinkPlugin()],
  });
  return createORPCClient(link);
}

/** Awaits a rejected call and returns its oRPC error (fails the test otherwise). */
export async function rpcError(promise: Promise<unknown>): Promise<ORPCError<string, unknown>> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(error, "expected the call to fail").toBeInstanceOf(ORPCError);
  return error as ORPCError<string, unknown>;
}

/** RFC 6238 TOTP (SHA-1, 6 digits, 30 s), as authenticator apps compute it. */
export function totp(secretBase32: string, now = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const ch of secretBase32.replace(/=+$/, "").toUpperCase()) {
    bits += alphabet.indexOf(ch).toString(2).padStart(5, "0");
  }
  const key = Buffer.from(bits.match(/.{8}/g)?.map((b) => Number.parseInt(b, 2)) ?? []);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / 30)));
  const hmac = createHmac("sha1", key).update(counter).digest();
  const offset = (hmac[hmac.length - 1] ?? 0) & 0xf;
  const code = (hmac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, "0");
}

/** A browser-like cookie jar for multi-step better-auth flows. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  store(res: Response): Response {
    for (const line of res.headers.getSetCookie?.() ?? []) {
      const [pair = "", ...attrs] = line.split(";");
      const eq = pair.indexOf("=");
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = attrs.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (!value || expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return res;
  }

  get header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  clear() {
    this.cookies.clear();
  }
}

/** Provision routing rights explicitly in tests whose subject is downstream of onboarding. */
export async function approveSiteDomains(admin: ApiClient, siteId: string) {
  const proofs = await admin.domainOwnership.get({ siteId });
  for (const proof of proofs)
    if (!proof.verified) await admin.domainOwnership.approve({ siteId, domain: proof.domain });
  const site = await admin.sites.get({ id: siteId });
  const cluster = await admin.clusters.get({ id: site.clusterId });
  if (!cluster.latestRevision) throw new Error("approved site has no revision");
  return cluster.latestRevision;
}
