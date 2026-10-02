import { siteCreateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { ne } from "drizzle-orm";
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
import { rollupUsage } from "../../src/server/services/usage";
import { createTestContext, seedOperator } from "./helpers";

describe("M5 statistics identity, rollups and retention", async () => {
  const { ctx, client } = await createTestContext();
  let edge: { id: string; clusterId: string }, siteId: string;
  const now = new Date("2026-09-27T12:30:00Z");
  const actor = { type: "user" as const, id: "user_admin" };
  beforeAll(async () => {
    await seedOperator(ctx.db);
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
        { actor, masterKey: ctx.masterKey },
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
    const before = await trafficSeries(ctx.db, query, now.getTime());
    expect(await rollupTraffic(ctx.db, now)).toBeGreaterThan(0);
    expect(await trafficSeries(ctx.db, query, now.getTime())).toEqual(before);
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
    expect((await topSites(ctx.db, { range: "30d", limit: 10 }, now.getTime()))[0]).toMatchObject({
      requests: 20,
      cacheHits: 18,
      cacheMisses: 2,
    });
    expect(
      (
        await trafficBreakdown(
          ctx.db,
          { range: "30d", by: "status", metric: "requests", limit: 10, siteId },
          now.getTime(),
        )
      ).total,
    ).toBe(20);
    expect(await rollupTraffic(ctx.db, now)).toBe(0);
  });
  it("serves late arrivals from minute detail until the dirty hour/day is rebuilt", async () => {
    await ingestStatsBatch(ctx.db, edge, 6n, [bucket("2026-09-26T10:02:00Z", 5)], now.getTime());
    const before = await trafficSeries(ctx.db, { range: "30d", siteId }, now.getTime());
    expect(before.totals.requests).toBe(25);
    await rollupTraffic(ctx.db, now);
    expect(await trafficSeries(ctx.db, { range: "30d", siteId }, now.getTime())).toEqual(before);
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
    const before = await trafficSeries(ctx.db, { range: "30d", siteId }, now.getTime());
    // The usage window of the minute is not computed yet: the minute stays.
    await pruneTraffic(ctx.db, now);
    expect(
      (await ctx.db.select().from(schema.nodeMinuteStats)).some(
        (r) => r.minute.getUTCDate() === 10,
      ),
    ).toBe(true);
    await rollupUsage(ctx.db, now);
    await pruneTraffic(ctx.db, now);
    expect(
      (await ctx.db.select().from(schema.nodeMinuteStats)).some(
        (r) => r.minute.getUTCDate() === 10,
      ),
    ).toBe(false);
    expect(await trafficSeries(ctx.db, { range: "30d", siteId }, now.getTime())).toEqual(before);
    expect(
      await ingestStatsBatch(ctx.db, edge, 7n, [bucket("2026-09-10T10:01:00Z")], now.getTime()),
    ).toBe(0);
  });
  it("keeps combined minute and rollup counters inside the API numeric range", async () => {
    const maximum = Number.MAX_SAFE_INTEGER;
    const item: ReportedMinuteStats = {
      ...bucket("2026-09-25T10:01:00Z", 1),
      requests: maximum - 1,
      bytesSent: maximum - 1,
      bytesReceived: maximum - 1,
      cacheHits: maximum - 1,
      cacheMisses: maximum - 1,
      statusCodes: { "200": maximum - 1 },
      topUrls: { "/counter-range": maximum - 1 },
      topIps: { "192.0.2.1": maximum - 1 },
    };
    await ingestMinuteStats(ctx.db, edge, [item, item]);
    await ingestMinuteStats(ctx.db, edge, [
      item,
      { ...item, minute: new Date("2026-09-25T10:02:00Z") },
    ]);
    const minute = (await ctx.db.select().from(schema.nodeMinuteStats)).find(
      (row) => row.minute.getUTCDate() === 25,
    );
    expect(minute).toMatchObject({
      requests: maximum,
      bytesSent: maximum,
      statusCodes: { "200": maximum },
    });
    expect(await rollupTraffic(ctx.db, now)).toBeGreaterThan(0);
    const day = (await ctx.db.select().from(schema.nodeDayStats)).find(
      (row) => row.minute.getUTCDate() === 25,
    );
    expect(day).toMatchObject({
      requests: maximum,
      bytesSent: maximum,
      statusCodes: { "200": maximum },
      topUrls: { "/counter-range": maximum },
    });
    expect(await rollupTraffic(ctx.db, now)).toBe(0);
  });
  it("keeps an hour dirty when a report lands while it is rolled up", async () => {
    await ingestMinuteStats(ctx.db, edge, [bucket("2026-09-24T08:10:00Z", 3)]);
    let injected = false;
    // The report commits between the hour's aggregate and the clearing of its marker.
    await rollupTraffic(ctx.db, now, 200, 30_000, async (tx) => {
      if (injected) return;
      injected = true;
      await ingestMinuteStats(tx, edge, [bucket("2026-09-24T08:59:00Z", 4)]);
    });
    const requestsAt = (rows: { minute: Date; requests: number }[], minute: string) =>
      rows.find((row) => row.minute.toISOString() === minute)?.requests;
    const hours = () => ctx.db.select().from(schema.nodeHourStats);
    expect(requestsAt(await hours(), "2026-09-24T08:00:00.000Z")).toBe(3);
    await rollupTraffic(ctx.db, now);
    expect(requestsAt(await hours(), "2026-09-24T08:00:00.000Z")).toBe(7);
    const days = await ctx.db.select().from(schema.nodeDayStats);
    expect(requestsAt(days, "2026-09-24T00:00:00.000Z")).toBe(7);
    expect(await rollupTraffic(ctx.db, now)).toBe(0);
  });
  it("drains a backlog in batches and passes over days whose hours are still dirty", async () => {
    await ingestMinuteStats(ctx.db, edge, [
      bucket("2026-09-20T01:00:00Z", 1),
      bucket("2026-09-20T02:00:00Z", 2),
      bucket("2026-09-20T03:00:00Z", 4),
    ]);
    // A later day that only waits for its own rollup.
    await ctx.db.insert(schema.nodeHourStats).values({
      minute: new Date("2026-09-21T05:00:00Z"),
      nodeId: edge.id,
      siteId,
      requests: 8,
    });
    await ctx.db.insert(schema.statsRollupDirty).values({
      granularity: "day",
      bucket: new Date("2026-09-21T00:00:00Z"),
      nodeId: edge.id,
      siteId,
    });
    const day = async (minute: string) =>
      (await ctx.db.select().from(schema.nodeDayStats)).find(
        (row) => row.minute.toISOString() === minute,
      )?.requests;
    // No time left: one batch of one key per granularity.
    expect(await rollupTraffic(ctx.db, now, 1, 0)).toBe(2);
    expect(await day("2026-09-21T00:00:00.000Z")).toBe(8);
    expect(await day("2026-09-20T00:00:00.000Z")).toBeUndefined();
    // With time, batches continue until nothing is left.
    expect(await rollupTraffic(ctx.db, now, 1)).toBe(3);
    expect(await day("2026-09-20T00:00:00.000Z")).toBe(7);
    expect(
      await ctx.db
        .select()
        .from(schema.statsRollupDirty)
        .where(ne(schema.statsRollupDirty.granularity, "usage")),
    ).toEqual([]);
  });
});
