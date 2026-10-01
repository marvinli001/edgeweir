import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";

// Upgrades a database that still has organizations (the schema up to 0030)
// to the single-operator schema and checks what happens to existing data.

const LAST_MULTI_TENANT = "0030_g3_waf";

/** A copy of the migrations folder that ends at `tag`. */
function migrationsUntil(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-migrations-"));
  cpSync(defaultMigrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string }[];
  };
  const end = journal.entries.findIndex((e) => e.tag === tag);
  if (end < 0) throw new Error(`unknown migration ${tag}`);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const client = new PGlite();
const db = drizzle({ client });
const legacy = migrationsUntil(LAST_MULTI_TENANT);
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: legacy, migrationsSchema: "drizzle" });
  await client.exec(`
    insert into organization (id, name, slug, created_at) values
      ('org_a', 'A', 'a', now()), ('org_b', 'B', 'b', now());
    insert into cluster (id, name) values ('00000000-0000-4000-8000-000000000001', 'default');
    insert into site (id, organization_id, cluster_id, name) values
      ('00000000-0000-4000-8000-00000000000a', 'org_a', '00000000-0000-4000-8000-000000000001', 'a'),
      ('00000000-0000-4000-8000-00000000000b', 'org_b', '00000000-0000-4000-8000-000000000001', 'b');
    insert into site_domain (site_id, name, verified, created_at) values
      ('00000000-0000-4000-8000-00000000000b', 'shop.test', false, now() - interval '1 day'),
      ('00000000-0000-4000-8000-00000000000a', 'shop.test', true, now()),
      ('00000000-0000-4000-8000-00000000000b', 'blog.test', false, now()),
      ('00000000-0000-4000-8000-00000000000a', 'docs.test', false, now() - interval '1 day'),
      ('00000000-0000-4000-8000-00000000000b', 'docs.test', false, now());
    insert into domain_ownership (organization_id, domain, token, verified_at) values
      ('org_a', 'shop.test', 'token', now());
    insert into system_setting (key, value) values
      ('domain_ownership_v1', '{"enabled":true}'), ('dns_resolvers', '{"servers":["1.1.1.1"]}');
  `);
  await migrate(db, { migrationsFolder: defaultMigrationsFolder, migrationsSchema: "drizzle" });
});

afterAll(async () => {
  await client.close();
  rmSync(legacy, { recursive: true, force: true });
});

describe("upgrade to a single operator", () => {
  it("routes every domain once: the verified route, else the oldest claim, keeps a name", async () => {
    const rows = await q<{ name: string; site: string }>(
      "select d.name, s.name as site from site_domain d join site s on s.id = d.site_id order by d.name",
    );
    expect(rows).toEqual([
      { name: "blog.test", site: "b" },
      { name: "docs.test", site: "a" },
      { name: "shop.test", site: "a" },
    ]);
    await expect(
      client.query(
        "insert into site_domain (site_id, name) values ('00000000-0000-4000-8000-00000000000b', 'shop.test')",
      ),
    ).rejects.toThrow();
  });

  it("drops domain ownership with its settings", async () => {
    const tables = await q<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_name = 'domain_ownership'",
    );
    expect(tables[0]?.n).toBe(0);
    const columns = await q<{ n: number }>(
      "select count(*)::int as n from information_schema.columns where table_name = 'site_domain' and column_name = 'verified'",
    );
    expect(columns[0]?.n).toBe(0);
    expect(await q("select key from system_setting order by key")).toEqual([]);
  });
});
