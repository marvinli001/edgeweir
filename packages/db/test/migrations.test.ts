import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

type JournalEntry = { idx: number; when: number; tag: string };

describe("migration journal", () => {
  const journal = JSON.parse(
    readFileSync(join(defaultMigrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: JournalEntry[] };
  const entries = journal.entries;

  it("has unique tags and contiguous indexes that match the tag prefix", () => {
    const tags = entries.map((e) => e.tag);
    expect(new Set(tags).size).toBe(tags.length);
    // Two branches must never ship the same migration number.
    const numbers = tags.map((t) => t.slice(0, 4));
    expect(new Set(numbers).size).toBe(numbers.length);
    entries.forEach((e, i) => {
      expect(e.idx).toBe(i);
      expect(e.tag.slice(0, 4)).toBe(String(i).padStart(4, "0"));
    });
  });

  it("has strictly increasing timestamps (drizzle skips migrations older than the last applied)", () => {
    for (let i = 1; i < entries.length; i++) {
      expect(entries[i]?.when).toBeGreaterThan(entries[i - 1]?.when ?? 0);
    }
  });

  it("has exactly one SQL file and one snapshot per entry", () => {
    const sql = readdirSync(defaultMigrationsFolder)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    expect(sql).toEqual(entries.map((e) => `${e.tag}.sql`));
    const snapshots = readdirSync(join(defaultMigrationsFolder, "meta"))
      .filter((f) => f.endsWith("_snapshot.json"))
      .sort();
    expect(snapshots).toEqual(entries.map((e) => `${e.tag.slice(0, 4)}_snapshot.json`));
  });
});

describe("migrations", () => {
  it("create every table", async () => {
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
      "region",
      "organization_settings",
      "node_certificate_revocation",
      "system_setting",
      "site_star",
      "origin_credential",
      "origin_health",
      "cache_task",
      "cache_task_node",
      "rate_limit",
      "ip_ban",
    ]) {
      expect(tables).toContain(name);
    }
  });

  it("stores revisions as bytea and permits only one verified route per domain", async () => {
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
    await db.insert(schema.siteDomain).values({ siteId: a.id, name: "demo.test", verified: true });
    await expect(
      db.insert(schema.siteDomain).values({ siteId: b.id, name: "demo.test", verified: true }),
    ).rejects.toThrow();
    // The same name as a wildcard suffix is a different route.
    await db
      .insert(schema.siteDomain)
      .values({ siteId: b.id, name: "demo.test", verified: true, wildcard: true });
  });

  it("detaches regions and default clusters instead of cascading deletes", async () => {
    await db.insert(schema.organization).values({
      id: "org_2",
      name: "Tenant",
      slug: "tenant",
      createdAt: new Date(),
    });
    const [cl] = await db.insert(schema.cluster).values({ name: "edge-b" }).returning();
    const [rg] = await db.insert(schema.region).values({ name: "East", code: "east" }).returning();
    if (!cl || !rg) throw new Error("not inserted");
    const [group] = await db
      .insert(schema.nodeGroup)
      .values({ clusterId: cl.id, name: "g", regionId: rg.id })
      .returning();
    await db
      .insert(schema.organizationSettings)
      .values({ organizationId: "org_2", defaultClusterId: cl.id });
    await expect(db.insert(schema.region).values({ name: "Dup", code: "east" })).rejects.toThrow();

    await db.delete(schema.region).where(eq(schema.region.id, rg.id));
    const [detached] = await db
      .select()
      .from(schema.nodeGroup)
      .where(eq(schema.nodeGroup.id, group?.id ?? ""));
    expect(detached?.regionId).toBeNull();

    await db.delete(schema.cluster).where(eq(schema.cluster.id, cl.id));
    const [settings] = await db
      .select()
      .from(schema.organizationSettings)
      .where(eq(schema.organizationSettings.organizationId, "org_2"));
    expect(settings?.defaultClusterId).toBeNull();
  });
});
