import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";

// 0065 makes "respect" the default of cache_rule.origin_cache_control (the
// contract's default); 0066 fills site.auth_identity_headers from the access
// authentication rules stored, disabled ones included.

function migrationsUntil(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-migrations-"));
  cpSync(defaultMigrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  const end = journal.entries.findIndex((e) => e.tag === tag);
  if (end < 0) throw new Error(`unknown migration ${tag}`);
  journal.entries = journal.entries.slice(0, end + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const client = new PGlite();
const db = drizzle({ client });
const before = migrationsUntil("0064_hidden_cards");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cluster = id(1);
const [s1, s2, s3] = [id(11), id(12), id(13)];
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: before, migrationsSchema: "drizzle" });
  await client.exec(`
    insert into cluster (id, name) values ('${cluster}', 'default');
    insert into site (id, name, cluster_id, cname_prefix) values
      ('${s1}', 'one', '${cluster}', 'one'), ('${s2}', 'two', '${cluster}', 'two'),
      ('${s3}', 'three', '${cluster}', 'three');
    insert into site_auth_rule (site_id, position, kind, enabled, settings) values
      ('${s1}', 0, 'basic', true, '{"realm":"r","userHeader":true}'),
      ('${s1}', 1, 'forward', false, '{"url":"https://auth.test/","responseHeaders":["x-user","X-Groups","x-auth-user"]}'),
      ('${s1}', 2, 'url_a', true, '{"validitySeconds":60}'),
      ('${s2}', 0, 'basic', true, '{"realm":"r","userHeader":false}'),
      ('${s2}', 1, 'forward', true, '{"url":"https://auth.test/"}');
  `);
  await migrate(db, { migrationsFolder: defaultMigrationsFolder, migrationsSchema: "drizzle" });
});

afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("0065 and 0066", () => {
  it("fills the identity headers of the stored rules, disabled ones included, in their order", async () => {
    const rows = await q<{ id: string; auth_identity_headers: string[] }>(
      "select id, auth_identity_headers from site order by name",
    );
    expect(Object.fromEntries(rows.map((r) => [r.id, r.auth_identity_headers]))).toEqual({
      [s1]: ["x-auth-user", "x-user", "x-groups"],
      [s3]: [],
      [s2]: [],
    });
    await client.exec(
      `insert into site (name, cluster_id, cname_prefix) values ('four', '${cluster}', 'four')`,
    );
    const [four] = await q<{ auth_identity_headers: string[] }>(
      "select auth_identity_headers from site where name = 'four'",
    );
    expect(four?.auth_identity_headers).toEqual([]);
  });

  it("a cache rule without origin_cache_control respects the origin", async () => {
    await client.exec(`insert into cache_rule (site_id) values ('${s1}')`);
    const [rule] = await q<{ origin_cache_control: string }>(
      "select origin_cache_control from cache_rule",
    );
    expect(rule?.origin_cache_control).toBe("respect");
  });
});
