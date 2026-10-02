import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

describe("site delivery: where a site's configuration runs", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  const nodeIds: string[] = [];
  const origins = [{ address: "origin.test", port: 8080 }];

  /** Reports the cluster's latest revision as applied by the given nodes. */
  const apply = async (ids: string[], healthy = true) => {
    const latest = await latestRevision(ctx.db, clusterId);
    if (!latest) throw new Error("no revision");
    for (const nodeId of ids)
      await ctx.db
        .insert(schema.nodeConfigStatus)
        .values({
          nodeId,
          appliedRevision: latest.revision,
          appliedContentHash: latest.contentHash,
          state: "applied",
          dataPlaneHealthy: healthy,
        })
        .onConflictDoUpdate({
          target: schema.nodeConfigStatus.nodeId,
          set: {
            appliedRevision: latest.revision,
            appliedContentHash: latest.contentHash,
            dataPlaneHealthy: healthy,
          },
        });
  };
  const delivery = async () => (await admin.sites.get({ id: siteId })).delivery;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.create({ name: "edge-delivery" })).id;
    const nodes = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId, name: "a", lastSeenAt: new Date() },
        { clusterId, name: "b", lastSeenAt: new Date() },
        // Offline nodes do not count.
        { clusterId, name: "offline", lastSeenAt: new Date(Date.now() - 3_600_000) },
      ])
      .returning({ id: schema.node.id });
    nodeIds.push(...nodes.map((n) => n.id));
    siteId = (
      await admin.sites.create({ name: "shop", clusterId, domains: ["shop.test"], origins })
    ).site.id;
  });
  afterAll(() => pglite.close());

  it("is pending until a node runs the site, partial while some do, live once all do", async () => {
    expect(await delivery()).toEqual({
      state: "pending",
      totalNodes: 2,
      servingNodes: 0,
      currentNodes: 0,
      canary: null,
    });
    await apply([nodeIds[0] as string]);
    expect(await delivery()).toEqual({
      state: "partial",
      totalNodes: 2,
      servingNodes: 1,
      currentNodes: 1,
      canary: null,
    });
    await apply([nodeIds[1] as string]);
    expect(await delivery()).toEqual({
      state: "live",
      totalNodes: 2,
      servingNodes: 2,
      currentNodes: 2,
      canary: null,
    });
  });

  it("is partial after a change until the nodes run it, and other sites stay live", async () => {
    const other = (
      await admin.sites.create({ name: "blog", clusterId, domains: ["blog.test"], origins })
    ).site.id;
    // The nodes still run the previous revision, which has this site as it is.
    expect((await delivery()).state).toBe("live");
    await apply(nodeIds.slice(0, 2));
    const changed = await admin.sites.update({
      id: siteId,
      domains: ["shop.test", "www.shop.test"],
    });
    expect(changed.site.delivery).toMatchObject({
      state: "partial",
      servingNodes: 2,
      currentNodes: 0,
    });
    expect((await admin.sites.get({ id: other })).delivery.state).toBe("live");
    await apply(nodeIds.slice(0, 2));
    expect((await delivery()).state).toBe("live");
  });

  it("is partial while a node's data plane is unhealthy, and disabled when disabled", async () => {
    await apply([nodeIds[1] as string], false);
    expect(await delivery()).toMatchObject({ state: "partial", servingNodes: 2, currentNodes: 1 });
    await apply([nodeIds[1] as string]);
    const site = await admin.sites.get({ id: siteId });
    const disabled = await admin.sites.setEnabled({
      id: siteId,
      enabled: false,
      expectedUpdatedAt: site.updatedAt,
    });
    // Until they apply the revision without it, the nodes still run the site.
    expect(disabled.site.delivery).toEqual({
      state: "disabled",
      totalNodes: 2,
      servingNodes: 2,
      currentNodes: 0,
      canary: null,
    });
    await apply(nodeIds.slice(0, 1));
    expect(await delivery()).toMatchObject({ state: "disabled", servingNodes: 1 });
    await apply(nodeIds.slice(1, 2));
    expect(await delivery()).toMatchObject({ state: "disabled", servingNodes: 0 });
  });

  it("is pending without online nodes", async () => {
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: null })
      .where(eq(schema.node.clusterId, clusterId));
    const site = await admin.sites.get({ id: siteId });
    await admin.sites.setEnabled({ id: siteId, enabled: true, expectedUpdatedAt: site.updatedAt });
    expect(await delivery()).toEqual({
      state: "pending",
      totalNodes: 0,
      servingNodes: 0,
      currentNodes: 0,
      canary: null,
    });
  });
});

describe("site delivery during a configuration canary", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let canaryNode: string;
  let stableNode: string;
  let siteId: string;
  let otherId: string;
  const origins = [{ address: "origin.test", port: 8080 }];
  const policy = {
    enabled: true,
    windowSeconds: 600,
    autoPromote: true,
    errorRatioMultiplier: 2,
    errorRatioFloor: 0.05,
    minRequests: 10,
  };

  /** The node reports the cluster's latest revision applied with a healthy data plane. */
  const report = async (nodeId: string) => {
    const row = await latestRevision(ctx.db, clusterId);
    const values = {
      nodeId,
      appliedRevision: row?.revision ?? 0,
      appliedContentHash: row?.contentHash ?? "",
      state: "applied",
      dataPlaneHealthy: true,
    };
    await ctx.db
      .insert(schema.nodeConfigStatus)
      .values(values)
      .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
  };
  const delivery = async (id = siteId) => (await admin.sites.get({ id })).delivery;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const defaultGroup = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    const canaryGroup = (
      await admin.nodeGroups.create({ clusterId, name: "canary", isCanary: true })
    ).id;
    const [a, b] = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId, nodeGroupId: canaryGroup, name: "edge-canary", lastSeenAt: new Date() },
        { clusterId, nodeGroupId: defaultGroup, name: "edge-stable", lastSeenAt: new Date() },
      ])
      .returning({ id: schema.node.id });
    canaryNode = a?.id ?? "";
    stableNode = b?.id ?? "";
    siteId = (await admin.sites.create({ name: "shop", domains: ["shop.test"], origins })).site.id;
    otherId = (await admin.sites.create({ name: "blog", domains: ["blog.test"], origins })).site.id;
    await report(canaryNode);
    await report(stableNode);
    await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy });
  });
  afterAll(() => pglite.close());

  it("says until when the canary holds a changed site back from the other nodes", async () => {
    const changed = await admin.sites.update({
      id: siteId,
      domains: ["shop.test", "www.shop.test"],
    });
    const rollout = await admin.clusters.rollout({ id: clusterId });
    expect(rollout).toMatchObject({
      state: "canary",
      candidateRevision: changed.revision.revision,
    });
    const canary = { endsAt: rollout.windowEndsAt, autoPromote: true };
    expect(changed.site.delivery).toEqual({
      state: "partial",
      totalNodes: 2,
      servingNodes: 2,
      currentNodes: 0,
      canary,
    });
    // An unchanged site runs the same version on both revisions.
    expect(await delivery(otherId)).toMatchObject({ state: "live", canary: null });
    await report(canaryNode);
    expect(await delivery()).toMatchObject({ state: "partial", currentNodes: 1, canary });
    // Without automatic promotion the operator ends the canary.
    await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy, autoPromote: false });
    expect((await delivery()).canary).toEqual({ ...canary, autoPromote: false });
  });

  it("drops the canary once the candidate goes to every node", async () => {
    await admin.clusters.promoteRollout({ id: clusterId });
    expect(await delivery()).toMatchObject({ state: "partial", currentNodes: 1, canary: null });
    await report(stableNode);
    expect(await delivery()).toMatchObject({ state: "live", currentNodes: 2, canary: null });
  });
});
