import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";
import * as schema from "../src/schema/index";

const client = new PGlite();
const db = drizzle({ client, schema, casing: "snake_case" });

beforeAll(async () => {
  await migrate(db, { migrationsFolder: defaultMigrationsFolder, migrationsSchema: "drizzle" });
});

afterAll(async () => {
  await client.close();
});

describe("migrations", () => {
  it("create every v0 table", async () => {
    const result = await client.query<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' order by 1",
    );
    const tables = result.rows.map((r) => r.table_name);
    for (const name of [
      "user",
      "organization",
      "member",
      "apikey",
      "cluster",
      "node_group",
      "node",
      "node_ip",
      "enrollment_token",
      "site",
      "site_domain",
      "origin_pool",
      "origin",
      "cache_rule",
      "config_revision",
      "node_config_status",
      "audit_log",
    ]) {
      expect(tables).toContain(name);
    }
  });

  it("stores revisions as bytea and enforces one site per domain", async () => {
    await db.insert(schema.organization).values({
      id: "org_1",
      name: "Default",
      slug: "default",
      createdAt: new Date(),
    });
    const [cl] = await db.insert(schema.cluster).values({ name: "default" }).returning();
    if (!cl) throw new Error("cluster not inserted");

    const ir = new Uint8Array([8, 1, 18, 3, 97, 98, 99]);
    await db
      .insert(schema.configRevision)
      .values({ clusterId: cl.id, revision: 1, contentHash: "h", ir });
    const [rev] = await db
      .select()
      .from(schema.configRevision)
      .where(eq(schema.configRevision.clusterId, cl.id));
    expect(Array.from(rev?.ir ?? [])).toEqual(Array.from(ir));

    const [a] = await db
      .insert(schema.site)
      .values({ organizationId: "org_1", clusterId: cl.id, name: "a" })
      .returning();
    const [b] = await db
      .insert(schema.site)
      .values({ organizationId: "org_1", clusterId: cl.id, name: "b" })
      .returning();
    if (!a || !b) throw new Error("sites not inserted");
    await db.insert(schema.siteDomain).values({ siteId: a.id, name: "demo.test" });
    await expect(
      db.insert(schema.siteDomain).values({ siteId: b.id, name: "demo.test" }),
    ).rejects.toThrow();
    // The same name as a wildcard suffix is a different route.
    await db.insert(schema.siteDomain).values({ siteId: b.id, name: "demo.test", wildcard: true });
  });
});
