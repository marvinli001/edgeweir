import { AI_CRAWLERS_FEATURE, decodeNodeConfig } from "@edgeweir/config-compiler";
import { AI_CRAWL_SITE_DEFAULTS, aiCrawlerCidrs } from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../../src/server/app";
import { aiCrawlOverview } from "../../src/server/services/ai-crawl";
import { latestRevision } from "../../src/server/services/revisions";
import { cleanDimensions } from "../../src/server/services/stats-dims";
import {
  type ApiClient,
  createTestContext,
  rpcClient,
  rpcError,
  setupPlatform,
  signIn,
} from "./helpers";

// Far from the real clock, like the analytics tests.
const NOW = Date.UTC(2020, 0, 15, 12, 34, 56);
const at = (hh: number, mm: number) => new Date(Date.UTC(2020, 0, 15, hh, mm));

async function addCrawlerStats(
  db: Database,
  row: {
    minute: Date;
    nodeId: string;
    siteId: string;
    stats: Record<string, number>;
    paths?: Record<string, number>;
  },
) {
  const requests = Object.entries(row.stats)
    .filter(([k]) => k.endsWith(":n"))
    .reduce((s, [, n]) => s + n, 0);
  await db.insert(schema.nodeMinuteStats).values({
    minute: row.minute,
    nodeId: row.nodeId,
    siteId: row.siteId,
    requests,
    bytesSent: 0,
    cacheHits: 0,
    cacheMisses: 0,
    statusCodes: {},
    crawlerStats: row.stats,
    crawlerPaths: row.paths ?? {},
  });
}

describe("AI crawl control", async () => {
  const { ctx, client: pglite } = await createTestContext();
  const app = createApp(ctx);
  const origin = ctx.env.EDGEWEIR_PUBLIC_URL;
  const origins = [{ address: "origin.test" }];
  let admin: ApiClient;
  let clusterId: string;
  let siteId: string;
  let nodeId: string;
  const config = async () =>
    decodeNodeConfig((await latestRevision(ctx.db, clusterId))?.ir ?? new Uint8Array());

  beforeAll(async () => {
    await setupPlatform(ctx);
    admin = rpcClient(app, origin, await signIn(app, origin, "admin@example.com"));
    clusterId = (await admin.clusters.list())[0]?.id ?? "";
    siteId = (await admin.sites.create({ name: "docs", domains: ["docs.crawl.test"], origins }))
      .site.id;
    nodeId =
      (await ctx.db.insert(schema.node).values({ clusterId, name: "edge-a" }).returning())[0]?.id ??
      "";
  });
  afterAll(() => pglite.close());

  it("lists the catalogue with how each crawler verifies", async () => {
    const catalogue = await admin.aiCrawl.catalogue();
    const gpt = catalogue.crawlers.find((c) => c.id === "gptbot");
    expect(gpt?.cidrs).toBe(aiCrawlerCidrs("gptbot").length);
    expect(gpt?.detectable).toBe(true);
    expect(catalogue.crawlers.find((c) => c.id === "google-extended")?.detectable).toBe(false);
    expect(catalogue.operators.some((o) => o.id === "anthropic")).toBe(true);
  });

  it("sends the catalogue with detection on, without requiring a feature", async () => {
    const settings = await admin.aiCrawl.settings();
    expect(settings.detection).toBe(true);
    await admin.aiCrawl.setSettings({ ...settings, operators: { bytedance: "block" } });
    const c = await config();
    expect(c.aiCrawlers?.crawlers.map((x) => x.id)).toContain("gptbot");
    expect(c.aiCrawlers?.crawlers.map((x) => x.id)).not.toContain("google-extended");
    // The global block applies to every site: the site's policy carries it.
    const site = c.sites.find((s) => s.id === siteId);
    expect(site?.aiCrawl?.actions.map((a) => [a.crawler, a.action])).toEqual([
      ["bytespider", "block"],
    ]);
    expect(c.requiredFeatures).toContain(AI_CRAWLERS_FEATURE);
    await admin.aiCrawl.setSettings({ ...settings, operators: {} });
    const off = await config();
    expect(off.sites.find((s) => s.id === siteId)?.aiCrawl).toBeUndefined();
    expect(off.requiredFeatures).not.toContain(AI_CRAWLERS_FEATURE);
    expect(off.aiCrawlers?.crawlers.length).toBeGreaterThan(0);
  });

  it("updates a site: actions, robots.txt, pay per crawl, with optimistic concurrency", async () => {
    const before = await admin.aiCrawl.get({ id: siteId });
    expect(before).toEqual({ ...AI_CRAWL_SITE_DEFAULTS, updatedAt: null });
    const saved = await admin.aiCrawl.update({
      id: siteId,
      ...AI_CRAWL_SITE_DEFAULTS,
      crawlers: { gptbot: "block", claudebot: "charge" },
      impersonators: "block",
      robots: { managed: true, search: "yes", aiInput: "unset", aiTrain: "no" },
      payPerCrawl: { enabled: true, price: "0.05", dynamicPricing: false },
    });
    expect(saved.updatedAt).not.toBeNull();
    const stale = await rpcError(
      admin.aiCrawl.update({
        id: siteId,
        expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
        ...AI_CRAWL_SITE_DEFAULTS,
      }),
    );
    expect(stale.status).toBe(409);
    const policy = (await config()).sites.find((s) => s.id === siteId)?.aiCrawl;
    expect(policy?.actions.map((a) => [a.crawler, a.action])).toEqual([
      ["claudebot", "charge"],
      ["gptbot", "block"],
    ]);
    expect(policy?.priceMicros).toBe(50000n);
    expect(policy?.impersonators).toBe("block");
    expect(policy?.robotsTxt).toContain("Content-Signal: search=yes, ai-train=no");
    expect(policy?.robotsTxt).toContain("User-agent: GPTBot\nDisallow: /");
    expect(policy?.robotsTxt).not.toContain("ClaudeBot");
    const audits = await ctx.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, "site.ai_crawl_update"));
    expect(audits.length).toBe(1);
  });

  it("blocks instead of charging while pay per crawl is off", async () => {
    const current = await admin.aiCrawl.get({ id: siteId });
    await admin.aiCrawl.update({
      ...current,
      id: siteId,
      expectedUpdatedAt: current.updatedAt ?? undefined,
      payPerCrawl: { ...current.payPerCrawl, enabled: false },
    });
    const policy = (await config()).sites.find((s) => s.id === siteId)?.aiCrawl;
    expect(policy?.actions.find((a) => a.crawler === "claudebot")?.action).toBe("block");
    expect(policy?.priceMicros).toBe(0n);
  });

  it("keeps the crawler counters nodes report, bounded and validated", () => {
    const d = cleanDimensions({
      crawlers: [
        {
          crawler: "gptbot",
          verification: "verified",
          requests: 5,
          status2xx: 4,
          status3xx: 0,
          status4xx: 1,
          status5xx: 0,
          blocked: 0,
          bytes: 900,
          charged: 2,
          chargedMicros: 20000,
          robots: 1,
          allowed: 4,
        },
        { crawler: "BAD ID", verification: "verified", requests: 1 },
        { crawler: "gptbot", verification: "maybe", requests: 1 },
      ] as never,
      crawlerPaths: [
        { crawler: "gptbot", path: "/docs", requests: 3 },
        { crawler: "gptbot", path: "/x?y=1", requests: 1 },
      ],
    });
    expect(d.crawler_stats["gptbot|verified:n"]).toBe(5);
    expect(d.crawler_stats["gptbot|verified:cm"]).toBe(20000);
    expect(d.crawler_stats["gptbot|verified:a"]).toBe(4);
    expect(Object.keys(d.crawler_stats).every((k) => k.startsWith("gptbot|verified:"))).toBe(true);
    expect(d.crawler_paths).toEqual({ "gptbot|/docs": 3 });
  });

  it("sums the overview by crawler, with the previous range, series and paths", async () => {
    await addCrawlerStats(ctx.db, {
      minute: at(12, 30),
      nodeId,
      siteId,
      stats: {
        "gptbot|verified:n": 10,
        "gptbot|verified:a": 8,
        "gptbot|verified:s2": 8,
        "gptbot|verified:s4": 2,
        "gptbot|verified:by": 5000,
        "gptbot|failed:n": 4,
        "gptbot|failed:b": 4,
        "gptbot|failed:s4": 4,
        "claudebot|unverifiable:n": 3,
        "claudebot|unverifiable:c": 2,
        "claudebot|unverifiable:cm": 100000,
        "claudebot|unverifiable:a": 3,
        "claudebot|unverifiable:r": 1,
      },
      paths: { "gptbot|/docs": 9, "claudebot|/robots.txt": 1 },
    });
    // The hour before: the previous range.
    await addCrawlerStats(ctx.db, {
      minute: at(11, 20),
      nodeId,
      siteId,
      stats: { "gptbot|verified:n": 6, "gptbot|verified:a": 6 },
    });
    const o = await aiCrawlOverview(ctx.db, { id: siteId, range: "1h" }, NOW);
    expect(o.totals.requests).toBe(17);
    expect(o.totals.allowed).toBe(11);
    expect(o.totals.failed).toBe(6);
    expect(o.totals.blocked).toBe(4);
    expect(o.totals.bytes).toBe(5000);
    expect(o.totals.charged).toBe(2);
    expect(o.totals.chargedMicros).toBe(100000);
    expect(o.totals.robots).toBe(1);
    expect(o.previous.requests).toBe(6);
    const gpt = o.crawlers.find((c) => c.crawler === "gptbot");
    expect(gpt).toMatchObject({
      requests: 14,
      verified: 10,
      unverified: 4,
      unverifiable: 0,
      previousRequests: 6,
    });
    expect(o.crawlers[0]?.crawler).toBe("gptbot");
    expect(o.series.length).toBe(60);
    expect(o.series.reduce((s, b) => s + b.requests, 0)).toBe(17);
    expect(o.paths[0]).toEqual({ crawler: "gptbot", path: "/docs", requests: 9 });
    expect(o.unsupportedNodes).toBeGreaterThanOrEqual(0);

    const anthropic = await aiCrawlOverview(
      ctx.db,
      { id: siteId, range: "1h", operator: "anthropic" },
      NOW,
    );
    expect(anthropic.totals.requests).toBe(3);
    expect(anthropic.paths.map((p) => p.crawler)).toEqual(["claudebot"]);
    const one = await aiCrawlOverview(ctx.db, { id: siteId, range: "1h", crawler: "gptbot" }, NOW);
    expect(one.crawlers.map((c) => c.crawler)).toEqual(["gptbot"]);
  });
});
