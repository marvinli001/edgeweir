import { type Database, schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  rangeWindow,
  topNodes,
  topSites,
  trafficBreakdown,
  trafficSeries,
} from "../../src/server/services/analytics";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const MINUTE = 60_000;
// Far from the real clock, so the live-window checks below never see these rows.
const NOW = Date.UTC(2020, 0, 15, 12, 34, 56);
const at = (hh: number, mm: number) => new Date(Date.UTC(2020, 0, 15, hh, mm));

async function addStats(
  db: Database,
  row: {
    minute: Date;
    nodeId: string;
    siteId: string;
    requests: number;
    bytesSent?: number;
    cacheHits?: number;
    cacheMisses?: number;
    statusCodes?: Record<string, number>;
    topUrls?: Record<string, number>;
    topIps?: Record<string, number>;
  },
) {
  await db.insert(schema.nodeMinuteStats).values({
    bytesSent: 0,
    cacheHits: 0,
    cacheMisses: 0,
    statusCodes: {},
    ...row,
  });
}

describe("analytics", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const db = ctx.db;
  const origins = [{ address: "origin.internal", port: 8080 }];
  let admin: ApiClient;
  let owner: ApiClient;
  let member: ApiClient;
  let defaultOrgId: string;
  let defaultClusterId: string;
  let clusterB: string;
  let tenantOrgId: string;
  let siteA: string;
  let siteB: string;
  let siteT: string;
  let nodeA: string;
  let nodeB: string;

  beforeAll(async () => {
    ({ organizationId: defaultOrgId } = await setupPlatform(ctx));
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    defaultClusterId = (await admin.clusters.list())[0]?.id ?? "";
    clusterB = (await admin.clusters.create({ name: "edge-b" })).id;
    tenantOrgId = (await admin.organizations.create({ name: "Tenant", defaultClusterId: clusterB }))
      .id;
    for (const [email, role] of [
      ["owner@tenant.test", "owner"],
      ["member@tenant.test", "member"],
    ] as const) {
      await admin.users.create({
        name: email,
        email,
        password: PASSWORD,
        organizationId: tenantOrgId,
        role,
      });
    }
    owner = rpcClient(app, origin, await signIn(app, origin, "owner@tenant.test"));
    member = rpcClient(app, origin, await signIn(app, origin, "member@tenant.test"));
    siteA = (await admin.sites.create({ name: "alpha", domains: ["alpha.test"], origins })).site.id;
    siteB = (await admin.sites.create({ name: "bravo", domains: ["bravo.test"], origins })).site.id;
    siteT = (await owner.sites.create({ name: "tango", domains: ["tango.test"], origins })).site.id;
    const nodes = await db
      .insert(schema.node)
      .values([
        { clusterId: defaultClusterId, name: "edge-a" },
        { clusterId: clusterB, name: "edge-b1" },
      ])
      .returning();
    nodeA = nodes[0]?.id ?? "";
    nodeB = nodes[1]?.id ?? "";
  });
  afterAll(() => pglite.close());

  it("ends each range with the bucket that holds now, aligned to the epoch", () => {
    const hour = rangeWindow("1h", NOW);
    expect(hour.bucketSeconds).toBe(60);
    expect(hour.from).toEqual(at(11, 35));
    expect(hour.end).toEqual(at(12, 35));
    expect(hour.previousFrom).toEqual(at(10, 35));
    const day = rangeWindow("24h", NOW);
    expect(day.bucketSeconds).toBe(600);
    expect(day.end).toEqual(at(12, 40));
    expect(day.end.getTime() - day.from.getTime()).toBe(24 * 60 * MINUTE);
  });

  it("buckets, zero-fills and totals traffic with status classes and the previous period", async () => {
    await addStats(db, {
      minute: at(12, 30),
      nodeId: nodeA,
      siteId: siteA,
      requests: 100,
      bytesSent: 6_000,
      cacheHits: 80,
      cacheMisses: 20,
      statusCodes: { "200": 88, "304": 2, "404": 8, "502": 2 },
    });
    await addStats(db, {
      minute: at(12, 31),
      nodeId: nodeA,
      siteId: siteB,
      requests: 10,
      bytesSent: 1_200,
      statusCodes: { "200": 10 },
    });
    // Previous hour (10:35–11:35) and outside both windows.
    await addStats(db, { minute: at(11, 0), nodeId: nodeA, siteId: siteA, requests: 50 });
    await addStats(db, { minute: at(9, 0), nodeId: nodeA, siteId: siteA, requests: 999 });
    // Tenant traffic served by the other cluster.
    await addStats(db, {
      minute: at(12, 30),
      nodeId: nodeB,
      siteId: siteT,
      requests: 7,
      statusCodes: { "200": 7 },
    });

    const all = await trafficSeries(db, { all: true }, { range: "1h" }, NOW);
    expect(all.points).toHaveLength(60);
    expect(all.from).toBe(at(11, 35).toISOString());
    expect(all.to).toBe(new Date(NOW).toISOString());
    expect(all.points.at(0)?.time).toBe(at(11, 35).toISOString());
    expect(all.points.at(-1)?.time).toBe(at(12, 34).toISOString());
    expect(all.points.find((p) => p.time === at(12, 30).toISOString())).toMatchObject({
      requests: 107,
      bytesSent: 6_000,
      status2xx: 95,
      status3xx: 2,
      status4xx: 8,
      status5xx: 2,
    });
    expect(all.points.find((p) => p.time === at(12, 0).toISOString())?.requests).toBe(0);
    expect(all.totals).toMatchObject({
      requests: 117,
      bytesSent: 7_200,
      cacheHits: 80,
      cacheMisses: 20,
      status2xx: 105,
      peakBytesPerSecond: 100,
    });
    expect(all.previous.requests).toBe(50);

    // 10-minute buckets merge 12:30 and 12:31.
    const day = await trafficSeries(db, { all: true }, { range: "24h" }, NOW);
    expect(day.points).toHaveLength(144);
    expect(day.points.at(-1)).toMatchObject({ time: at(12, 30).toISOString(), requests: 117 });
    expect(day.totals.requests).toBe(117 + 50 + 999);
    expect(day.totals.peakBytesPerSecond).toBe(7_200 / 600);

    const tenant = await trafficSeries(
      db,
      { all: false, organizationId: tenantOrgId },
      { range: "1h" },
      NOW,
    );
    expect(tenant.totals.requests).toBe(7);
    const one = await trafficSeries(db, { all: true }, { range: "1h", siteId: siteB }, NOW);
    expect(one.totals.requests).toBe(10);
  });

  it("ranks sites within the scope and nodes platform-wide", async () => {
    const sites = await topSites(db, { all: true }, { range: "1h", limit: 5 }, NOW);
    expect(sites.map((s) => [s.name, s.requests])).toEqual([
      ["alpha", 100],
      ["bravo", 10],
      ["tango", 7],
    ]);
    expect(sites[0]).toMatchObject({
      parentId: defaultOrgId,
      parentName: "Default",
      cacheHits: 80,
      cacheMisses: 20,
    });
    const tenant = await topSites(
      db,
      { all: false, organizationId: tenantOrgId },
      { range: "1h", limit: 5 },
      NOW,
    );
    expect(tenant.map((s) => s.name)).toEqual(["tango"]);
    expect(await topSites(db, { all: true }, { range: "1h", limit: 1 }, NOW)).toHaveLength(1);

    const nodes = await topNodes(db, { range: "24h", limit: 5 }, NOW);
    expect(nodes.map((n) => [n.name, n.parentId, n.parentName, n.requests])).toEqual([
      ["edge-a", defaultClusterId, "default", 1_159],
      ["edge-b1", clusterB, "edge-b", 7],
    ]);
  });

  it("breaks traffic down by site, node and status code with the remainder's total", async () => {
    const bySite = await trafficBreakdown(
      db,
      { all: true },
      { range: "1h", by: "site", metric: "requests", limit: 10 },
      NOW,
    );
    expect(bySite.times).toHaveLength(60);
    expect(bySite.times.at(0)).toBe(at(11, 35).toISOString());
    expect(bySite.items.map((i) => [i.name, i.parentName, i.total])).toEqual([
      ["alpha", "Default", 100],
      ["bravo", "Default", 10],
      ["tango", "Tenant", 7],
    ]);
    const alpha = bySite.items[0]?.series ?? [];
    expect(alpha).toHaveLength(60);
    expect(alpha[bySite.times.indexOf(at(12, 30).toISOString())]).toBe(100);
    expect(alpha.reduce((a, b) => a + b, 0)).toBe(100);
    expect(bySite.total).toBe(117);
    expect(bySite.totalSeries[bySite.times.indexOf(at(12, 30).toISOString())]).toBe(107);

    // Ranked by bytes, sites that sent nothing drop out; the total still covers the scope.
    const bytes = await trafficBreakdown(
      db,
      { all: true },
      { range: "1h", by: "site", metric: "bytesSent", limit: 1 },
      NOW,
    );
    expect(bytes.items.map((i) => [i.name, i.total])).toEqual([["alpha", 6_000]]);
    expect(bytes.total).toBe(7_200);

    const byNode = await trafficBreakdown(
      db,
      { all: true },
      { range: "24h", by: "node", metric: "requests", limit: 10 },
      NOW,
    );
    expect(byNode.items.map((i) => [i.name, i.parentName, i.total])).toEqual([
      ["edge-a", "default", 1_159],
      ["edge-b1", "edge-b", 7],
    ]);

    const byStatus = await trafficBreakdown(
      db,
      { all: true },
      { range: "1h", by: "status", metric: "requests", limit: 10 },
      NOW,
    );
    expect(byStatus.items.map((i) => [i.id, i.name, i.parentName, i.total])).toEqual([
      ["200", "200", null, 105],
      ["404", "404", null, 8],
      ["304", "304", null, 2],
      ["502", "502", null, 2],
    ]);
    expect(byStatus.total).toBe(117);
    const errors = await trafficBreakdown(
      db,
      { all: true },
      { range: "1h", by: "status", metric: "requests", statusClass: 4, limit: 10 },
      NOW,
    );
    expect(errors.items.map((i) => i.id)).toEqual(["404"]);
    expect(errors.total).toBe(8);

    const tenant = await trafficBreakdown(
      db,
      { all: false, organizationId: tenantOrgId },
      { range: "1h", by: "status", metric: "requests", limit: 10 },
      NOW,
    );
    expect(tenant.items.map((i) => [i.id, i.total])).toEqual([["200", 7]]);
    const one = await trafficBreakdown(
      db,
      { all: true },
      { range: "1h", siteId: siteB, by: "node", metric: "requests", limit: 10 },
      NOW,
    );
    expect(one.items.map((i) => [i.name, i.total])).toEqual([["edge-a", 10]]);
  });

  it("scopes the procedures to the caller's organization", async () => {
    const traffic = await member.analytics.traffic({ range: "1h" });
    expect(traffic.points).toHaveLength(60);
    expect(traffic.range).toBe("1h");
    // Tenant data only; the rows above lie outside the live window.
    expect(traffic.totals.requests).toBe(0);
    expect(await member.analytics.topSites({})).toEqual([]);
    const denied = await rpcError(member.analytics.traffic({ siteId: siteA }));
    expect(denied).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    expect((await member.analytics.traffic({ siteId: siteT })).range).toBe("24h");

    const now = new Date(Math.floor(Date.now() / MINUTE) * MINUTE);
    await addStats(db, {
      minute: now,
      nodeId: nodeB,
      siteId: siteT,
      requests: 3,
      topUrls: { "/tenant": 3 },
      topIps: { "192.0.2.2": 3 },
    });
    await addStats(db, {
      minute: now,
      nodeId: nodeA,
      siteId: siteA,
      requests: 5,
      topUrls: { "/private": 5 },
      topIps: { "192.0.2.1": 5 },
    });
    expect((await member.analytics.traffic({ range: "1h" })).totals.requests).toBe(3);
    expect((await admin.analytics.traffic({ range: "1h" })).totals.requests).toBe(8);
    expect((await member.analytics.topSites({ range: "1h" })).map((s) => s.name)).toEqual([
      "tango",
    ]);
    expect((await admin.analytics.topNodes({ range: "1h" })).map((n) => n.name)).toEqual([
      "edge-a",
      "edge-b1",
    ]);

    expect(await member.analytics.topRequests({ range: "1h", by: "url" })).toEqual({
      approximate: true,
      items: [{ value: "/tenant", requests: 3 }],
    });
    expect((await member.analytics.topRequests({ range: "30d", by: "ip" })).items).toEqual([
      { value: "192.0.2.2", requests: 3 },
    ]);
    expect((await admin.analytics.topRequests({ by: "url" })).items).toHaveLength(2);
    expect((await rpcError(member.analytics.topRequests({ by: "ip", siteId: siteA }))).code).toBe(
      "SITE_NOT_FOUND",
    );
    const sites = await member.analytics.breakdown({ range: "1h", by: "site" });
    expect(sites.items.map((i) => [i.name, i.total])).toEqual([["tango", 3]]);
    expect(sites.total).toBe(3);
    const nodes = await rpcError(member.analytics.breakdown({ by: "node" }));
    expect(nodes).toMatchObject({ code: "FORBIDDEN", status: 403 });
    const foreign = await rpcError(member.analytics.breakdown({ by: "status", siteId: siteA }));
    expect(foreign).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });
    const edge = await admin.analytics.breakdown({ range: "1h", by: "node", siteId: siteA });
    expect(edge.items.map((i) => [i.name, i.total])).toEqual([["edge-a", 5]]);
  });

  it("keeps stars per user and within the caller's scope", async () => {
    expect(await member.sites.starred()).toEqual([]);
    await member.sites.setStarred({ id: siteT, starred: true });
    // Starring twice is a no-op.
    await member.sites.setStarred({ id: siteT, starred: true });
    expect(await member.sites.starred()).toEqual([
      { id: siteT, name: "tango", domains: ["tango.test"] },
    ]);
    expect(await owner.sites.starred()).toEqual([]);
    const denied = await rpcError(member.sites.setStarred({ id: siteA, starred: true }));
    expect(denied).toMatchObject({ code: "SITE_NOT_FOUND", status: 404 });

    await admin.sites.setStarred({ id: siteA, starred: true });
    await admin.sites.setStarred({ id: siteT, starred: true });
    expect((await admin.sites.starred()).map((s) => s.name)).toEqual(["tango", "alpha"]);

    await member.sites.setStarred({ id: siteT, starred: false });
    expect(await member.sites.starred()).toEqual([]);
    // Deleting a site drops its stars.
    await admin.sites.delete({ id: siteA });
    expect((await admin.sites.starred()).map((s) => s.name)).toEqual(["tango"]);
  });
});
