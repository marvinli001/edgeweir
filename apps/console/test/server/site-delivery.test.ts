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
    });
    await apply([nodeIds[0] as string]);
    expect(await delivery()).toEqual({
      state: "partial",
      totalNodes: 2,
      servingNodes: 1,
      currentNodes: 1,
    });
    await apply([nodeIds[1] as string]);
    expect(await delivery()).toEqual({
      state: "live",
      totalNodes: 2,
      servingNodes: 2,
      currentNodes: 2,
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
    expect(disabled.site.delivery.state).toBe("disabled");
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
    });
  });
});
