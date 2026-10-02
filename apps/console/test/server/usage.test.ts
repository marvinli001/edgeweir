import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { ingestMinuteStats, ingestStatsBatch } from "../../src/server/services/stats";
import {
  advanceUsageWatermark,
  maintainUsage,
  pruneUsage,
  recordStatsWatermark,
  rollupUsage,
  usageRows,
} from "../../src/server/services/usage";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const WINDOW = 300_000;

describe("recomputable 5-minute usage", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let otherSiteId: string;
  let nodeA: { id: string; clusterId: string };
  let nodeB: { id: string; clusterId: string };
  // A closed window two windows back from now, so nothing still writes into it.
  const window = Math.floor(Date.now() / WINDOW) * WINDOW - 2 * WINDOW;
  const at = (offset: number) => new Date(window + offset);
  const minuteStats = (
    site: string,
    minute: Date,
    requests: number,
    sent: number,
    received = 0,
  ) => ({
    minute,
    siteId: site,
    requests,
    bytesSent: sent,
    bytesReceived: received,
    cacheHits: 0,
    cacheMisses: 0,
    statusCodes: { "200": requests },
  });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "metered",
        domains: ["metered.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    otherSiteId = (
      await admin.sites.create({
        name: "other",
        domains: ["other-usage.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const enrolledAt = new Date(window - 3600_000);
    const [a, b] = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId, name: "a", enrolledAt, lastSeenAt: new Date() },
        { clusterId, name: "b", enrolledAt, lastSeenAt: new Date() },
      ])
      .returning();
    if (!a || !b) throw new Error("nodes missing");
    nodeA = { id: a.id, clusterId };
    nodeB = { id: b.id, clusterId };
  });
  afterAll(() => pglite.close());

  it("sums every node's minutes into one exact record per site and window", async () => {
    await ingestStatsBatch(ctx.db, nodeA, 1n, [
      minuteStats(siteId, at(0), 3, 1000, 10),
      minuteStats(siteId, at(60_000), 2, 500, 5),
      minuteStats(otherSiteId, at(0), 1, 1, 1),
    ]);
    await ingestStatsBatch(ctx.db, nodeB, 1n, [minuteStats(siteId, at(240_000), 4, 250, 1)]);
    // The next window is separate.
    await ingestStatsBatch(ctx.db, nodeB, 2n, [minuteStats(siteId, at(WINDOW), 1, 7, 7)]);
    expect(await rollupUsage(ctx.db)).toBe(3);
    const [first, second] = await usageRows(ctx.db, siteId, at(0), at(WINDOW));
    expect(first).toMatchObject({
      requests: "9",
      bytesSent: "1750",
      bytesReceived: "16",
      revision: 1,
    });
    expect(second).toMatchObject({ requests: "1", bytesSent: "7", revision: 1 });
    const listed = await admin.usage.list({
      from: at(0).toISOString(),
      to: at(2 * WINDOW).toISOString(),
      siteId,
    });
    expect(listed.items.map((i) => [i.id, i.windowStart, i.windowEnd, i.requests])).toEqual([
      [`${siteId}.${window / 1000}`, at(0).toISOString(), at(WINDOW).toISOString(), "9"],
      [
        `${siteId}.${(window + WINDOW) / 1000}`,
        at(WINDOW).toISOString(),
        at(2 * WINDOW).toISOString(),
        "1",
      ],
    ]);
  });

  it("does not change anything when a batch is retried", async () => {
    const before = await usageRows(ctx.db, siteId, at(0), at(0));
    expect(await ingestStatsBatch(ctx.db, nodeA, 1n, [minuteStats(siteId, at(0), 100, 100)])).toBe(
      0,
    );
    await rollupUsage(ctx.db);
    expect(await usageRows(ctx.db, siteId, at(0), at(0))).toEqual(before);
    // A recomputation that yields the same values changes neither revision nor seq.
    await ingestStatsBatch(ctx.db, nodeA, 2n, [minuteStats(siteId, at(0), 0, 0, 0)]);
    expect(await rollupUsage(ctx.db)).toBe(0);
    expect(await usageRows(ctx.db, siteId, at(0), at(0))).toEqual(before);
  });

  it("turns late data into a revision with a new seq that usage.changes returns again", async () => {
    const [before] = await usageRows(ctx.db, siteId, at(0), at(0));
    const changes = await admin.usage.changes({});
    const seen = changes.items.find(
      (i) => i.siteId === siteId && i.windowStart === at(0).toISOString(),
    );
    expect(seen?.revision).toBe(1);
    await ingestStatsBatch(ctx.db, nodeB, 3n, [minuteStats(siteId, at(120_000), 1, 50, 0)]);
    expect(await rollupUsage(ctx.db)).toBe(1);
    const [after] = await usageRows(ctx.db, siteId, at(0), at(0));
    expect(after).toMatchObject({ requests: "10", bytesSent: "1800", revision: 2 });
    expect(after?.seq).toBeGreaterThan(before?.seq ?? 0n);
    const next = await admin.usage.changes({ afterSeq: changes.lastSeq });
    expect(next.items.map((i) => [i.id, i.revision, i.requests])).toEqual([
      [`${siteId}.${window / 1000}`, 2, "10"],
    ]);
    expect(BigInt(next.lastSeq)).toBeGreaterThan(BigInt(changes.lastSeq));
    const idle = await admin.usage.changes({ afterSeq: next.lastSeq });
    expect(idle).toMatchObject({ items: [], lastSeq: next.lastSeq });
  });

  it("keeps a window dirty when nodes report into it while it is computed", async () => {
    // Reports that commit after the window was computed, before its markers are cleared.
    const race = async (offset: number, node: { id: string; clusterId: string }, seq: bigint) => {
      const start = window - offset * WINDOW;
      await ingestStatsBatch(ctx.db, nodeA, seq, [minuteStats(siteId, new Date(start), 1, 10)]);
      let injected = false;
      await rollupUsage(ctx.db, new Date(), 500, async (tx) => {
        if (injected) return;
        injected = true;
        await ingestMinuteStats(tx, node, [minuteStats(siteId, new Date(start + 60_000), 2, 20)]);
      });
      const [first] = await usageRows(ctx.db, siteId, new Date(start), new Date(start));
      expect(first).toMatchObject({ requests: "1" });
      expect(await rollupUsage(ctx.db)).toBe(1);
      const [second] = await usageRows(ctx.db, siteId, new Date(start), new Date(start));
      expect(second).toMatchObject({ requests: "3", bytesSent: "30", revision: 2 });
    };
    // A's marker was read: the report gives it a new generation.
    await race(12, nodeA, 3n);
    // B had no marker: the report adds one that was never read.
    await race(13, nodeB, 4n);
  });

  it("keeps values above 2^53 exact", async () => {
    const big = Number.MAX_SAFE_INTEGER; // per-row counters saturate here
    const later = window - 4 * WINDOW;
    const rows = [0, 1, 2, 3, 4].flatMap((m) =>
      [nodeA.id, nodeB.id].map((nodeId) => ({
        minute: new Date(later + m * 60_000),
        nodeId,
        siteId,
        requests: big,
        bytesSent: big,
        bytesReceived: 1,
      })),
    );
    await ctx.db.insert(schema.nodeMinuteStats).values(rows);
    await ctx.db.insert(schema.statsRollupDirty).values({
      granularity: "usage",
      bucket: new Date(later),
      nodeId: nodeA.id,
      siteId,
    });
    await rollupUsage(ctx.db);
    const [record] = (
      await admin.usage.list({
        from: new Date(later).toISOString(),
        to: new Date(later + WINDOW).toISOString(),
      })
    ).items;
    expect(record?.requests).toBe((10n * BigInt(big)).toString());
    expect(record?.requests).toBe("90071992547409910");
    expect(record?.bytesSent).toBe("90071992547409910");
    expect(record?.bytesReceived).toBe("10");
  });

  it("refuses ranges that are not 5-minute aligned or empty", async () => {
    const ranges: [Date, Date][] = [
      [at(1000), at(WINDOW)],
      [at(0), at(WINDOW + 60_000)],
      [at(WINDOW), at(WINDOW)],
      [at(WINDOW), at(0)],
    ];
    for (const [from, to] of ranges) {
      const error = await rpcError(
        admin.usage.list({ from: from.toISOString(), to: to.toISOString() }),
      );
      expect(error.code).toBe("USAGE_RANGE_INVALID");
      expect(error.status).toBe(400);
    }
    expect(
      (
        await rpcError(
          admin.usage.list({
            from: at(0).toISOString(),
            to: at(WINDOW).toISOString(),
            cursor: "x",
          }),
        )
      ).code,
    ).toBe("USAGE_CURSOR_INVALID");
  });

  it("pages by (window, site) with a cursor", async () => {
    const all = await admin.usage.list({
      from: new Date(window - 8 * WINDOW).toISOString(),
      to: at(3 * WINDOW).toISOString(),
    });
    expect(all.items.length).toBe(4);
    const pages = [];
    let cursor: string | undefined;
    do {
      const page = await admin.usage.list({
        from: new Date(window - 8 * WINDOW).toISOString(),
        to: at(3 * WINDOW).toISOString(),
        limit: 1,
        cursor,
      });
      pages.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(pages.map((p) => p.id)).toEqual(all.items.map((i) => i.id));
    const keys = all.items.map((i) => `${i.windowStart}|${i.siteId}`);
    expect(keys).toEqual([...keys].sort());
  });

  it("filters by site", async () => {
    const range = {
      from: new Date(window - 8 * WINDOW).toISOString(),
      to: at(3 * WINDOW).toISOString(),
    };
    const filtered = await admin.usage.list({ ...range, siteId: otherSiteId });
    expect(filtered.items.map((i) => i.siteId)).toEqual([otherSiteId]);
  });

  it("advances completeUntil with the slowest active node and skips offline ones", async () => {
    const now = new Date(window + 3 * WINDOW + 30_000);
    await recordStatsWatermark(ctx.db, nodeA.id, at(3 * WINDOW), now.getTime());
    await recordStatsWatermark(ctx.db, nodeB.id, at(WINDOW + 60_000), now.getTime());
    // B reported up to 1 minute into the second window: only the first window is complete.
    expect(await advanceUsageWatermark(ctx.db, now)).toEqual(at(WINDOW));
    expect(
      (await admin.usage.list({ from: at(0).toISOString(), to: at(WINDOW).toISOString() }))
        .completeUntil,
    ).toBe(at(WINDOW).toISOString());
    // A watermark that goes back is ignored.
    await recordStatsWatermark(ctx.db, nodeB.id, at(0), now.getTime());
    expect(await advanceUsageWatermark(ctx.db, now)).toEqual(at(WINDOW));
    // B goes offline longer than the threshold: it no longer holds the watermark back.
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(now.getTime() - 61 * 60_000) })
      .where(eq(schema.node.id, nodeB.id));
    expect(await advanceUsageWatermark(ctx.db, now)).toEqual(at(3 * WINDOW));
    // B returns with its old watermark; the stored watermark never goes back.
    await ctx.db.update(schema.node).set({ lastSeenAt: now }).where(eq(schema.node.id, nodeB.id));
    expect(await advanceUsageWatermark(ctx.db, now)).toEqual(at(3 * WINDOW));
    // Its late data for a complete window becomes a revision.
    await ingestStatsBatch(
      ctx.db,
      nodeB,
      4n,
      [minuteStats(siteId, at(WINDOW), 1, 1, 1)],
      now.getTime(),
    );
    await rollupUsage(ctx.db, now);
    const [second] = await usageRows(ctx.db, siteId, at(WINDOW), at(WINDOW));
    expect(second).toMatchObject({ requests: "2", revision: 2 });
  });

  it("counts a node that never reported a watermark from its enrollment", async () => {
    const now = new Date(window + 6 * WINDOW);
    await ctx.db.insert(schema.node).values({
      clusterId,
      name: "old-agent",
      enrolledAt: at(4 * WINDOW + 60_000),
      lastSeenAt: now,
    });
    await recordStatsWatermark(ctx.db, nodeA.id, at(6 * WINDOW), now.getTime());
    await recordStatsWatermark(ctx.db, nodeB.id, at(6 * WINDOW), now.getTime());
    expect(await advanceUsageWatermark(ctx.db, now)).toEqual(at(4 * WINDOW));
  });

  it("holds completeUntil before windows that are still waiting to be computed", async () => {
    const now = new Date(window + 8 * WINDOW);
    await ctx.db
      .update(schema.node)
      .set({ status: "disabled" })
      .where(eq(schema.node.name, "old-agent"));
    await recordStatsWatermark(ctx.db, nodeA.id, at(8 * WINDOW), now.getTime());
    await recordStatsWatermark(ctx.db, nodeB.id, at(8 * WINDOW), now.getTime());
    await ctx.db.insert(schema.statsRollupDirty).values({
      granularity: "usage",
      bucket: at(5 * WINDOW),
      nodeId: nodeA.id,
      siteId,
    });
    expect(await advanceUsageWatermark(ctx.db, now)).toEqual(at(5 * WINDOW));
    await maintainUsage(ctx.db, now);
    expect(await advanceUsageWatermark(ctx.db, now)).toEqual(at(8 * WINDOW));
  });

  it("keeps usage for the configured retention and audits settings", async () => {
    expect(await admin.settings.usage()).toEqual({
      retentionDays: 100,
      offlineThresholdMinutes: 60,
    });
    await admin.settings.setUsage({ retentionDays: 35, offlineThresholdMinutes: 30 });
    expect((await admin.auditLogs.list({ action: "system.usage_update" })).items[0]).toMatchObject({
      metadata: { to: { retentionDays: 35, offlineThresholdMinutes: 30 } },
    });
    for (const bad of [
      { retentionDays: 34, offlineThresholdMinutes: 60 },
      { retentionDays: 401, offlineThresholdMinutes: 60 },
      { retentionDays: 100, offlineThresholdMinutes: 4 },
    ])
      expect((await rpcError(admin.settings.setUsage(bad))).status).toBe(400);
    expect(await pruneUsage(ctx.db, new Date(window + 36 * 86_400_000))).toBeGreaterThan(0);
    expect(await usageRows(ctx.db, siteId, at(-100 * WINDOW), at(10 * WINDOW))).toEqual([]);
  });
});
