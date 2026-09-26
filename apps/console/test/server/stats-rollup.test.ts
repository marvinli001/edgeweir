import { siteCreateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { topSites, trafficBreakdown, trafficSeries } from "../../src/server/services/analytics";
import { createClusterTx } from "../../src/server/services/clusters";
import { createSite } from "../../src/server/services/sites";
import {
  ingestMinuteStats,
  ingestStatsBatch,
  type ReportedMinuteStats,
} from "../../src/server/services/stats";
import { pruneTraffic, rollupTraffic } from "../../src/server/services/stats-rollup";
import { createTestContext, seedOrganization } from "./helpers";

describe("M5 statistics identity, rollups and retention", async () => {
  const { ctx, client } = await createTestContext();
  let edge: { id: string; clusterId: string }, siteId: string;
  const now = new Date("2026-09-27T12:30:00Z");
  const actor = { type: "user" as const, id: "user_admin" };
  beforeAll(async () => {
    const { organizationId } = await seedOrganization(ctx.db);
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "stats", description: "" }, actor),
    );
    siteId = (
      await createSite(
        ctx.db,
        siteCreateInput.parse({
          name: "stats",
          clusterId: cluster.id,
          domains: ["stats.test"],
          origins: [{ address: "origin.test" }],
        }),
        { organizationId, actor, masterKey: ctx.masterKey },
      )
    ).site.id;
    const [row] = await ctx.db
      .insert(schema.node)
      .values({ clusterId: cluster.id, name: "stats" })
      .returning();
    if (!row) throw new Error("node missing");
    edge = row;
  });
  afterAll(() => client.close());
  const bucket = (date: string, requests = 10): ReportedMinuteStats => ({
    minute: new Date(date),
    siteId,
    requests,
    bytesSent: requests * 100,
    bytesReceived: requests * 10,
    cacheHits: requests - 1,
    cacheMisses: 1,
    statusCodes: { "200": requests - 1, "502": 1 },
    topUrls: { "/popular": requests },
    topIps: { "192.0.2.1": requests },
  });
  it("deduplicates retries and ignores older sequences while accepting gaps", async () => {
    const batch = [bucket("2026-09-26T10:01:15Z")];
    expect(await ingestStatsBatch(ctx.db, edge, 1n, batch, now.getTime())).toBe(1);
    expect(await ingestStatsBatch(ctx.db, edge, 1n, batch, now.getTime())).toBe(0);
    expect(await ingestStatsBatch(ctx.db, edge, 4n, batch, now.getTime())).toBe(1);
    expect(await ingestStatsBatch(ctx.db, edge, 2n, batch, now.getTime())).toBe(0);
    expect((await ctx.db.select().from(schema.nodeMinuteStats))[0]?.requests).toBe(20);
    await expect(ingestStatsBatch(ctx.db, edge, 0n, batch)).rejects.toThrow();
  });
  it("does not advance the cursor when a statistics write fails", async () => {
    await client.exec(
      `create function fail_stats() returns trigger language plpgsql as $$ begin raise exception 'disk test'; end $$; create trigger fail_stats before insert on node_minute_stats for each row execute function fail_stats();`,
    );
    await expect(
      ingestStatsBatch(ctx.db, edge, 5n, [bucket("2026-09-26T11:01:00Z")], now.getTime()),
    ).rejects.toThrow();
    expect((await ctx.db.select().from(schema.nodeStatsCursor))[0]?.sequence).toBe(4n);
    await client.exec("drop trigger fail_stats on node_minute_stats; drop function fail_stats();");
  });
  it("preserves traffic, status, Top counters and rankings before and after rollups", async () => {
    const query = { range: "30d" as const, siteId };
    const before = await trafficSeries(ctx.db, { all: true }, query, now.getTime());
    expect(await rollupTraffic(ctx.db, now)).toBeGreaterThan(0);
    expect(await trafficSeries(ctx.db, { all: true }, query, now.getTime())).toEqual(before);
    const [hour] = await ctx.db.select().from(schema.nodeHourStats),
      [day] = await ctx.db.select().from(schema.nodeDayStats);
    expect(hour).toMatchObject({
      requests: 20,
      statusCodes: { "200": 18, "502": 2 },
      topUrls: { "/popular": 20 },
    });
    expect(day).toMatchObject({
      requests: 20,
      statusCodes: { "200": 18, "502": 2 },
      topIps: { "192.0.2.1": 20 },
    });
    expect(
      (await topSites(ctx.db, { all: true }, { range: "30d", limit: 10 }, now.getTime()))[0],
    ).toMatchObject({ requests: 20, cacheHits: 18, cacheMisses: 2 });
    expect(
      (
        await trafficBreakdown(
          ctx.db,
          { all: true },
          { range: "30d", by: "status", metric: "requests", limit: 10, siteId },
          now.getTime(),
        )
      ).total,
    ).toBe(20);
    expect(await rollupTraffic(ctx.db, now)).toBe(0);
  });
  it("serves late arrivals from minute detail until the dirty hour/day is rebuilt", async () => {
    await ingestStatsBatch(ctx.db, edge, 6n, [bucket("2026-09-26T10:02:00Z", 5)], now.getTime());
    const before = await trafficSeries(
      ctx.db,
      { all: true },
      { range: "30d", siteId },
      now.getTime(),
    );
    expect(before.totals.requests).toBe(25);
    await rollupTraffic(ctx.db, now);
    expect(
      await trafficSeries(ctx.db, { all: true }, { range: "30d", siteId }, now.getTime()),
    ).toEqual(before);
    expect((await ctx.db.select().from(schema.nodeDayStats))[0]?.requests).toBe(25);
  });
  it("retains unrolled data, prunes completed details and rejects expired uploads", async () => {
    await ingestMinuteStats(ctx.db, edge, [bucket("2026-09-10T10:01:00Z", 3)]);
    await pruneTraffic(ctx.db, now);
    expect(
      (await ctx.db.select().from(schema.nodeMinuteStats)).some(
        (r) => r.minute.getUTCDate() === 10,
      ),
    ).toBe(true);
    await rollupTraffic(ctx.db, now);
    const before = await trafficSeries(
      ctx.db,
      { all: true },
      { range: "30d", siteId },
      now.getTime(),
    );
    await pruneTraffic(ctx.db, now);
    expect(
      (await ctx.db.select().from(schema.nodeMinuteStats)).some(
        (r) => r.minute.getUTCDate() === 10,
      ),
    ).toBe(false);
    expect(
      await trafficSeries(ctx.db, { all: true }, { range: "30d", siteId }, now.getTime()),
    ).toEqual(before);
    expect(
      await ingestStatsBatch(ctx.db, edge, 7n, [bucket("2026-09-10T10:01:00Z")], now.getTime()),
    ).toBe(0);
  });
});
