import { create } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { decodeNodeConfig } from "@edgeweir/config-compiler";
import { tlsSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { AccessLogSchema } from "@edgeweir/proto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { ingestLogs, logsCsv, queryLogs } from "../../src/server/services/access-logs";
import { updateHttps } from "../../src/server/services/certificates";
import { latestRevision } from "../../src/server/services/revisions";
import { ingestMinuteStats } from "../../src/server/services/stats";
import { rollupTraffic } from "../../src/server/services/stats-rollup";
import { topWafRules, updateSiteWaf } from "../../src/server/services/waf";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const ALL_FEATURES = [
  "rules-v1",
  "tls-v1",
  "access-logs-v1",
  "brotli-v1",
  "zstd-v1",
  "modsecurity-v1",
];

/** A change without the operator behind it (service accounts, background jobs). */
const service = {
  actor: { type: "service_account" as const, id: "service-account-waf", name: "integration" },
};

describe("Brotli, Zstandard and OWASP CRS on the console side", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let otherSiteId: string;
  let nodeId: string;
  const origins = [{ address: "origin.test" }];
  const api = (key: string, method: string, path: string, body?: unknown) =>
    app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());
  const siteOf = async (id = siteId) => (await config()).sites.find((site) => site.id === id);
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));
  const audits = (action: string) =>
    ctx.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, action));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (await admin.sites.create({ name: "store", domains: ["store.guard.test"], origins }))
      .site.id;
    otherSiteId = (
      await admin.sites.create({ name: "apart", domains: ["www.apart.test"], origins })
    ).site.id;
    // An active node with every G3 feature; tests take features away from it.
    const [node] = await ctx.db
      .insert(schema.node)
      .values({ clusterId, name: "edge-g3", supportedFeatures: ALL_FEATURES })
      .returning();
    if (!node) throw new Error("node missing");
    nodeId = node.id;
  });
  afterAll(() => pglite.close());

  it("reads CRS off with the defaults and every feature available", async () => {
    expect(await admin.waf.get({ id: siteId })).toEqual({
      siteId,
      mode: "off",
      paranoiaLevel: 1,
      anomalyThreshold: 5,
      excludedRuleIds: [],
      requestBodyLimit: 131072,
      updatedAt: null,
    });
    const available = { available: true, reason: null };
    expect(await admin.sites.features({ id: siteId })).toEqual({
      brotli: available,
      zstd: available,
      crs: available,
    });
    const https = await admin.https.get({ id: siteId });
    expect(https).toMatchObject({ brotli: false, brotliLevel: 6, zstd: false, zstdLevel: 3 });
    const current = await config();
    expect(current.sites.every((site) => !site.waf)).toBe(true);
    expect(current.requiredFeatures).not.toContain("modsecurity-v1");
  });

  it("lets read-only AccessKeys read CRS but not change it", async () => {
    const reader = await admin.accessKeys.create({ name: "waf-read", scope: "read" });
    for (const path of [
      `/sites/${siteId}/waf`,
      `/sites/${siteId}/waf/rules?range=1h`,
      `/sites/${siteId}/features`,
    ])
      expect((await api(reader.key, "GET", path)).status, path).toBe(200);
    for (const [method, path, body] of [
      ["PATCH", `/sites/${siteId}/waf`, { mode: "block" }],
      ["PUT", `/sites/${siteId}/https`, { settings: { brotli: true } }],
    ] as const) {
      const res = await api(reader.key, method, path, body);
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ code: "ACCESS_KEY_READ_ONLY" });
    }
    expect((await admin.waf.get({ id: siteId })).mode).toBe("off");
  });

  it("turns CRS on through /api/v1, publishes Site.waf with modsecurity-v1 and audits it", async () => {
    const before = (await config()).revision;
    const writer = await admin.accessKeys.create({ name: "waf-write", scope: "write" });
    const res = await api(writer.key, "PATCH", `/sites/${siteId}/waf`, {
      mode: "block",
      paranoiaLevel: 2,
      anomalyThreshold: 10,
      excludedRuleIds: [942100, 920350],
      requestBodyLimit: 65536,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      siteId,
      mode: "block",
      paranoiaLevel: 2,
      anomalyThreshold: 10,
      excludedRuleIds: [920350, 942100],
      requestBodyLimit: 65536,
    });
    const current = await config();
    expect(current.revision).toBeGreaterThan(before);
    expect(await latestRevision(ctx.db, clusterId)).toMatchObject({
      reasonCode: "site_waf_updated",
      reasonParams: { site: "store" },
    });
    expect(current.requiredFeatures).toContain("modsecurity-v1");
    expect((await siteOf())?.waf).toMatchObject({
      mode: "block",
      paranoiaLevel: 2,
      anomalyThreshold: 10,
      excludedRuleIds: [920350, 942100],
      requestBodyLimit: 65536,
    });
    expect((await siteOf(otherSiteId))?.waf).toBeUndefined();
    const [audit] = await audits("site.waf_update");
    expect(audit).toMatchObject({ targetId: siteId, actorType: "api_key" });
    expect(audit?.metadata).toMatchObject({
      from: { mode: "off", paranoiaLevel: 1 },
      to: { mode: "block", paranoiaLevel: 2, excludedRuleIds: [920350, 942100] },
    });
    // Fields not given keep their values; duplicate or non-CRS ids are refused.
    const detect = await admin.waf.update({ id: siteId, mode: "detect" });
    expect(detect).toMatchObject({ mode: "detect", paranoiaLevel: 2, anomalyThreshold: 10 });
    expect((await siteOf())?.waf?.mode).toBe("detect");
    for (const input of [
      { excludedRuleIds: [942100, 942100] },
      { excludedRuleIds: [123] },
      { paranoiaLevel: 5 },
      { anomalyThreshold: 0 },
      { requestBodyLimit: 134_217_729 },
    ])
      expect((await rpcError(admin.waf.update({ id: siteId, ...input }))).status).toBe(400);
    // Off: the site no longer carries CRS and the cluster no longer needs the module.
    await admin.waf.update({ id: siteId, mode: "off" });
    expect((await siteOf())?.waf).toBeUndefined();
    expect((await config()).requiredFeatures).not.toContain("modsecurity-v1");
    // Changing settings while off publishes nothing new.
    const idle = (await config()).revision;
    await admin.waf.update({ id: siteId, paranoiaLevel: 3 });
    expect((await config()).revision).toBe(idle);
  });

  it("compiles Brotli and Zstandard from the HTTPS settings and requires their features", async () => {
    const settings = tlsSettings.parse({
      brotli: true,
      brotliLevel: 9,
      brotliMinLength: 512,
      brotliTypes: ["text/html", "application/json"],
      zstd: true,
      zstdLevel: 5,
      zstdMinLength: 1024,
      zstdTypes: ["text/css"],
    });
    const saved = await admin.https.update({ id: siteId, settings });
    expect(saved).toMatchObject({ brotli: true, brotliLevel: 9, zstd: true, zstdLevel: 5 });
    expect(await admin.https.get({ id: siteId })).toMatchObject({
      brotli: true,
      brotliLevel: 9,
      brotliMinLength: 512,
      zstd: true,
      zstdMinLength: 1024,
      zstdTypes: ["text/css"],
    });
    expect((await siteOf())?.tls).toMatchObject({
      brotli: true,
      brotliLevel: 9,
      brotliMinLength: 512,
      brotliTypes: ["application/json", "text/html"],
      zstd: true,
      zstdLevel: 5,
      zstdMinLength: 1024,
      zstdTypes: ["text/css"],
      gzip: true,
    });
    expect((await config()).requiredFeatures).toEqual(
      expect.arrayContaining(["brotli-v1", "zstd-v1", "tls-v1"]),
    );
    await admin.https.update({ id: siteId, settings: tlsSettings.parse({}) });
    expect((await siteOf())?.tls).toMatchObject({ brotli: false, brotliTypes: [], zstd: false });
    expect((await config()).requiredFeatures).not.toContain("brotli-v1");
    expect((await config()).requiredFeatures).not.toContain("zstd-v1");
  });

  it("holds a module the cluster's active nodes lack for changes without the operator; the operator may require it", async () => {
    await setNodeFeatures(["rules-v1", "tls-v1"]);
    const unavailable = { available: false, reason: "nodes" };
    expect(await admin.sites.features({ id: siteId })).toEqual({
      brotli: unavailable,
      zstd: unavailable,
      crs: unavailable,
    });
    const before = (await config()).revision;
    for (const [call, feature] of [
      [() => updateHttps(ctx, siteId, tlsSettings.parse({ brotli: true }), service), "brotli-v1"],
      [() => updateHttps(ctx, siteId, tlsSettings.parse({ zstd: true }), service), "zstd-v1"],
      [() => updateSiteWaf(ctx.db, { id: siteId, mode: "detect" }, service), "modsecurity-v1"],
    ] as const)
      await expect(call()).rejects.toMatchObject({
        code: "NODE_CAPABILITY_REQUIRED",
        status: 409,
        data: { features: feature },
      });
    expect((await config()).revision).toBe(before);
    expect((await admin.waf.get({ id: siteId })).mode).toBe("off");
    expect((await admin.https.get({ id: siteId })).brotli).toBe(false);
    // A disabled node does not count.
    await ctx.db.update(schema.node).set({ status: "disabled" }).where(eq(schema.node.id, nodeId));
    expect((await admin.sites.features({ id: siteId })).brotli.available).toBe(true);
    await ctx.db.update(schema.node).set({ status: "active" }).where(eq(schema.node.id, nodeId));
    // The operator may deliberately require the upgrade.
    await admin.waf.update({ id: siteId, mode: "detect" });
    await admin.https.update({ id: siteId, settings: tlsSettings.parse({ brotli: true }) });
    expect((await config()).requiredFeatures).toEqual(
      expect.arrayContaining(["modsecurity-v1", "brotli-v1"]),
    );
    await admin.waf.update({ id: siteId, mode: "off" });
    await admin.https.update({ id: siteId, settings: tlsSettings.parse({}) });
    await setNodeFeatures(ALL_FEATURES);
    expect((await admin.sites.features({ id: siteId })).crs.available).toBe(true);
  });

  it("rolls CRS back with its site and drops the module when the site no longer ships", async () => {
    await admin.waf.update({ id: siteId, mode: "block" });
    const withCrs = (await config()).revision;
    await admin.waf.update({ id: siteId, mode: "off" });
    await admin.clusters.rollback({ id: clusterId, revision: Number(withCrs) });
    expect((await siteOf())?.waf?.mode).toBe("block");
    expect((await config()).requiredFeatures).toContain("modsecurity-v1");
    await admin.sites.setEnabled({ id: siteId, enabled: false });
    await admin.clusters.rollback({ id: clusterId, revision: Number(withCrs) });
    expect(await siteOf()).toBeUndefined();
    expect((await config()).requiredFeatures).not.toContain("modsecurity-v1");
    await admin.sites.setEnabled({ id: siteId, enabled: true });
    expect((await siteOf())?.waf).toBeUndefined();
  });

  it("ingests WAF rule hits per minute (bounded, rule ids only) and ranks them per site", async () => {
    const now = Date.now();
    const minute = new Date(Math.floor(now / 60_000) * 60_000 - 60_000);
    const node = { id: nodeId, clusterId };
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [String(930000 + i), 1]));
    const bucket = (site: string, wafRules: Record<string, number>) => ({
      minute,
      siteId: site,
      requests: 10,
      bytesSent: 0,
      bytesReceived: 0,
      cacheHits: 0,
      cacheMisses: 0,
      statusCodes: {},
      wafRules,
    });
    await ingestMinuteStats(ctx.db, node, [
      bucket(siteId, {
        "942100": 5,
        "920350": 2,
        "../x": 9,
        "0": 3,
        "4294967296": 1,
        "941100": -1,
      }),
      bucket(siteId, { "942100": 1, "913100": 4 }),
      bucket(otherSiteId, { "949110": 7 }),
    ]);
    await ingestMinuteStats(ctx.db, node, [bucket(siteId, { "920350": 3, ...many })]);
    const [row] = await ctx.db
      .select()
      .from(schema.nodeMinuteStats)
      .where(eq(schema.nodeMinuteStats.siteId, siteId));
    expect(Object.keys(row?.wafRules ?? {})).toHaveLength(50);
    expect(row?.wafRules).toMatchObject({ "942100": 6, "920350": 5, "913100": 4 });
    expect(row?.wafRules).not.toHaveProperty("../x");
    expect(row?.wafRules).not.toHaveProperty("0");

    const top = await admin.waf.topRules({ id: siteId, range: "1h", limit: 3 });
    expect(top).toEqual({
      approximate: true,
      items: [
        { ruleId: 942100, requests: 6 },
        { ruleId: 920350, requests: 5 },
        { ruleId: 913100, requests: 4 },
      ],
    });
    // Another site's rules never show up.
    expect((await admin.waf.topRules({ id: siteId })).items.map((i) => i.ruleId)).not.toContain(
      949110,
    );
    expect((await admin.waf.topRules({ id: otherSiteId })).items).toEqual([
      { ruleId: 949110, requests: 7 },
    ]);
    // Long ranges read the hourly rollups, before and after they are built.
    const week = await topWafRules(ctx.db, { id: siteId, range: "7d", limit: 2 });
    expect(week.items).toEqual([
      { ruleId: 942100, requests: 6 },
      { ruleId: 920350, requests: 5 },
    ]);
    await rollupTraffic(ctx.db, new Date(minute.getTime() + 2 * 3600_000));
    const [hour] = await ctx.db
      .select()
      .from(schema.nodeHourStats)
      .where(eq(schema.nodeHourStats.siteId, siteId));
    expect(hour?.wafRules).toMatchObject({ "942100": 6, "920350": 5 });
    expect((await topWafRules(ctx.db, { id: siteId, range: "30d", limit: 1 })).items).toEqual([
      { ruleId: 942100, requests: 6 },
    ]);
  });

  it("keeps the rules a request matched and whether CRS blocked it in access logs and CSV", async () => {
    await admin.logs.configure({ siteId, sampleRate: 10000 });
    const now = Date.now();
    const entry = (wafRuleIds: number[], wafBlocked: boolean) =>
      create(AccessLogSchema, {
        siteId,
        time: timestampFromDate(new Date(now)),
        clientIp: "198.51.100.7",
        method: "POST",
        host: "store.guard.test",
        path: "/login",
        status: wafBlocked ? 403 : 200,
        bytesSent: 10n,
        durationMs: 1,
        sampleRate: 10000,
        cacheStatus: "BYPASS",
        wafRuleIds,
        wafBlocked,
      });
    const ids = [949110, 942100, 942100, 0, ...Array.from({ length: 20 }, (_, i) => 920000 + i)];
    expect(
      await ingestLogs(
        ctx,
        { id: nodeId, clusterId },
        1n,
        [entry(ids, true), entry([], false)],
        now,
      ),
    ).toBe(2);
    const { entries } = await queryLogs(ctx, {
      siteId,
      from: new Date(now - 60_000).toISOString(),
      to: new Date(now + 60_000).toISOString(),
      ip: "",
      path: "",
      limit: 10,
    });
    const blocked = entries.find((e) => e.wafBlocked);
    expect(blocked?.wafRuleIds).toHaveLength(16);
    expect(blocked?.wafRuleIds.slice(0, 3)).toEqual([920000, 920001, 920002]);
    expect(blocked?.wafRuleIds).not.toContain(0);
    expect(entries.find((e) => !e.wafBlocked)).toMatchObject({ wafRuleIds: [], wafBlocked: false });
    const csv = logsCsv(entries).split("\r\n");
    expect(csv[0]).toMatch(/,ja4,wafRuleIds,wafBlocked$/);
    expect(
      csv.some((line) => line.includes('"920000 920001 920002') && line.endsWith('"true"')),
    ).toBe(true);
    const res = await admin.logs.export({
      siteId,
      from: new Date(now - 60_000).toISOString(),
      to: new Date(now + 60_000).toISOString(),
      ip: "",
      path: "",
      limit: 10,
    });
    expect(res.csv).toContain("wafRuleIds");
  });
});
