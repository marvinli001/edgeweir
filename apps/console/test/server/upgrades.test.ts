import { create } from "@bufbuild/protobuf";
import { schema } from "@edgeweir/db";
import { ReportTaskResultRequestSchema, TaskState } from "@edgeweir/proto";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import {
  expireUpgrades,
  pullUpgrade,
  recordUpgradeHealth,
  reportUpgrade,
} from "../../src/server/services/upgrades";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("signed upgrade orchestration: canary health, scope, retries and outcomes", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  let admin: ApiClient, clusterId: string, groupId: string;
  let canary: typeof schema.node.$inferSelect, peer: typeof schema.node.$inferSelect;
  let revision: number, hash: string;
  const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const v = String(url).match(/\/v([^/]+)\/checksums\.txt$/)?.[1];
    if (!v) return new Response("", { status: 404 });
    return new Response(
      ["amd64", "arm64"]
        .map((arch) => `${"a".repeat(64)}  edgeweir-node_${v}_linux_${arch}.tar.gz`)
        .join("\n"),
    );
  });
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(
      app,
      ctx.env.EDGEWEIR_PUBLIC_URL,
      await signIn(app, ctx.env.EDGEWEIR_PUBLIC_URL, "admin@example.com"),
    );
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const group = await admin.nodeGroups.create({ clusterId, name: "canary" });
    groupId = group.id;
    const defaultGroup = (await admin.nodeGroups.list({ clusterId })).find((g) => g.isDefault);
    if (!defaultGroup) throw new Error("no default group");
    const nodes = await ctx.db
      .insert(schema.node)
      .values(
        [
          { name: "canary", nodeGroupId: groupId },
          { name: "peer", nodeGroupId: defaultGroup.id },
        ].map((n) => ({
          ...n,
          clusterId,
          os: "linux",
          arch: "arm64",
          agentVersion: "0.1.0",
          supportedFeatures: ["self-upgrade-v1"],
          lastSeenAt: new Date(),
        })),
      )
      .returning();
    if (!nodes[0] || !nodes[1]) throw new Error("no fixture nodes");
    canary = nodes[0];
    peer = nodes[1];
    const latest = await latestRevision(ctx.db, clusterId);
    if (!latest) throw new Error("no revision");
    revision = latest.revision;
    hash = latest.contentHash;
    await ctx.db.insert(schema.nodeConfigStatus).values(
      nodes.map((n) => ({
        nodeId: n.id,
        state: "applied",
        dataPlaneHealthy: true,
        appliedRevision: revision,
        appliedContentHash: hash,
      })),
    );
  });
  afterAll(async () => {
    fetchMock.mockRestore();
    await client.close();
  });
  const fresh = async (id: string, version: string) => {
    await ctx.db
      .update(schema.node)
      .set({ agentVersion: version, lastSeenAt: new Date() })
      .where(eq(schema.node.id, id));
  };
  const result = (id: string, success = true) =>
    create(ReportTaskResultRequestSchema, {
      taskId: id,
      state: success ? TaskState.SUCCEEDED : TaskState.FAILED,
      errorCode: success ? "" : "upgrade_rolled_back",
      message: success ? "healthy" : "candidate failed; old version restored",
    });
  const get = async (id: string) =>
    (await admin.upgrades.list({ clusterId })).find((j) => j.id === id);
  it("requires all target nodes to advertise upgrade support and be in sync", async () => {
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: [] })
      .where(eq(schema.node.id, peer.id));
    expect(
      (await rpcError(admin.upgrades.create({ version: "0.2.0", nodeGroupId: groupId }))).code,
    ).toBe("UPGRADE_NODES_UNAVAILABLE");
    expect(await ctx.db.select().from(schema.nodeUpgrade)).toHaveLength(0);
    await ctx.db
      .update(schema.node)
      .set({ supportedFeatures: ["self-upgrade-v1"] })
      .where(eq(schema.node.id, peer.id));
  });
  it("holds the rest of the cluster until a healthy canary window and an explicit promotion", async () => {
    const job = await admin.upgrades.create({ version: "0.2.0", nodeGroupId: groupId });
    expect(job.deliveries.map((d) => d.state).sort()).toEqual(["held", "pending"]);
    expect(
      (await rpcError(admin.upgrades.create({ version: "0.2.0", nodeGroupId: groupId }))).code,
    ).toBe("UPGRADE_BUSY");
    expect(await pullUpgrade(ctx, peer)).toBeNull();
    const task = await pullUpgrade(ctx, canary);
    if (!task) throw new Error("missing upgrade");
    expect(task.kind.case).toBe("upgrade");
    expect(await pullUpgrade(ctx, canary)).toBeNull();
    await expect(reportUpgrade(ctx, peer.id, result(task.id))).rejects.toMatchObject({ code: 7 });
    await expect(reportUpgrade(ctx, canary.id, result(task.id))).rejects.toMatchObject({ code: 9 });
    await fresh(canary.id, "0.2.0");
    await reportUpgrade(ctx, canary.id, result(task.id));
    await reportUpgrade(ctx, canary.id, result(task.id)); // lost result ACK: idempotent.
    expect((await get(job.id))?.canPromote).toBe(false);
    expect((await rpcError(admin.upgrades.promote({ id: job.id }))).code).toBe("UPGRADE_NOT_READY");
    await ctx.db
      .update(schema.nodeUpgradeDelivery)
      .set({ healthySince: new Date(Date.now() - 31_000) })
      .where(eq(schema.nodeUpgradeDelivery.id, task.id));
    expect((await get(job.id))?.canPromote).toBe(true);
    await ctx.db.transaction((tx) =>
      recordUpgradeHealth(
        tx,
        { ...canary, agentVersion: "0.2.0", lastSeenAt: new Date() },
        {
          state: "failed",
          dataPlaneHealthy: false,
          appliedRevision: revision,
          appliedContentHash: hash,
        },
        new Date(),
      ),
    );
    expect((await get(job.id))?.canPromote).toBe(false);
    await ctx.db.transaction((tx) =>
      recordUpgradeHealth(
        tx,
        { ...canary, agentVersion: "0.2.0", lastSeenAt: new Date() },
        {
          state: "applied",
          dataPlaneHealthy: true,
          appliedRevision: revision,
          appliedContentHash: hash,
        },
        new Date(),
      ),
    );
    expect((await get(job.id))?.canPromote).toBe(false);
    await ctx.db
      .update(schema.nodeUpgradeDelivery)
      .set({ healthySince: new Date(Date.now() - 31_000) })
      .where(eq(schema.nodeUpgradeDelivery.id, task.id));
    expect((await admin.upgrades.promote({ id: job.id })).state).toBe("rollout");
    const second = await pullUpgrade(ctx, peer);
    if (!second) throw new Error("peer was not released");
    expect((await rpcError(admin.upgrades.cancel({ id: job.id }))).code).toBe("UPGRADE_BUSY");
    await fresh(peer.id, "0.2.0");
    await reportUpgrade(ctx, peer.id, result(second.id));
    expect((await get(job.id))?.state).toBe("succeeded");
  });
  it("stops pending nodes after a canary failure and expires abandoned work", async () => {
    const job = await admin.upgrades.create({ version: "0.3.0", nodeGroupId: groupId });
    const task = await pullUpgrade(ctx, canary);
    if (!task) throw new Error("no canary");
    await reportUpgrade(ctx, canary.id, result(task.id, false));
    const failed = await get(job.id);
    expect(failed?.state).toBe("failed");
    expect(failed?.deliveries.find((d) => d.nodeId === peer.id)?.state).toBe("cancelled");
    expect(await pullUpgrade(ctx, peer)).toBeNull();
    const next = await admin.upgrades.create({ version: "0.4.0", nodeGroupId: groupId });
    await expireUpgrades(ctx.db, new Date(Date.now() + 31 * 60_000));
    expect((await get(next.id))?.state).toBe("failed");
    expect(await pullUpgrade(ctx, canary)).toBeNull();
  });
  it("cancels queued work without changing completed node versions", async () => {
    const job = await admin.upgrades.create({ version: "0.5.0", nodeGroupId: groupId });
    const cancelled = await admin.upgrades.cancel({ id: job.id });
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.deliveries.every((d) => d.state === "cancelled")).toBe(true);
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, "node.upgrade_cancel"),
          eq(schema.auditLog.targetId, job.id),
        ),
      );
    expect(audits).toHaveLength(1);
  });
});
