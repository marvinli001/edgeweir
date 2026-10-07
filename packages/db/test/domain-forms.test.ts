import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";

// 0056 turns the wildcard flag into the domain form and gives every existing
// site and layer-4 application its id as CNAME prefix, so their CNAME names
// stay the same.

function migrationsUntil(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-migrations-"));
  cpSync(defaultMigrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const CLUSTER = "00000000-0000-4000-8000-0000000000c1";
const SITE = "00000000-0000-4000-8000-0000000000a1";
const APP = "00000000-0000-4000-8000-0000000000b1";

const client = new PGlite();
const db = drizzle({ client });
const before = migrationsUntil("0055_site_content");

beforeAll(async () => {
  await migrate(db, { migrationsFolder: before, migrationsSchema: "drizzle" });
  await client.query(`insert into cluster (id, name) values ('${CLUSTER}', 'edge')`);
  await client.query(
    `insert into site (id, cluster_id, name) values ('${SITE}', '${CLUSTER}', 'shop')`,
  );
  await client.query(
    `insert into site_domain (site_id, name, wildcard) values
      ('${SITE}', 'shop.test', false), ('${SITE}', 'shop.test', true)`,
  );
  await client.query(
    `insert into l4_app (id, cluster_id, name, protocol, port) values ('${APP}', '${CLUSTER}', 'ssh', 'tcp', 2222)`,
  );
  await migrate(db, { migrationsFolder: defaultMigrationsFolder, migrationsSchema: "drizzle" });
});
afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("0056_domain_forms_cname_prefix", () => {
  it("keeps exact and wildcard domains as their kind", async () => {
    const rows = (
      await client.query<{ name: string; kind: string }>(
        "select name, kind from site_domain order by kind",
      )
    ).rows;
    expect(rows).toEqual([
      { name: "shop.test", kind: "exact" },
      { name: "shop.test", kind: "wildcard" },
    ]);
  });

  it("gives existing sites and applications their id as CNAME prefix", async () => {
    const site = await client.query<{ cname_prefix: string }>("select cname_prefix from site");
    const app = await client.query<{ cname_prefix: string }>("select cname_prefix from l4_app");
    expect(site.rows).toEqual([{ cname_prefix: SITE }]);
    expect(app.rows).toEqual([{ cname_prefix: APP }]);
  });

  it("leaves the unknown host settings at their defaults", async () => {
    const rows = (
      await client.query<{ unknown_hosts: unknown; default_site_id: string | null }>(
        "select unknown_hosts, default_site_id from cluster",
      )
    ).rows;
    expect(rows).toEqual([{ unknown_hosts: null, default_site_id: null }]);
  });
});
