import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  hasDeliverableTasks,
  pullCacheTasks,
  reportCacheTaskResult,
} from "../../src/server/services/cache-tasks";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  setupPlatform,
  signIn,
} from "./helpers";

describe("cache task delivery", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let tenant: ApiClient;
  let clusterId: string;
  let siteId: string;

  const addNode = async (name: string, status: "active" | "disabled" = "active") => {
    const [row] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name, status, lastSeenAt: new Date() })
      .returning();
    if (!row) throw new Error("node insert failed");
    return row;
  };
  const delivery = async (taskId: string, nodeId: string) =>
    (
      await ctx.db
        .select()
        .from(schema.cacheTaskNode)
        .where(
          and(eq(schema.cacheTaskNode.taskId, taskId), eq(schema.cacheTaskNode.nodeId, nodeId)),
        )
    )[0];
  const succeed = (node: { id: string }, taskId: string) =>
    reportCacheTaskResult(ctx.db, node, {
      taskId,
      state: "succeeded",
      message: "",
      succeeded: 1,
      failed: 0,
      finishedAt: new Date(),
    });

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.create({ name: "edge-t" })).id;
    const org = await admin.organizations.create({ name: "Tenant", defaultClusterId: clusterId });
    await admin.users.create({
      name: "Tina",
      email: "tina@tenant.test",
      password: PASSWORD,
      organizationId: org.id,
    });
    tenant = rpcClient(app, origin, await signIn(app, origin, "tina@tenant.test"));
    siteId = (
      await tenant.sites.create({
        name: "shop",
        domains: ["shop.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
  });
  afterAll(() => client.close());

  describe("disabled nodes (CP-M3)", () => {
    it("dispatches only to enabled nodes and lists disabled ones as skipped", async () => {
      const enabled = await addNode("edge-on");
      const disabled = await addNode("edge-off", "disabled");
      const task = await tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/a"] });
      expect(task.state).toBe("pending");
      const byName = Object.fromEntries(task.nodes.map((n) => [n.nodeName, n]));
      expect(byName["edge-on"]).toMatchObject({ state: "pending", errorCode: "" });
      expect(byName["edge-off"]).toMatchObject({
        state: "skipped",
        errorCode: "node_disabled",
        message: "skipped: the node is disabled",
      });
      expect(byName["edge-off"]?.finishedAt).not.toBeNull();
      // The disabled node gets nothing to deliver, the enabled one does.
      expect(await hasDeliverableTasks(ctx.db, disabled.id)).toBe(false);
      expect(await hasDeliverableTasks(ctx.db, enabled.id)).toBe(true);

      // The enabled node alone finishes the task: skipped nodes do not hold it up.
      const [pulled] = await pullCacheTasks(ctx.db, enabled, 10);
      expect(pulled?.id).toBe(task.id);
      await succeed(enabled, task.id);
      const done = await tenant.cacheTasks.get({ id: task.id });
      expect(done.state).toBe("succeeded");
      expect(done.finishedAt).not.toBeNull();
      await ctx.db.delete(schema.node).where(eq(schema.node.id, enabled.id));
      await ctx.db.delete(schema.node).where(eq(schema.node.id, disabled.id));
    });

    it("skips a node's pending and running deliveries when it is disabled", async () => {
      const stays = await addNode("edge-stays");
      const leaves = await addNode("edge-leaves");
      const first = await tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/1"] });
      // Handed out but never reported: "running".
      expect((await pullCacheTasks(ctx.db, leaves, 10)).map((t) => t.id)).toEqual([first.id]);
      const second = await tenant.cacheTasks.create({
        type: "prefix",
        urls: ["http://shop.test/2/"],
      });
      expect((await delivery(first.id, leaves.id))?.state).toBe("running");
      expect((await delivery(second.id, leaves.id))?.state).toBe("pending");

      const node = await admin.nodes.disable({ id: leaves.id });
      expect(node.status).toBe("disabled");
      for (const task of [first, second]) {
        expect(await delivery(task.id, leaves.id)).toMatchObject({
          state: "skipped",
          errorCode: "node_disabled",
        });
      }
      expect(await hasDeliverableTasks(ctx.db, leaves.id)).toBe(false);
      const [audit] = (await admin.auditLogs.list({ action: "node.disable" })).items;
      expect(audit).toMatchObject({ targetId: leaves.id, metadata: { skippedTasks: 2 } });

      // The remaining node finishes both tasks; nothing waits 7 days for the disabled one.
      expect((await tenant.cacheTasks.get({ id: first.id })).state).toBe("pending");
      await pullCacheTasks(ctx.db, stays, 10);
      await succeed(stays, first.id);
      await succeed(stays, second.id);
      for (const task of [first, second]) {
        const after = await tenant.cacheTasks.get({ id: task.id });
        expect(after.state).toBe("succeeded");
        expect(after.finishedAt).not.toBeNull();
      }
      // A late report from the disabled node changes nothing.
      expect(await succeed(leaves, first.id)).toBe(false);
      expect((await delivery(first.id, leaves.id))?.state).toBe("skipped");
    });

    it("finishes a task at once when every node of the cluster is disabled", async () => {
      await ctx.db
        .update(schema.node)
        .set({ status: "disabled" })
        .where(eq(schema.node.clusterId, clusterId));
      const task = await tenant.cacheTasks.create({ type: "site", siteIds: [siteId] });
      expect(task.state).toBe("succeeded");
      expect(task.finishedAt).not.toBeNull();
      expect(task.nodes.every((n) => n.state === "skipped")).toBe(true);
      await ctx.db
        .update(schema.node)
        .set({ status: "active" })
        .where(eq(schema.node.clusterId, clusterId));
    });
  });
});
