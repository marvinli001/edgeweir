import { RULE_LOG_FEATURE } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { topLoggedRules } from "../../src/server/services/rule-logs";
import { ingestMinuteStats } from "../../src/server/services/stats";
import { rollupTraffic } from "../../src/server/services/stats-rollup";
import { type ApiClient, createTestContext, rpcClient, setupPlatform, signIn } from "./helpers";

describe("matches of log rules", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const origins = [{ address: "origin.test" }];
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let otherSiteId: string;
  let nodeId: string;

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (await admin.sites.create({ name: "logged", domains: ["logged.test"], origins })).site
      .id;
    otherSiteId = (
      await admin.sites.create({ name: "elsewhere", domains: ["elsewhere.test"], origins })
    ).site.id;
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-log", supportedFeatures: ["rules-v1", RULE_LOG_FEATURE] })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("counts matches per rule with the rules' names, platform rules included", async () => {
    const log = (name: string, expression: string) => ({
      name,
      phase: "waf-custom" as const,
      expression,
      action: { kind: "log" as const },
    });
    const [scanner, admins] = await admin.rules.save({
      id: siteId,
      rules: [
        log("scanners", 'http.request.headers["user-agent"] contains "scan"'),
        log("admin", 'http.request.uri.path matches "^/admin/"'),
      ],
    });
    const [global] = await admin.platformRules.save({ rules: [log("everything", "true")] });
    const [foreign] = await admin.rules.save({ id: otherSiteId, rules: [log("foreign", "true")] });
    if (!scanner || !admins || !global || !foreign) throw new Error("rules missing");
    const deleted = "00000000-0000-4000-8000-00000000dead";
    const minute = new Date(Math.floor(Date.now() / 60_000) * 60_000 - 60_000);
    const bucket = (site: string, loggedRules: Record<string, number>) => ({
      minute,
      siteId: site,
      requests: 10,
      bytesSent: 0,
      bytesReceived: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCodes: {},
      loggedRules,
    });
    const node = { id: nodeId, clusterId };
    await ingestMinuteStats(ctx.db, node, [
      bucket(siteId, { [scanner.id]: 4, [global.id]: 9, "not-a-rule": 50, [admins.id]: -1 }),
      bucket(siteId, { [scanner.id]: 2, [deleted]: 1 }),
      bucket(otherSiteId, { [foreign.id]: 7 }),
    ]);
    // A rule of another site counted for this one (never sent by nodes) gets no name.
    await ingestMinuteStats(ctx.db, node, [bucket(siteId, { [foreign.id]: 1 })]);
    const [row] = await ctx.db
      .select()
      .from(schema.nodeMinuteStats)
      .where(eq(schema.nodeMinuteStats.siteId, siteId));
    expect(row?.loggedRules).toEqual({
      [scanner.id]: 6,
      [global.id]: 9,
      [deleted]: 1,
      [foreign.id]: 1,
    });

    const top = await admin.rules.topLogged({ id: siteId, range: "1h" });
    expect(top).toEqual({
      approximate: true,
      items: [
        { ruleId: global.id, name: "everything", platform: true, requests: 9 },
        { ruleId: scanner.id, name: "scanners", platform: false, requests: 6 },
        { ruleId: deleted, name: null, platform: false, requests: 1 },
        { ruleId: foreign.id, name: null, platform: false, requests: 1 },
      ],
      unsupportedNodes: 0,
    });
    expect((await admin.rules.topLogged({ id: siteId, range: "1h", limit: 1 })).items).toEqual([
      { ruleId: global.id, name: "everything", platform: true, requests: 9 },
    ]);
    expect((await admin.rules.topLogged({ id: otherSiteId })).items).toEqual([
      { ruleId: foreign.id, name: "foreign", platform: false, requests: 7 },
    ]);

    // Long ranges read the hourly rollups, before and after they are built.
    const week = await topLoggedRules(ctx.db, { id: siteId, range: "7d", limit: 1 });
    expect(week.items.map((item) => item.requests)).toEqual([9]);
    await rollupTraffic(ctx.db, new Date(minute.getTime() + 2 * 3600_000));
    const [hour] = await ctx.db
      .select()
      .from(schema.nodeHourStats)
      .where(eq(schema.nodeHourStats.siteId, siteId));
    expect(hour?.loggedRules).toMatchObject({ [scanner.id]: 6, [global.id]: 9 });
    expect((await topLoggedRules(ctx.db, { id: siteId, range: "30d", limit: 2 })).items).toEqual([
      { ruleId: global.id, name: "everything", platform: true, requests: 9 },
      { ruleId: scanner.id, name: "scanners", platform: false, requests: 6 },
    ]);
  });

  it("tells how many active nodes do not count them", async () => {
    await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-old", supportedFeatures: ["rules-v1"] });
    await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-gone", status: "disabled", supportedFeatures: [] });
    expect((await admin.rules.topLogged({ id: siteId })).unsupportedNodes).toBe(1);
  });
});
