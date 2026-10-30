import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { TIER_UPPER_FEATURE, TIERED_CACHE_FEATURE } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { needsTierCertificate } from "../../src/server/node-channel/service";
import { NODE_CERT_LIFETIME_DAYS } from "../../src/server/pki/ca";
import { latestRevision } from "../../src/server/services/revisions";
import {
  readSiteTieredCache,
  recordTierLatencies,
  selectTiers,
  tierAddressOf,
} from "../../src/server/services/tiered-cache";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const DAY = 24 * 3600 * 1000;

describe("tiered cache", async () => {
  const { ctx, client } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  const nodes: Record<string, string> = {};
  const names: Record<string, string> = {};

  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const measure = async (rtts: Record<string, number>, targetId: string) => {
    for (const [name, rttMs] of Object.entries(rtts))
      await recordTierLatencies(ctx.db, nodes[name] as string, [
        { targetId, rttMs, ok: true, measuredAt: new Date() },
      ]);
  };
  const uppers = async () => {
    const selection = await admin.tieredCache.site.selection({ id: siteId });
    return Object.fromEntries(
      selection.nodes.map((n) => [
        names[n.nodeId],
        n.uppers.map((u) => `${names[u.nodeId]}:${u.reason}`),
      ]),
    );
  };

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (
      await admin.sites.create({
        name: "shop",
        domains: ["shop.test"],
        origins: [{ address: "Origin.Example.com", port: 8443 }],
      })
    ).site.id;
    const eu = await admin.regions.create({ name: "Europe", code: "eu" });
    const us = await admin.regions.create({ name: "US", code: "us" });
    const groups = {
      eu: (await admin.nodeGroups.create({ clusterId, name: "eu", regionId: eu.id })).id,
      us: (await admin.nodeGroups.create({ clusterId, name: "us", regionId: us.id })).id,
    };
    const features = ["tls-v1", "http01-v1", "rules-v1", TIERED_CACHE_FEATURE, TIER_UPPER_FEATURE];
    for (const [name, group, address, extra] of [
      ["e1", "eu", "10.1.0.1", []],
      ["e2", "eu", "10.1.0.2", []],
      ["u1", "us", "10.2.0.1", []],
      // Takes part as a lower tier only: its certificate cannot serve TLS yet.
      ["u2", "us", "10.2.0.2", ["no-upper"]],
      // Without the feature: fetches from the origin.
      ["old", "us", "10.2.0.3", ["old"]],
    ] as const) {
      const [row] = await ctx.db
        .insert(schema.node)
        .values({
          clusterId,
          nodeGroupId: groups[group],
          name,
          lastSeenAt: new Date(),
          supportedFeatures: extra.includes("old" as never)
            ? ["tls-v1", "http01-v1", "rules-v1"]
            : extra.includes("no-upper" as never)
              ? features.filter((f) => f !== TIER_UPPER_FEATURE)
              : features,
        })
        .returning();
      nodes[name] = row?.id as string;
      names[row?.id as string] = name;
      await ctx.db
        .insert(schema.nodeIp)
        .values({ nodeId: row?.id as string, address, source: "configured", level: 0 });
    }
  });
  afterAll(() => client.close());

  it("is off by default and the site follows the console-wide setting", async () => {
    expect(await admin.tieredCache.get()).toEqual({
      topology: "off",
      port: 8444,
      upperNodeIds: [],
      upperNodeGroupIds: [],
    });
    expect(await admin.tieredCache.site.get({ id: siteId })).toMatchObject({ topology: "inherit" });
    expect((await config()).tieredCache).toBeUndefined();
    expect((await admin.tieredCache.site.selection({ id: siteId })).topology).toBe("off");
  });

  it("smart: measures the origin first, then the fastest node is the upper tier", async () => {
    await admin.tieredCache.update({
      topology: "smart",
      port: 8444,
      upperNodeIds: [],
      upperNodeGroupIds: [],
    });
    const waiting = await admin.tieredCache.site.selection({ id: siteId });
    expect(waiting).toMatchObject({
      topology: "smart",
      inherited: true,
      target: "origin.example.com:8443",
      idleReason: "no_latency",
      unsupportedNodes: 1,
    });
    const target = (await config()).tieredCache?.latencyTargets[0];
    expect(target).toMatchObject({ host: "origin.example.com", port: 8443 });
    expect((await config()).tieredCache?.plans).toEqual([]);

    await measure({ e1: 30, e2: 10, u1: 50, u2: 5 }, target?.id ?? "");
    expect(await selectTiers(ctx.db)).toEqual([clusterId]);
    expect(await uppers()).toEqual({
      e1: ["e2:lowest_latency", "u1:fallback_region"],
      e2: [],
      // u2 is faster but cannot serve lower tiers.
      u1: ["e2:lowest_latency"],
      u2: ["e2:lowest_latency", "u1:fallback_region"],
      old: [],
    });
    const compiled = await config();
    const site = compiled.sites.find((s) => s.id === siteId);
    expect(site?.tierPlanId).toBe(compiled.tieredCache?.plans[0]?.id);
    expect(compiled.tieredCache?.nodes.find((n) => n.id === nodes.e2)?.address).toBe("10.1.0.2");
    expect(compiled.tieredCache?.nodes.find((n) => n.id === nodes.e1)?.address).toBe("");
    expect(
      (await latestRevision(ctx.db, clusterId))?.reasonCode,
      "the minute job publishes the change",
    ).toBe("tier_selection_changed");
  });

  it("keeps the upper tier while it is not clearly slower, and follows a clear change", async () => {
    const targetId = (await config()).tieredCache?.latencyTargets[0]?.id ?? "";
    const revision = (await latestRevision(ctx.db, clusterId))?.revision;
    await measure({ e1: 9, e2: 12 }, targetId);
    expect(await selectTiers(ctx.db)).toEqual([]);
    expect((await latestRevision(ctx.db, clusterId))?.revision).toBe(revision);
    expect((await uppers()).e1?.[0]).toBe("e2:lowest_latency");

    await measure({ e1: 2, e2: 40 }, targetId);
    expect(await selectTiers(ctx.db)).toEqual([clusterId]);
    expect((await uppers()).e2).toEqual(["e1:lowest_latency", "u1:fallback_region"]);
  });

  it("custom and per-site settings, audited and published", async () => {
    const error = await rpcError(
      admin.tieredCache.site.update({
        id: siteId,
        topology: "custom",
        upperNodeIds: ["not-a-uuid"],
        upperNodeGroupIds: [],
      }),
    );
    expect(error.status).toBe(400);
    const groups = await admin.nodeGroups.list({ clusterId });
    const us = groups.find((g) => g.name === "us")?.id as string;
    await admin.tieredCache.site.update({
      id: siteId,
      topology: "custom",
      upperNodeIds: [],
      upperNodeGroupIds: [us],
    });
    expect(await uppers()).toEqual({
      e1: ["u1:custom"],
      e2: ["u1:custom"],
      u1: [],
      u2: ["u1:custom"],
      old: [],
    });
    const selection = await admin.tieredCache.site.selection({ id: siteId });
    expect(selection).toMatchObject({ topology: "custom", inherited: false });

    await admin.tieredCache.site.update({
      id: siteId,
      topology: "off",
      upperNodeIds: [],
      upperNodeGroupIds: [],
    });
    const compiled = await config();
    expect(compiled.tieredCache).toBeUndefined();
    expect(compiled.sites.find((s) => s.id === siteId)?.tierPlanId).toBe("");
    // Back to the console-wide setting: stored as null.
    await admin.tieredCache.site.update({
      id: siteId,
      topology: "inherit",
      upperNodeIds: [],
      upperNodeGroupIds: [],
    });
    const [row] = await ctx.db.select({ t: schema.site.tieredCache }).from(schema.site);
    expect(row?.t).toBeNull();
  });

  it("counts tier fetches and the upper tiers' hit ratio", async () => {
    const node = nodes.e1 as string;
    await ctx.db.insert(schema.nodeMinuteStats).values({
      minute: new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000),
      nodeId: node,
      siteId,
      requests: 10,
      bytesSent: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCodes: {},
      tierStats: { "f:HIT": 6, "f:MISS": 2, "f:origin": 1, "v:HIT": 4 },
    });
    expect(await admin.tieredCache.site.stats({ id: siteId, range: "1h" })).toEqual({
      fetches: { HIT: 6, MISS: 2, origin: 1 },
      served: { HIT: 4 },
      hitRatio: 0.75,
      fallbacks: 1,
    });
  });
});

describe("tiered cache helpers", () => {
  it("reads a stored site setting over the defaults", () => {
    expect(readSiteTieredCache(null).topology).toBe("inherit");
    expect(readSiteTieredCache({ topology: "smart" })).toEqual({
      topology: "smart",
      upperNodeIds: [],
      upperNodeGroupIds: [],
    });
    expect(readSiteTieredCache({ topology: "bogus" }).topology).toBe("inherit");
  });

  it("reaches a node at its first primary address, IPv4 first", () => {
    const row = (address: string, level = 0) =>
      ({ id: "x", nodeId: "n", address, kind: "private", source: "configured", level }) as never;
    expect(tierAddressOf([row("2001:db8::1"), row("10.0.0.9"), row("10.0.0.1", 1)])).toBe(
      "10.0.0.9",
    );
    expect(tierAddressOf([row("2001:db8::1")])).toBe("2001:db8::1");
    expect(tierAddressOf([])).toBe("");
  });

  it("asks nodes without a TLS-capable certificate to renew once a day", () => {
    const lifetime = NODE_CERT_LIFETIME_DAYS * DAY;
    expect(needsTierCertificate([TIERED_CACHE_FEATURE], lifetime - 2 * DAY)).toBe(true);
    expect(needsTierCertificate([TIERED_CACHE_FEATURE], lifetime - 3600_000)).toBe(false);
    expect(
      needsTierCertificate([TIERED_CACHE_FEATURE, TIER_UPPER_FEATURE], lifetime - 2 * DAY),
    ).toBe(false);
    expect(needsTierCertificate([], lifetime - 2 * DAY)).toBe(false);
  });
});
