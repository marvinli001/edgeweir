import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { ATTENTION_RECENT_MS } from "../../src/server/services/attention";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

describe("what needs the operator: canary changes and the attention list", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let canary: string;
  let stable: string;
  let renames = 0;

  const attention = async () => (await admin.overview.get()).attention;
  const kinds = async () => (await attention()).map((a) => a.kind);
  const rollout = () => admin.clusters.rollout({ id: clusterId });
  /** Heartbeat: the node reports `revision` applied now. */
  const report = async (
    nodeId: string,
    revision: number,
    opts: { healthy?: boolean; state?: "applied" | "failed" } = {},
  ) => {
    const [row] = await ctx.db
      .select()
      .from(schema.configRevision)
      .where(
        and(
          eq(schema.configRevision.clusterId, clusterId),
          eq(schema.configRevision.revision, revision),
        ),
      );
    const values = {
      nodeId,
      appliedRevision: revision,
      appliedContentHash: row?.contentHash ?? "",
      state: opts.state ?? "applied",
      dataPlaneHealthy: opts.healthy ?? true,
    };
    await ctx.db
      .insert(schema.nodeConfigStatus)
      .values(values)
      .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date() })
      .where(eq(schema.node.id, nodeId));
  };
  const latest = async () =>
    (await admin.clusters.get({ id: clusterId })).latestRevision?.revision ?? 0;
  const rename = async () => {
    renames++;
    return (await admin.sites.update({ id: siteId, name: `shop-${renames}` })).revision.revision;
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    const defaultGroup = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    const group = await admin.nodeGroups.create({ clusterId, name: "canary", isCanary: true });
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.attention.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    const nodes = await ctx.db
      .insert(schema.node)
      .values(
        (
          [
            [group.id, "edge-canary"],
            [defaultGroup, "edge-stable"],
          ] as const
        ).map(([nodeGroupId, name]) => ({
          clusterId,
          nodeGroupId,
          name,
          lastSeenAt: new Date(),
          supportedFeatures: ["tls-v1", "http01-v1", "rules-v1", "stats-sequence-v1"],
        })),
      )
      .returning({ id: schema.node.id });
    [canary, stable] = nodes.map((n) => n.id) as [string, string];
  });
  afterAll(() => pglite.close());

  it("is empty while all is well, and for nodes still starting", async () => {
    // Online without any configuration yet: starting, neither lagging nor unhealthy.
    expect(await attention()).toEqual([]);
    const revision = await latest();
    await report(canary, revision);
    await report(stable, revision);
    expect(await attention()).toEqual([]);
  });

  it("counts unhealthy and lagging nodes per cluster", async () => {
    const revision = await latest();
    await report(stable, revision, { healthy: false });
    expect(await attention()).toEqual([
      {
        kind: "nodes_unhealthy",
        clusterId,
        clusterName: "default",
        revision: null,
        at: null,
        count: 1,
        version: "",
      },
    ]);
    await report(stable, revision);
    const next = await rename();
    expect(next).toBeGreaterThan(revision);
    expect(await attention()).toEqual([
      expect.objectContaining({ kind: "nodes_lagging", count: 2 }),
    ]);
    await report(canary, next);
    await report(stable, next);
    // Offline after connecting is unhealthy too.
    await ctx.db
      .update(schema.node)
      .set({ lastSeenAt: new Date(Date.now() - 3_600_000) })
      .where(eq(schema.node.id, stable));
    expect(await kinds()).toEqual(["nodes_unhealthy"]);
    await report(stable, next);
    expect(await attention()).toEqual([]);
  });

  it("follows a canary window: what the candidate changes, running, rolled back", async () => {
    const policy = (await rollout()).policy;
    await admin.clusters.setRolloutPolicy({
      id: clusterId,
      ...policy,
      enabled: true,
      windowSeconds: 600,
      autoPromote: false,
      expectedUpdatedAt: (await rollout()).policyUpdatedAt,
    });
    const stableRevision = await latest();
    expect((await rollout()).candidateChanges).toBeNull();

    const first = await rename();
    const running = await rollout();
    expect(running).toMatchObject({ state: "canary", candidateRevision: first });
    expect(running.candidateChanges?.sites).toEqual({
      added: [],
      changed: [{ id: siteId, name: `shop-${renames}` }],
      removed: [],
    });
    expect(running.candidateChanges?.reasons.map((r) => r.reasonCode)).toEqual(["site_updated"]);
    // A second change replaces the candidate: both show, the same reason once.
    const blog = await admin.sites.create({
      name: "blog",
      domains: ["blog.attention.test"],
      origins: [{ address: "origin.test" }],
    });
    // Updated again under the same name: the same reason.
    const second = (
      await admin.sites.update({
        id: siteId,
        cacheRules: [{ pathPrefixes: ["/"], edgeTtlSeconds: 60 }],
      })
    ).revision.revision;
    const replaced = await rollout();
    expect(replaced.candidateRevision).toBe(second);
    expect(replaced.stableRevision).toBe(stableRevision);
    expect(replaced.candidateChanges?.sites).toEqual({
      added: [{ id: blog.site.id, name: "blog" }],
      changed: [{ id: siteId, name: `shop-${renames}` }],
      removed: [],
    });
    const reasons = replaced.candidateChanges?.reasons ?? [];
    expect(reasons.map((r) => [r.reasonCode, r.reasonParams])).toEqual([
      ["site_created", { site: "blog" }],
      ["site_updated", { site: `shop-${renames}` }],
    ]);
    expect(reasons.at(-1)?.revision).toBe(second);

    const items = await attention();
    expect(items.find((a) => a.kind === "canary_running")).toMatchObject({
      clusterId,
      revision: second,
      at: replaced.windowEndsAt,
    });
    // The canary node runs the candidate: nothing lags.
    await report(canary, second);
    expect(await kinds()).toEqual(["canary_running"]);

    await admin.clusters.abortRollout({ id: clusterId });
    expect((await rollout()).candidateChanges).toBeNull();
    const rolledBack = (await attention()).find((a) => a.kind === "canary_rolled_back");
    expect(rolledBack).toMatchObject({ revision: second });
    // A day later it is history.
    await ctx.db
      .update(schema.clusterRollout)
      .set({ finishedAt: new Date(Date.now() - ATTENTION_RECENT_MS - 60_000) })
      .where(eq(schema.clusterRollout.clusterId, clusterId));
    expect(await kinds()).not.toContain("canary_rolled_back");
  });

  it("lists failed or blocked DNS publications and failed upgrades with their place", async () => {
    // Off: nothing about DNS, even with a failed revision.
    const [failed] = await ctx.db
      .insert(schema.dnsRevision)
      .values({ clusterId, policy: {}, contentHash: "x", reason: "manual", status: "failed" })
      .returning();
    if (!failed) throw new Error("no revision");
    await ctx.db
      .insert(schema.dnsBinding)
      .values({ clusterId, mode: "off", desiredRevision: failed.revision })
      .onConflictDoUpdate({
        target: schema.dnsBinding.clusterId,
        set: { mode: "off", desiredRevision: failed.revision },
      });
    expect(await kinds()).not.toContain("dns_failed");
    await ctx.db
      .update(schema.dnsBinding)
      .set({ mode: "manual", domain: "edge.attention.test" })
      .where(eq(schema.dnsBinding.clusterId, clusterId));
    expect(await attention()).toContainEqual(
      expect.objectContaining({ kind: "dns_failed", clusterId, revision: failed.revision }),
    );
    await ctx.db
      .insert(schema.dnsRevision)
      .values({ clusterId, policy: {}, contentHash: "y", reason: "health", status: "blocked" });
    expect(await kinds()).toContain("dns_blocked");

    const [job] = await ctx.db
      .insert(schema.nodeUpgrade)
      .values({
        clusterId,
        clusterName: "default",
        groupName: "canary",
        version: "0.9.1",
        state: "failed",
        artifacts: [],
      })
      .returning();
    if (!job) throw new Error("no job");
    await ctx.db.insert(schema.nodeUpgradeDelivery).values({
      upgradeId: job.id,
      nodeId: canary,
      nodeName: "edge-canary",
      arch: "amd64",
      phase: "canary",
      state: "failed",
      finishedAt: new Date(),
    });
    expect(await attention()).toContainEqual(
      expect.objectContaining({ kind: "upgrade_failed", clusterId, version: "0.9.1" }),
    );
    // Most pressing first.
    const order = await kinds();
    expect(order.indexOf("dns_failed")).toBeLessThan(order.indexOf("upgrade_failed"));
    // A failure older than a day is history.
    await ctx.db
      .update(schema.nodeUpgradeDelivery)
      .set({ finishedAt: new Date(Date.now() - ATTENTION_RECENT_MS - 60_000) })
      .where(eq(schema.nodeUpgradeDelivery.upgradeId, job.id));
    expect(await kinds()).not.toContain("upgrade_failed");
  });
});
