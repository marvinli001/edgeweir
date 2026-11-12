import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { accountNodeTraffic } from "../../src/server/services/node-traffic-limit";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

describe("exact NIC traffic limits", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx),
    bootId = randomUUID();
  let admin: ApiClient, clusterId: string;
  const at = Date.now() - 20_000;
  const network = (tick: number, rx: string, tx: string, boot = bootId) => ({
    bootId: boot,
    sampledAt: new Date(at + tick * 1000).toISOString(),
    interfaces: [{ name: "eth0", bytesReceived: rx, bytesSent: tx }],
  });
  const metrics = (net: schema.NetworkCountersData) => ({
    cpuPercent: 0,
    load1: 0,
    load5: 0,
    load15: 0,
    memoryUsedBytes: 0,
    memoryTotalBytes: 0,
    egressBps: 0,
    activeConnections: 0,
    reportedAt: new Date().toISOString(),
    network: net,
  });
  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(
      app,
      ctx.env.EDGEWEIR_PUBLIC_URL,
      await signIn(app, ctx.env.EDGEWEIR_PUBLIC_URL, "admin@example.com"),
    );
    const cluster = (await admin.clusters.list())[0];
    assert(cluster);
    clusterId = cluster.id;
  });
  afterAll(() => client.close());
  it("counts uint64 RX+TX exactly, replays once, and requires reset or a raised limit before re-enabling", async () => {
    const base = 9007199254740993000n;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ name: "exact", clusterId, metrics: metrics(network(0, String(base), "50")) })
      .returning();
    assert(node);
    const id = node.id;
    await admin.nodes.setTrafficLimit({ id, bytesLimit: "10" });
    const report = network(1, String(base + 5n), "55");
    await ctx.db.transaction((tx) => accountNodeTraffic(tx, id, report));
    await ctx.db.transaction((tx) => accountNodeTraffic(tx, id, report));
    const got = await admin.nodes.get({ id });
    expect(got.status).toBe("disabled");
    expect(got.trafficLimit).toMatchObject({
      bytesReceived: "5",
      bytesSent: "5",
      bytesLimit: "10",
    });
    expect(JSON.stringify(got.trafficLimit)).not.toContain("baseline");
    await expect(admin.nodes.enable({ id })).rejects.toMatchObject({
      code: "NODE_TRAFFIC_LIMIT_REACHED",
    });
    await admin.nodes.setTrafficLimit({ id, bytesLimit: "20" });
    expect((await admin.nodes.get({ id })).trafficLimit?.reachedAt).toBeNull();
    await admin.nodes.enable({ id });
    expect((await admin.nodes.get({ id })).status).toBe("active");
    const audits = await admin.auditLogs.list({});
    expect(
      audits.items.filter((a) => a.action === "node.traffic_limit_reached" && a.targetId === id),
    ).toHaveLength(1);
  });
  it("handles node restart, host reboot, interface reset and a temporarily missing interface", async () => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ name: "reset", clusterId, metrics: metrics(network(0, "100", "200")) })
      .returning();
    assert(node);
    const id = node.id;
    await admin.nodes.setTrafficLimit({ id, bytesLimit: "1000" });
    await ctx.db.transaction((tx) => accountNodeTraffic(tx, id, network(1, "110", "220")));
    await ctx.db.transaction((tx) =>
      accountNodeTraffic(tx, id, { ...network(2, "0", "0"), interfaces: [] }),
    );
    await ctx.db.transaction((tx) => accountNodeTraffic(tx, id, network(3, "115", "225")));
    expect((await admin.nodes.get({ id })).trafficLimit).toMatchObject({
      bytesReceived: "15",
      bytesSent: "25",
    });
    await ctx.db.transaction((tx) =>
      accountNodeTraffic(tx, id, network(4, "2", "3", randomUUID())),
    );
    expect((await admin.nodes.get({ id })).trafficLimit).toMatchObject({
      bytesReceived: "17",
      bytesSent: "28",
    });
    await ctx.db.transaction((tx) => accountNodeTraffic(tx, id, undefined));
    expect((await admin.nodes.get({ id })).trafficLimit).toMatchObject({
      bytesReceived: "17",
      bytesSent: "28",
    });
    await admin.nodes.setTrafficLimit({ id, bytesLimit: null });
    expect((await admin.nodes.get({ id })).trafficLimit).toBeNull();
  });
  it("refuses unsupported counters, stale samples and unknown interfaces", async () => {
    const [old] = await ctx.db.insert(schema.node).values({ name: "old", clusterId }).returning();
    assert(old);
    await expect(
      admin.nodes.setTrafficLimit({ id: old.id, bytesLimit: "100" }),
    ).rejects.toMatchObject({ code: "NODE_NETWORK_COUNTERS_REQUIRED" });
    await ctx.db
      .update(schema.node)
      .set({ metrics: metrics(network(0, "100", "100")) })
      .where(eq(schema.node.id, old.id));
    await expect(
      admin.nodes.setTrafficLimit({ id: old.id, bytesLimit: "100", interfaces: ["missing"] }),
    ).rejects.toMatchObject({ code: "NODE_NETWORK_INTERFACE_UNKNOWN" });
  });
  it("does not re-enable past a quota when enabling and accounting race", async () => {
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ name: "race", clusterId, metrics: metrics(network(0, "0", "0")) })
      .returning();
    assert(node);
    await admin.nodes.setTrafficLimit({ id: node.id, bytesLimit: "10" });
    await Promise.allSettled([
      ctx.db.transaction((tx) => accountNodeTraffic(tx, node.id, network(1, "5", "5"))),
      admin.nodes.enable({ id: node.id }),
    ]);
    expect((await admin.nodes.get({ id: node.id })).status).toBe("disabled");
  });
});
