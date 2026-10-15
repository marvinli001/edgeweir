import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { DEMO_EMAIL, DEMO_PASSWORD, NODE_LOGS_FEATURE } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  NodeLogEntrySchema,
  NodeLogLevel,
  NodeLogSource,
  ReportNodeLogsRequestSchema,
} from "@edgeweir/proto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  ingestNodeLogs,
  listNodeLogs,
  nodeLogCursor,
  pruneNodeLogs,
} from "../../src/server/services/node-logs";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("node logs (ADR-0050)", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let nodeId: string;
  const now = Date.now();
  const at = (offset: number) => timestampFromDate(new Date(now + offset));
  const entry = (init: MessageInitShape<typeof NodeLogEntrySchema> = {}) =>
    create(NodeLogEntrySchema, {
      time: at(0),
      level: NodeLogLevel.WARN,
      source: NodeLogSource.AGENT,
      message: "report failed",
      ...init,
    });
  const batch = (sequence: bigint, entries: ReturnType<typeof entry>[], dropped = [0, 0]) =>
    create(ReportNodeLogsRequestSchema, {
      batchSequence: sequence,
      entries,
      droppedRateLimited: dropped[0],
      droppedOverflow: dropped[1],
    });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const [cluster] = await ctx.db.select().from(schema.cluster).limit(1);
    if (!cluster) throw new Error("no cluster");
    const [n] = await ctx.db
      .insert(schema.node)
      .values({ name: "logs-node", clusterId: cluster.id, supportedFeatures: [NODE_LOGS_FEATURE] })
      .returning();
    if (!n) throw new Error("fixture missing");
    nodeId = n.id;
  });
  afterAll(() => client.close());

  it("stores a batch once, removes secrets again and keeps only events at info", async () => {
    const node = { id: nodeId };
    const first = batch(
      1n,
      [
        entry({
          level: NodeLogLevel.ERROR,
          source: NodeLogSource.NGINX,
          message: "connect() failed (111: Connection refused) while connecting to upstream",
          fields: {
            client: "192.0.2.77",
            request: "GET /x?token=e2e-secret HTTP/1.1",
            upstream: "http://127.0.0.1:9/x?token=e2e-secret",
            authorization: "Bearer abc",
            "Bad Key": "dropped",
          },
        }),
        entry({ level: NodeLogLevel.INFO, message: "pushed site table" }),
        entry({
          level: NodeLogLevel.INFO,
          message: "configuration applied",
          event: "config_applied",
        }),
        entry({ level: NodeLogLevel.INFO, message: "x", event: "made_up" }),
        entry({ level: NodeLogLevel.UNSPECIFIED }),
        entry({ source: NodeLogSource.UNSPECIFIED }),
        // Older than the retention: not kept; far ahead: dated when it arrived.
        entry({ time: at(-8 * 86_400_000), message: "too old" }),
        entry({
          time: at(3_600_000),
          level: NodeLogLevel.INFO,
          message: "ahead",
          event: "config_applied",
        }),
        entry({ message: "a\u0000b\nc", component: "Bad Component" }),
      ],
      [3, 2],
    );
    // nginx, two events and the cleaned one; the drops are a row of their own.
    expect(await ingestNodeLogs(ctx, node, first, now)).toBe(4);
    // A retry of the same batch stores nothing more.
    expect(await ingestNodeLogs(ctx, node, first, now)).toBe(0);
    expect(await nodeLogCursor(ctx.db, nodeId)).toBe(1n);

    const page = await listNodeLogs(ctx.db, { id: nodeId, limit: 100 });
    expect(page.supported).toBe(true);
    const json = JSON.stringify(page);
    expect(json).not.toContain("e2e-secret");
    expect(json).not.toContain("Bearer abc");
    const nginx = page.entries.find((e) => e.source === "nginx");
    expect(nginx?.fields).toEqual({
      client: "192.0.2.77",
      request: "GET /x?[redacted] HTTP/1.1",
      upstream: "http://127.0.0.1:9/x?[redacted]",
      authorization: "[redacted]",
    });
    expect(page.entries.filter((e) => e.level === "info").map((e) => e.event)).toEqual([
      "config_applied",
      "config_applied",
    ]);
    const ahead = page.entries.find((e) => e.message === "ahead");
    expect(ahead?.time).toBe(new Date(now).toISOString());
    expect(page.entries.some((e) => e.message === "too old")).toBe(false);
    const cleaned = page.entries.find((e) => e.message.startsWith("ab"));
    expect(cleaned).toMatchObject({ message: "ab\nc", component: "" });
    const dropped = page.entries.find((e) => e.kind === "dropped");
    expect(dropped?.dropped).toEqual({ rateLimited: 3, overflow: 2 });
  });

  it("refuses invalid batches", async () => {
    await expect(ingestNodeLogs(ctx, { id: nodeId }, batch(0n, [entry()]), now)).rejects.toThrow(
      "invalid node log batch",
    );
    const big = Array.from({ length: 501 }, () => entry());
    await expect(ingestNodeLogs(ctx, { id: nodeId }, batch(2n, big), now)).rejects.toThrow(
      "invalid node log batch",
    );
  });

  it("filters and pages newest first through the API", async () => {
    const entries = Array.from({ length: 5 }, (_, i) =>
      entry({ time: at(1000 + i), message: `page ${i}`, source: NodeLogSource.LUA }),
    );
    await ingestNodeLogs(ctx, { id: nodeId }, batch(2n, entries), now + 10_000);
    const first = await admin.nodes.logs({ id: nodeId, source: "lua", limit: 2 });
    expect(first.entries.map((e) => e.message)).toEqual(["page 4", "page 3"]);
    expect(first.nextCursor).not.toBeNull();
    const second = await admin.nodes.logs({
      id: nodeId,
      source: "lua",
      limit: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.entries.map((e) => e.message)).toEqual(["page 2", "page 1"]);
    const third = await admin.nodes.logs({
      id: nodeId,
      source: "lua",
      limit: 2,
      cursor: second.nextCursor ?? undefined,
    });
    expect(third.entries.map((e) => e.message)).toEqual(["page 0"]);
    expect(third.nextCursor).toBeNull();
    const errors = await admin.nodes.logs({ id: nodeId, minLevel: "error" });
    expect(errors.entries.every((e) => e.level === "error")).toBe(true);
    expect(errors.entries).toHaveLength(1);
    expect((await admin.nodes.logs({ id: nodeId, q: "PAGE 3" })).entries).toHaveLength(1);
    expect((await admin.nodes.logs({ id: nodeId, q: "%" })).entries).toHaveLength(0);
    const later = await admin.nodes.logs({
      id: nodeId,
      from: new Date(now + 1003).toISOString(),
    });
    expect(later.entries.map((e) => e.message)).toEqual(["page 4", "page 3"]);
    expect((await rpcError(admin.nodes.logs({ id: nodeId, cursor: "nope" }))).code).toBe(
      "NODE_LOG_CURSOR_INVALID",
    );
    expect((await rpcError(admin.nodes.logs({ id: crypto.randomUUID() }))).code).toBe(
      "NODE_NOT_FOUND",
    );
  });

  it("tells nodes without node-logs-v1 apart", async () => {
    const [cluster] = await ctx.db.select().from(schema.cluster).limit(1);
    const [old] = await ctx.db
      .insert(schema.node)
      .values({ name: "old-node", clusterId: cluster?.id ?? "", supportedFeatures: ["rules-v1"] })
      .returning();
    const page = await admin.nodes.logs({ id: old?.id ?? "" });
    expect(page).toEqual({ entries: [], nextCursor: null, supported: false });
  });

  it("shows the demo account client addresses reduced to their network", async () => {
    await admin.settings.setDemo({ enabled: true });
    const demo = rpcClient(app, origin, await signIn(app, origin, DEMO_EMAIL, DEMO_PASSWORD));
    const page = await demo.nodes.logs({ id: nodeId, source: "nginx" });
    expect(page.entries[0]?.fields.client).toBe("192.0.2.0/24");
    await admin.settings.setDemo({ enabled: false });
  });

  it("keeps the retention setting and deletes old entries and each node's oldest beyond its limit", async () => {
    expect(await admin.settings.nodeLogRetention()).toEqual({ days: 7, perNode: 10000 });
    expect(
      (await rpcError(admin.settings.setNodeLogRetention({ days: 31, perNode: 10000 }))).code,
    ).toBe("BAD_REQUEST");
    expect(await admin.settings.setNodeLogRetention({ days: 1, perNode: 1000 })).toEqual({
      days: 1,
      perNode: 1000,
    });
    const [audit] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "system.node_log_retention_update"));
    expect(audit?.metadata).toMatchObject({ to: { days: 1, perNode: 1000 } });

    const t = schema.nodeLogEntry;
    // 1200 entries within the day, the 3 oldest of them a day and more ago.
    await ctx.db.insert(t).values(
      Array.from({ length: 1200 }, (_, i) => ({
        nodeId,
        sequence: 100n,
        idx: i,
        time: new Date(now - (i < 3 ? 2 * 86_400_000 : 60_000) + i),
        level: "warn",
        source: "agent",
        message: `bulk ${i}`,
      })),
    );
    const before = (await ctx.db.select({ n: t.idx }).from(t).where(eq(t.nodeId, nodeId))).length;
    const removed = await pruneNodeLogs(ctx.db, new Date(now));
    const left = await ctx.db
      .select({ message: t.message, time: t.time })
      .from(t)
      .where(eq(t.nodeId, nodeId));
    expect(left).toHaveLength(1000);
    expect(removed).toBe(before - 1000);
    // The newest are kept.
    expect(left.some((e) => e.message === "bulk 1199")).toBe(true);
    expect(left.some((e) => e.message === "page 4")).toBe(true);
    expect(
      await ctx.db
        .select()
        .from(t)
        .where(and(eq(t.nodeId, nodeId), eq(t.message, "bulk 0"))),
    ).toHaveLength(0);
    await admin.settings.setNodeLogRetention({ days: 7, perNode: 10000 });
  });

  it("deletes a node's logs with the node", async () => {
    await ctx.db.delete(schema.node).where(eq(schema.node.id, nodeId));
    expect(
      await ctx.db.select().from(schema.nodeLogEntry).where(eq(schema.nodeLogEntry.nodeId, nodeId)),
    ).toHaveLength(0);
    expect(await nodeLogCursor(ctx.db, nodeId)).toBe(0n);
  });
});
