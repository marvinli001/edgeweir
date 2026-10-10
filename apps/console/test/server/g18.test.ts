import "reflect-metadata";
import { decodeNodeConfig, IMAGE_CONVERT_FEATURE } from "@edgeweir/config-compiler";
import { IMAGE_CONVERT_DEFAULTS, type ImageConvertSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { updateImageConvert } from "../../src/server/services/image-convert";
import { latestRevision } from "../../src/server/services/revisions";
import { ingestStatsBatch, type ReportedMinuteStats } from "../../src/server/services/stats";
import { rollupTraffic } from "../../src/server/services/stats-rollup";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

const service = {
  type: "service_account" as const,
  id: "service-account-g18",
  name: "integration",
};
const FULL = ["tls-v1", "rules-v1", "access-logs-v1"];
const MINUTE = 60_000;
const HOUR = 3_600_000;

const ON: ImageConvertSettings = {
  ...IMAGE_CONVERT_DEFAULTS,
  enabled: true,
  avif: true,
  webpQuality: 75,
  avifQuality: 45,
  png: false,
  minSize: 2048,
  maxSize: 5_000_000,
  maxPixels: 8_000_000,
};

describe("WebP / AVIF conversion (G18)", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  let admin: ApiClient;
  let clusterId = "";
  let siteId = "";
  let otherSiteId = "";
  let nodeId = "";
  let node: { id: string; clusterId: string };
  const now = Date.now();

  const api = async (key: string, method: string, path: string, body?: unknown) => {
    const res = await app.request(`${origin}/api/v1${path}`, {
      method,
      headers: { "x-api-key": key, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: (text ? JSON.parse(text) : {}) as Record<string, unknown> };
  };
  const ir = async () => {
    const row = await latestRevision(ctx.db, clusterId);
    if (!row) throw new Error("no revision");
    return decodeNodeConfig(row.ir);
  };
  const siteIr = async (id = siteId) => (await ir()).sites.find((s) => s.id === id);
  const setNodeFeatures = (features: string[]) =>
    ctx.db
      .update(schema.node)
      .set({ supportedFeatures: features })
      .where(eq(schema.node.id, nodeId));

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    for (const name of ["photos", "docs"]) {
      const id = (
        await admin.sites.create({
          name,
          domains: [`${name}.g18.test`],
          origins: [{ address: "origin.example.com" }],
        })
      ).site.id;
      if (name === "photos") siteId = id;
      else otherSiteId = id;
    }
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-g18",
        lastSeenAt: new Date(),
        supportedFeatures: [...FULL, IMAGE_CONVERT_FEATURE],
      })
      .returning();
    if (!row) throw new Error("node missing");
    nodeId = row.id;
    node = { id: row.id, clusterId };
  });
  afterAll(() => pglite.close());

  describe("site settings (12.1)", () => {
    it("starts off with the defaults; nodes see nothing", async () => {
      expect(await admin.imageConvert.get({ id: siteId })).toEqual(IMAGE_CONVERT_DEFAULTS);
      expect(IMAGE_CONVERT_DEFAULTS).toMatchObject({
        enabled: false,
        webp: true,
        avif: false,
        webpQuality: 80,
        avifQuality: 50,
        jpeg: true,
        png: true,
      });
      expect((await ir()).requiredFeatures).not.toContain(IMAGE_CONVERT_FEATURE);
      expect((await siteIr())?.imageConvert).toBeUndefined();
    });

    it("saves, publishes with image-convert-v1 and audits what changed", async () => {
      const before = (await ir()).revision;
      expect(await admin.imageConvert.update({ id: siteId, ...ON })).toEqual(ON);
      expect(await admin.imageConvert.get({ id: siteId })).toEqual(ON);
      const config = await ir();
      expect(config.revision).toBeGreaterThan(before);
      expect(config.requiredFeatures).toContain(IMAGE_CONVERT_FEATURE);
      expect((await siteIr())?.imageConvert).toMatchObject({
        webp: true,
        avif: true,
        webpQuality: 75,
        avifQuality: 45,
        jpeg: true,
        png: false,
        minSize: 2048n,
        maxSize: 5_000_000n,
        maxPixels: 8_000_000n,
      });
      // The other site converts nothing.
      expect((await siteIr(otherSiteId))?.imageConvert).toBeUndefined();
      const [entry] = await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "site.image_convert_update"))
        .orderBy(desc(schema.auditLog.occurredAt))
        .limit(1);
      expect(entry?.targetId).toBe(siteId);
      expect(entry?.metadata).toMatchObject({
        enabled: true,
        changed: expect.arrayContaining([
          "enabled",
          "avif",
          "webpQuality",
          "avifQuality",
          "png",
          "minSize",
          "maxSize",
          "maxPixels",
        ]),
      });
      expect((entry?.metadata as { changed?: string[] } | undefined)?.changed).not.toContain(
        "webp",
      );
    });

    it("turns off without losing the settings; changes while off publish nothing", async () => {
      await admin.imageConvert.update({ id: siteId, ...ON, enabled: false });
      expect((await siteIr())?.imageConvert).toBeUndefined();
      expect((await ir()).requiredFeatures).not.toContain(IMAGE_CONVERT_FEATURE);
      const revision = (await ir()).revision;
      await admin.imageConvert.update({ id: siteId, ...ON, enabled: false, webpQuality: 60 });
      expect((await ir()).revision).toBe(revision);
      expect(await admin.imageConvert.get({ id: siteId })).toEqual({
        ...ON,
        enabled: false,
        webpQuality: 60,
      });
      await admin.imageConvert.update({ id: siteId, ...ON });
      expect((await siteIr())?.imageConvert?.webpQuality).toBe(75);
    });

    it("rejects settings outside the bounds, also while off", async () => {
      for (const bad of [
        { webp: false, avif: false },
        { jpeg: false, png: false },
        { minSize: 10, maxSize: 9 },
        { webpQuality: 0 },
        { avifQuality: 101 },
        { maxSize: 64 * 1024 * 1024 + 1 },
        { maxSize: 0 },
        { minSize: -1 },
        { maxPixels: 0 },
        { maxPixels: 50_000_001 },
        { enabled: false, webp: false, avif: false },
      ]) {
        const error = await rpcError(admin.imageConvert.update({ id: siteId, ...ON, ...bad }));
        expect(error.status, JSON.stringify(bad)).toBe(400);
      }
      expect(await admin.imageConvert.get({ id: siteId })).toEqual(ON);
      // The largest values are accepted.
      await admin.imageConvert.update({
        id: siteId,
        ...ON,
        maxSize: 64 * 1024 * 1024,
        maxPixels: 50_000_000,
        minSize: 0,
      });
      await admin.imageConvert.update({ id: siteId, ...ON });
      expect((await rpcError(admin.imageConvert.get({ id: crypto.randomUUID() }))).status).toBe(
        404,
      );
    });
  });

  describe("node capability (12.4)", () => {
    it("is unavailable while a node lacks image-convert-v1; background publishes are held", async () => {
      expect((await admin.sites.features({ id: siteId })).imageConvert).toEqual({
        available: true,
        reason: null,
      });
      await admin.imageConvert.update({ id: siteId, ...ON, enabled: false });
      await setNodeFeatures(FULL);
      expect((await admin.sites.features({ id: siteId })).imageConvert).toEqual({
        available: false,
        reason: "nodes",
      });
      const before = (await ir()).revision;
      const error = await updateImageConvert(
        ctx.db,
        { id: siteId, ...ON },
        { actor: service },
      ).catch((e) => e);
      expect(error?.code ?? error?.data?.code ?? String(error)).toContain(
        "NODE_CAPABILITY_REQUIRED",
      );
      expect((await ir()).revision).toBe(before);
      expect((await admin.imageConvert.get({ id: siteId })).enabled).toBe(false);
      // The operator may require it; the cluster holds the revision until its nodes are upgraded.
      await admin.imageConvert.update({ id: siteId, ...ON });
      expect((await siteIr())?.imageConvert).toBeDefined();
      await setNodeFeatures([...FULL, IMAGE_CONVERT_FEATURE]);
    });
  });

  describe("saved bytes (12.4)", () => {
    let sequence = 0n;
    const report = (buckets: ReportedMinuteStats[]) => {
      sequence += 1n;
      return ingestStatsBatch(ctx.db, node, sequence, buckets, now);
    };
    const bucket = (minute: Date, extra: Partial<ReportedMinuteStats>): ReportedMinuteStats => ({
      minute,
      siteId,
      requests: 10,
      bytesSent: 1000,
      bytesReceived: 100,
      cacheHits: 5,
      cacheMisses: 5,
      statusCodes: { "200": 10 },
      ...extra,
    });

    it("sums what nodes report per site and range, rolled up or not", async () => {
      expect(await admin.imageConvert.savings({ id: siteId, range: "24h" })).toEqual({
        bytesSaved: 0,
        unsupportedNodes: 0,
      });
      const recent = new Date(Math.floor(now / MINUTE) * MINUTE - 2 * MINUTE);
      const earlier = new Date(Math.floor(now / HOUR) * HOUR - 5 * HOUR);
      await report([
        bucket(recent, { imageBytesSaved: 1_000_000 }),
        bucket(recent, { imageBytesSaved: 234 }),
        bucket(earlier, { imageBytesSaved: 5_000 }),
        bucket(recent, { siteId: otherSiteId, imageBytesSaved: 777 }),
        bucket(recent, {}),
      ]);
      expect((await admin.imageConvert.savings({ id: siteId, range: "1h" })).bytesSaved).toBe(
        1_000_234,
      );
      expect((await admin.imageConvert.savings({ id: siteId, range: "24h" })).bytesSaved).toBe(
        1_005_234,
      );
      expect((await admin.imageConvert.savings({ id: otherSiteId, range: "24h" })).bytesSaved).toBe(
        777,
      );
      // Hourly rollups carry the counter (ranges over a day read them).
      await rollupTraffic(ctx.db, new Date(now + 2 * HOUR));
      const [hour] = await ctx.db
        .select({ saved: schema.nodeHourStats.imageBytesSaved })
        .from(schema.nodeHourStats)
        .where(eq(schema.nodeHourStats.siteId, siteId))
        .orderBy(desc(schema.nodeHourStats.minute))
        .limit(1);
      expect(hour?.saved).toBe(1_000_234);
      expect((await admin.imageConvert.savings({ id: siteId, range: "7d" })).bytesSaved).toBe(
        1_005_234,
      );
      // Negative or unsafe counters drop the bucket.
      await report([bucket(recent, { imageBytesSaved: -5 })]);
      expect((await admin.imageConvert.savings({ id: siteId, range: "1h" })).bytesSaved).toBe(
        1_000_234,
      );
    });

    it("counts the cluster's nodes that do not convert", async () => {
      await setNodeFeatures(FULL);
      expect((await admin.imageConvert.savings({ id: siteId })).unsupportedNodes).toBe(1);
      await setNodeFeatures([...FULL, IMAGE_CONVERT_FEATURE]);
      expect((await admin.imageConvert.savings({ id: siteId })).unsupportedNodes).toBe(0);
    });
  });

  describe("copying settings and cloning (G17)", () => {
    it("copies the part and nothing else; a clone converts like its source", async () => {
      const target = otherSiteId;
      expect((await admin.imageConvert.get({ id: target })).enabled).toBe(false);
      const preview = await admin.sites.copySettingsPreview({
        id: siteId,
        targetIds: [target],
        parts: ["imageConvert"],
      });
      expect(preview.targets[0]?.changes[0]).toMatchObject({ part: "imageConvert", changed: true });
      const result = await admin.sites.copySettings({
        id: siteId,
        targetIds: [target],
        parts: ["imageConvert"],
      });
      expect(result.targets[0]?.ok).toBe(true);
      expect(await admin.imageConvert.get({ id: target })).toEqual(
        await admin.imageConvert.get({ id: siteId }),
      );
      expect((await siteIr(target))?.imageConvert).toBeDefined();
      const clone = await admin.sites.clone({
        id: siteId,
        name: "photos-copy",
        domains: ["copy.g18.test"],
      });
      expect(await admin.imageConvert.get({ id: clone.site.id })).toEqual(
        await admin.imageConvert.get({ id: siteId }),
      );
    });
  });

  it("keeps the 403 matrix: read-only AccessKeys cannot write, service accounts get nothing", async () => {
    const reader = (await admin.accessKeys.create({ name: "g18-ro", scope: "read" })).key;
    const account = await admin.serviceAccounts.create({
      name: "g18-integration",
      scopes: ["clusters:read", "system:read", "sites:read", "sites:write", "usage:read"],
    });
    const key = (await admin.serviceAccounts.createKey({ id: account.id })).secret;
    for (const path of [
      `/sites/${siteId}/image-convert`,
      `/sites/${siteId}/image-convert/savings?range=24h`,
    ]) {
      expect((await api(reader, "GET", path)).status, path).toBe(200);
      const refused = await api(key, "GET", path);
      expect([refused.status, refused.json.code], path).toEqual([403, "SERVICE_ACCOUNT_FORBIDDEN"]);
    }
    const body = { ...ON, enabled: false };
    const readOnly = await api(reader, "PUT", `/sites/${siteId}/image-convert`, body);
    expect([readOnly.status, readOnly.json.code]).toEqual([403, "ACCESS_KEY_READ_ONLY"]);
    const refused = await api(key, "PUT", `/sites/${siteId}/image-convert`, body);
    expect([refused.status, refused.json.code]).toEqual([403, "SERVICE_ACCOUNT_FORBIDDEN"]);
    // Nothing changed.
    expect((await admin.imageConvert.get({ id: siteId })).enabled).toBe(true);
    // A writing AccessKey may.
    const writer = (await admin.accessKeys.create({ name: "g18-rw", scope: "write" })).key;
    const saved = await api(writer, "PUT", `/sites/${siteId}/image-convert`, ON);
    expect(saved.status).toBe(200);
    expect(saved.json).toEqual(ON);
    const invalid = await api(writer, "PUT", `/sites/${siteId}/image-convert`, {
      ...ON,
      jpeg: false,
      png: false,
    });
    expect(invalid.status).toBe(400);
  });
});
