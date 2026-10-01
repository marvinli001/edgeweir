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
  const config = async (node: TestNode) =>
    decodeNodeConfig((await nodeTarget(ctx.db, node))?.ir ?? new Uint8Array());
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
});
