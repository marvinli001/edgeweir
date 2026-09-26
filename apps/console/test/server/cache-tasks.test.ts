import { schema } from "@edgeweir/db";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  CACHE_TASK_LIMITS,
  expireCacheTasks,
  hasDeliverableTasks,
  pullCacheTasks,
  reportCacheTaskResult,
} from "../../src/server/services/cache-tasks";
import {
  type ApiClient,
  createTestContext,
  PASSWORD,
  rpcClient,
  rpcError,
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
  let platformSiteId: string;
  let tenantOrgId: string;

  const DAY = 24 * 3600 * 1000;
  /** Pretends the tasks were created `days` ago. */
  const backdate = (taskIds: string[], days: number) =>
    ctx.db
      .update(schema.cacheTask)
      .set({ createdAt: new Date(Date.now() - days * DAY) })
      .where(inArray(schema.cacheTask.id, taskIds));
  const nodeRow = async (id: string) => {
    const [row] = await ctx.db.select().from(schema.node).where(eq(schema.node.id, id));
    if (!row) throw new Error("node missing");
    return row;
  };

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
    tenantOrgId = org.id;
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
    platformSiteId = (
      await admin.sites.create({
        name: "platform",
        clusterId,
        domains: ["www.platform.test"],
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

  describe("purges a node missed (N-M4)", () => {
    it("makes up purges that expired while the node was offline, once, with a whole-site purge", async () => {
      await ctx.db.delete(schema.node).where(eq(schema.node.clusterId, clusterId));
      const node = await addNode("edge-back");
      const url = await tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/x"] });
      const prefix = await tenant.cacheTasks.create({
        type: "prefix",
        urls: ["http://shop.test/p/"],
      });
      const prefetch = await tenant.cacheTasks.create({
        type: "prefetch",
        urls: ["http://shop.test/big"],
      });
      // Eight days pass without the node pulling anything.
      await backdate([url.id, prefix.id, prefetch.id], 8);
      expect(await hasDeliverableTasks(ctx.db, node.id)).toBe(true);

      const pulled = await pullCacheTasks(ctx.db, node, 10);
      // Not the stale purges and not the stale prefetch: one whole-site purge instead.
      expect(pulled).toHaveLength(1);
      expect(pulled[0]).toMatchObject({
        type: "site",
        items: [expect.objectContaining({ siteId, clusterId, type: "site" })],
      });
      const recovery = await tenant.cacheTasks.get({ id: pulled[0]?.id ?? "" });
      expect(recovery).toMatchObject({
        type: "site",
        source: "recovery",
        targets: ["shop"],
        sites: [{ id: siteId, name: "shop" }],
        createdByName: "",
      });
      expect(recovery.nodes).toEqual([
        expect.objectContaining({ nodeName: "edge-back", state: "running" }),
      ]);
      for (const task of [url, prefix]) {
        const d = await delivery(task.id, node.id);
        expect(d).toMatchObject({ state: "failed", errorCode: "task_expired" });
        expect(d?.recoveredAt).not.toBeNull();
        const dto = await tenant.cacheTasks.get({ id: task.id });
        expect(dto.state).toBe("failed");
        expect(dto.nodes[0]).toMatchObject({ errorCode: "task_expired" });
        expect(dto.nodes[0]?.recoveredAt).not.toBeNull();
      }
      // A missed prefetch needs no make-up.
      expect(await delivery(prefetch.id, node.id)).toMatchObject({
        state: "failed",
        errorCode: "task_expired",
        recoveredAt: null,
      });
      const [audit] = (await admin.auditLogs.list({ action: "cache.purge" })).items;
      expect(audit).toMatchObject({
        actorType: "system",
        targetId: recovery.id,
        metadata: { recovery: true, node: "edge-back", missedCount: 2, sites: ["shop"] },
      });

      // Once: the next pulls hand out nothing new.
      expect(await pullCacheTasks(ctx.db, node, 10)).toEqual([]);
      await succeed(node, recovery.id);
      expect(await hasDeliverableTasks(ctx.db, node.id)).toBe(false);
      expect(await pullCacheTasks(ctx.db, node, 10)).toEqual([]);
      expect((await tenant.cacheTasks.get({ id: recovery.id })).state).toBe("succeeded");
    });

    it("also makes up deliveries the expiry job failed, and only for the node that missed them", async () => {
      const offline = await addNode("edge-offline");
      const online = await addNode("edge-online");
      const task = await tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/z"] });
      await pullCacheTasks(ctx.db, online, 10);
      await succeed(online, task.id);
      expect(await expireCacheTasks(ctx.db, new Date(Date.now() + 8 * DAY))).toBeGreaterThan(0);
      expect(await delivery(task.id, offline.id)).toMatchObject({
        state: "failed",
        errorCode: "task_expired",
        recoveredAt: null,
      });
      expect(await hasDeliverableTasks(ctx.db, online.id)).toBe(false);
      expect(await pullCacheTasks(ctx.db, online, 10)).toEqual([]);
      const pulled = await pullCacheTasks(ctx.db, offline, 10);
      expect(pulled.map((t) => t.type)).toEqual(["site"]);
      expect((await delivery(task.id, offline.id))?.recoveredAt).not.toBeNull();
      await succeed(offline, pulled[0]?.id ?? "");
    });

    it("makes up the purges a node skipped while disabled, per organization, once it is enabled again", async () => {
      const node = await addNode("edge-away");
      await admin.nodes.disable({ id: node.id });
      const own = await tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/y"] });
      const both = await admin.cacheTasks.create({
        type: "site",
        siteIds: [siteId, platformSiteId],
      });
      expect((await delivery(own.id, node.id))?.state).toBe("skipped");
      expect((await delivery(both.id, node.id))?.state).toBe("skipped");
      // Nothing is handed to a node while it is disabled.
      expect(await hasDeliverableTasks(ctx.db, node.id)).toBe(false);
      expect(await pullCacheTasks(ctx.db, await nodeRow(node.id), 10)).toEqual([]);
      expect((await delivery(own.id, node.id))?.recoveredAt).toBeNull();

      await admin.nodes.enable({ id: node.id });
      expect(await hasDeliverableTasks(ctx.db, node.id)).toBe(true);
      const pulled = await pullCacheTasks(ctx.db, await nodeRow(node.id), 10);
      // One task per organization, each with its own sites.
      expect(pulled.map((t) => t.items.map((i) => i.siteId)).sort()).toEqual(
        [[platformSiteId], [siteId]].sort(),
      );
      const ids = pulled.map((t) => t.id);
      const tenantVisible = (await tenant.cacheTasks.list({ pageSize: 100 })).items.filter((t) =>
        ids.includes(t.id),
      );
      expect(tenantVisible.map((t) => t.targets)).toEqual([["shop"]]);
      const adminVisible = (await admin.cacheTasks.list({ pageSize: 100 })).items.filter((t) =>
        ids.includes(t.id),
      );
      expect(adminVisible.map((t) => t.source)).toEqual(["recovery", "recovery"]);
      for (const task of [own, both]) {
        expect((await delivery(task.id, node.id))?.recoveredAt).not.toBeNull();
      }
      expect(await pullCacheTasks(ctx.db, await nodeRow(node.id), 10)).toEqual([]);
    });

    it("flags missed purges of deleted sites without sending anything", async () => {
      const node = await addNode("edge-late");
      const temp = await tenant.sites.create({
        name: "temp",
        domains: ["temp.test"],
        origins: [{ address: "origin.test" }],
      });
      const task = await tenant.cacheTasks.create({ type: "url", urls: ["http://temp.test/"] });
      await backdate([task.id], 9);
      await tenant.sites.delete({ id: temp.site.id });
      expect(await pullCacheTasks(ctx.db, node, 10)).toEqual([]);
      expect(await delivery(task.id, node.id)).toMatchObject({ errorCode: "task_expired" });
      expect((await delivery(task.id, node.id))?.recoveredAt).not.toBeNull();
      expect(await hasDeliverableTasks(ctx.db, node.id)).toBe(false);
    });
  });

  describe("per-organization rate limit (N-H3)", () => {
    let burst: ApiClient;
    let burstOrgId: string;
    const tasksOf = async (organizationId: string) =>
      ctx.db
        .select({ id: schema.cacheTask.id })
        .from(schema.cacheTask)
        .where(eq(schema.cacheTask.organizationId, organizationId));
    const urls = (n: number, from = 0) =>
      Array.from({ length: n }, (_, i) => `http://burst.test/f/${from + i}`);

    beforeAll(async () => {
      burstOrgId = (
        await admin.organizations.create({ name: "Burst", defaultClusterId: clusterId })
      ).id;
      await admin.users.create({
        name: "Bea",
        email: "bea@burst.test",
        password: PASSWORD,
        organizationId: burstOrgId,
      });
      burst = rpcClient(app, origin, await signIn(app, origin, "bea@burst.test"));
      await burst.sites.create({
        name: "burst",
        domains: ["burst.test"],
        origins: [{ address: "origin.test" }],
      });
    });

    it("refuses more than the tasks per minute with CACHE_TASK_RATE_LIMITED and a retry time", async () => {
      expect(CACHE_TASK_LIMITS).toEqual({ tasksPerMinute: 10, urlsPerHour: 2000 });
      for (let i = 0; i < CACHE_TASK_LIMITS.tasksPerMinute; i++) {
        await burst.cacheTasks.create({ type: "url", urls: [`http://burst.test/${i}`] });
      }
      const before = (await tasksOf(burstOrgId)).length;
      const error = await rpcError(
        burst.cacheTasks.create({ type: "prefix", urls: ["http://burst.test/x/"] }),
      );
      expect(error).toMatchObject({
        code: "CACHE_TASK_RATE_LIMITED",
        status: 429,
        data: { tasksPerMinute: 10, urlsPerHour: 2000 },
      });
      const retry = (error.data as { retryAfterSeconds: number }).retryAfterSeconds;
      expect(retry).toBeGreaterThanOrEqual(1);
      expect(retry).toBeLessThanOrEqual(60);
      expect((await tasksOf(burstOrgId)).length).toBe(before);
      const [burstSite] = (await burst.sites.list({})).items;
      if (!burstSite) throw new Error("missing burst site");
      const beforePurge = await burst.sites.get({ id: burstSite.id });
      expect((await rpcError(burst.sites.purgeAll({ id: burstSite.id }))).code).toBe(
        "CACHE_TASK_RATE_LIMITED",
      );
      expect(await burst.sites.get({ id: burstSite.id })).toEqual(beforePurge);

      // Other organizations are not affected.
      await tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/fine"] });
      // A minute later there is room again.
      await backdate(
        (await tasksOf(burstOrgId)).map((t) => t.id),
        2 / (24 * 60),
      );
      await burst.cacheTasks.create({ type: "prefix", urls: ["http://burst.test/x/"] });
    });

    it("refuses more than the URLs per hour, counting every target", async () => {
      // 11 targets used so far this hour; three tasks of 500 bring it to 1511.
      for (let i = 0; i < 3; i++) {
        await burst.cacheTasks.create({ type: "url", urls: urls(500, i * 500) });
      }
      const error = await rpcError(burst.cacheTasks.create({ type: "url", urls: urls(500, 1500) }));
      expect(error.code).toBe("CACHE_TASK_RATE_LIMITED");
      // The oldest requests of the hour must age out first: about 58 minutes.
      const retry = (error.data as { retryAfterSeconds: number }).retryAfterSeconds;
      expect(retry).toBeGreaterThan(3000);
      expect(retry).toBeLessThanOrEqual(3600);
      // What still fits goes through.
      await burst.cacheTasks.create({ type: "url", urls: urls(489, 1500) });
      expect(
        (await rpcError(burst.cacheTasks.create({ type: "url", urls: urls(1, 5000) }))).code,
      ).toBe("CACHE_TASK_RATE_LIMITED");
      // An hour later the budget is back.
      await backdate(
        (await tasksOf(burstOrgId)).map((t) => t.id),
        61 / (24 * 60),
      );
      await burst.cacheTasks.create({ type: "url", urls: urls(500, 1500) });
    });

    it("does not limit platform administrators, and make-up purges do not count", async () => {
      const ownTasks = async () => (await tasksOf(tenantOrgId)).map((t) => t.id);
      await backdate(await ownTasks(), 2 / (24 * 60));
      for (let i = 0; i < CACHE_TASK_LIMITS.tasksPerMinute + 2; i++) {
        await admin.cacheTasks.create({ type: "site", siteIds: [siteId] });
      }
      // They purge the organization's objects too, so they count for its budget.
      const limited = await rpcError(
        tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/1"] }),
      );
      expect(limited.code).toBe("CACHE_TASK_RATE_LIMITED");

      await backdate(await ownTasks(), 2 / (24 * 60));
      // Ten whole-site purges the console sent on its own this minute use none of it.
      await ctx.db.insert(schema.cacheTask).values(
        Array.from({ length: CACHE_TASK_LIMITS.tasksPerMinute }, () => ({
          organizationId: tenantOrgId,
          type: "site",
          source: "recovery",
          targets: ["shop"],
          siteIds: [siteId],
        })),
      );
      await tenant.cacheTasks.create({ type: "url", urls: ["http://shop.test/2"] });
    });
  });
});
