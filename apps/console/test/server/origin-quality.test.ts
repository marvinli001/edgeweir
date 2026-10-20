import { MAX_STATS_ORIGINS, ORIGIN_STATS_FEATURE } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { headerTimeQuantile, originQuality } from "../../src/server/services/origin-quality";
import { ingestMinuteStats } from "../../src/server/services/stats";
import type { ReportedOrigin } from "../../src/server/services/stats-dims";
import { rollupTraffic } from "../../src/server/services/stats-rollup";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

const fetches = (originId: string, extra: Partial<ReportedOrigin> = {}): ReportedOrigin => ({
  originId,
  requests: 10,
  connectFailures: 1,
  timeouts: 0,
  tlsFailures: 0,
  invalidResponses: 0,
  serverErrors: 1,
  headerTimeBuckets: [0, 4, 4, 2, 0, 0, 0, 0, 0, 0, 0],
  headerTimeMsSum: 400,
  ...extra,
});

describe("origin quality (origin-stats-v1)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const publicUrl = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let nodeId: string;
  let first: string;
  let second: string;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, publicUrl, await signIn(app, publicUrl, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const created = await admin.sites.create({
      name: "origins",
      domains: ["origins.test"],
      origins: [
        { address: "a.origin.test" },
        { address: "b.origin.test", port: 8080, backup: true },
      ],
    });
    siteId = created.site.id;
    const origins = (await admin.sites.get({ id: siteId })).origins;
    first = origins.find((o) => o.address === "a.origin.test")?.id ?? "";
    second = origins.find((o) => o.address === "b.origin.test")?.id ?? "";
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-origins", supportedFeatures: [ORIGIN_STATS_FEATURE] })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("interpolates header time percentiles in the buckets", () => {
    const buckets = [0, 4, 4, 2, 0, 0, 0, 0, 0, 0, 0];
    expect(headerTimeQuantile(buckets, 0.5)).toBe(31.3);
    expect(headerTimeQuantile(buckets, 0.95)).toBe(87.5);
    expect(headerTimeQuantile(buckets, 0.99)).toBe(97.5);
    expect(headerTimeQuantile([2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], 0.5)).toBe(5);
    expect(headerTimeQuantile([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3], 0.5)).toBe(10000);
    expect(headerTimeQuantile(Array(11).fill(0), 0.5)).toBeNull();
  });

  it("stores valid origins' counters and answers each current origin's quality", async () => {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const deleted = "00000000-0000-4000-8000-00000000dead";
    const bucket = (origins: ReportedOrigin[]) => ({
      minute,
      siteId,
      requests: 10,
      bytesSent: 0,
      bytesReceived: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCodes: {},
      dimensions: { origins },
    });
    const node = { id: nodeId, clusterId };
    await ingestMinuteStats(ctx.db, node, [
      bucket([
        fetches(first),
        fetches(second, { requests: 4, connectFailures: 0, serverErrors: 0, timeouts: 2 }),
        fetches("not-an-origin"),
        fetches(deleted, { headerTimeBuckets: [1, 2], headerTimeMsSum: 9 }),
        fetches("00000000-0000-4000-8000-00000000beef", { requests: 0 }),
      ]),
      bucket([fetches(first, { requests: 5, connectFailures: 0, serverErrors: 0 })]),
    ]);
    const [row] = await ctx.db
      .select()
      .from(schema.nodeMinuteStats)
      .where(eq(schema.nodeMinuteStats.siteId, siteId));
    expect(row?.originStats).toEqual({
      [`${first}:n`]: 15,
      [`${first}:cf`]: 1,
      [`${first}:e5`]: 1,
      [`${first}:ms`]: 800,
      [`${first}:h1`]: 8,
      [`${first}:h2`]: 8,
      [`${first}:h3`]: 4,
      [`${second}:n`]: 4,
      [`${second}:to`]: 2,
      [`${second}:ms`]: 400,
      [`${second}:h1`]: 4,
      [`${second}:h2`]: 4,
      [`${second}:h3`]: 2,
      // Buckets of the wrong length drop the header times.
      [`${deleted}:n`]: 10,
      [`${deleted}:cf`]: 1,
      [`${deleted}:e5`]: 1,
    });

    const quality = await admin.sites.originQuality({ id: siteId, range: "1h" });
    expect(quality.times).toHaveLength(60);
    expect(quality.unsupportedNodes).toBe(0);
    expect(quality.items.map((item) => item.originId)).toEqual([first, second]);
    const [a, b] = quality.items;
    expect(a).toMatchObject({
      address: "a.origin.test",
      port: 80,
      scheme: "http",
      group: "",
      backup: false,
      requests: 15,
      failures: { connect: 1, timeout: 0, tls: 0, invalid: 0, server: 1 },
      errors: 2,
      answered: 20,
      meanMs: 40,
      p50Ms: 31.3,
      p95Ms: 87.5,
      p99Ms: 97.5,
    });
    expect(a?.errorRate).toBeCloseTo(2 / 15);
    const at = quality.times.indexOf(minute.toISOString());
    expect(at).toBeGreaterThanOrEqual(0);
    expect(a?.series.requests[at]).toBe(15);
    expect(a?.series.errors[at]).toBe(2);
    expect(a?.series.p95Ms[at]).toBe(87.5);
    expect(a?.series.requests.reduce((x, y) => x + y, 0)).toBe(15);
    expect(a?.series.p95Ms.filter((v) => v !== null)).toHaveLength(1);
    expect(b).toMatchObject({ port: 8080, backup: true, requests: 4, errors: 2, errorRate: 0.5 });

    // Long ranges read the hourly rollups, before and after they are built.
    const week = await originQuality(ctx.db, { id: siteId, range: "7d" });
    expect(week.items[0]?.requests).toBe(15);
    await rollupTraffic(ctx.db, new Date(minute.getTime() + 2 * 3600_000));
    const [hour] = await ctx.db
      .select()
      .from(schema.nodeHourStats)
      .where(eq(schema.nodeHourStats.siteId, siteId));
    expect(hour?.originStats).toMatchObject({ [`${first}:n`]: 15, [`${second}:to`]: 2 });
    const month = await originQuality(ctx.db, { id: siteId, range: "30d" });
    expect(month.items.map((item) => [item.requests, item.p95Ms])).toEqual([
      [15, 87.5],
      [4, 87.5],
    ]);

    // A node without origin-stats-v1 makes the counts partial.
    await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-old", supportedFeatures: ["rules-v1"] });
    expect((await admin.sites.originQuality({ id: siteId })).unsupportedNodes).toBe(1);
  });

  it(`keeps the ${MAX_STATS_ORIGINS} origins with the most attempts of a report`, async () => {
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 5 * 60_000);
    const many = Array.from({ length: MAX_STATS_ORIGINS + 6 }, (_, i) =>
      fetches(`00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, { requests: i + 1 }),
    );
    const bucket = (origins: ReportedOrigin[]) => ({
      minute,
      siteId,
      requests: 1,
      bytesSent: 0,
      bytesReceived: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCodes: {},
      dimensions: { origins },
    });
    await ingestMinuteStats(ctx.db, { id: nodeId, clusterId }, [
      bucket(many.slice(0, 40)),
      bucket(many.slice(40)),
    ]);
    const [row] = await ctx.db
      .select()
      .from(schema.nodeMinuteStats)
      .where(eq(schema.nodeMinuteStats.minute, minute));
    const ids = new Set(Object.keys(row?.originStats ?? {}).map((k) => k.split(":")[0]));
    expect(ids.size).toBe(MAX_STATS_ORIGINS);
    expect(ids.has(many[0]?.originId ?? "")).toBe(false);
    expect(ids.has(many[MAX_STATS_ORIGINS + 5]?.originId ?? "")).toBe(true);
  });

  it("answers SITE_NOT_FOUND for an unknown site", async () => {
    await expect(
      admin.sites.originQuality({ id: "00000000-0000-4000-8000-000000000000" }),
    ).rejects.toMatchObject({ code: "SITE_NOT_FOUND" });
  });
});
