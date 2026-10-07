import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { schema } from "@edgeweir/db";
import { AccessLogSchema } from "@edgeweir/proto";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ingestLogs,
  logCutoff,
  logsCsv,
  maintainLogs,
  queryLogs,
} from "../../src/server/services/access-logs";
import { createClusterTx } from "../../src/server/services/clusters";
import { ingestStatsBatch } from "../../src/server/services/stats";
import { createTestContext, seedOperator } from "./helpers";

describe("sampled logs: bounded retention, safe export and durable acknowledgement", async () => {
  const { ctx, client } = await createTestContext();
  let node: { id: string; clusterId: string };
  let siteId: string;
  const now = Date.now();
  beforeAll(async () => {
    await seedOperator(ctx.db);
    const cluster = await ctx.db.transaction((tx) =>
      createClusterTx(tx, { name: "logs", description: "" }, { type: "user", id: "user_admin" }),
    );
    const [s] = await ctx.db
      .insert(schema.site)
      .values({ name: "logs", clusterId: cluster.id, logSampleRate: 10000, cnamePrefix: "logs" })
      .returning();
    const [n] = await ctx.db
      .insert(schema.node)
      .values({ name: "logs-node", clusterId: cluster.id })
      .returning();
    if (!s || !n) throw new Error("fixture missing");
    siteId = s.id;
    node = n;
  });
  afterAll(() => client.close());
  const entry = () =>
    create(AccessLogSchema, {
      siteId,
      time: timestampFromDate(new Date(now)),
      clientIp: "2001:db8::1",
      method: "GET",
      host: "log.test",
      path: "/hello?token=secret#fragment",
      status: 200,
      bytesSent: 42n,
      durationMs: 12,
      sampleRate: 10000,
      cacheStatus: "MISS",
    });
  const query = () => ({
    siteId,
    from: new Date(now - 60000).toISOString(),
    to: new Date(now + 60000).toISOString(),
    ip: "",
    path: "",
    limit: 100,
  });
  it("deduplicates retries, sanitizes sensitive fields and refuses an unknown site", async () => {
    expect(
      await ingestLogs(
        ctx,
        node,
        1n,
        [entry(), create(AccessLogSchema, { ...entry(), siteId: crypto.randomUUID() })],
        now,
      ),
    ).toBe(1);
    expect(await ingestLogs(ctx, node, 1n, [entry()], now)).toBe(0);
    const found = await queryLogs(ctx, query());
    expect(found.entries).toHaveLength(1);
    expect(found.entries[0]?.path).toBe("/hello");
    expect(JSON.stringify(found)).not.toContain("secret");
    expect((await queryLogs(ctx, { ...query(), status: 404 })).entries).toHaveLength(0);
    expect((await queryLogs(ctx, { ...query(), path: "/he" })).entries).toHaveLength(1);
    expect((await queryLogs(ctx, { ...query(), path: "/%" })).entries).toHaveLength(0);
    await expect(queryLogs(ctx, { ...query(), siteId: crypto.randomUUID() })).rejects.toMatchObject(
      { code: "SITE_NOT_FOUND" },
    );
    const first = found.entries[0];
    if (!first) throw new Error("expected log entry");
    const csv = logsCsv([{ ...first, host: '=HYPERLINK("evil")', path: '/a,"b\n' }]);
    expect(csv).toContain('"\'=HYPERLINK(""evil"")"');
    expect(csv).toContain('"/a,""b\n"');
  });
  it("stores logs of a site that samples nothing only while a rule samples it", async () => {
    const [quiet] = await ctx.db
      .insert(schema.site)
      .values({ name: "quiet", clusterId: node.clusterId, logSampleRate: 0, cnamePrefix: "quiet" })
      .returning();
    if (!quiet) throw new Error("fixture missing");
    const sampled = () => create(AccessLogSchema, { ...entry(), siteId: quiet.id });
    expect(await ingestLogs(ctx, node, 50n, [sampled()], now)).toBe(0);
    const rule = {
      siteId: quiet.id,
      name: "sample /logged",
      phase: "config",
      expression: 'http.request.uri.path eq "/logged"',
      priority: 0,
      action: { kind: "config", logSampleRate: 10000 },
    };
    const [row] = await ctx.db.insert(schema.edgeRule).values(rule).returning();
    expect(await ingestLogs(ctx, node, 51n, [sampled()], now)).toBe(1);
    await ctx.db
      .update(schema.edgeRule)
      .set({ enabled: false })
      .where(eq(schema.edgeRule.id, row?.id ?? ""));
    expect(await ingestLogs(ctx, node, 52n, [sampled()], now)).toBe(0);
    await ctx.db
      .update(schema.edgeRule)
      .set({ action: { kind: "config", logSampleRate: 0 }, enabled: true })
      .where(eq(schema.edgeRule.id, row?.id ?? ""));
    expect(await ingestLogs(ctx, node, 53n, [sampled()], now)).toBe(0);
  });
  it("keeps logs when a node is removed and drops expired partitions", async () => {
    const old = create(AccessLogSchema, {
      ...entry(),
      time: timestampFromDate(new Date(logCutoff(now) - 1)),
    });
    expect(await ingestLogs(ctx, node, 2n, [old], now)).toBe(0);
    const partitions = await ctx.db.execute<{ n: number }>(
      sql`select count(*)::integer AS n from pg_inherits where inhparent='access_log'::regclass`,
    );
    expect(partitions.rows[0]?.n).toBe(1);
    await ingestStatsBatch(
      ctx.db,
      node,
      1n,
      [
        {
          siteId,
          minute: new Date(now),
          requests: 7,
          bytesSent: 70,
          bytesReceived: 0,
          cacheHits: 7,
          cacheMisses: 0,
          statusCodes: { "200": 7 },
        },
      ],
      now,
    );
    await ctx.db.delete(schema.node).where(eq(schema.node.id, node.id));
    expect((await queryLogs(ctx, query())).entries).toHaveLength(1);
    expect((await ctx.db.select().from(schema.nodeMinuteStats))[0]?.requests).toBe(7);
    await maintainLogs(ctx.db, now + 8 * 86400000);
    expect(await ctx.db.select().from(schema.accessLog)).toHaveLength(0);
  });
  it("does not acknowledge a ClickHouse failure, and never falls back to storing raw logs in Postgres", async () => {
    const [newNode] = await ctx.db
      .insert(schema.node)
      .values({ name: "ch", clusterId: node.clusterId })
      .returning();
    if (!newNode) throw new Error("fixture missing");
    ctx.env.EDGEWEIR_ANALYTICS = "clickhouse";
    const mock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("unavailable", { status: 503 }));
    try {
      await expect(ingestLogs(ctx, newNode, 1n, [entry()], now)).rejects.toThrow(
        "ClickHouse request failed",
      );
      expect(
        await ctx.db
          .select()
          .from(schema.nodeLogCursor)
          .where(eq(schema.nodeLogCursor.nodeId, newNode.id)),
      ).toHaveLength(0);
      expect(await ctx.db.select().from(schema.accessLog)).toHaveLength(0);
    } finally {
      mock.mockRestore();
      ctx.env.EDGEWEIR_ANALYTICS = "lite";
    }
  });
});
