import { siteCreateInput } from "@edgeweir/contract";
import { createDatabase, type Database, runMigrations, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MasterKey } from "../../src/server/lib/envelope";
import type { Actor } from "../../src/server/services/audit";
import { createCluster } from "../../src/server/services/clusters";
import { replaceOriginHealth } from "../../src/server/services/origin-health";
import { createSite, deleteSite } from "../../src/server/services/sites";
import { seedOperator, TEST_MASTER_KEY } from "./helpers";

/**
 * A site deleted while a writer of rows that reference it runs, on a real
 * PostgreSQL: PGlite runs one transaction at a time and cannot interleave
 * them. TEST_DATABASE_URL names a database whose user may create databases;
 * the tests work in a database of their own and drop it afterwards.
 */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("site deletion against concurrent writers (PostgreSQL)", () => {
  const name = `edgeweir_locks_${process.pid}_${Date.now()}`;
  const masterKey = new MasterKey(TEST_MASTER_KEY);
  const actor: Actor = { type: "user", id: "user_admin", name: "Admin" };
  const opened: pg.Client[] = [];
  let admin: pg.Client;
  let testUrl: string;
  let handle: ReturnType<typeof createDatabase>;
  let db: Database;
  let clusterId: string;
  let node: { id: string; clusterId: string };

  beforeAll(async () => {
    admin = new pg.Client({ connectionString: url });
    await admin.connect();
    await admin.query(`create database "${name}"`);
    const target = new URL(url ?? "");
    target.pathname = `/${name}`;
    testUrl = target.toString();
    handle = createDatabase(testUrl, () => {});
    db = handle.db;
    await runMigrations(handle.pool);
    await seedOperator(db);
    clusterId = (await createCluster(db, { name: "default", description: "" }, actor)).id;
    const [row] = await db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-1",
        enrolledAt: new Date(Date.now() - 86_400_000),
        lastSeenAt: new Date(),
      })
      .returning();
    if (!row) throw new Error("node missing");
    node = { id: row.id, clusterId };
  });

  afterAll(async () => {
    for (const client of opened) await client.end().catch(() => {});
    await handle?.pool.end();
    await admin?.query(`drop database if exists "${name}" with (force)`);
    await admin?.end();
  });

  /**
   * A connection of its own, as the console's pool would hand one out. With
   * `pauseAfter`, its first statement whose SQL matches stops the caller
   * (inside its transaction, locks held) until `release`.
   */
  async function connection(pauseAfter?: RegExp) {
    const client = new pg.Client({ connectionString: testUrl });
    opened.push(client);
    await client.connect();
    const pid: number = (await client.query("select pg_backend_pid() as pid")).rows[0].pid;
    let reached = () => {};
    let release = () => {};
    const paused = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    if (pauseAfter) {
      const query = client.query.bind(client) as (...args: unknown[]) => Promise<unknown>;
      let armed = true;
      Object.assign(client, {
        query: async (...args: unknown[]) => {
          const result = await query(...args);
          const config = args[0];
          const text = typeof config === "string" ? config : (config as { text: string }).text;
          if (armed && pauseAfter.test(text)) {
            armed = false;
            reached();
            await released;
          }
          return result;
        },
      });
    }
    const conn = drizzle({ client, schema, casing: "snake_case" }) as unknown as Database;
    return { db: conn, pid, paused, release };
  }

  /** Resolves once the backend waits for a lock another transaction holds. */
  async function waitsForLock(pid: number) {
    for (let i = 0; i < 400; i++) {
      const { rows } = await admin.query(
        "select wait_event_type from pg_stat_activity where pid = $1",
        [pid],
      );
      if (rows[0]?.wait_event_type === "Lock") return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`backend ${pid} never waited for a lock`);
  }

  async function seedSite(label: string) {
    const { site } = await createSite(
      db,
      siteCreateInput.parse({
        name: label,
        domains: [`www.${label}.test`],
        origins: [{ address: `origin.${label}.test` }],
      }),
      { actor, masterKey },
    );
    const [origin] = site.origins;
    if (!origin) throw new Error("origin missing");
    return { siteId: site.id, originId: origin.id };
  }

  const failing = (siteId: string, originId: string) => ({
    siteId,
    originId,
    source: "passive" as const,
    healthy: false,
    consecutiveFailures: 3,
    lastError: "HTTP 503",
    lastFailureAt: new Date(),
    downUntil: null,
  });

  const healthOf = (siteId: string) =>
    db.select().from(schema.originHealth).where(eq(schema.originHealth.siteId, siteId));

  it("deletes a site while a heartbeat replaces the node's origin health", async () => {
    const { siteId, originId } = await seedSite("health");
    await replaceOriginHealth(db, node, [failing(siteId, originId)]);
    // The heartbeat has replaced the node's stored entries (the site's among
    // them) when the site is deleted; then it writes the reported ones.
    const heartbeat = await connection(/^delete from "origin_health"/i);
    const deletion = await connection();
    const reporting = heartbeat.db.transaction((tx) =>
      replaceOriginHealth(tx, node, [failing(siteId, originId)]),
    );
    await heartbeat.paused;
    const deleting = deleteSite(deletion.db, siteId, { actor });
    await waitsForLock(deletion.pid);
    heartbeat.release();
    expect(await Promise.allSettled([reporting, deleting])).toMatchObject([
      { status: "fulfilled", value: 1 },
      { status: "fulfilled" },
    ]);
    expect(await healthOf(siteId)).toEqual([]);
  });

  it("drops the origin health of a site deleted while the heartbeat waited for it", async () => {
    const { siteId, originId } = await seedSite("gone");
    await replaceOriginHealth(db, node, [failing(siteId, originId)]);
    const deletion = await connection(/^delete from "site"/i);
    const heartbeat = await connection();
    const deleting = deleteSite(deletion.db, siteId, { actor });
    await deletion.paused;
    const reporting = heartbeat.db.transaction((tx) =>
      replaceOriginHealth(tx, node, [failing(siteId, originId)]),
    );
    await waitsForLock(heartbeat.pid);
    deletion.release();
    expect(await Promise.allSettled([reporting, deleting])).toMatchObject([
      { status: "fulfilled", value: 0 },
      { status: "fulfilled" },
    ]);
    expect(await healthOf(siteId)).toEqual([]);
  });
});
