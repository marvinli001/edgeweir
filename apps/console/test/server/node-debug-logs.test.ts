import { create, type MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import {
  DEMO_EMAIL,
  DEMO_PASSWORD,
  NODE_DEBUG_LOG_LIMITS,
  NODE_DEBUG_LOGS_FEATURE,
} from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import {
  NodeLogEntrySchema,
  NodeLogLevel,
  NodeLogSource,
  ReportTaskResultRequestSchema,
  TaskState,
  UploadDebugLogsRequestSchema,
} from "@edgeweir/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  hasDebugLogTasks,
  pruneNodeDebugLogs,
  pullDebugLogTask,
  reportDebugLogResult,
  uploadDebugLogs,
} from "../../src/server/services/node-debug-logs";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("node debug log pulls (ADR-0050)", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let nodeId: string;
  let oldNodeId: string;
  const entry = (init: MessageInitShape<typeof NodeLogEntrySchema> = {}) =>
    create(NodeLogEntrySchema, {
      time: timestampFromDate(new Date()),
      level: NodeLogLevel.DEBUG,
      source: NodeLogSource.AGENT,
      message: "pulled tasks",
      ...init,
    });
  const upload = (taskId: string, entries: ReturnType<typeof entry>[]) =>
    create(UploadDebugLogsRequestSchema, {
      taskId,
      entries,
      truncated: true,
      bufferSince: timestampFromDate(new Date(Date.now() - 60_000)),
      overwritten: 12n,
      supervisorMissing: true,
    });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    const [cluster] = await ctx.db.select().from(schema.cluster).limit(1);
    if (!cluster) throw new Error("no cluster");
    const nodes = await ctx.db
      .insert(schema.node)
      .values([
        { name: "debug-node", clusterId: cluster.id, supportedFeatures: [NODE_DEBUG_LOGS_FEATURE] },
        { name: "old-node", clusterId: cluster.id, supportedFeatures: [] },
      ])
      .returning();
    nodeId = nodes[0]?.id ?? "";
    oldNodeId = nodes[1]?.id ?? "";
  });
  afterAll(() => client.close());

  it("hands a pull to the node once, stores its upload without secrets and audits it", async () => {
    expect((await admin.nodes.debugLogs({ id: nodeId })).pulls).toEqual([]);
    const pull = await admin.nodes.pullDebugLogs({
      id: nodeId,
      from: new Date(Date.now() - 3_600_000).toISOString(),
      components: ["channel", "channel"],
      sources: ["agent", "nginx"],
    });
    expect(pull).toMatchObject({ state: "pending", components: ["channel"], entryCount: 0 });
    // One open pull per node.
    expect((await rpcError(admin.nodes.pullDebugLogs({ id: nodeId }))).code).toBe(
      "NODE_DEBUG_LOGS_BUSY",
    );
    const [audit] = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "node.debug_logs_pull"));
    expect(audit?.targetId).toBe(nodeId);

    expect(await hasDebugLogTasks(ctx.db, nodeId)).toBe(true);
    const task = await pullDebugLogTask(ctx, { id: nodeId });
    expect(task?.id).toBe(pull.id);
    expect(task?.kind.case).toBe("debugLogs");
    if (task?.kind.case !== "debugLogs") throw new Error("not a debug log task");
    expect(task.kind.value.components).toEqual(["channel"]);
    expect(task.kind.value.sources).toEqual([NodeLogSource.AGENT, NodeLogSource.NGINX]);
    expect(task.kind.value.since).toBeDefined();
    // Leased: not handed out again while the node works on it.
    expect(await pullDebugLogTask(ctx, { id: nodeId })).toBeNull();
    expect(await hasDebugLogTasks(ctx.db, nodeId)).toBe(false);

    // Another node cannot answer it.
    await expect(uploadDebugLogs(ctx, { id: oldNodeId }, upload(pull.id, []))).rejects.toThrow(
      /no open debug log pull/,
    );
    const stored = await uploadDebugLogs(
      ctx,
      { id: nodeId },
      upload(pull.id, [
        entry({
          message: "GET https://origin.test/a?token=e2e-secret",
          fields: { password: "hunter2", client: "192.0.2.77", "Bad Key": "x" },
          component: "channel",
        }),
        entry({ level: NodeLogLevel.INFO, message: "plain info" }),
        entry({ level: NodeLogLevel.UNSPECIFIED }),
        entry({ source: NodeLogSource.UNSPECIFIED }),
      ]),
    );
    expect(stored).toBe(2);
    // Answered once.
    await expect(uploadDebugLogs(ctx, { id: nodeId }, upload(pull.id, []))).rejects.toThrow();
    // The result after the upload changes nothing.
    expect(
      await reportDebugLogResult(
        ctx,
        nodeId,
        create(ReportTaskResultRequestSchema, { taskId: pull.id, state: TaskState.SUCCEEDED }),
      ),
    ).toBe(true);

    const got = await admin.nodes.debugLog({ id: nodeId, pullId: pull.id });
    expect(got).toMatchObject({
      state: "succeeded",
      entryCount: 2,
      truncated: true,
      overwritten: 12,
      supervisorMissing: true,
    });
    expect(got.bufferSince).not.toBeNull();
    expect(JSON.stringify(got)).not.toContain("e2e-secret");
    expect(JSON.stringify(got)).not.toContain("hunter2");
    expect(got.entries[0]).toMatchObject({
      level: "debug",
      component: "channel",
      fields: { password: "[redacted]", client: "192.0.2.77" },
    });
    expect(got.entries[1]?.level).toBe("info");
    const list = await admin.nodes.debugLogs({ id: nodeId });
    expect(list.supported).toBe(true);
    expect(list.pulls[0]?.id).toBe(pull.id);
    expect(list.pulls[0]).not.toHaveProperty("entries");
    expect((await rpcError(admin.nodes.debugLog({ id: oldNodeId, pullId: pull.id }))).code).toBe(
      "NODE_DEBUG_LOG_NOT_FOUND",
    );
  });

  it("refuses nodes without debug-logs-v1 and records failures and timeouts", async () => {
    const refused = await rpcError(admin.nodes.pullDebugLogs({ id: oldNodeId }));
    expect(refused.code).toBe("NODE_CAPABILITY_REQUIRED");
    expect((await admin.nodes.debugLogs({ id: oldNodeId })).supported).toBe(false);

    // The node reports a failure.
    const failed = await admin.nodes.pullDebugLogs({ id: nodeId });
    await pullDebugLogTask(ctx, { id: nodeId });
    await reportDebugLogResult(
      ctx,
      nodeId,
      create(ReportTaskResultRequestSchema, {
        taskId: failed.id,
        state: TaskState.FAILED,
        errorCode: "debug_logs_failed",
        errorParams: { reason: "disabled" },
        message: "this node keeps no debug logs",
      }),
    );
    expect(await admin.nodes.debugLog({ id: nodeId, pullId: failed.id })).toMatchObject({
      state: "failed",
      errorCode: "debug_logs_failed",
      errorParams: { reason: "disabled" },
    });

    // A lease that ran out hands the pull out again; past the deadline it fails.
    const late = await admin.nodes.pullDebugLogs({ id: nodeId });
    await pullDebugLogTask(ctx, { id: nodeId });
    await ctx.db
      .update(schema.nodeDebugLog)
      .set({ leaseUntil: new Date(Date.now() - 1000) })
      .where(eq(schema.nodeDebugLog.id, late.id));
    expect((await pullDebugLogTask(ctx, { id: nodeId }))?.id).toBe(late.id);
    await ctx.db
      .update(schema.nodeDebugLog)
      .set({ deadlineAt: new Date(Date.now() - 1000) })
      .where(eq(schema.nodeDebugLog.id, late.id));
    expect(await pullDebugLogTask(ctx, { id: nodeId })).toBeNull();
    await expect(uploadDebugLogs(ctx, { id: nodeId }, upload(late.id, []))).rejects.toThrow();
    expect(await admin.nodes.debugLog({ id: nodeId, pullId: late.id })).toMatchObject({
      state: "failed",
      errorCode: "debug_logs_timeout",
    });
    // A new pull is possible again.
    expect((await admin.nodes.pullDebugLogs({ id: nodeId })).state).toBe("pending");
    expect(NODE_DEBUG_LOG_LIMITS.timeoutSeconds).toBe(120);
  });

  it("lets the demo account read pulls but not start one", async () => {
    await admin.settings.setDemo({ enabled: true });
    const demo = rpcClient(app, origin, await signIn(app, origin, DEMO_EMAIL, DEMO_PASSWORD));
    const { pulls } = await demo.nodes.debugLogs({ id: nodeId });
    const done = pulls.find((p) => p.state === "succeeded");
    const got = await demo.nodes.debugLog({ id: nodeId, pullId: done?.id ?? "" });
    expect(got.entries[0]?.fields.client).toBe("192.0.2.0/24");
    expect((await rpcError(demo.nodes.pullDebugLogs({ id: nodeId }))).code).toBe(
      "DEMO_READ_ONLY",
    );
    await admin.settings.setDemo({ enabled: false });
  });

  it("prunes pulls past the retention and beyond the per-node limit", async () => {
    const t = schema.nodeDebugLog;
    await ctx.db.delete(t);
    const old = new Date(Date.now() - 8 * 86_400_000);
    await ctx.db.insert(t).values([
      { nodeId, state: "succeeded", createdAt: old, deadlineAt: old },
      ...Array.from({ length: NODE_DEBUG_LOG_LIMITS.kept + 2 }, (_, i) => {
        const at = new Date(Date.now() - (i + 1) * 60_000);
        return { nodeId, state: "failed", createdAt: at, deadlineAt: at };
      }),
    ]);
    expect(await pruneNodeDebugLogs(ctx.db)).toBe(3);
    expect(await ctx.db.select({ id: t.id }).from(t)).toHaveLength(NODE_DEBUG_LOG_LIMITS.kept);
  });
});
