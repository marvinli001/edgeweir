import type { AiCrawlerModel, AiCrawlModel, SiteModel } from "@edgeweir/config-compiler";
import {
  AI_CRAWL_GLOBAL_DEFAULTS,
  AI_CRAWL_SITE_DEFAULTS,
  AI_CRAWLER_OPERATORS,
  AI_CRAWLER_RANGES_UPDATED,
  AI_CRAWLER_STATS_FIELDS,
  AI_CRAWLERS,
  AI_CRAWLERS_FEATURE,
  type AiCrawlCatalogue,
  type AiCrawlGlobalSettings,
  type AiCrawlOverview,
  type AiCrawlSite,
  type AiCrawlSiteSettings,
  type AnalyticsRange,
  aiCrawlerCidrs,
  aiCrawlerDetectable,
  aiCrawlGlobalSettings,
  effectiveAiCrawlActions,
  formatPriceMicros,
  managedRobotsTxt,
  nodeSupportsFeature,
  priceMicros,
} from "@edgeweir/contract";
import { type Database, schema } from "@edgeweir/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import { assertUpdatedAt, nextUpdatedAt } from "../lib/updated-at";
import { rangeWindow, sourceFor } from "./analytics";
import type { Actor } from "./audit";
import { type Executor, publishClusters, type Tx } from "./revisions";
import { defineSetting } from "./settings";
import { publishSiteChange } from "./site-change";
import { findSite } from "./sites";

const aiCrawlSetting = defineSetting({
  key: "ai_crawl_settings",
  schema: aiCrawlGlobalSettings,
  defaults: AI_CRAWL_GLOBAL_DEFAULTS,
  auditAction: "system.ai_crawl_update",
});

export const getAiCrawlSettings = aiCrawlSetting.read;

export function aiCrawlCatalogue(): AiCrawlCatalogue {
  return {
    operators: AI_CRAWLER_OPERATORS,
    crawlers: AI_CRAWLERS.map((c) => ({
      id: c.id,
      name: c.name,
      operator: c.operator,
      category: c.category,
      robots: c.robots,
      detectable: aiCrawlerDetectable(c),
      cidrs: aiCrawlerCidrs(c.id).length,
      domains: c.domains,
    })),
    rangesUpdated: AI_CRAWLER_RANGES_UPDATED,
  };
}

/**
 * Saves the global settings and publishes every cluster (a cluster whose
 * configuration does not change gets no revision).
 */
export async function setAiCrawlSettings(
  db: Database,
  input: AiCrawlGlobalSettings,
  actor: Actor,
): Promise<AiCrawlGlobalSettings> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('ai_crawl_settings'))`);
    return aiCrawlSetting.write(tx, actor, input, {
      afterWrite: async () => {
        await publishClusters(
          tx,
          (await tx.select({ id: schema.cluster.id }).from(schema.cluster)).map((c) => c.id),
          { reason: { code: "ai_crawl_updated", params: {} }, actor },
        );
        return undefined;
      },
    });
  });
}

type Row = typeof schema.siteAiCrawl.$inferSelect;

function toSettings(row: Row | undefined): AiCrawlSiteSettings {
  if (!row) return AI_CRAWL_SITE_DEFAULTS;
  return {
    crawlers: row.crawlers as AiCrawlSiteSettings["crawlers"],
    operators: row.operators as AiCrawlSiteSettings["operators"],
    impersonators: row.impersonators as AiCrawlSiteSettings["impersonators"],
    challenge: row.challenge as AiCrawlSiteSettings["challenge"],
    blockStatus: row.blockStatus as AiCrawlSiteSettings["blockStatus"],
    blockBody: row.blockBody,
    robots: {
      managed: row.robotsManaged,
      search: row.signalSearch as AiCrawlSiteSettings["robots"]["search"],
      aiInput: row.signalAiInput as AiCrawlSiteSettings["robots"]["aiInput"],
      aiTrain: row.signalAiTrain as AiCrawlSiteSettings["robots"]["aiTrain"],
    },
    payPerCrawl: {
      enabled: row.payPerCrawl,
      price: formatPriceMicros(row.priceMicros),
      dynamicPricing: row.dynamicPricing,
    },
  };
}

function rowValues(settings: AiCrawlSiteSettings) {
  return {
    crawlers: settings.crawlers,
    operators: settings.operators,
    impersonators: settings.impersonators,
    challenge: settings.challenge,
    blockStatus: settings.blockStatus,
    blockBody: settings.blockBody,
    robotsManaged: settings.robots.managed,
    signalSearch: settings.robots.search,
    signalAiInput: settings.robots.aiInput,
    signalAiTrain: settings.robots.aiTrain,
    payPerCrawl: settings.payPerCrawl.enabled,
    priceMicros: priceMicros(settings.payPerCrawl.price),
    dynamicPricing: settings.payPerCrawl.dynamicPricing,
  };
}

export async function getSiteAiCrawl(db: Database, id: string): Promise<AiCrawlSite> {
  const site = await findSite(db, id);
  const [row] = await db
    .select()
    .from(schema.siteAiCrawl)
    .where(eq(schema.siteAiCrawl.siteId, site.id));
  return { ...toSettings(row), updatedAt: row?.updatedAt.toISOString() ?? null };
}

/** Replaces a site's settings and publishes its cluster (hot update). */
export async function updateSiteAiCrawl(
  db: Database,
  input: AiCrawlSiteSettings & { id: string; expectedUpdatedAt?: string },
  ctx: { actor: Actor },
): Promise<AiCrawlSite> {
  const { id, expectedUpdatedAt, ...settings } = input;
  return db.transaction(async (tx) => {
    const site = await findSite(tx, id, true);
    const [before] = await tx
      .select()
      .from(schema.siteAiCrawl)
      .where(eq(schema.siteAiCrawl.siteId, site.id))
      .for("update");
    assertUpdatedAt(
      before?.updatedAt,
      expectedUpdatedAt,
      "the AI crawl control settings changed since they were read",
    );
    const values = { ...rowValues(settings), updatedAt: nextUpdatedAt(before?.updatedAt) };
    const [row] = await tx
      .insert(schema.siteAiCrawl)
      .values({ siteId: site.id, ...values })
      .onConflictDoUpdate({ target: schema.siteAiCrawl.siteId, set: values })
      .returning();
    await publishSiteChange(tx, ctx.actor, site, {
      reason: "site_ai_crawl_updated",
      action: "site.ai_crawl_update",
      metadata: { from: toSettings(before), to: settings },
    });
    return { ...toSettings(row), updatedAt: row?.updatedAt.toISOString() ?? null };
  });
}

/** What a site compiles to, from its settings over the global ones. */
function aiCrawlModel(site: AiCrawlSiteSettings, global: AiCrawlGlobalSettings): AiCrawlModel {
  const effective = effectiveAiCrawlActions(site, global);
  const actions: AiCrawlModel["actions"] = {};
  for (const [id, a] of effective) {
    const c = AI_CRAWLERS.find((x) => x.id === id);
    if (!c || !aiCrawlerDetectable(c)) continue;
    // Charging without a price blocks: the protocol has nothing to ask.
    actions[id] = a === "charge" && !site.payPerCrawl.enabled ? "block" : a;
  }
  return {
    actions,
    impersonators: site.impersonators ?? global.impersonators,
    challenge: site.challenge ?? global.challenge,
    blockStatus: site.blockStatus ?? global.blockStatus,
    blockBody: site.blockBody ?? global.blockBody,
    robotsTxt: managedRobotsTxt(site.robots, effective),
    priceMicros: site.payPerCrawl.enabled ? priceMicros(site.payPerCrawl.price) : 0,
    dynamicPricing: site.payPerCrawl.dynamicPricing,
  };
}

/** The catalogue as nodes receive it. */
function aiCrawlerModels(): AiCrawlerModel[] {
  return AI_CRAWLERS.filter(aiCrawlerDetectable).map((c) => ({
    id: c.id,
    operator: c.operator,
    tokens: c.tokens,
    cidrs: aiCrawlerCidrs(c.id),
    domains: c.domains,
  }));
}

/** Adds each site's AI crawl control and returns the catalogue input for the cluster. */
export async function loadAiCrawl(
  tx: Executor,
  sites: SiteModel[],
): Promise<{ sites: SiteModel[]; catalogue: { detection: boolean; crawlers: AiCrawlerModel[] } }> {
  const global = await getAiCrawlSettings(tx);
  const ids = sites.map((s) => s.id);
  const rows = ids.length
    ? await tx.select().from(schema.siteAiCrawl).where(inArray(schema.siteAiCrawl.siteId, ids))
    : [];
  const byId = new Map(rows.map((r) => [r.siteId, r]));
  return {
    sites: sites.map((s) => ({ ...s, aiCrawl: aiCrawlModel(toSettings(byId.get(s.id)), global) })),
    catalogue: { detection: global.detection, crawlers: aiCrawlerModels() },
  };
}

type Totals = AiCrawlOverview["totals"];
const zero = (): Totals => ({
  requests: 0,
  allowed: 0,
  failed: 0,
  blocked: 0,
  status2xx: 0,
  status3xx: 0,
  status4xx: 0,
  status5xx: 0,
  bytes: 0,
  robots: 0,
  charged: 0,
  chargedMicros: 0,
});
const FIELD_TO_TOTAL: Record<string, keyof Totals> = {
  n: "requests",
  s2: "status2xx",
  s3: "status3xx",
  s4: "status4xx",
  s5: "status5xx",
  b: "blocked",
  by: "bytes",
  c: "charged",
  cm: "chargedMicros",
  r: "robots",
  a: "allowed",
};
const FIELDS: ReadonlySet<string> = new Set(AI_CRAWLER_STATS_FIELDS);

function addField(t: Totals, field: string, n: number) {
  const key = FIELD_TO_TOTAL[field];
  if (key) t[key] += n;
}
const finish = (t: Totals): Totals => ({ ...t, failed: Math.max(0, t.requests - t.allowed) });

/**
 * A site's AI crawler requests over a range, from the minute statistics (24
 * hours and less) or the hourly rollups (7 and 30 days), with the same
 * counters over the range before it.
 */
export async function aiCrawlOverview(
  db: Database,
  input: { id: string; range: AnalyticsRange; crawler?: string; operator?: string },
  now = Date.now(),
): Promise<AiCrawlOverview> {
  const site = await findSite(db, input.id);
  const stats = sourceFor(input.range);
  const window = rangeWindow(input.range, now);
  const bucketMs = window.bucketSeconds * 1000;
  const wanted = (crawler: string) => {
    if (input.crawler && crawler !== input.crawler) return false;
    if (input.operator && AI_CRAWLERS.find((c) => c.id === crawler)?.operator !== input.operator)
      return false;
    return true;
  };
  const inRange = and(
    eq(stats.siteId, site.id),
    sql`${stats.minute} >= ${window.previousFrom.toISOString()}::timestamptz`,
    sql`${stats.minute} < ${window.end.toISOString()}::timestamptz`,
  );
  const counters = await db.execute<{ t: string; k: string; n: string }>(sql`
    select (floor(extract(epoch from ${stats.minute}) / ${window.bucketSeconds}) * ${window.bucketSeconds})::bigint::text as t,
      e.key as k, sum(e.value::numeric)::text as n
    from ${stats} cross join lateral jsonb_each_text(${stats.crawlerStats}) e
    where ${inRange}
    group by 1, 2`);
  const totals = zero();
  const previous = zero();
  const perCrawler = new Map<
    string,
    {
      t: Totals;
      previousRequests: number;
      verified: number;
      unverified: number;
      unverifiable: number;
    }
  >();
  const series = new Map<number, Totals>();
  for (let t = window.from.getTime(); t < window.end.getTime(); t += bucketMs)
    series.set(t, zero());
  for (const row of counters.rows) {
    const at = row.k.lastIndexOf(":");
    const pair = row.k.slice(0, at);
    const field = row.k.slice(at + 1);
    const [crawler = "", verification = ""] = pair.split("|");
    if (!FIELDS.has(field) || !wanted(crawler)) continue;
    const n = Number(row.n);
    const t = Number(row.t) * 1000;
    if (t < window.from.getTime()) {
      addField(previous, field, n);
      if (field === "n") {
        const c = perCrawler.get(crawler) ?? {
          t: zero(),
          previousRequests: 0,
          verified: 0,
          unverified: 0,
          unverifiable: 0,
        };
        c.previousRequests += n;
        perCrawler.set(crawler, c);
      }
      continue;
    }
    addField(totals, field, n);
    const bucket = series.get(t);
    if (bucket) addField(bucket, field, n);
    const c = perCrawler.get(crawler) ?? {
      t: zero(),
      previousRequests: 0,
      verified: 0,
      unverified: 0,
      unverifiable: 0,
    };
    addField(c.t, field, n);
    if (field === "n") {
      if (verification === "verified") c.verified += n;
      else if (verification === "failed") c.unverified += n;
      else if (verification === "unverifiable") c.unverifiable += n;
    }
    perCrawler.set(crawler, c);
  }
  const paths = await db.execute<{ k: string; n: string }>(sql`
    select e.key as k, sum(e.value::numeric)::text as n
    from ${stats} cross join lateral jsonb_each_text(${stats.crawlerPaths}) e
    where ${and(
      eq(stats.siteId, site.id),
      sql`${stats.minute} >= ${window.from.toISOString()}::timestamptz`,
      sql`${stats.minute} < ${window.end.toISOString()}::timestamptz`,
    )}
    group by 1 order by sum(e.value::numeric) desc, 1 limit 500`);
  const nodes = await db
    .select({ features: schema.node.supportedFeatures })
    .from(schema.node)
    .where(and(eq(schema.node.clusterId, site.clusterId), eq(schema.node.status, "active")));
  return {
    totals: finish(totals),
    previous: finish(previous),
    series: [...series].map(([t, b]) => ({
      t: new Date(t).toISOString(),
      requests: b.requests,
      allowed: b.allowed,
      failed: Math.max(0, b.requests - b.allowed),
    })),
    crawlers: [...perCrawler]
      .filter(([, c]) => c.t.requests > 0)
      .map(([crawler, c]) => ({
        ...finish(c.t),
        crawler,
        previousRequests: c.previousRequests,
        verified: c.verified,
        unverified: c.unverified,
        unverifiable: c.unverifiable,
      }))
      .sort((a, b) => b.requests - a.requests || (a.crawler < b.crawler ? -1 : 1)),
    paths: paths.rows
      .map((row) => {
        const bar = row.k.indexOf("|");
        return {
          crawler: row.k.slice(0, bar),
          path: row.k.slice(bar + 1),
          requests: Number(row.n),
        };
      })
      .filter((p) => wanted(p.crawler))
      .slice(0, 20),
    unsupportedNodes: nodes.filter((n) => !nodeSupportsFeature(n.features, AI_CRAWLERS_FEATURE))
      .length,
  };
}

/** A site's stored settings, defaults filled in (site copy). */
export async function readSiteAiCrawl(db: Executor, siteId: string): Promise<AiCrawlSiteSettings> {
  const [row] = await db
    .select()
    .from(schema.siteAiCrawl)
    .where(eq(schema.siteAiCrawl.siteId, siteId));
  return toSettings(row);
}

/** Stores a site's settings without publishing (site copy publishes once). */
export async function writeSiteAiCrawl(tx: Tx, siteId: string, settings: AiCrawlSiteSettings) {
  const values = rowValues(settings);
  await tx
    .insert(schema.siteAiCrawl)
    .values({ siteId, ...values, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.siteAiCrawl.siteId,
      set: { ...values, updatedAt: new Date() },
    });
}
