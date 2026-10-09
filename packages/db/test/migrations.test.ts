import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cacheConditionExpression, parseExpression } from "@edgeweir/rule-engine";
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
      "node_certificate_revocation",
      "system_setting",
      "site_star",
      "origin_credential",
      "origin_health",
      "cache_task",
      "cache_task_node",
      "rate_limit",
      "ip_ban",
      "site_protection",
      "challenge_key",
      "security_event",
      "site_waf",
      "site_error_page",
      "bulk_redirect",
      "probe",
      "probe_token",
      "probe_result",
      "node_address_state",
      "scheduling_rule",
      "scheduling_state",
    ]) {
      expect(tables).toContain(name);
    }
  });

  it("stores revisions as bytea and permits only one route per domain", async () => {
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
      .values({ clusterId: cl.id, name: "a", cnamePrefix: "a" })
      .returning();
    const [b] = await db
      .insert(schema.site)
      .values({ clusterId: cl.id, name: "b", cnamePrefix: "b" })
      .returning();
    if (!a || !b) throw new Error("sites not inserted");
    await db.insert(schema.siteDomain).values({ siteId: a.id, name: "demo.test" });
    await expect(
      db.insert(schema.siteDomain).values({ siteId: b.id, name: "demo.test" }),
    ).rejects.toThrow();
    // The same name as a wildcard or suffix domain is a different route.
    await db
      .insert(schema.siteDomain)
      .values({ siteId: b.id, name: "demo.test", kind: "wildcard" });
    await db.insert(schema.siteDomain).values({ siteId: b.id, name: "demo.test", kind: "suffix" });
  });

  it("keeps one challenge key per role and cluster and one security event per node event", async () => {
    const [cl] = await db.insert(schema.cluster).values({ name: "g2" }).returning();
    if (!cl) throw new Error("cluster not inserted");
    await db.insert(schema.challengeKey).values({ clusterId: cl.id, role: "current" });
    await expect(
      db.insert(schema.challengeKey).values({ clusterId: cl.id, role: "current" }),
    ).rejects.toThrow();
    const [site] = await db
      .insert(schema.site)
      .values({ clusterId: cl.id, name: "g2", cnamePrefix: "g2" })
      .returning();
    const [node] = await db.insert(schema.node).values({ clusterId: cl.id, name: "n" }).returning();
    if (!site || !node) throw new Error("not inserted");
    expect(node.securityState).toEqual([]);
    const event = {
      nodeId: node.id,
      nodeEventId: "e1",
      siteId: site.id,
      occurredAt: new Date(),
      kind: "site_level",
    };
    await db.insert(schema.securityEvent).values(event);
    await expect(db.insert(schema.securityEvent).values(event)).rejects.toThrow();
    await db.insert(schema.siteProtection).values({ siteId: site.id });
    const [protection] = await db.select().from(schema.siteProtection);
    expect(protection).toMatchObject({
      underAttack: false,
      underAttackChallenge: "js",
      passTtlSeconds: 1800,
      powDifficulty: 16,
      powHighDifficulty: 20,
      cc: null,
      logJa4: false,
    });
    await db.delete(schema.node).where(eq(schema.node.id, node.id));
    const [kept] = await db.select().from(schema.securityEvent);
    expect(kept?.nodeId).toBeNull();
  });

  it("defaults a site's CRS to off and carries WAF rule hits through the traffic view", async () => {
    const [cl] = await db.insert(schema.cluster).values({ name: "g3" }).returning();
    if (!cl) throw new Error("cluster not inserted");
    const [site] = await db
      .insert(schema.site)
      .values({ clusterId: cl.id, name: "g3", cnamePrefix: "g3" })
      .returning();
    if (!site) throw new Error("site not inserted");
    await db.insert(schema.siteWaf).values({ siteId: site.id });
    const [waf] = await db.select().from(schema.siteWaf);
    expect(waf).toMatchObject({
      mode: "off",
      paranoiaLevel: 1,
      anomalyThreshold: 5,
      exclusions: [],
      requestBodyLimit: 131072,
    });
    const minute = new Date("2026-10-01T10:05:00Z");
    const nodeId = "00000000-0000-4000-8000-0000000000a1";
    await db.insert(schema.nodeMinuteStats).values({
      minute,
      nodeId,
      siteId: site.id,
      requests: 3,
      wafRules: { "942100": 2, "920350": 1 },
    });
    const [row] = await db.select().from(schema.trafficHourStats);
    expect(row).toMatchObject({ requests: 3, wafRules: { "942100": 2, "920350": 1 } });
    // Minute rows written before G3 read as no matches.
    const [old] = await db
      .insert(schema.nodeMinuteStats)
      .values({ minute: new Date("2026-10-01T10:06:00Z"), nodeId, siteId: site.id })
      .returning();
    expect(old?.wafRules).toEqual({});
    await db.delete(schema.site).where(eq(schema.site.id, site.id));
    expect(await db.select().from(schema.siteWaf)).toEqual([]);
  });

  it("carries log rule matches through the traffic view and its rollups", async () => {
    const [cl] = await db.insert(schema.cluster).values({ name: "rule-log" }).returning();
    if (!cl) throw new Error("cluster not inserted");
    const [site] = await db
      .insert(schema.site)
      .values({ clusterId: cl.id, name: "rule-log", cnamePrefix: "rule-log" })
      .returning();
    if (!site) throw new Error("site not inserted");
    const nodeId = "00000000-0000-4000-8000-0000000000b1";
    const rule = "00000000-0000-4000-8000-0000000000b2";
    await db.insert(schema.nodeMinuteStats).values({
      minute: new Date("2026-10-02T10:05:00Z"),
      nodeId,
      siteId: site.id,
      requests: 4,
      loggedRules: { [rule]: 3 },
    });
    await db.insert(schema.nodeHourStats).values({
      minute: new Date("2026-10-02T08:00:00Z"),
      nodeId,
      siteId: site.id,
      requests: 9,
      loggedRules: { [rule]: 7 },
    });
    const rows = await db
      .select()
      .from(schema.trafficHourStats)
      .where(eq(schema.trafficHourStats.siteId, site.id));
    expect(rows.map((row) => row.loggedRules[rule]).sort()).toEqual([3, 7]);
    // Rows written before rule-log-v1 read as no matches.
    const [old] = await db
      .insert(schema.nodeMinuteStats)
      .values({ minute: new Date("2026-10-02T10:06:00Z"), nodeId, siteId: site.id })
      .returning();
    expect(old?.loggedRules).toEqual({});
    await db.delete(schema.site).where(eq(schema.site.id, site.id));
  });

  it("keeps one origin health row per node, origin and check, and one error page per site and status", async () => {
    const [cl] = await db.insert(schema.cluster).values({ name: "g4" }).returning();
    if (!cl) throw new Error("cluster not inserted");
    const [site] = await db
      .insert(schema.site)
      .values({ clusterId: cl.id, name: "g4", cnamePrefix: "g4" })
      .returning();
    if (!site) throw new Error("site not inserted");
    expect(site).toMatchObject({
      keepCacheTag: false,
      interceptOriginErrors: false,
      errorPagesUpdatedAt: null,
    });
    const [pool] = await db.insert(schema.originPool).values({ siteId: site.id }).returning();
    if (!pool) throw new Error("pool not inserted");
    expect(pool).toMatchObject({ activeHealthCheck: {}, sessionAffinity: {} });
    const [origin] = await db
      .insert(schema.origin)
      .values({ poolId: pool.id, address: "origin.test", port: 80 })
      .returning();
    const [node] = await db.insert(schema.node).values({ clusterId: cl.id, name: "n" }).returning();
    if (!origin || !node) throw new Error("not inserted");
    const health = { nodeId: node.id, originId: origin.id, siteId: site.id, healthy: false };
    const [passive] = await db.insert(schema.originHealth).values(health).returning();
    expect(passive?.source).toBe("passive");
    await db.insert(schema.originHealth).values({ ...health, source: "active" });
    await expect(
      db.insert(schema.originHealth).values({ ...health, source: "active" }),
    ).rejects.toThrow();
    await db.insert(schema.siteErrorPage).values({ siteId: site.id, status: 503, template: "x" });
    await expect(
      db.insert(schema.siteErrorPage).values({ siteId: site.id, status: 503, template: "y" }),
    ).rejects.toThrow();
    await db.delete(schema.site).where(eq(schema.site.id, site.id));
    expect(await db.select().from(schema.siteErrorPage)).toEqual([]);
    expect(await db.select().from(schema.originHealth)).toEqual([]);
  });

  it("keeps one bulk redirect per site and source and defaults origin groups and browser TTLs", async () => {
    const [cl] = await db.insert(schema.cluster).values({ name: "g5" }).returning();
    if (!cl) throw new Error("cluster not inserted");
    const [site] = await db
      .insert(schema.site)
      .values({ clusterId: cl.id, name: "g5", cnamePrefix: "g5" })
      .returning();
    if (!site) throw new Error("site not inserted");
    const [pool] = await db.insert(schema.originPool).values({ siteId: site.id }).returning();
    if (!pool) throw new Error("pool not inserted");
    const [origin] = await db
      .insert(schema.origin)
      .values({ poolId: pool.id, address: "origin.test", port: 80 })
      .returning();
    expect(origin?.groupName).toBe("");
    const [rule] = await db.insert(schema.cacheRule).values({ siteId: site.id }).returning();
    expect(rule).toMatchObject({ browserTtlSeconds: 0, listIds: [] });
    const redirect = { siteId: site.id, source: "/old", target: "/new", position: 0 };
    const [row] = await db.insert(schema.bulkRedirect).values(redirect).returning();
    expect(row).toMatchObject({ statusCode: 301, preserveQuery: false });
    await expect(db.insert(schema.bulkRedirect).values(redirect)).rejects.toThrow();
    await db.delete(schema.site).where(eq(schema.site.id, site.id));
    expect(await db.select().from(schema.bulkRedirect)).toEqual([]);
  });

  it("detaches regions instead of cascading deletes", async () => {
    const [cl] = await db.insert(schema.cluster).values({ name: "edge-b" }).returning();
    const [rg] = await db.insert(schema.region).values({ name: "East", code: "east" }).returning();
    if (!cl || !rg) throw new Error("not inserted");
    const [group] = await db
      .insert(schema.nodeGroup)
      .values({ clusterId: cl.id, name: "g", regionId: rg.id })
      .returning();
    await expect(db.insert(schema.region).values({ name: "Dup", code: "east" })).rejects.toThrow();

    await db.delete(schema.region).where(eq(schema.region.id, rg.id));
    const [detached] = await db
      .select()
      .from(schema.nodeGroup)
      .where(eq(schema.nodeGroup.id, group?.id ?? ""));
    expect(detached?.regionId).toBeNull();
  });
});

describe("migration 0031 on existing data", () => {
  it("keeps the origin health nodes reported before G4 as passive entries", async () => {
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // The migrations up to 0030, then data written by a G3 console, then the rest.
    const folder = mkdtempSync(join(tmpdir(), "edgeweir-g3-"));
    const old = new PGlite();
    try {
      mkdirSync(join(folder, "meta"));
      const entries = journal.entries.filter((entry) => entry.idx <= 30);
      writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries)
        copyFileSync(join(defaultMigrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
      const oldDb = drizzle({ client: old, schema, casing: "snake_case" });
      await migrate(oldDb, { migrationsFolder: folder, migrationsSchema: "drizzle" });
      await old.exec(`
        insert into organization (id, name, slug, created_at) values ('org_old', 'Old', 'old', now());
        insert into cluster (id, name) values ('00000000-0000-4000-8000-0000000000c1', 'old');
        insert into site (id, organization_id, cluster_id, name)
          values ('00000000-0000-4000-8000-0000000000c2', 'org_old', '00000000-0000-4000-8000-0000000000c1', 'old');
        insert into origin_pool (id, site_id)
          values ('00000000-0000-4000-8000-0000000000c3', '00000000-0000-4000-8000-0000000000c2');
        insert into origin (id, pool_id, address, port)
          values ('00000000-0000-4000-8000-0000000000c4', '00000000-0000-4000-8000-0000000000c3', 'origin.test', 80);
        insert into node (id, cluster_id, name)
          values ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-0000000000c1', 'old');
        insert into origin_health (node_id, origin_id, site_id, healthy, consecutive_failures)
          values ('00000000-0000-4000-8000-0000000000c5', '00000000-0000-4000-8000-0000000000c4',
                  '00000000-0000-4000-8000-0000000000c2', false, 3);
      `);
      await migrate(oldDb, {
        migrationsFolder: defaultMigrationsFolder,
        migrationsSchema: "drizzle",
      });
      const rows = await old.query<{ source: string; consecutive_failures: number }>(
        "select source, consecutive_failures from origin_health",
      );
      expect(rows.rows).toEqual([{ source: "passive", consecutive_failures: 3 }]);
      const [pool] = (
        await old.query<{ active_health_check: unknown; session_affinity: unknown }>(
          "select active_health_check, session_affinity from origin_pool",
        )
      ).rows;
      expect(pool).toEqual({ active_health_check: {}, session_affinity: {} });
    } finally {
      await old.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("migration 0032 on existing data", () => {
  it("rewrites structured cache rule conditions as the builder's expressions and clears the lists", async () => {
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // The migrations up to 0031, then cache rules written by a G4 console, then 0032.
    const folder = mkdtempSync(join(tmpdir(), "edgeweir-g4-"));
    const old = new PGlite();
    const rules: { id: string; pathPrefixes: string[]; paths: string[]; extensions: string[] }[] = [
      { id: "a1", pathPrefixes: ["/static/"], paths: [], extensions: [] },
      {
        id: "a2",
        pathPrefixes: ["/b/", "/a/", '/q"uote/', "/back\\slash/", "/中文/", "/tab\tline/"],
        paths: [],
        extensions: [],
      },
      { id: "a3", pathPrefixes: [], paths: ["/z.html", "/index.html", "/ü"], extensions: [] },
      { id: "a4", pathPrefixes: [], paths: [], extensions: ["png", "css", "png"] },
      {
        id: "a5",
        pathPrefixes: ["/img/", "/media/"],
        paths: ['/"x"'],
        extensions: ["webp", "avif"],
      },
      { id: "a6", pathPrefixes: [], paths: [], extensions: [] },
    ];
    const uuid = (id: string) => `00000000-0000-4000-8000-0000000000${id}`;
    try {
      mkdirSync(join(folder, "meta"));
      const entries = journal.entries.filter((entry) => entry.idx <= 31);
      writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries)
        copyFileSync(join(defaultMigrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
      const oldDb = drizzle({ client: old, schema, casing: "snake_case" });
      await migrate(oldDb, { migrationsFolder: folder, migrationsSchema: "drizzle" });
      await old.exec(`
        insert into organization (id, name, slug, created_at) values ('org_old', 'Old', 'old', now());
        insert into cluster (id, name) values ('00000000-0000-4000-8000-0000000000d1', 'old');
        insert into site (id, organization_id, cluster_id, name)
          values ('00000000-0000-4000-8000-0000000000d2', 'org_old', '00000000-0000-4000-8000-0000000000d1', 'old');
      `);
      for (const rule of rules)
        await old.query(
          `insert into cache_rule (id, site_id, path_prefixes, paths, extensions)
             values ($1, '00000000-0000-4000-8000-0000000000d2', $2, $3, $4)`,
          [uuid(rule.id), rule.pathPrefixes, rule.paths, rule.extensions],
        );
      // A rule that already has an expression is left alone.
      await old.query(
        `insert into cache_rule (id, site_id, path_prefixes, expression)
           values ($1, '00000000-0000-4000-8000-0000000000d2', '{/kept/}', 'ssl eq true')`,
        [uuid("a7")],
      );
      await migrate(oldDb, {
        migrationsFolder: defaultMigrationsFolder,
        migrationsSchema: "drizzle",
      });
      const migrated = await old.query<{
        id: string;
        expression: string;
        path_prefixes: string[];
        paths: string[];
        extensions: string[];
        browser_ttl_seconds: number;
      }>(
        "select id, expression, path_prefixes, paths, extensions, browser_ttl_seconds from cache_rule order by id",
      );
      expect(migrated.rows).toHaveLength(rules.length + 1);
      for (const rule of rules) {
        const row = migrated.rows.find((r) => r.id === uuid(rule.id));
        expect(row?.expression, rule.id).toBe(cacheConditionExpression(rule));
        // The expression parses as a cache condition (the vectors prove it matches like the lists).
        expect(() => parseExpression(row?.expression ?? "", "cache")).not.toThrow();
        expect(row).toMatchObject({
          path_prefixes: [],
          paths: [],
          extensions: [],
          browser_ttl_seconds: 0,
        });
      }
      expect(migrated.rows.find((r) => r.id === uuid("a6"))?.expression).toBe("true");
      expect(migrated.rows.find((r) => r.id === uuid("a7"))).toMatchObject({
        expression: "ssl eq true",
        path_prefixes: ["/kept/"],
      });
    } finally {
      await old.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});

describe("migration 0060 on existing data", () => {
  it("turns site-wide CRS exclusions into one exclusion and adds the G14 defaults", async () => {
    const journal = JSON.parse(
      readFileSync(join(defaultMigrationsFolder, "meta", "_journal.json"), "utf8"),
    ) as { entries: { idx: number; tag: string }[] };
    // The migrations up to 0059, then CRS settings written by a G13 console, then 0060.
    const folder = mkdtempSync(join(tmpdir(), "edgeweir-g13-"));
    const old = new PGlite();
    const id = (n: string) => `00000000-0000-4000-8000-0000000000${n}`;
    try {
      mkdirSync(join(folder, "meta"));
      const entries = journal.entries.filter((entry) => entry.idx <= 59);
      writeFileSync(join(folder, "meta", "_journal.json"), JSON.stringify({ ...journal, entries }));
      for (const { tag } of entries)
        copyFileSync(join(defaultMigrationsFolder, `${tag}.sql`), join(folder, `${tag}.sql`));
      const oldDb = drizzle({ client: old, schema, casing: "snake_case" });
      await migrate(oldDb, { migrationsFolder: folder, migrationsSchema: "drizzle" });
      await old.exec(`
        insert into cluster (id, name) values ('${id("e1")}', 'g13');
        insert into site (id, cluster_id, name, cname_prefix) values
          ('${id("e2")}', '${id("e1")}', 'with', 'g13a'),
          ('${id("e3")}', '${id("e1")}', 'without', 'g13b');
        insert into site_waf (site_id, mode, excluded_rule_ids) values
          ('${id("e2")}', 'block', '{920350,942100}'),
          ('${id("e3")}', 'detect', '{}');
        insert into site_protection (site_id) values ('${id("e2")}');
      `);
      await migrate(oldDb, {
        migrationsFolder: defaultMigrationsFolder,
        migrationsSchema: "drizzle",
      });
      const waf = await old.query<{ site_id: string; exclusions: unknown }>(
        "select site_id, exclusions from site_waf order by site_id",
      );
      expect(waf.rows).toEqual([
        {
          site_id: id("e2"),
          exclusions: [{ path: "", exact: false, ruleIds: [920350, 942100], targets: [] }],
        },
        { site_id: id("e3"), exclusions: [] },
      ]);
      const columns = await old.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_name = 'site_waf'",
      );
      expect(columns.rows.map((r) => r.column_name)).not.toContain("excluded_rule_ids");
      const [protection] = (
        await old.query(
          "select allow_verified_bots, challenge_text, failure_ban_enabled, failure_threshold, failure_ban_seconds from site_protection",
        )
      ).rows;
      expect(protection).toEqual({
        allow_verified_bots: false,
        challenge_text: {},
        failure_ban_enabled: false,
        failure_threshold: 10,
        failure_ban_seconds: 600,
      });
      const [site] = (
        await old.query<{ rules_body_limit: number }>(
          `select rules_body_limit from site where id = '${id("e2")}'`,
        )
      ).rows;
      expect(site?.rules_body_limit).toBe(65536);
      // A node may hold an automatic and a rule ban of the same address on a site.
      await old.exec(`
        insert into node (id, cluster_id, name) values ('${id("e4")}', '${id("e1")}', 'n');
        insert into ip_ban (scope, site_id, cluster_id, cidr, reason, source, node_id, expires_at, seq) values
          ('site', '${id("e2")}', '${id("e1")}', '192.0.2.1/32', 'cc_ip_rate', 'auto', '${id("e4")}', now() + interval '1 hour', 1),
          ('site', '${id("e2")}', '${id("e1")}', '192.0.2.1/32', 'waf_rule', 'rule', '${id("e4")}', now() + interval '1 hour', 2);
      `);
      await expect(
        old.exec(`
          insert into ip_ban (scope, site_id, cluster_id, cidr, reason, source, node_id, expires_at, seq) values
            ('site', '${id("e2")}', '${id("e1")}', '192.0.2.1/32', 'rate_limit', 'rule', '${id("e4")}', now() + interval '1 hour', 3);
        `),
      ).rejects.toThrow();
      const logs = await old.query<{ column_default: string }>(
        "select column_default from information_schema.columns where table_name = 'access_log' and column_name = 'rule_ids'",
      );
      expect(logs.rows[0]?.column_default).toContain("{}");
    } finally {
      await old.close();
      rmSync(folder, { recursive: true, force: true });
    }
  });
});
