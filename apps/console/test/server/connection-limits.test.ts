import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { latestRevision } from "../../src/server/services/revisions";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

describe("kernel connection limits of a cluster", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  const config = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return { revision: row.revision, config: decodeNodeConfig(row.ir) };
  };
  const settings = {
    enabled: true,
    perIp: 100,
    newPerSecond: 20,
    burst: 0,
    ports: null,
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    await admin.sites.create({
      name: "shop",
      domains: ["shop.limits.test"],
      origins: [{ address: "origin.test" }],
    });
    await ctx.db.insert(schema.node).values([
      { clusterId, name: "edge-a", supportedFeatures: ["bans-v1", "conn-limit-v1"] },
      { clusterId, name: "edge-b", supportedFeatures: ["bans-v1", "conn-limit-v1"] },
      { clusterId, name: "edge-old", supportedFeatures: ["bans-v1"] },
    ]);
  });
  afterAll(() => pglite.close());

  it("starts off with the defaults and the cluster's ports", async () => {
    const value = await admin.clusters.connectionLimits({ clusterId });
    expect(value.settings).toEqual({
      enabled: false,
      perIp: 256,
      newPerSecond: 50,
      burst: 100,
      ports: null,
    });
    // Without a certificate the cluster listens on port 80 only.
    expect(value.effectivePorts).toEqual([{ start: 80, end: 80 }]);
    expect((await config()).config.connectionLimits).toBeUndefined();
  });

  it("publishes the limits on the cluster's ports and audits the change", async () => {
    const before = (await config()).revision;
    const value = await admin.clusters.setConnectionLimits({ clusterId, settings });
    expect(value.settings).toEqual(settings);
    const after = await config();
    expect(after.revision).toBe(before + 1);
    expect(after.config.connectionLimits).toMatchObject({
      perIpConnections: 100,
      newPerSecond: 20,
      burst: 20,
      ports: [{ start: 80, end: 80 }],
    });
    // The same settings again publish nothing.
    await admin.clusters.setConnectionLimits({ clusterId, settings });
    expect((await config()).revision).toBe(after.revision);
    const audits = (await admin.auditLogs.list({ action: "cluster.connection_limits_update" }))
      .items;
    expect(audits).toHaveLength(1);
    expect(audits[0]?.metadata).toMatchObject({ to: settings, revision: after.revision });
  });

  it("limits the ports named, merged", async () => {
    await admin.clusters.setConnectionLimits({
      clusterId,
      settings: {
        ...settings,
        burst: 50,
        ports: [
          { start: 8443, end: 8443 },
          { start: 443, end: 443 },
          { start: 8000, end: 8442 },
        ],
      },
    });
    const value = await admin.clusters.connectionLimits({ clusterId });
    expect(value.effectivePorts).toEqual([
      { start: 443, end: 443 },
      { start: 8000, end: 8443 },
    ]);
    expect((await config()).config.connectionLimits).toMatchObject({
      burst: 50,
      ports: [
        { start: 443, end: 443 },
        { start: 8000, end: 8443 },
      ],
    });
  });

  it("refuses settings without a limit or with a low burst", async () => {
    for (const bad of [
      { ...settings, perIp: 0, newPerSecond: 0 },
      { ...settings, burst: 5 },
      { ...settings, newPerSecond: 0, burst: 5 },
      {
        ...settings,
        ports: [
          { start: 80, end: 90 },
          { start: 85, end: 85 },
        ],
      },
    ])
      expect(
        (await rpcError(admin.clusters.setConnectionLimits({ clusterId, settings: bad }))).code,
      ).toBe("BAD_REQUEST");
  });

  it("tells the nodes that enforce the limits from those that do not", async () => {
    const [a] = await ctx.db.select().from(schema.node).where(eq(schema.node.name, "edge-a"));
    if (!a) throw new Error("no node");
    await ctx.db
      .update(schema.node)
      .set({
        banStatus: {
          appliedSequence: "1",
          entries: 0,
          capacity: 0,
          unappliedIds: [],
          unapplied: 0,
          kernelEntries: 0,
          autoEvicted: "0",
          reportedAt: new Date().toISOString(),
          connectionLimitsActive: true,
        },
      })
      .where(eq(schema.node.id, a.id));
    await ctx.db
      .update(schema.node)
      .set({
        banStatus: {
          appliedSequence: "1",
          entries: 0,
          capacity: 0,
          unappliedIds: [],
          unapplied: 0,
          kernelEntries: 0,
          autoEvicted: "0",
          reportedAt: new Date().toISOString(),
          connectionLimitsActive: false,
          connectionLimitsError: "kernel bans are not active",
        },
      })
      .where(eq(schema.node.name, "edge-b"));
    const { nodes } = await admin.clusters.connectionLimits({ clusterId });
    expect(nodes).toMatchObject({
      total: 3,
      enforcing: 1,
      unsupported: [{ name: "edge-old" }],
      failing: [{ name: "edge-b", error: "kernel bans are not active" }],
    });
  });

  it("turns off and keeps the values", async () => {
    await admin.clusters.setConnectionLimits({
      clusterId,
      settings: { ...settings, enabled: false },
    });
    const value = await admin.clusters.connectionLimits({ clusterId });
    expect(value.settings).toEqual({ ...settings, enabled: false });
    expect(value.nodes.failing).toEqual([]);
    expect((await config()).config.connectionLimits).toBeUndefined();
  });
});
