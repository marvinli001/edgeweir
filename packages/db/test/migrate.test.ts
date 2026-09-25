import type pg from "pg";
import { beforeEach, describe, expect, it, vi } from "vitest";

const migrated: unknown[] = [];
let migrateError: Error | null = null;

vi.mock("drizzle-orm/node-postgres/migrator", () => ({
  migrate: vi.fn(async (db: { $client: unknown }) => {
    migrated.push(db.$client);
    if (migrateError) throw migrateError;
  }),
}));

const { runMigrations } = await import("../src/migrate");

/** A pool that hands out one recording client and tracks how it is returned. */
function fakePool() {
  const queries: string[] = [];
  const released: (Error | undefined)[] = [];
  const client = {
    query: vi.fn(async (text: string) => {
      queries.push(text);
      return { rows: [], rowCount: 0 };
    }),
    release: vi.fn((error?: Error) => {
      released.push(error);
    }),
  };
  const pool = { connect: vi.fn(async () => client) };
  return { pool: pool as unknown as pg.Pool, client, queries, released, connects: pool.connect };
}

describe("runMigrations", () => {
  beforeEach(() => {
    migrated.length = 0;
    migrateError = null;
  });

  it("locks, migrates and unlocks on one dedicated connection", async () => {
    const { pool, client, queries, released, connects } = fakePool();
    await runMigrations(pool, "/migrations");
    expect(connects).toHaveBeenCalledTimes(1);
    expect(queries).toEqual([
      "select pg_advisory_lock(727274)",
      "select pg_advisory_unlock(727274)",
    ]);
    // drizzle ran the migrations on the same client that holds the lock.
    expect(migrated).toEqual([client]);
    expect(released).toEqual([undefined]);
  });

  it("unlocks and discards the connection when a migration fails", async () => {
    const { pool, queries, released } = fakePool();
    migrateError = new Error("syntax error");
    await expect(runMigrations(pool, "/migrations")).rejects.toThrow("syntax error");
    expect(queries.at(-1)).toBe("select pg_advisory_unlock(727274)");
    expect(released).toHaveLength(1);
    expect(released[0]).toBe(migrateError);
  });
});
