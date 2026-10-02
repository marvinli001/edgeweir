import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";

// 0046 lets one subscription cover a set of sites (audit U-9): the former
// rows, one per account, site and channel, fold into one per account and
// channel.

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
const before = migrationsUntil("0045_rollout_policy_updated_at");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cluster = id(1);
const [s1, s2, s3] = [id(11), id(12), id(13)];
const [c1, c2, c3, c4] = [id(21), id(22), id(23), id(24)];
const single = id(34);
const q = async <T>(sql: string) => (await client.query<T>(sql)).rows;

beforeAll(async () => {
  await migrate(db, { migrationsFolder: before, migrationsSchema: "drizzle" });
  await client.exec(`
    insert into "user" (id, name, email, created_at, updated_at) values
      ('u1', 'Operator', 'op@example.test', now(), now());
    insert into cluster (id, name) values ('${cluster}', 'c');
    insert into site (id, name, cluster_id) values
      ('${s1}', 's1', '${cluster}'), ('${s2}', 's2', '${cluster}'), ('${s3}', 's3', '${cluster}');
    insert into alert_channel (id, name, kind, config_envelope) values
      ('${c1}', 'c1', 'webhook', '{}'), ('${c2}', 'c2', 'webhook', '{}'),
      ('${c3}', 'c3', 'webhook', '{}'), ('${c4}', 'c4', 'webhook', '{}');
    insert into alert_subscription (id, user_id, site_id, channel_id, kinds, enabled) values
      -- Both enabled: one subscription with both sites and every kind.
      ('${id(31)}', 'u1', '${s1}', '${c1}', '{node_offline}', true),
      ('${id(32)}', 'u1', '${s2}', '${c1}', '{high_5xx,node_offline}', true),
      -- One paused: it sent nothing, so its site and kinds stay out.
      ('${id(33)}', 'u1', '${s1}', '${c2}', '{cc_mitigation}', true),
      ('${id(35)}', 'u1', '${s2}', '${c2}', '{origin_unavailable}', false),
      -- All paused: kept paused with every site and kind.
      ('${id(36)}', 'u1', '${s1}', '${c3}', '{node_offline}', false),
      ('${id(37)}', 'u1', '${s3}', '${c3}', '{high_5xx}', false),
      -- A single row keeps its id.
      ('${single}', 'u1', '${s3}', '${c4}', '{certificate_expiring}', true);
  `);
  await migrate(db, { migrationsFolder: defaultMigrationsFolder, migrationsSchema: "drizzle" });
});
afterAll(async () => {
  await client.close();
  rmSync(before, { recursive: true, force: true });
});

const subscriptions = () =>
  q<{ id: string; channel: string; sites: string[]; kinds: string[]; enabled: boolean }>(`
    select a.id, c.name as channel, a.kinds, a.enabled,
      array(select s.name from alert_subscription_site m join site s on s.id = m.site_id
            where m.subscription_id = a.id order by s.name) as sites
    from alert_subscription a join alert_channel c on c.id = a.channel_id
    where a.user_id = 'u1' and not a.all_sites order by c.name`);

describe("0046_alert_subscription_sites", () => {
  it("folds the rows of an account and channel into one subscription of a set of sites", async () => {
    expect((await subscriptions()).map(({ id: _id, ...rest }) => rest)).toEqual([
      { channel: "c1", sites: ["s1", "s2"], kinds: ["high_5xx", "node_offline"], enabled: true },
      { channel: "c2", sites: ["s1"], kinds: ["cc_mitigation"], enabled: true },
      { channel: "c3", sites: ["s1", "s3"], kinds: ["high_5xx", "node_offline"], enabled: false },
      { channel: "c4", sites: ["s3"], kinds: ["certificate_expiring"], enabled: true },
    ]);
    expect((await subscriptions()).find((s) => s.channel === "c4")?.id).toBe(single);
    expect(await q("select count(*)::int as n from alert_subscription")).toEqual([{ n: 4 }]);
  });

  it("keeps one subscription per account and channel", async () => {
    await expect(
      client.query(
        `insert into alert_subscription (user_id, channel_id, kinds) values ('u1', '${c1}', '{high_5xx}')`,
      ),
    ).rejects.toThrow();
    const columns = await q<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'alert_subscription' and column_name = 'site_id'",
    );
    expect(columns).toEqual([]);
  });

  it("drops a deleted site out of the sets and a deleted subscription's sites with it", async () => {
    await client.query(`delete from site where id = '${s1}'`);
    expect((await subscriptions()).map((s) => [s.channel, s.sites])).toEqual([
      ["c1", ["s2"]],
      ["c2", []],
      ["c3", ["s3"]],
      ["c4", ["s3"]],
    ]);
    await client.query(`delete from alert_subscription where channel_id = '${c3}'`);
    expect(
      await q(`select site_id from alert_subscription_site where site_id = '${s3}' order by 1`),
    ).toHaveLength(1);
  });
});
