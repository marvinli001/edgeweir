import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { getRevision, latestRevision } from "../../src/server/services/revisions";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

describe("cluster summary: how many live nodes run their target revision", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let a: string;
  let b: string;

  /** Reports `revision` (default: the latest) as applied by a node. */
  const apply = async (nodeId: string, revision?: number) => {
    const row =
      revision === undefined
        ? await latestRevision(ctx.db, clusterId)
        : await getRevision(ctx.db, clusterId, revision);
    if (!row) throw new Error("no revision");
    const values = {
      appliedRevision: row.revision,
      appliedContentHash: row.contentHash,
      state: "applied",
      dataPlaneHealthy: true,
    };
    await ctx.db
      .insert(schema.nodeConfigStatus)
      .values({ nodeId, ...values })
      .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
  };
  const summary = async () => {
    const cluster = await admin.clusters.get({ id: clusterId });
    return {
      revision: cluster.latestRevision?.revision,
      live: cluster.liveNodeCount,
      applied: cluster.appliedNodeCount,
    };
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.create({ name: "edge-summary" })).id;
  });
  afterAll(() => pglite.close());

  it("counts nothing without nodes", async () => {
    expect(await summary()).toEqual({ revision: 1, live: 0, applied: 0 });
  });

  it("counts online active nodes and those that applied the latest revision", async () => {
    const nodes = await ctx.db
      .insert(schema.node)
      .values([
        { clusterId, name: "a", lastSeenAt: new Date() },
        { clusterId, name: "b", lastSeenAt: new Date() },
        // Neither offline nor disabled nodes are delivered to now.
        { clusterId, name: "offline", lastSeenAt: new Date(Date.now() - 3_600_000) },
        { clusterId, name: "off", lastSeenAt: new Date(), status: "disabled" },
        // Enrolled, never connected.
        { clusterId, name: "new" },
      ])
      .returning({ id: schema.node.id });
    [a, b] = nodes.map((n) => n.id) as [string, string];
    expect(await summary()).toEqual({ revision: 1, live: 2, applied: 0 });
    await apply(a);
    expect(await summary()).toEqual({ revision: 1, live: 2, applied: 1 });
    await apply(b);
    expect(await summary()).toEqual({ revision: 1, live: 2, applied: 2 });
    // A new revision: both run an older one now.
    await admin.sites.create({
      name: "shop",
      clusterId,
      domains: ["shop.summary.test"],
      origins: [{ address: "origin.test", port: 8080 }],
    });
    expect(await summary()).toEqual({ revision: 2, live: 2, applied: 0 });
  });

  it("compares each node with its own target during a canary window", async () => {
    // Revision 2 is the candidate of node a; node b keeps the stable revision 1.
    const rollout = {
      enabled: true,
      state: "canary",
      stableRevision: 1,
      candidateRevision: 2,
      canaryNodeIds: [a],
      windowStartedAt: new Date(),
    };
    await ctx.db
      .insert(schema.clusterRollout)
      .values({ clusterId, ...rollout })
      .onConflictDoUpdate({ target: schema.clusterRollout.clusterId, set: rollout });
    expect(await summary()).toEqual({ revision: 2, live: 2, applied: 1 });
    await apply(a, 2);
    expect(await summary()).toEqual({ revision: 2, live: 2, applied: 2 });
    // A node running a newer revision than its target runs it too (nodes never go back).
    await apply(b, 2);
    expect(await summary()).toEqual({ revision: 2, live: 2, applied: 2 });
  });
});
