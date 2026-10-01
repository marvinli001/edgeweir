import { schema } from "@edgeweir/db";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MasterKey } from "../../src/server/lib/envelope";
import { systemActor } from "../../src/server/services/audit";
import {
  bindingPolicy,
  compileBindingPlan,
  loadBinding,
  reconcileDns,
  saveBinding,
  siteDnsTarget,
} from "../../src/server/services/dns";
import { dnsFixture, type FixtureRecord, resolve } from "./dns-fixture";
import { createTestContext, TEST_MASTER_KEY } from "./helpers";

vi.mock("../../src/server/services/certificate-worker", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../src/server/services/certificate-worker")>();
  const { makeFakeCertd } = await import("./dns-fixture");
  return { ...actual, runCertd: vi.fn(makeFakeCertd(actual.CertdError)) };
});

/**
 * Migration 0036 turns the platform-wide DNS policy into one binding per
 * cluster. Seeded on the 0028 schema (organizations included): two clusters with sites (A: three
 * sites, line "east"; B: one site, line "west"), a cluster without sites, the
 * records the former per-site layout wrote, a managed name of a deleted site,
 * records the console never managed, and a firing platform-wide hold alert.
 */
const ids = {
  org: "org_migration",
  clusterA: "00000000-0000-4000-8000-00000000000a",
  clusterB: "00000000-0000-4000-8000-00000000000b",
  clusterC: "00000000-0000-4000-8000-00000000000c",
  groupA: "00000000-0000-4000-8000-0000000000a1",
  groupB: "00000000-0000-4000-8000-0000000000b1",
  groupC: "00000000-0000-4000-8000-0000000000c1",
  provider: "00000000-0000-4000-8000-0000000000f0",
  sitesA: [
    "10000000-0000-4000-8000-000000000001",
    "20000000-0000-4000-8000-000000000002",
    "30000000-0000-4000-8000-000000000003",
  ],
  siteB: "40000000-0000-4000-8000-000000000004",
  deletedSite: "50000000-0000-4000-8000-000000000005",
};
const zone = "cdn.test";
const suffix = "edge.cdn.test";
const ipsA = ["8.8.8.1", "8.8.8.2"];
const ipsB = ["9.9.9.1"];
const a = (name: string, data: string): FixtureRecord => ({ name, type: "A", data, ttl: 60 });
const cname = (name: string, data: string): FixtureRecord => ({
  name,
  type: "CNAME",
  data,
  ttl: 60,
});
/** What the former compileDnsPlan produced for one site. */
function oldSiteRecords(site: string, line: string, ips: string[]) {
  return [
    cname(`${site}.edge`, `all.${site}.${suffix}`),
    ...ips.map((ip) => a(`all.${site}.edge`, ip)),
    ...ips.map((ip) => a(`${line}.${site}.edge`, ip)),
  ];
}
function oldSiteNames(site: string, line: string) {
  return [
    { name: `${site}.edge`, type: "CNAME" },
    { name: `all.${site}.edge`, type: "A" },
    { name: `all.${site}.edge`, type: "AAAA" },
    { name: `${line}.${site}.edge`, type: "A" },
    { name: `${line}.${site}.edge`, type: "AAAA" },
  ];
}
const oldRecords = [
  ...ids.sitesA.flatMap((site) => oldSiteRecords(site, "east", ipsA)),
  ...oldSiteRecords(ids.siteB, "west", ipsB),
  cname(`${ids.deletedSite}.edge`, `all.${ids.deletedSite}.${suffix}`),
];
const oldNames = [
  ...ids.sitesA.flatMap((site) => oldSiteNames(site, "east")),
  ...oldSiteNames(ids.siteB, "west"),
  { name: `${ids.deletedSite}.edge`, type: "CNAME" },
];
const unmanaged: FixtureRecord[] = [
  { name: "www", type: "TXT", data: "keep", ttl: 600 },
  a("legacy", "1.1.1.1"),
];

async function seed(client: PGlite) {
  const q = (text: string, params: unknown[] = []) => client.query(text, params);
  await q(`insert into organization (id, name, slug, created_at) values ($1, 'M', 'm', now())`, [
    ids.org,
  ]);
  for (const [id, name, at] of [
    [ids.clusterA, "a", "2026-01-01T00:00:00Z"],
    [ids.clusterC, "c", "2026-01-02T00:00:00Z"],
    [ids.clusterB, "b", "2026-01-03T00:00:00Z"],
  ])
    await q(`insert into cluster (id, name, created_at) values ($1, $2, $3)`, [id, name, at]);
  for (const [id, cluster] of [
    [ids.groupA, ids.clusterA],
    [ids.groupB, ids.clusterB],
    [ids.groupC, ids.clusterC],
  ])
    await q(
      `insert into node_group (id, cluster_id, name, is_default) values ($1, $2, 'default', true)`,
      [id, cluster],
    );
  for (const [site, cluster] of [
    ...ids.sitesA.map((s) => [s, ids.clusterA]),
    [ids.siteB, ids.clusterB],
  ]) {
    await q(`insert into site (id, organization_id, cluster_id, name) values ($1, $2, $3, $4)`, [
      site,
      ids.org,
      cluster,
      `site ${site}`,
    ]);
    await q(`insert into site_domain (site_id, name, verified) values ($1, $2, true)`, [
      site,
      `${site?.slice(0, 8)}.customer.test`,
    ]);
  }
  const envelope = new MasterKey(TEST_MASTER_KEY).seal(JSON.stringify({ api_token: "token-m" }), {
    purpose: "platform_dns_provider.credential_envelope",
    recordId: ids.provider,
  });
  await q(
    `insert into platform_dns_provider (id, name, provider, zone, credential_envelope) values ($1, 'M', 'test', $2, $3)`,
    [ids.provider, zone, JSON.stringify(envelope)],
  );
  const policy = {
    enabled: true,
    providerId: ids.provider,
    cnameSuffix: suffix,
    ttl: 60,
    lines: [
      { name: "east", nodeGroupId: ids.groupA, overrides: [] },
      { name: "west", nodeGroupId: ids.groupB, overrides: [] },
    ],
  };
  const revision = await q(
    `insert into dns_revision (provider_id, policy, records, managed_names, content_hash, reason, status, applied_at)
     values ($1, $2, $3, $4, 'old', 'manual', 'applied', now()) returning revision`,
    [ids.provider, JSON.stringify(policy), JSON.stringify(oldRecords), JSON.stringify(oldNames)],
  );
  const number = (revision.rows[0] as { revision: number }).revision;
  await q(
    `update dns_state set policy = $1, desired_revision = $2, applied_revision = $2 where id = 1`,
    [JSON.stringify(policy), number],
  );
  for (const name of oldNames)
    await q(`insert into dns_managed_name (provider_id, name, type) values ($1, $2, $3)`, [
      ids.provider,
      name.name,
      name.type,
    ]);
  await q(
    `insert into alert_state (key, site_id, kind, resource_id, active) values ('dns_mass_removal_blocked/platform/dns', null, 'dns_mass_removal_blocked', 'dns', true)`,
  );
}

describe("migration 0036: platform-wide DNS policy to cluster bindings", async () => {
  const { ctx, client } = await createTestContext(
    { EDGEWEIR_DNS_TEST_ENDPOINT: "http://fixture.invalid" },
    { seed: { upTo: "0028_g1_dynamic_bans", run: seed } },
  );
  const newRecords = () => dnsFixture.records("token-m", zone);
  const shownNames = [
    ...ids.sitesA.flatMap((s) => [`${s}.${suffix}`, `east.${s}.${suffix}`]),
    `${ids.siteB}.${suffix}`,
    `west.${ids.siteB}.${suffix}`,
  ];

  beforeAll(async () => {
    dnsFixture.reset();
    dnsFixture.accounts.set("token-m", { zones: [zone] });
    dnsFixture.set("token-m", zone, [...oldRecords, ...unmanaged]);
    // Healthy nodes running each cluster's configuration.
    for (const [cluster, group, ips] of [
      [ids.clusterA, ids.groupA, ipsA],
      [ids.clusterB, ids.groupB, ipsB],
    ] as const) {
      await ctx.db.insert(schema.configRevision).values({
        clusterId: cluster,
        revision: 1,
        contentHash: `hash-${cluster}`,
        ir: Buffer.alloc(0),
      });
      for (const ip of ips) {
        const [node] = await ctx.db
          .insert(schema.node)
          .values({ clusterId: cluster, nodeGroupId: group, name: ip, lastSeenAt: new Date() })
          .returning();
        if (!node) throw new Error("node missing");
        await ctx.db.insert(schema.nodeIp).values({ nodeId: node.id, address: ip });
        await ctx.db.insert(schema.nodeConfigStatus).values({
          nodeId: node.id,
          appliedRevision: 1,
          appliedContentHash: `hash-${cluster}`,
          state: "applied",
          dataPlaneHealthy: true,
        });
      }
    }
  });
  afterAll(() => client.close());

  it("creates one binding per cluster with the former suffix and distinct all-lines labels", async () => {
    const rows = await ctx.db.select().from(schema.dnsBinding);
    const by = (id: string) => rows.find((r) => r.clusterId === id);
    expect(by(ids.clusterA)).toMatchObject({
      mode: "auto",
      providerId: ids.provider,
      domain: suffix,
      ttl: 60,
      allLabel: "all",
      lineAliases: true,
      lines: [{ name: "east", nodeGroupId: ids.groupA, overrides: [] }],
    });
    expect(by(ids.clusterB)).toMatchObject({
      mode: "auto",
      allLabel: "all-2",
      lineAliases: true,
      lines: [{ name: "west", nodeGroupId: ids.groupB, overrides: [] }],
    });
    // Clusters with sites come first; the empty cluster gets the last label.
    expect(by(ids.clusterC)).toMatchObject({ mode: "auto", allLabel: "all-3", lines: [] });
    const names = await ctx.db.select().from(schema.dnsManagedName);
    const owner = (name: string) => names.find((n) => n.name === name)?.clusterId;
    expect(owner(`all.${ids.sitesA[0]}.edge`)).toBe(ids.clusterA);
    expect(owner(`west.${ids.siteB}.edge`)).toBe(ids.clusterB);
    // A deleted site's name goes to the first cluster using the account.
    expect(owner(`${ids.deletedSite}.edge`)).toBe(ids.clusterA);
    const [state] = await ctx.db
      .select()
      .from(schema.alertState)
      .where(eq(schema.alertState.key, "dns_mass_removal_blocked/platform/dns"));
    expect(state?.active).toBe(false);
  });

  it("holds the first publication when every node looks offline after the upgrade", async () => {
    const at = new Date();
    await ctx.db.update(schema.node).set({ lastSeenAt: new Date(0) });
    await reconcileDns(ctx);
    // The former records stay: no site points at an empty all-lines record.
    expect(newRecords()).toEqual([...oldRecords, ...unmanaged]);
    const [held] = await ctx.db
      .select()
      .from(schema.dnsRevision)
      .where(eq(schema.dnsRevision.clusterId, ids.clusterA));
    expect(held).toMatchObject({ status: "blocked", lastError: "dns_mass_removal_blocked" });
    await ctx.db.update(schema.node).set({ lastSeenAt: at });
  });

  it("keeps every site target name and resolves every name sites were shown to the same addresses", async () => {
    const before = Object.fromEntries(
      shownNames.map((name) => [name, resolve(oldRecords, zone, name)]),
    );
    expect(before[`${ids.sitesA[0]}.${suffix}`]).toEqual(ipsA);
    expect(before[`west.${ids.siteB}.${suffix}`]).toEqual(ipsB);
    const result = await reconcileDns(ctx);
    expect(result).toMatchObject({ failures: [] });
    for (const site of ids.sitesA)
      expect((await siteDnsTarget(ctx, site)).target).toBe(`${site}.${suffix}`);
    expect(await siteDnsTarget(ctx, ids.siteB)).toMatchObject({
      target: `${ids.siteB}.${suffix}`,
      published: true,
      healthy: true,
      lines: [{ name: "west", target: `west.${ids.siteB}.${suffix}` }],
    });
    for (const name of shownNames)
      expect(resolve(newRecords(), zone, name), name).toEqual(before[name]);
  });

  it("writes fewer records and removes only the names the console managed", () => {
    const managedBefore = oldRecords.length;
    const managedAfter = newRecords().filter(
      (r) => !unmanaged.some((u) => u.name === r.name && u.type === r.type),
    ).length;
    // Before: 3 × 5 + 3 + 1 = 19; after: cluster addresses 4 + 2, CNAMEs 4 + aliases 4.
    expect(managedBefore).toBe(19);
    expect(managedAfter).toBe(14);
    expect(managedAfter).toBeLessThan(managedBefore);
    for (const record of unmanaged) expect(newRecords()).toContainEqual(record);
    const names = new Set(newRecords().map((r) => r.name));
    expect(names.has(`all.${ids.sitesA[0]}.edge`)).toBe(false);
    expect(names.has(`${ids.deletedSite}.edge`)).toBe(false);
    expect(names.has("all.edge")).toBe(true);
    expect(names.has("all-2.edge")).toBe(true);
  });

  it("drops the per-site line aliases on request, leaving the site targets and cluster lines", async () => {
    const row = await loadBinding(ctx.db, ids.clusterA);
    const { allLabel: _label, ...policy } = bindingPolicy(row);
    await saveBinding(ctx, ids.clusterA, { ...policy, lineAliases: false }, systemActor);
    await reconcileDns(ctx, systemActor, ids.clusterA);
    for (const site of ids.sitesA) {
      expect(resolve(newRecords(), zone, `${site}.${suffix}`)).toEqual(ipsA);
      expect(resolve(newRecords(), zone, `east.${site}.${suffix}`)).toEqual([]);
    }
    expect(resolve(newRecords(), zone, `east.${suffix}`)).toEqual(ipsA);
    expect((await siteDnsTarget(ctx, ids.sitesA[0] ?? "")).lines).toEqual([
      { name: "east", target: `east.${suffix}` },
    ]);
    const plan = await compileBindingPlan(
      ctx.db,
      ids.clusterA,
      bindingPolicy(await loadBinding(ctx.db, ids.clusterA)),
    );
    // Sites + cluster addresses: 3 CNAMEs + all (2) + east (2).
    expect(plan.records).toHaveLength(7);
  });
});
