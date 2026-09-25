import { siteCreateInput } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, asc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createClusterTx } from "../../src/server/services/clusters";
import { createSite } from "../../src/server/services/sites";
import {
  ingestMinuteStats,
  MAX_STATS_PER_REPORT,
  type ReportedMinuteStats,
} from "../../src/server/services/stats";
import { createTestContext, seedOrganization } from "./helpers";

const actor = { type: "user" as const, id: "user_admin" };
const MINUTE = 60_000;
const T0 = Date.UTC(2026, 8, 1, 12, 0);

const bucket = (
  siteId: string,
  at: number,
  counters: Partial<Omit<ReportedMinuteStats, "minute" | "siteId">> = {},
): ReportedMinuteStats => ({
  minute: new Date(at),
  siteId,
  requests: 0,
  bytesSent: 0,
  bytesReceived: 0,
  cacheHits: 0,
  cacheMisses: 0,
  statusCodes: {},
  ...counters,
});

describe("node minute stats ingestion (ReportStats)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  let node: { id: string; clusterId: string };
  let siteA: string;
  let siteB: string;
  let foreignSite: string;

  const rowsOf = (siteId: string) =>
    ctx.db
      .select()
      .from(schema.nodeMinuteStats)
      .where(
        and(eq(schema.nodeMinuteStats.nodeId, node.id), eq(schema.nodeMinuteStats.siteId, siteId)),
      )
      .orderBy(asc(schema.nodeMinuteStats.minute));

  beforeAll(async () => {
    const { organizationId } = await seedOrganization(ctx.db);
    const [cluster, other] = await ctx.db.transaction(async (tx) => [
      await createClusterTx(tx, { name: "default", description: "" }, actor),
      await createClusterTx(tx, { name: "other", description: "" }, actor),
    ]);
    if (!cluster || !other) throw new Error("no clusters");
    const site = async (name: string, clusterId: string) =>
      (
        await createSite(
          ctx.db,
          siteCreateInput.parse({
            name,
            clusterId,
            domains: [`${name}.test`],
            origins: [{ address: "origin.test" }],
          }),
          { organizationId, actor, masterKey: ctx.masterKey },
        )
      ).site.id;
    siteA = await site("a", cluster.id);
    siteB = await site("b", cluster.id);
    foreignSite = await site("foreign", other.id);
    const [row] = await ctx.db
      .insert(schema.node)
      .values({ clusterId: cluster.id, name: "edge-1" })
      .returning();
    if (!row) throw new Error("no node");
    node = row;
  });
  afterAll(() => pglite.close());

  it("adds counters across reports and merges status codes key by key", async () => {
    await ingestMinuteStats(ctx.db, node, [
      bucket(siteA, T0, {
        requests: 10,
        bytesSent: 1000,
        bytesReceived: 100,
        cacheHits: 7,
        cacheMisses: 3,
        statusCodes: { "200": 9, "404": 1 },
      }),
    ]);
    await ingestMinuteStats(ctx.db, node, [
      bucket(siteA, T0, {
        requests: 5,
        bytesSent: 500,
        bytesReceived: 50,
        cacheHits: 1,
        cacheMisses: 4,
        statusCodes: { "200": 4, "502": 1 },
      }),
    ]);
    expect(await rowsOf(siteA)).toEqual([
      expect.objectContaining({
        minute: new Date(T0),
        requests: 15,
        bytesSent: 1500,
        bytesReceived: 150,
        cacheHits: 8,
        cacheMisses: 7,
        statusCodes: { "200": 13, "404": 1, "502": 1 },
      }),
    ]);
  });

  it("sums buckets of the same minute and site inside one report", async () => {
    const at = T0 + 10 * MINUTE;
    const accepted = await ingestMinuteStats(ctx.db, node, [
      // Seconds are truncated: both land in the same minute.
      bucket(siteB, at + 5_000, { requests: 1, statusCodes: { "200": 1 } }),
      bucket(siteB, at + 50_000, {
        requests: 2,
        cacheHits: 2,
        statusCodes: { "200": 1, "304": 1 },
      }),
      bucket(siteB, at + MINUTE, { requests: 4 }),
      bucket(siteB.toUpperCase(), at, { requests: 8 }),
    ]);
    expect(accepted).toBe(4);
    const rows = await rowsOf(siteB);
    expect(rows.map((r) => [r.minute.getTime(), r.requests])).toEqual([
      [at, 11],
      [at + MINUTE, 4],
    ]);
    expect(rows[0]).toMatchObject({ cacheHits: 2, statusCodes: { "200": 2, "304": 1 } });
  });

  it("drops buckets of other clusters, unknown sites and malformed ids", async () => {
    const at = T0 + 20 * MINUTE;
    const accepted = await ingestMinuteStats(ctx.db, node, [
      bucket(foreignSite, at, { requests: 1 }),
      bucket("00000000-0000-4000-8000-000000000000", at, { requests: 1 }),
      bucket("not-a-uuid", at, { requests: 1 }),
      bucket(siteA, Number.NaN, { requests: 1 }),
      bucket(siteA, at, { requests: 3 }),
    ]);
    expect(accepted).toBe(1);
    expect(await rowsOf(foreignSite)).toEqual([]);
    expect((await rowsOf(siteA)).at(-1)).toMatchObject({ minute: new Date(at), requests: 3 });
    expect(await ingestMinuteStats(ctx.db, node, [bucket(foreignSite, at)])).toBe(0);
    expect(await ingestMinuteStats(ctx.db, node, [])).toBe(0);
  });

  it("stores a full report of 5000 buckets with a single statement", async () => {
    const start = T0 + 1000 * MINUTE;
    const report = Array.from({ length: MAX_STATS_PER_REPORT + 1 }, (_, i) =>
      bucket(i % 2 ? siteA : siteB, start + Math.floor(i / 2) * MINUTE, {
        requests: 1,
        bytesSent: i,
        statusCodes: { "200": 1 },
      }),
    );
    const query = vi.spyOn(pglite, "query");
    try {
      // The bucket beyond the limit is dropped.
      expect(await ingestMinuteStats(ctx.db, node, report)).toBe(MAX_STATS_PER_REPORT);
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
    const stored = [...(await rowsOf(siteA)), ...(await rowsOf(siteB))].filter(
      (r) => r.minute.getTime() >= start,
    );
    expect(stored).toHaveLength(MAX_STATS_PER_REPORT);
    expect(stored.reduce((sum, r) => sum + r.requests, 0)).toBe(MAX_STATS_PER_REPORT);
    expect(stored.reduce((sum, r) => sum + r.bytesSent, 0)).toBe(
      ((MAX_STATS_PER_REPORT - 1) * MAX_STATS_PER_REPORT) / 2,
    );

    // Reporting the same buckets again doubles them in place.
    const again = vi.spyOn(pglite, "query");
    try {
      await ingestMinuteStats(ctx.db, node, report);
      expect(again).toHaveBeenCalledTimes(1);
    } finally {
      again.mockRestore();
    }
    const doubled = (await rowsOf(siteB)).filter((r) => r.minute.getTime() >= start);
    expect(doubled).toHaveLength(MAX_STATS_PER_REPORT / 2);
    expect(doubled.every((r) => r.requests === 2 && r.statusCodes["200"] === 2)).toBe(true);
  });
});
