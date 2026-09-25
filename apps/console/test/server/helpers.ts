import { type Database, defaultMigrationsFolder, schema } from "@edgeweir/db";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import type pg from "pg";
import { createAuth } from "../../src/server/lib/auth";
import type { AppContext } from "../../src/server/lib/context";
import { loadEnv } from "../../src/server/lib/env";
import { MasterKey } from "../../src/server/lib/envelope";
import { ConfigEventBus } from "../../src/server/lib/events";
import { createLogger, setLogLevel } from "../../src/server/lib/logger";
import { CertificateAuthority, generateCa } from "../../src/server/pki/ca";

export const TEST_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

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

export async function createTestContext(overrides: Record<string, string> = {}) {
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
  const ctx: AppContext = {
    env,
    db,
    pool: undefined as unknown as pg.Pool,
    auth: createAuth({ db, secret: env.BETTER_AUTH_SECRET, publicUrl: env.EDGEWEIR_PUBLIC_URL }),
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
