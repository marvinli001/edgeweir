/**
 * AI crawl control: the catalogue, the global settings and each site's, and the site overview.
 * shop.example.com blocks the training crawlers of two operators, charges GPTBot through pay per
 * crawl and sees a spoofed GPTBot; other sites get a lighter mix with no actions of their own.
 */
import {
  AI_CRAWL_GLOBAL_DEFAULTS,
  AI_CRAWL_SITE_DEFAULTS,
  AI_CRAWLER_OPERATORS,
  AI_CRAWLER_RANGES_UPDATED,
  AI_CRAWLERS,
  type AiCrawlGlobalSettings,
  type AiCrawlOverview,
  type AiCrawlSite,
  type AnalyticsRange,
  aiCrawlerCidrs,
  aiCrawlerDetectable,
  priceMicros,
} from "@edgeweir/contract";
import type { Fixtures } from "./define";
import { ago, DAY, noise, sites } from "./world";

const SHOP = sites.find((s) => s.name === "shop.example.com");

let global: AiCrawlGlobalSettings = {
  ...AI_CRAWL_GLOBAL_DEFAULTS,
  operators: { bytedance: "block" },
};

const siteSettings = new Map<string, AiCrawlSite>();
function settingsOf(siteId: string): AiCrawlSite {
  let settings = siteSettings.get(siteId);
  if (!settings) {
    settings =
      siteId === SHOP?.id
        ? {
            ...AI_CRAWL_SITE_DEFAULTS,
            crawlers: { gptbot: "charge", ccbot: "block", "google-extended": "block" },
            operators: { meta: "challenge" },
            impersonators: "block",
            robots: { managed: true, search: "yes", aiInput: "yes", aiTrain: "no" },
            payPerCrawl: { enabled: true, price: "0.01", dynamicPricing: false },
            updatedAt: ago(2 * DAY),
          }
        : { ...AI_CRAWL_SITE_DEFAULTS, updatedAt: null };
    siteSettings.set(siteId, settings);
  }
  return settings;
}

const RANGES: Record<AnalyticsRange, { seconds: number; bucketSeconds: number }> = {
  "1h": { seconds: 3_600, bucketSeconds: 60 },
  "6h": { seconds: 21_600, bucketSeconds: 300 },
  "24h": { seconds: 86_400, bucketSeconds: 600 },
  "7d": { seconds: 604_800, bucketSeconds: 3_600 },
  "30d": { seconds: 2_592_000, bucketSeconds: 21_600 },
};

/** Requests an hour per crawler on the shop (others get a tenth). */
const RATES: Record<string, number> = {
  googlebot: 2400,
  bingbot: 900,
  gptbot: 640,
  "oai-searchbot": 410,
  "chatgpt-user": 220,
  claudebot: 380,
  "claude-user": 60,
  perplexitybot: 150,
  ccbot: 120,
  bytespider: 300,
  "meta-externalagent": 210,
  amazonbot: 90,
  applebot: 140,
};

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
const add = (into: Totals, from: Totals) => {
  for (const key of Object.keys(into) as (keyof Totals)[]) into[key] += from[key];
};

/** One crawler's counters for one bucket: what its action makes of its requests. */
function bucketOf(siteId: string, crawler: string, time: number, seconds: number): Totals {
  const shop = siteId === SHOP?.id;
  const rate = (RATES[crawler] ?? 0) * (shop ? 1 : 0.1);
  const wave = 0.6 + 0.8 * noise(Math.floor(time / 600_000) * 31 + crawler.length);
  const requests = Math.round((rate * seconds * wave) / 3600);
  const t = zero();
  if (requests === 0) return t;
  const action = shop ? settingsOf(siteId).crawlers[crawler] : undefined;
  const refused =
    action === "block" || crawler === "bytespider"
      ? requests
      : action === "charge"
        ? Math.round(requests * 0.7)
        : action === "challenge" || (shop && crawler === "meta-externalagent")
          ? Math.round(requests * 0.9)
          : 0;
  const errors = Math.round((requests - refused) * 0.03);
  const ok = requests - refused - errors;
  t.requests = requests;
  t.blocked = refused;
  t.allowed = ok;
  t.failed = requests - ok;
  t.status2xx = Math.round(ok * 0.92);
  t.status3xx = ok - t.status2xx;
  t.status4xx = refused + Math.round(errors * 0.8);
  t.status5xx = errors - Math.round(errors * 0.8);
  t.bytes = ok * 38_000 + refused * 600;
  t.robots = Math.max(1, Math.round(requests * 0.01));
  if (action === "charge") {
    t.charged = Math.round(ok * 0.9);
    t.chargedMicros = t.charged * priceMicros(settingsOf(siteId).payPerCrawl.price);
  }
  return t;
}

const PATHS = [
  "/",
  "/products/linen-shirt",
  "/products/canvas-tote",
  "/collections/summer",
  "/blog/care-guide",
  "/sitemap.xml",
  "/robots.txt",
  "/products/wool-socks",
];

function overviewOf(input: {
  id: string;
  range?: AnalyticsRange;
  crawler?: string;
  operator?: string;
}): AiCrawlOverview {
  const { seconds, bucketSeconds } = RANGES[input.range ?? "24h"];
  const bucketMs = bucketSeconds * 1000;
  const last = Math.floor(Date.now() / bucketMs) * bucketMs;
  const count = seconds / bucketSeconds;
  const from = last - (count - 1) * bucketMs;
  const wanted = AI_CRAWLERS.filter(
    (c) =>
      aiCrawlerDetectable(c) &&
      (!input.crawler || c.id === input.crawler) &&
      (!input.operator || c.operator === input.operator),
  );
  const totals = zero();
  const previous = zero();
  const series: AiCrawlOverview["series"] = [];
  const perCrawler = new Map<string, { t: Totals; previous: number }>();
  for (let i = 0; i < count; i++) {
    const time = from + i * bucketMs;
    const bucket = zero();
    for (const c of wanted) {
      const now = bucketOf(input.id, c.id, time, bucketSeconds);
      const before = bucketOf(input.id, c.id, time - seconds * 1000, bucketSeconds);
      add(bucket, now);
      add(previous, before);
      const row = perCrawler.get(c.id) ?? { t: zero(), previous: 0 };
      add(row.t, now);
      row.previous += before.requests;
      perCrawler.set(c.id, row);
    }
    add(totals, bucket);
    series.push({
      t: new Date(time).toISOString(),
      requests: bucket.requests,
      allowed: bucket.allowed,
      failed: bucket.failed,
    });
  }
  const crawlers = [...perCrawler]
    .filter(([, row]) => row.t.requests > 0)
    .map(([crawler, row]) => {
      const entry = AI_CRAWLERS.find((c) => c.id === crawler);
      const verifiable =
        !!entry && (entry.domains.length > 0 || aiCrawlerCidrs(crawler).length > 0);
      // The shop's spoofed GPTBot: a share of its claims come from elsewhere.
      const spoofed =
        input.id === SHOP?.id && crawler === "gptbot" ? Math.round(row.t.requests * 0.12) : 0;
      const pending = verifiable ? Math.round(row.t.requests * 0.01) : 0;
      return {
        ...row.t,
        crawler,
        previousRequests: row.previous,
        verified: verifiable ? row.t.requests - spoofed - pending : 0,
        unverified: spoofed,
        unverifiable: verifiable ? 0 : row.t.requests,
      };
    })
    .sort((a, b) => b.requests - a.requests);
  const paths = crawlers
    .slice(0, 4)
    .flatMap((row, i) =>
      PATHS.map((path, j) => ({
        path,
        crawler: row.crawler,
        requests: Math.round((row.requests / (j + 2)) * (0.5 + noise(i * 13 + j))),
      })),
    )
    .sort((a, b) => b.requests - a.requests)
    .slice(0, 20);
  return { totals, previous, series, crawlers, paths, unsupportedNodes: 0 };
}

export const aiCrawlFixtures: Fixtures = {
  aiCrawl: {
    catalogue: () => ({
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
    }),
    settings: () => global,
    setSettings: (input) => {
      global = input;
      return global;
    },
    get: ({ id }) => settingsOf(id),
    update: ({ id, expectedUpdatedAt: _at, ...settings }) => {
      const saved = { ...settings, updatedAt: new Date().toISOString() };
      siteSettings.set(id, saved);
      return saved;
    },
    overview: (input) => overviewOf(input),
  },
};
