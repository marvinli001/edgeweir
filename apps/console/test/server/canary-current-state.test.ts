import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { and, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import {
  certificateKeyBinding,
  inspectCertificate,
  nodeCertificates,
} from "../../src/server/services/certificates";
import { latestRevision, nodeTarget, publishRevision } from "../../src/server/services/revisions";
import { evaluateRollout } from "../../src/server/services/rollout";
import {
  type ApiClient,
  approveSiteDomains,
  createTestContext,
  rpcClient,
  setupPlatform,
  signIn,
} from "./helpers";

type TestNode = { id: string; clusterId: string; nodeGroupId: string | null };

/** What the configuration canary keeps current on every node, whatever the window. */
describe("configuration canary and current state", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let defaultGroup: string;
  let canaryGroup: string;
  let canary: TestNode;
  let stable: TestNode;
  let renames = 0;

  const policy = {
    enabled: true,
    windowSeconds: 300,
    autoPromote: true,
    errorRatioMultiplier: 2,
    errorRatioFloor: 0.05,
    minRequests: 10,
  };
  const rollout = () => admin.clusters.rollout({ id: clusterId });
  const change = async (id = siteId) => {
    renames++;
    return (await admin.sites.update({ id, name: `site-${renames}` })).revision.revision;
  };
  /** The node's target, from its row as the node channel reads it. */
  const target = async (node: TestNode) => {
    const [row] = await ctx.db.select().from(schema.node).where(eq(schema.node.id, node.id));
    if (!row) throw new Error("node missing");
    return nodeTarget(ctx.db, row);
  };
  const config = async (node: TestNode) =>
    decodeNodeConfig((await target(node))?.ir ?? new Uint8Array());
  /** Heartbeat: the node reports `revision` applied at `at`. */
  const report = async (node: TestNode, revision: number, at = new Date()) => {
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
      nodeId: node.id,
      appliedRevision: revision,
      appliedContentHash: row?.contentHash ?? "",
      state: "applied",
      dataPlaneHealthy: true,
      reportedAt: at,
    };
    await ctx.db
      .insert(schema.nodeConfigStatus)
      .values(values)
      .onConflictDoUpdate({ target: schema.nodeConfigStatus.nodeId, set: values });
    await ctx.db.update(schema.node).set({ lastSeenAt: at }).where(eq(schema.node.id, node.id));
  };
  /** Both nodes report their targets: the start of every scenario. */
  const settle = async () => {
    for (const node of [canary, stable]) await report(node, (await config(node)).revision as never);
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    defaultGroup = (await admin.nodeGroups.list({ clusterId }))[0]?.id ?? "";
    canaryGroup = (await admin.nodeGroups.create({ clusterId, name: "canary", isCanary: true })).id;
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.current.test"],
        origins: [{ address: "origin.test" }],
      })
    ).site.id;
    await approveSiteDomains(admin, siteId);
    const [a, b] = await ctx.db
      .insert(schema.node)
      .values(
        (
          [
            [canaryGroup, "edge-canary"],
            [defaultGroup, "edge-stable"],
          ] as const
        ).map(([nodeGroupId, name]) => ({
          clusterId,
          nodeGroupId,
          name,
          lastSeenAt: new Date(),
          supportedFeatures: ["tls-v1", "http01-v1", "rules-v1", "challenge-v1", "http3-v1"],
        })),
      )
      .returning();
    if (!a || !b) throw new Error("nodes missing");
    canary = { id: a.id, clusterId, nodeGroupId: canaryGroup };
    stable = { id: b.id, clusterId, nodeGroupId: defaultGroup };
    const latest = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    await report(canary, latest);
    await report(stable, latest);
    await admin.clusters.setRolloutPolicy({ id: clusterId, ...policy });
  });
  afterAll(() => pglite.close());

  it("gives a certificate renewed in place to the canary node during a window", async () => {
    const first = await ctx.nodeCa.issueServerCertificate(["shop.current.test"]);
    const certificate = await admin.certificates.upload({
      name: "shop",
      chainPem: first.certificatePem,
      privateKeyPem: first.privateKeyPem,
    });
    await admin.https.update({
      id: siteId,
      settings: tlsSettings.parse({ certificateId: certificate.id }),
    });
    await admin.clusters.promoteRollout({ id: clusterId });
    await settle();
    await change();
    expect((await rollout()).state).toBe("canary");
    expect((await config(stable)).certificates.map((c) => c.sha256Fingerprint)).toEqual([
      certificate.fingerprint,
    ]);
    // Renewal in place, as the certificate worker does it.
    const renewed = await ctx.nodeCa.issueServerCertificate(["shop.current.test"]);
    const inspected = inspectCertificate(renewed.certificatePem, renewed.privateKeyPem);
    await ctx.db.transaction(async (tx) => {
      await tx
        .update(schema.certificate)
        .set({
          chainPem: renewed.certificatePem,
          privateKeyEnvelope: JSON.stringify(
            ctx.masterKey.seal(renewed.privateKeyPem, certificateKeyBinding(certificate.id)),
          ),
          fingerprint: inspected.fingerprint,
          notAfter: inspected.notAfter,
        })
        .where(eq(schema.certificate.id, certificate.id));
      await publishRevision(tx, {
        clusterId,
        reason: { code: "certificate_updated", params: { site: "shop" } },
      });
    });
    const candidate = await config(canary);
    expect(candidate.certificates.map((c) => c.sha256Fingerprint)).toEqual([inspected.fingerprint]);
    const served = await nodeCertificates(ctx, clusterId, [certificate.id]);
    expect(served.map((c) => c.sha256Fingerprint)).toEqual([inspected.fingerprint]);
    expect(served[0]?.privateKeyPem).toBe(renewed.privateKeyPem);
  });

  it("keeps the candidate with the window's canary nodes when node groups change", async () => {
    await admin.clusters.abortRollout({ id: clusterId });
    await settle();
    const first = await change();
    const group = (node: TestNode, nodeGroupId: string) =>
      ctx.db.update(schema.node).set({ nodeGroupId }).where(eq(schema.node.id, node.id));
    // The canary node leaves its group, the other node joins it during the window.
    await group(canary, defaultGroup);
    await group(stable, canaryGroup);
    const stableRevision = (await rollout()).stableRevision;
    expect((await target(canary))?.revision).toBe(first);
    expect((await target(stable))?.revision).toBe(stableRevision);
    // A replacement candidate goes to the same nodes.
    const second = await change();
    expect((await target(canary))?.revision).toBe(second);
    expect((await target(stable))?.revision).toBe(stableRevision);
    expect((await rollout()).canaryNodes).toEqual([
      expect.objectContaining({ id: canary.id, participating: true }),
      expect.objectContaining({ id: stable.id, participating: false }),
    ]);
    // Only the window's canary node decides it.
    await report(stable, second);
    await ctx.db
      .update(schema.nodeConfigStatus)
      .set({ state: "failed" })
      .where(eq(schema.nodeConfigStatus.nodeId, stable.id));
    expect(await evaluateRollout(ctx, clusterId)).toBe("canary");
    await report(stable, stableRevision ?? 0);
    await report(canary, second);
    await ctx.db
      .update(schema.nodeConfigStatus)
      .set({ state: "failed" })
      .where(eq(schema.nodeConfigStatus.nodeId, canary.id));
    expect(await evaluateRollout(ctx, clusterId)).toBe("rolled_back");
    const restored = (await rollout()).stableRevision;
    expect((await target(canary))?.revision).toBe(restored);
    await group(canary, canaryGroup);
    await group(stable, defaultGroup);
  });

  it("rolls back to the stable content without what was taken offline, removed or purged since", async () => {
    await settle();
    const create = async (name: string, domains: string[]) => {
      const id = (
        await admin.sites.create({ name, domains, origins: [{ address: "origin.test" }] })
      ).site.id;
      await approveSiteDomains(admin, id);
      return id;
    };
    const blog = await create("blog", ["blog.current.test", "www.blog.current.test"]);
    const old = await create("old", ["old.current.test"]);
    await admin.clusters.promoteRollout({ id: clusterId });
    await settle();
    const before = await config(stable);
    expect(before.sites.map((s) => s.name).sort()).toEqual(["blog", "old", expect.any(String)]);
    const generation = before.sites.find((s) => s.id === siteId)?.cacheGeneration ?? 0n;
    // During the window: a domain is removed, a site disabled, the cache purged.
    await change();
    await admin.sites.update({ id: blog, domains: ["blog.current.test"] });
    const withoutDomain = (await latestRevision(ctx.db, clusterId))?.revision ?? 0;
    await admin.sites.setEnabled({ id: old, enabled: false });
    await admin.sites.purgeAll({ id: siteId });
    const candidate = (await rollout()).candidateRevision ?? 0;
    await report(canary, candidate);
    await ctx.db
      .update(schema.nodeConfigStatus)
      .set({ state: "failed" })
      .where(eq(schema.nodeConfigStatus.nodeId, canary.id));
    expect(await evaluateRollout(ctx, clusterId)).toBe("rolled_back");
    const restored = await config(stable);
    expect(restored.revision).toBeGreaterThan(candidate);
    expect(restored.sites.find((s) => s.id === old)).toBeUndefined();
    expect(restored.offlineHosts.map((h) => h.name)).toEqual(["old.current.test"]);
    expect(restored.sites.find((s) => s.id === blog)?.domains.map((d) => d.name)).toEqual([
      "blog.current.test",
    ]);
    expect(restored.sites.find((s) => s.id === siteId)?.cacheGeneration).toBe(generation + 1n);
    // The rest is the stable content: the rename stays with the rolled back candidate.
    expect(restored.sites.find((s) => s.id === siteId)?.name).toBe(
      before.sites.find((s) => s.id === siteId)?.name,
    );
    // An administrator's rollback keeps the current cache generation as well.
    await settle();
    await admin.clusters.rollback({ id: clusterId, revision: withoutDomain });
    const manual = await config(stable);
    expect(manual.sites.find((s) => s.id === siteId)?.cacheGeneration).toBe(generation + 1n);
    expect(manual.sites.find((s) => s.id === old)).toBeUndefined();
    await admin.sites.delete({ id: blog });
    await admin.sites.delete({ id: old });
    await admin.clusters.promoteRollout({ id: clusterId });
  });
});
