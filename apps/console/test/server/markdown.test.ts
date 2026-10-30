import "reflect-metadata";
import { decodeNodeConfig, MARKDOWN_FEATURE } from "@edgeweir/config-compiler";
import { MARKDOWN_DEFAULTS, type MarkdownSettings } from "@edgeweir/contract";
import { schema } from "@edgeweir/db";
import { desc, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { updateMarkdown } from "../../src/server/services/markdown";
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
  id: "service-account-markdown",
  name: "integration",
};
const FULL = ["tls-v1", "rules-v1", "access-logs-v1"];
const MINUTE = 60_000;
const HOUR = 3_600_000;

const ON: MarkdownSettings = {
  enabled: true,
  includePrefixes: ["/blog/", "/docs/"],
  excludePrefixes: ["/docs/private/"],
};

describe("Markdown for Agents", async () => {
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
    for (const name of ["docs", "shop"]) {
      const id = (
        await admin.sites.create({
          name,
          domains: [`${name}.md.test`],
          origins: [{ address: "origin.example.com" }],
        })
      ).site.id;
      if (name === "docs") siteId = id;
      else otherSiteId = id;
    }
    const [row] = await ctx.db
      .insert(schema.node)
      .values({
        clusterId,
        name: "edge-md",
        lastSeenAt: new Date(),
        supportedFeatures: [...FULL, MARKDOWN_FEATURE],
      })
      .returning();
    if (!row) throw new Error("node missing");
    nodeId = row.id;
    node = { id: row.id, clusterId };
  });
  afterAll(() => pglite.close());

  describe("site settings", () => {
    it("starts off on every path; nodes see nothing", async () => {
      expect(await admin.markdown.get({ id: siteId })).toEqual(MARKDOWN_DEFAULTS);
      expect(MARKDOWN_DEFAULTS).toEqual({ enabled: false, includePrefixes: [], excludePrefixes: [] });
      expect((await ir()).requiredFeatures).not.toContain(MARKDOWN_FEATURE);
      expect((await siteIr())?.markdown).toBeUndefined();
    });

    it("saves sorted and unique prefixes, publishes with markdown-v1 and audits what changed", async () => {
      const before = (await ir()).revision;
      const saved = await admin.markdown.update({
        id: siteId,
        enabled: true,
        includePrefixes: ["/docs/", "/blog/", "/docs/"],
        excludePrefixes: ["/docs/private/"],
      });
      expect(saved).toEqual(ON);
      expect(await admin.markdown.get({ id: siteId })).toEqual(ON);
      const config = await ir();
      expect(config.revision).toBeGreaterThan(before);
      expect(config.requiredFeatures).toContain(MARKDOWN_FEATURE);
      expect((await siteIr())?.markdown).toMatchObject({
        includePrefixes: ["/blog/", "/docs/"],
        excludePrefixes: ["/docs/private/"],
      });
      expect((await siteIr(otherSiteId))?.markdown).toBeUndefined();
      const [entry] = await ctx.db
        .select()
        .from(schema.auditLog)
        .where(eq(schema.auditLog.action, "site.markdown_update"))
        .orderBy(desc(schema.auditLog.occurredAt))
        .limit(1);
      expect(entry?.targetId).toBe(siteId);
      expect(entry?.metadata).toEqual({
        enabled: true,
        changed: ["enabled", "includePrefixes", "excludePrefixes"],
      });
    });

    it("every path: an empty include list still sends the message", async () => {
      await admin.markdown.update({ id: siteId, enabled: true, includePrefixes: [], excludePrefixes: [] });
      const md = (await siteIr())?.markdown;
      expect(md).toBeDefined();
      expect(md?.includePrefixes).toEqual([]);
      await admin.markdown.update({ id: siteId, ...ON });
    });

    it("turns off without losing the prefixes; changes while off publish nothing", async () => {
      await admin.markdown.update({ id: siteId, ...ON, enabled: false });
      expect((await siteIr())?.markdown).toBeUndefined();
      expect((await ir()).requiredFeatures).not.toContain(MARKDOWN_FEATURE);
      const revision = (await ir()).revision;
      await admin.markdown.update({ id: siteId, ...ON, enabled: false, excludePrefixes: [] });
      expect((await ir()).revision).toBe(revision);
      expect(await admin.markdown.get({ id: siteId })).toEqual({
        ...ON,
        enabled: false,
        excludePrefixes: [],
      });
      await admin.markdown.update({ id: siteId, ...ON });
    });

    it("rejects invalid prefixes", async () => {
      for (const bad of [
        { includePrefixes: ["docs/"] },
        { includePrefixes: ["/a b"] },
        { excludePrefixes: ["/文档"] },
        { includePrefixes: [`/${"a".repeat(256)}`] },
        { includePrefixes: Array.from({ length: 33 }, (_, i) => `/p${i}`) },
      ]) {
        const error = await rpcError(admin.markdown.update({ id: siteId, ...ON, ...bad }));
        expect(error.status, JSON.stringify(bad)).toBe(400);
      }
      expect(await admin.markdown.get({ id: siteId })).toEqual(ON);
      expect((await rpcError(admin.markdown.get({ id: crypto.randomUUID() }))).status).toBe(404);
    });

    it("is served under /api/v1 too", async () => {
      const key = (await admin.accessKeys.create({ name: "md", scope: "read" })).key;
      const res = await app.request(`${origin}/api/v1/sites/${siteId}/markdown`, {
        headers: { "x-api-key": key },
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(ON);
    });
  });

  describe("node capability", () => {
    it("is unavailable while a node lacks markdown-v1; background changes are refused", async () => {
      expect((await admin.sites.features({ id: siteId })).markdown).toEqual({
        available: true,
        reason: null,
      });
      await admin.markdown.update({ id: siteId, ...ON, enabled: false });
      await setNodeFeatures(FULL);
      expect((await admin.sites.features({ id: siteId })).markdown).toEqual({
        available: false,
        reason: "nodes",
      });
      const before = (await ir()).revision;
      const error = await updateMarkdown(ctx.db, { id: siteId, ...ON }, { actor: service }).catch(
        (e) => e,
      );
      expect(error?.code ?? error?.data?.code ?? String(error)).toContain(
        "NODE_CAPABILITY_REQUIRED",
      );
      expect((await ir()).revision).toBe(before);
      expect((await admin.markdown.get({ id: siteId })).enabled).toBe(false);
      await setNodeFeatures([...FULL, MARKDOWN_FEATURE]);
      await admin.markdown.update({ id: siteId, ...ON });
    });
  });

  describe("Markdown responses", () => {
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
      expect(await admin.markdown.stats({ id: siteId, range: "24h" })).toEqual({
        responses: 0,
        unsupportedNodes: 0,
      });
      const recent = new Date(Math.floor(now / MINUTE) * MINUTE - 2 * MINUTE);
      const earlier = new Date(Math.floor(now / HOUR) * HOUR - 5 * HOUR);
      await report([
        bucket(recent, { markdownResponses: 7 }),
        bucket(recent, { markdownResponses: 3 }),
        bucket(earlier, { markdownResponses: 40 }),
        bucket(recent, { siteId: otherSiteId, markdownResponses: 9 }),
        bucket(recent, {}),
      ]);
      expect((await admin.markdown.stats({ id: siteId, range: "1h" })).responses).toBe(10);
      expect((await admin.markdown.stats({ id: siteId, range: "24h" })).responses).toBe(50);
      expect((await admin.markdown.stats({ id: otherSiteId, range: "24h" })).responses).toBe(9);
      await rollupTraffic(ctx.db, new Date(now + 2 * HOUR));
      const [hour] = await ctx.db
        .select({ responses: schema.nodeHourStats.markdownResponses })
        .from(schema.nodeHourStats)
        .where(eq(schema.nodeHourStats.siteId, siteId))
        .orderBy(desc(schema.nodeHourStats.minute))
        .limit(1);
      expect(hour?.responses).toBe(10);
      expect((await admin.markdown.stats({ id: siteId, range: "7d" })).responses).toBe(50);
      await report([bucket(recent, { markdownResponses: -1 })]);
      expect((await admin.markdown.stats({ id: siteId, range: "1h" })).responses).toBe(10);
    });

    it("counts the cluster's nodes that do not convert", async () => {
      await setNodeFeatures(FULL);
      expect((await admin.markdown.stats({ id: siteId })).unsupportedNodes).toBe(1);
      await setNodeFeatures([...FULL, MARKDOWN_FEATURE]);
      expect((await admin.markdown.stats({ id: siteId })).unsupportedNodes).toBe(0);
    });
  });

  describe("copying settings", () => {
    it("copies the part", async () => {
      const result = await admin.sites.copySettings({
        id: siteId,
        targetIds: [otherSiteId],
        parts: ["markdown"],
      });
      expect(result.targets[0]?.ok).toBe(true);
      expect(await admin.markdown.get({ id: otherSiteId })).toEqual(ON);
      expect((await siteIr(otherSiteId))?.markdown).toBeDefined();
    });
  });
});
