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

    const [a] = await db.insert(schema.site).values({ clusterId: cl.id, name: "a" }).returning();
    const [b] = await db.insert(schema.site).values({ clusterId: cl.id, name: "b" }).returning();
    if (!a || !b) throw new Error("sites not inserted");
    await db.insert(schema.siteDomain).values({ siteId: a.id, name: "demo.test" });
    await expect(
      db.insert(schema.siteDomain).values({ siteId: b.id, name: "demo.test" }),
    ).rejects.toThrow();
    // The same name as a wildcard suffix is a different route.
    await db.insert(schema.siteDomain).values({ siteId: b.id, name: "demo.test", wildcard: true });
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
      .values({ clusterId: cl.id, name: "g2" })
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
      .values({ clusterId: cl.id, name: "g3" })
      .returning();
    if (!site) throw new Error("site not inserted");
    await db.insert(schema.siteWaf).values({ siteId: site.id });
    const [waf] = await db.select().from(schema.siteWaf);
    expect(waf).toMatchObject({
      mode: "off",
      paranoiaLevel: 1,
      anomalyThreshold: 5,
      excludedRuleIds: [],
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

  it("keeps one origin health row per node, origin and check, and one error page per site and status", async () => {
    const [cl] = await db.insert(schema.cluster).values({ name: "g4" }).returning();
    if (!cl) throw new Error("cluster not inserted");
    const [site] = await db
      .insert(schema.site)
      .values({ clusterId: cl.id, name: "g4" })
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
