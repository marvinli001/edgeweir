import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";

// 0044 drops the per-site node_offline alert states: node_offline is one
// alert per node now (audit 2026-10-01 P1-38).

function migrationsUntil(tag: string): string {
  const dir = mkdtempSync(join(tmpdir(), "edgeweir-migrations-"));
  cpSync(defaultMigrationsFolder, dir, { recursive: true });
  const journalPath = join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
  journal.entries = journal.entries.slice(0, journal.entries.findIndex((e) => e.tag === tag) + 1);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

const client = new PGlite();
const db = drizzle({ client });
const before = migrationsUntil("0043_stats_marker_generation");
const site = "00000000-0000-4000-8000-000000000001";
const node = "00000000-0000-4000-8000-000000000002";

beforeAll(async () => {
  await migrate(db, { migrationsFolder: before, migrationsSchema: "drizzle" });
  await client.exec(
    `insert into cluster (id, name) values ('00000000-0000-4000-8000-000000000003', 'c');
     insert into site (id, name, cluster_id) values ('${site}', 's', '00000000-0000-4000-8000-000000000003');
     insert into alert_state (key, site_id, kind, resource_id, active) values
      ('node_offline/${site}/${node}', '${site}', 'node_offline', '${node}', true),
      ('high_5xx/${site}/${site}', '${site}', 'high_5xx', '${site}', true),
      ('dns_mass_removal_blocked/platform/x', null, 'dns_mass_removal_blocked', 'x', true)`,
  );
  await migrate(db, { migrationsFolder: defaultMigrationsFolder, migrationsSchema: "drizzle" });
});
afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

describe("0044_node_offline_per_node", () => {
  it("drops only the per-site node_offline states", async () => {
    const rows = (await client.query<{ key: string }>("select key from alert_state order by key"))
      .rows;
    expect(rows.map((r) => r.key)).toEqual([
      "dns_mass_removal_blocked/platform/x",
      `high_5xx/${site}/${site}`,
    ]);
  });
});
