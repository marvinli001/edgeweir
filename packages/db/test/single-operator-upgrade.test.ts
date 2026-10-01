import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defaultMigrationsFolder } from "../src/migrate";

// Upgrades a database that still has organizations (the schema up to 0032)
// to the single-operator schema and checks what happens to existing data.

const LAST_MULTI_TENANT = "0032_g5_rules";

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
    insert into site (id, organization_id, cluster_id, name, suspended, suspend_reason) values
      ('00000000-0000-4000-8000-00000000000a', 'org_a', '00000000-0000-4000-8000-000000000001', 'a', false, null),
      ('00000000-0000-4000-8000-00000000000b', 'org_b', '00000000-0000-4000-8000-000000000001', 'b', true, 'billing');
    insert into service_account (id, name, scopes) values
      ('00000000-0000-4000-8000-0000000000c1', 'sync', '{limits:read,limits:write,sites:read,sites:suspend,usage:read}');
    insert into organization_limit (organization_id, max_sites) values ('org_a', 5);
    insert into site_domain (site_id, name, verified, created_at) values
      ('00000000-0000-4000-8000-00000000000b', 'shop.test', false, now() - interval '1 day'),
      ('00000000-0000-4000-8000-00000000000a', 'shop.test', true, now()),
      ('00000000-0000-4000-8000-00000000000b', 'blog.test', false, now()),
      ('00000000-0000-4000-8000-00000000000a', 'docs.test', false, now() - interval '1 day'),
      ('00000000-0000-4000-8000-00000000000b', 'docs.test', false, now());
    insert into domain_ownership (organization_id, domain, token, verified_at) values
      ('org_a', 'shop.test', 'token', now());
    insert into system_setting (key, value) values
      ('domain_ownership_v1', '{"enabled":true}'), ('dns_resolvers', '{"servers":["1.1.1.1"]}'),
      ('waf_settings', '{"tenantCrs":false}');
    -- The first administrator is disabled: the second one keeps the console.
    insert into "user" (id, name, email, role, banned, created_at) values
      ('u_old', 'Old admin', 'old@example.test', 'admin', true, now() - interval '3 days'),
      ('u_admin', 'Admin', 'admin@example.test', 'user,admin', false, now() - interval '2 days'),
      ('u_member', 'Member', 'member@example.test', 'user', false, now() - interval '1 day');
    insert into member (id, organization_id, user_id, role, created_at) values
      ('m1', 'org_a', 'u_admin', 'owner', now()), ('m2', 'org_b', 'u_member', 'owner', now());
    insert into apikey (id, reference_id, key, created_at, updated_at) values
      ('k_admin', 'u_admin', 'hash-a', now(), now()), ('k_member', 'u_member', 'hash-m', now(), now());
    insert into alert_channel (id, name, kind, config_envelope, available_to_tenants) values
      ('00000000-0000-4000-8000-0000000000d1', 'ops', 'webhook', '{}', true);
    insert into alert_subscription (user_id, organization_id, site_id, channel_id, kinds, enabled) values
      ('u_admin', 'org_a', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000d1', '{node_offline}', false),
      ('u_member', 'org_a', '00000000-0000-4000-8000-00000000000a', '00000000-0000-4000-8000-0000000000d1', '{certificate_expiry,node_offline}', true),
      ('u_member', 'org_b', '00000000-0000-4000-8000-00000000000b', '00000000-0000-4000-8000-0000000000d1', '{origin_errors}', true);
    insert into ip_list (id, organization_id, name, kind, entries) values
      ('00000000-0000-4000-8000-0000000000e1', null, 'office', 'allow', '{192.0.2.0/24}'),
      ('00000000-0000-4000-8000-0000000000e2', 'org_a', 'office', 'block', '{198.51.100.0/24}'),
      ('00000000-0000-4000-8000-0000000000e3', 'org_b', 'lab', 'allow', '{203.0.113.0/24}');
    insert into edge_rule (site_id, name, phase, expression, priority, action, list_ids) values
      ('00000000-0000-4000-8000-00000000000a', 'own office', 'waf-custom',
       'ip.src in $office or ip.src in $office_hq', 0, '{"kind":"block"}',
       '{00000000-0000-4000-8000-0000000000e2}'),
      (null, 'shared office', 'waf-custom', 'ip.src in $office', 0, '{"kind":"allow"}',
       '{00000000-0000-4000-8000-0000000000e1}');
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

  it("keeps suspended sites dark as disabled sites", async () => {
    expect(await q("select name, enabled from site order by name")).toEqual([
      { name: "a", enabled: true },
      { name: "b", enabled: false },
    ]);
    const columns = await q<{ column_name: string }>(
      "select column_name from information_schema.columns where table_name = 'site' and column_name like 'suspend%'",
    );
    expect(columns).toEqual([]);
    expect(await q("select scopes from service_account")).toEqual([
      { scopes: ["sites:read", "usage:read"] },
    ]);
  });

  it("keeps one account: the earliest administrator who is not disabled", async () => {
    expect(await q('select id, role, banned from "user"')).toEqual([
      { id: "u_admin", role: "admin", banned: false },
    ]);
    expect(await q("select id from apikey")).toEqual([{ id: "k_admin" }]);
  });

  it("moves the other accounts' alert subscriptions to the operator, merging kinds", async () => {
    const rows = await q<{ user_id: string; site: string; kinds: string[]; enabled: boolean }>(
      "select a.user_id, s.name as site, a.kinds, a.enabled from alert_subscription a join site s on s.id = a.site_id order by s.name",
    );
    expect(rows).toEqual([
      {
        user_id: "u_admin",
        site: "a",
        kinds: ["certificate_expiry", "node_offline"],
        enabled: true,
      },
      { user_id: "u_admin", site: "b", kinds: ["origin_errors"], enabled: true },
    ]);
  });

  it("puts IP lists in one namespace without changing what rules match", async () => {
    const lists = await q<{ id: string; name: string; kind: string }>(
      "select id, name, kind from ip_list order by id",
    );
    const suffix = (id: string) => createHash("md5").update(id).digest("hex").slice(0, 6);
    expect(lists).toEqual([
      { id: "00000000-0000-4000-8000-0000000000e1", name: "office", kind: "allow" },
      {
        id: "00000000-0000-4000-8000-0000000000e2",
        name: `office_${suffix("00000000-0000-4000-8000-0000000000e2")}`,
        kind: "collection",
      },
      { id: "00000000-0000-4000-8000-0000000000e3", name: "lab", kind: "collection" },
    ]);
    const rules = await q<{ name: string; expression: string }>(
      "select name, expression from edge_rule order by name",
    );
    expect(rules).toEqual([
      {
        name: "own office",
        expression: `ip.src in $office_${suffix("00000000-0000-4000-8000-0000000000e2")} or ip.src in $office_hq`,
      },
      { name: "shared office", expression: "ip.src in $office" },
    ]);
  });

  it("drops organizations, members, invitations and every organization column", async () => {
    const tables = await q<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema = 'public' and table_name in ('organization', 'member', 'invitation', 'organization_settings')",
    );
    expect(tables).toEqual([]);
    const columns = await q<{ table_name: string }>(
      "select table_name from information_schema.columns where table_schema = 'public' and column_name in ('organization_id', 'active_organization_id', 'available_to_tenants')",
    );
    expect(columns).toEqual([]);
    expect(await q("select scopes from service_account")).toEqual([
      { scopes: ["sites:read", "usage:read"] },
    ]);
  });

  it("drops organization limits", async () => {
    const tables = await q<{ n: number }>(
      "select count(*)::int as n from information_schema.tables where table_name = 'organization_limit'",
    );
    expect(tables[0]?.n).toBe(0);
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
