import "reflect-metadata";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDatabase,
  type Database,
  defaultMigrationsFolder,
  runMigrations,
  schema,
} from "@edgeweir/db";
import { eq, type SQL } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MasterKey } from "../../src/server/lib/envelope";
import { systemActor } from "../../src/server/services/audit";
import { createCluster } from "../../src/server/services/clusters";
import { setListenPorts } from "../../src/server/services/edge";
import { updateNodeExtensionSettings } from "../../src/server/services/extension-node-settings";
import {
  activateExtensionVersion,
  extensionSecretBinding,
  updateExtension,
} from "../../src/server/services/extensions";
import type { Tx } from "../../src/server/services/revisions";
import { kid, PUBLIC_JWK } from "./extension-fixtures";
import { seedNodeExtension } from "./extension-node-fixtures";

/** Pause after the real transaction acquires the lock, before it reads any port state. */
function pauseAtPortLock(db: Database) {
  const acquired = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  const dialect = new PgDialect();
  let paused = false;
  const gated = new Proxy(db, {
    get(target, property) {
      if (property === "transaction")
        return (work: (tx: Tx) => Promise<unknown>) =>
          target.transaction((tx) =>
            work(
              new Proxy(tx, {
                get(transaction, key) {
                  if (key === "execute")
                    return async (query: SQL) => {
                      const result = await transaction.execute(query);
                      if (
                        !paused &&
                        dialect.sqlToQuery(query).params.includes("edgeweir.listener-ports")
                      ) {
                        paused = true;
                        acquired.resolve();
                        await resume.promise;
                      }
                      return result;
                    };
                  const value = Reflect.get(transaction, key);
                  return typeof value === "function" ? value.bind(transaction) : value;
                },
              }),
            ),
          );
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { db: gated, acquired: acquired.promise, resume: () => resume.resolve() };
}

// This URL must point to a test PostgreSQL role allowed to create temporary databases.
const postgres = process.env.EDGEWEIR_TEST_POSTGRES_URL;
describe.runIf(!!postgres)("listener port transactions on PostgreSQL", () => {
  const databaseName = `extension_ports_${randomBytes(8).toString("hex")}`;
  let control: pg.Pool;
  let handle: ReturnType<typeof createDatabase>;

  beforeAll(async () => {
    control = new pg.Pool({ connectionString: postgres });
    await control.query(`create database "${databaseName}"`);
    const url = new URL(postgres as string);
    url.pathname = `/${databaseName}`;
    handle = createDatabase(url.toString(), () => {});
    await runMigrations(handle.pool);
    const key = JSON.parse(PUBLIC_JWK);
    await handle.db.insert(schema.extensionKey).values({
      kid: kid(key.x),
      publisher: "example.org",
      x: key.x,
    });
  });
  afterAll(async () => {
    await handle?.pool.end();
    await control?.query(`drop database if exists "${databaseName}"`);
    await control?.end();
  });

  it("creates the settings table, key/index, defaults and cascade on a clean PostgreSQL", async () => {
    const constraints = await handle.pool.query<{ contype: string }>(
      "select contype from pg_constraint where conrelid = 'extension_node_setting'::regclass order by contype",
    );
    expect(constraints.rows.map((row) => row.contype)).toEqual(["f", "n", "n", "n", "p"]);
    const indexes = await handle.pool.query<{ indexdef: string }>(
      "select indexdef from pg_indexes where tablename = 'extension_node_setting'",
    );
    expect(indexes.rows).toHaveLength(1);
    expect(indexes.rows[0]?.indexdef).toContain("UNIQUE INDEX");
    await expect(
      handle.pool.query("insert into extension_node_setting (extension_id) values ('missing')"),
    ).rejects.toMatchObject({ code: "23503" });
    await seedNodeExtension(handle.db, "node-cascade");
    const saved = await handle.pool.query(
      "insert into extension_node_setting (extension_id) values ('node-cascade') returning settings, updated_at",
    );
    expect(saved.rows[0]).toMatchObject({ settings: {}, updated_at: expect.any(Date) });
    await expect(
      handle.pool.query(
        "insert into extension_node_setting (extension_id) values ('node-cascade')",
      ),
    ).rejects.toMatchObject({ code: "23505" });
    await handle.db.delete(schema.extension).where(eq(schema.extension.id, "node-cascade"));
    expect((await handle.pool.query("select * from extension_node_setting")).rows).toEqual([]);
  });

  it("upgrades the accepted 0091 schema without changing old site packages, settings or sealed associations", async () => {
    const folder = mkdtempSync(join(tmpdir(), "extension-node-upgrade-"));
    const upgradeName = `${databaseName}_upgrade`;
    const url = new URL(postgres as string);
    url.pathname = `/${upgradeName}`;
    await control.query(`create database "${upgradeName}"`);
    const old = createDatabase(url.toString(), () => {});
    try {
      const journal = JSON.parse(
        readFileSync(join(defaultMigrationsFolder, "meta/_journal.json"), "utf8"),
      );
      const entries = journal.entries.filter((entry: { idx: number }) => entry.idx <= 91);
      expect(entries.at(-1)?.tag).toBe("0091_oauth_mcp");
      mkdirSync(join(folder, "meta"));
      writeFileSync(join(folder, "meta/_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries)
        copyFileSync(join(defaultMigrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
      await runMigrations(old.pool, folder);
      expect(
        (await old.pool.query("select to_regclass('extension_node_setting') as name")).rows[0]
          ?.name,
      ).toBeNull();
      const id = "legacy-site-upgrade";
      await seedNodeExtension(old.db, id, [
        { scope: undefined, hooks: ["init"], listeners: undefined },
      ]);
      const key = new MasterKey(randomBytes(32).toString("base64"));
      const secret = randomBytes(32);
      const envelope = key.seal(secret, extensionSecretBinding(id));
      await old.db
        .update(schema.extension)
        .set({
          config: { label: "old global" },
          secretEnvelope: JSON.stringify(envelope),
          secretVersion: 1,
        })
        .where(eq(schema.extension.id, id));
      const [cluster] = await old.db
        .insert(schema.cluster)
        .values({ name: "old cluster" })
        .returning();
      const [site] = await old.db
        .insert(schema.site)
        .values({ clusterId: cluster?.id ?? "", name: "old site", cnamePrefix: "old-site" })
        .returning();
      await old.db.insert(schema.siteExtension).values({
        siteId: site?.id ?? "",
        extensionId: id,
        enabled: true,
        config: { label: "old site" },
      });
      await old.db.insert(schema.siteExtensionData).values({
        siteId: site?.id ?? "",
        extensionId: id,
        name: "legacy",
        sha256: "old-digest",
        size: 3,
        content: Buffer.from([0, 1, 255]),
      });
      const tables = ["extension", "extension_version", "site_extension", "site_extension_data"];
      const before = await Promise.all(
        tables.map(async (table) => (await old.pool.query(`select * from ${table}`)).rows),
      );
      await runMigrations(old.pool);
      expect(
        await Promise.all(
          tables.map(async (table) => (await old.pool.query(`select * from ${table}`)).rows),
        ),
      ).toEqual(before);
      expect((await old.pool.query("select * from extension_node_setting")).rows).toEqual([]);
      const [retained] = await old.db.select().from(schema.extension);
      expect(
        key.open(JSON.parse(retained?.secretEnvelope ?? ""), extensionSecretBinding(id)),
      ).toEqual(secret);
      expect(() => key.open(envelope, extensionSecretBinding("another-id"))).toThrow();
      await runMigrations(old.pool);
      expect(
        await Promise.all(
          tables.map(async (table) => (await old.pool.query(`select * from ${table}`)).rows),
        ),
      ).toEqual(before);
    } finally {
      await old.pool.end();
      await control.query(`drop database if exists "${upgradeName}"`);
      rmSync(folder, { recursive: true, force: true });
    }
  });

  it("rolls back node settings when their audit cannot commit", async () => {
    const id = "node-audit-rollback";
    const cluster = await createCluster(handle.db, { name: id, description: "" }, systemActor);
    await seedNodeExtension(handle.db, id);
    const original = { listeners: {}, clusterIds: [] };
    await updateNodeExtensionSettings(handle.db, { id, settings: original }, systemActor);
    await updateExtension(handle.db, { id, enabled: true }, systemActor);
    const before = await handle.db
      .select()
      .from(schema.extensionNodeSetting)
      .where(eq(schema.extensionNodeSetting.extensionId, id));
    const audits = await handle.db.select().from(schema.auditLog);
    const revisions = await handle.db.select().from(schema.configRevision);
    await handle.pool.query(
      "alter table audit_log add constraint test_fail_node_settings_audit check (action <> 'extension.node_settings_update') not valid",
    );
    try {
      await expect(
        updateNodeExtensionSettings(
          handle.db,
          { id, settings: { clusterIds: [cluster.id] } },
          systemActor,
        ),
      ).rejects.toThrow();
      expect(
        await handle.db
          .select()
          .from(schema.extensionNodeSetting)
          .where(eq(schema.extensionNodeSetting.extensionId, id)),
      ).toEqual(before);
      expect(await handle.db.select().from(schema.auditLog)).toEqual(audits);
      expect(await handle.db.select().from(schema.configRevision)).toEqual(revisions);
    } finally {
      await handle.pool.query(
        "alter table audit_log drop constraint test_fail_node_settings_audit",
      );
    }
  });

  it("keeps active packages, settings, secrets and audits when publishing an activation fails", async () => {
    const id = "node-activation-rollback";
    const cluster = await createCluster(handle.db, { name: id, description: "" }, systemActor);
    await seedNodeExtension(handle.db, id, [{}, { secret: true }]);
    await updateNodeExtensionSettings(
      handle.db,
      { id, settings: { clusterIds: [cluster.id] } },
      systemActor,
    );
    await updateExtension(handle.db, { id, enabled: true }, systemActor);
    const tables = [
      "extension",
      "extension_version",
      "extension_node_setting",
      "config_revision",
      "audit_log",
    ];
    const before = await Promise.all(
      tables.map(async (table) => (await handle.pool.query(`select * from ${table}`)).rows),
    );
    await handle.pool.query(
      "alter table config_revision add constraint test_fail_node_activation check (reason_code <> 'extension_updated') not valid",
    );
    try {
      await expect(
        activateExtensionVersion(
          handle.db,
          new MasterKey(randomBytes(32).toString("base64")),
          { id, version: "1.0.1" },
          systemActor,
        ),
      ).rejects.toThrow();
      expect(
        await Promise.all(
          tables.map(async (table) => (await handle.pool.query(`select * from ${table}`)).rows),
        ),
      ).toEqual(before);
    } finally {
      await handle.pool.query(
        "alter table config_revision drop constraint test_fail_node_activation",
      );
    }
  });

  it.each(["extension", "edge"] as const)(
    "serializes when %s gets the port first",
    async (winner) => {
      const id = `node-race-${winner}`;
      const cluster = await createCluster(handle.db, { name: id, description: "" }, systemActor);
      await seedNodeExtension(handle.db, id);
      await updateExtension(handle.db, { id, enabled: true }, systemActor);
      const firstClient = await handle.pool.connect();
      const secondClient = await handle.pool.connect();
      const first = drizzle({ client: firstClient, schema, casing: "snake_case" });
      const second = drizzle({ client: secondClient, schema, casing: "snake_case" });
      const paused = pauseAtPortLock(first);
      const firstPid = (await firstClient.query<{ pid: number }>("select pg_backend_pid() as pid"))
        .rows[0]?.pid;
      const secondPid = (
        await secondClient.query<{ pid: number }>("select pg_backend_pid() as pid")
      ).rows[0]?.pid;
      const port = winner === "extension" ? 9800 : 9801;
      const extensionWrite = (db: Database) =>
        updateNodeExtensionSettings(
          db,
          {
            id,
            settings: {
              listeners: { status: { port, allow: ["127.0.0.1"] } },
              clusterIds: [cluster.id],
            },
          },
          systemActor,
        );
      const edgeWrite = (db: Database) =>
        setListenPorts(
          db,
          {
            clusterId: cluster.id,
            httpPorts: [port],
            httpsPorts: [],
          },
          systemActor,
        );
      const lead = (winner === "extension" ? extensionWrite : edgeWrite)(paused.db);
      let follower: Promise<unknown> | undefined;
      try {
        await paused.acquired;
        follower = (winner === "extension" ? edgeWrite : extensionWrite)(second).then(
          () => ({ code: "unexpected_success" }),
          (error: unknown) => error,
        );
        await expect
          .poll(
            async () => {
              const result = await handle.pool.query<{ blocked: boolean }>(
                "select $1::integer = any(pg_blocking_pids($2::integer)) as blocked",
                [firstPid, secondPid],
              );
              return result.rows[0]?.blocked;
            },
            { timeout: 4000, interval: 10 },
          )
          .toBe(true);
        paused.resume();
        await lead;
        expect(await follower).toMatchObject({ code: "PORT_BINDING_CONFLICT" });
        const [row] = await handle.db
          .select()
          .from(schema.cluster)
          .where(eq(schema.cluster.id, cluster.id));
        const [settings] = await handle.db
          .select()
          .from(schema.extensionNodeSetting)
          .where(eq(schema.extensionNodeSetting.extensionId, id));
        expect(row?.extraHttpPorts).toEqual(winner === "edge" ? [port] : []);
        expect(!!settings).toBe(winner === "extension");
        const audits = await handle.db
          .select()
          .from(schema.auditLog)
          .where(eq(schema.auditLog.targetId, winner === "extension" ? cluster.id : id));
        expect(
          audits.some(
            (entry) =>
              entry.action ===
              (winner === "extension"
                ? "cluster.listen_ports_update"
                : "extension.node_settings_update"),
          ),
        ).toBe(false);
      } finally {
        paused.resume();
        await Promise.allSettled([lead, ...(follower ? [follower] : [])]);
        firstClient.release();
        secondClient.release();
      }
    },
  );
});
