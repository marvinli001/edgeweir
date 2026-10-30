/**
 * AI crawl control (ADR-0070, node feature ai-crawlers-v1): actions on the
 * crawlers of the catalogue (`ai-crawlers.ts`), the managed robots.txt and
 * pay per crawl, globally and per site, and the per-site overview.
 *
 * Actions resolve per crawler: the site's crawler action, the site's
 * operator action, the global crawler action, the global operator action;
 * none of them: the crawler is only tagged. Pay per crawl is the protocol
 * only (HTTP 402, crawler-price, crawler-exact-price, crawler-max-price,
 * crawler-charged, crawler-error): the console records what nodes charged
 * and never processes payments.
 */
import { challengeTypes } from "@edgeweir/rule-engine";
import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  AI_CRAWLER_CATEGORIES,
  AI_CRAWLER_OPERATORS,
  AI_CRAWLERS,
  type AiCrawler,
  aiCrawler,
  aiCrawlerDetectable,
} from "./ai-crawlers";
import { analyticsRange, expectedUpdatedAt, isoDateTime, uuid } from "./schemas";

export * from "./ai-crawlers";

export const AI_CRAWL_ACTIONS = ["allow", "block", "challenge", "charge"] as const;
export type AiCrawlAction = (typeof AI_CRAWL_ACTIONS)[number];
/** What robots.txt-only tokens (no User-Agent) can take. */
export const AI_CRAWL_TOKEN_ACTIONS = ["allow", "block"] as const;
export const AI_CRAWL_IMPERSONATOR_ACTIONS = ["none", "block", "challenge"] as const;
export const AI_CRAWL_BLOCK_STATUSES = [403, 402] as const;
export const CONTENT_SIGNAL_VALUES = ["unset", "yes", "no"] as const;
/** Verification results nodes report (CrawlerCounter.verification). */
export const AI_CRAWLER_VERIFICATIONS = ["verified", "failed", "unverifiable", "pending"] as const;
export type AiCrawlerVerification = (typeof AI_CRAWLER_VERIFICATIONS)[number];

/**
 * Counters stored per `<crawler>|<verification>` (CrawlerCounter): requests,
 * status classes, refused by AI crawl control, bytes sent, charged crawls,
 * their prices (millionths of a US dollar), robots.txt requests and allowed
 * (below 400 and not refused).
 */
export const AI_CRAWLER_STATS_FIELDS = [
  "n",
  "s2",
  "s3",
  "s4",
  "s5",
  "b",
  "by",
  "c",
  "cm",
  "r",
  "a",
] as const;
/** `<crawler>|<path>` entries a minute, hour or day keeps (heaviest first). */
export const MAX_CRAWLER_PATHS = 100;
/** `<crawler>|<verification>` pairs a bucket keeps (heaviest first). */
export const MAX_CRAWLER_STATS = 256;

const MAX_BLOCK_BODY_BYTES = 2048;
/** Pay per crawl prices, in millionths of a US dollar: USD 0.001 to USD 1000. */
const PAY_PER_CRAWL_PRICE_MICROS = { min: 1000, max: 1_000_000_000 } as const;

const action = z.enum(AI_CRAWL_ACTIONS);
const challengeType = z.enum(challengeTypes);

const crawlerActions = z.record(z.string(), action).superRefine((value, ctx) => {
  for (const [id, a] of Object.entries(value)) {
    const c = aiCrawler(id);
    if (!c) ctx.addIssue({ code: "custom", path: [id], message: "unknown crawler" });
    else if (!aiCrawlerDetectable(c) && !AI_CRAWL_TOKEN_ACTIONS.includes(a as "allow"))
      ctx.addIssue({
        code: "custom",
        path: [id],
        message: "robots.txt tokens take allow or block",
      });
  }
});
const operatorActions = z.record(z.string(), action).superRefine((value, ctx) => {
  for (const id of Object.keys(value))
    if (!AI_CRAWLER_OPERATORS.some((o) => o.id === id))
      ctx.addIssue({ code: "custom", path: [id], message: "unknown operator" });
});

const blockBody = z
  .string()
  .refine((s) => new TextEncoder().encode(s).length <= MAX_BLOCK_BODY_BYTES, "too long")
  .refine((s) => !s.includes("\0"), "no NUL characters");

/** Settings every site starts from (the /protection page). */
export const aiCrawlGlobalSettings = z.object({
  /** Send the catalogue to nodes so requests are tagged with the crawler they claim. */
  detection: z.boolean(),
  crawlers: crawlerActions,
  operators: operatorActions,
  impersonators: z.enum(AI_CRAWL_IMPERSONATOR_ACTIONS),
  challenge: challengeType,
  blockStatus: z.union([z.literal(403), z.literal(402)]),
  blockBody,
});
export const AI_CRAWL_GLOBAL_DEFAULTS: AiCrawlGlobalSettings = {
  detection: true,
  crawlers: {},
  operators: {},
  impersonators: "none",
  challenge: "js",
  blockStatus: 403,
  blockBody: "",
};

const contentSignal = z.enum(CONTENT_SIGNAL_VALUES);
/** The site's managed robots.txt: Disallow lines for blocked crawlers and content signals. */
const aiCrawlRobots = z.object({
  managed: z.boolean(),
  search: contentSignal,
  aiInput: contentSignal,
  aiTrain: contentSignal,
});

/** Decimal US dollars with up to six decimals ("0.01"). */
export const payPerCrawlPrice = z
  .string()
  .regex(/^(?:0|[1-9][0-9]{0,3})(?:\.[0-9]{1,6})?$/, "a price in US dollars such as 0.01")
  .refine((s) => {
    const micros = priceMicros(s);
    return micros >= PAY_PER_CRAWL_PRICE_MICROS.min && micros <= PAY_PER_CRAWL_PRICE_MICROS.max;
  }, "USD 0.001 to 1000");

const aiCrawlPayPerCrawl = z.object({
  enabled: z.boolean(),
  price: payPerCrawlPrice,
  /** The origin's crawler-price response header sets a response's price. */
  dynamicPricing: z.boolean(),
});

const aiCrawlSiteFields = z.object({
  /** Site actions; crawlers and operators not listed follow the global actions. */
  crawlers: crawlerActions,
  operators: operatorActions,
  /** null: the global setting. */
  impersonators: z.enum(AI_CRAWL_IMPERSONATOR_ACTIONS).nullable(),
  challenge: challengeType.nullable(),
  blockStatus: z.union([z.literal(403), z.literal(402)]).nullable(),
  blockBody: blockBody.nullable(),
  robots: aiCrawlRobots,
  payPerCrawl: aiCrawlPayPerCrawl,
});
export const aiCrawlSiteSettings = aiCrawlSiteFields;
export const AI_CRAWL_SITE_DEFAULTS: AiCrawlSiteSettings = {
  crawlers: {},
  operators: {},
  impersonators: null,
  challenge: null,
  blockStatus: null,
  blockBody: null,
  robots: { managed: false, search: "unset", aiInput: "unset", aiTrain: "unset" },
  payPerCrawl: { enabled: false, price: "0.01", dynamicPricing: false },
};

const aiCrawlSite = aiCrawlSiteFields.extend({ updatedAt: isoDateTime.nullable() });
const aiCrawlSiteInput = aiCrawlSiteFields.extend({ id: uuid, expectedUpdatedAt });

const catalogueEntry = z.object({
  id: z.string(),
  name: z.string(),
  operator: z.string(),
  category: z.enum(AI_CRAWLER_CATEGORIES),
  robots: z.string(),
  /** False for robots.txt-only tokens. */
  detectable: z.boolean(),
  /** How nodes verify a claim: published ranges (with their count) and / or reverse DNS. */
  cidrs: z.number().int(),
  domains: z.array(z.string()),
});
const catalogue = z.object({
  operators: z.array(z.object({ id: z.string(), name: z.string() })),
  crawlers: z.array(catalogueEntry),
  /** When the published ranges were last copied (YYYY-MM-DD). */
  rangesUpdated: z.string(),
});

const count = z.number().int();
const overviewInput = z.object({
  id: uuid,
  range: analyticsRange.default("24h"),
  /** Only these crawlers / this operator. */
  crawler: z.string().max(40).optional(),
  operator: z.string().max(40).optional(),
});
const overviewTotals = z.object({
  requests: count,
  /** Status below 400 and not refused by AI crawl control. */
  allowed: count,
  /** The rest: refused, 4xx and 5xx. */
  failed: count,
  /** Refused by AI crawl control (block, challenge, pay per crawl). */
  blocked: count,
  status2xx: count,
  status3xx: count,
  status4xx: count,
  status5xx: count,
  bytes: count,
  robots: count,
  /** Pay per crawl: crawls sent with crawler-charged and their prices' sum in millionths of a US dollar. */
  charged: count,
  chargedMicros: count,
});
const aiCrawlOverview = z.object({
  totals: overviewTotals,
  /** The same counters over the range before. */
  previous: overviewTotals,
  /** Per bucket (minute, hour or day by range). */
  series: z.array(z.object({ t: isoDateTime, requests: count, allowed: count, failed: count })),
  crawlers: z.array(
    overviewTotals.extend({
      crawler: z.string(),
      previousRequests: count,
      verified: count,
      /** Claims whose address did not verify (impersonators). */
      unverified: count,
      unverifiable: count,
    }),
  ),
  /** Most requested paths (approximate: each node keeps its 64 heaviest a minute). */
  paths: z.array(z.object({ path: z.string(), crawler: z.string(), requests: count })),
  /** Active nodes of the site's cluster without ai-crawlers-v1: counts are partial. */
  unsupportedNodes: count,
});

const idParam = z.object({ id: uuid });

export const aiCrawlContract = {
  /** The crawler catalogue the console ships. */
  catalogue: oc
    .route({ method: "GET", path: "/ai-crawlers", tags: ["ai-crawl"] })
    .output(catalogue),
  /** Global actions, impersonators, challenge and block response. */
  settings: oc
    .route({ method: "GET", path: "/settings/ai-crawl", tags: ["ai-crawl"] })
    .output(aiCrawlGlobalSettings),
  /** Publishes every cluster whose configuration changes. */
  setSettings: oc
    .route({ method: "PUT", path: "/settings/ai-crawl", tags: ["ai-crawl"] })
    .input(aiCrawlGlobalSettings)
    .output(aiCrawlGlobalSettings),
  get: oc
    .route({ method: "GET", path: "/sites/{id}/ai-crawl", tags: ["ai-crawl"] })
    .input(idParam)
    .output(aiCrawlSite),
  /** Replaces the site's settings; publishes the site's cluster (hot update). */
  update: oc
    .route({ method: "PUT", path: "/sites/{id}/ai-crawl", tags: ["ai-crawl"] })
    .input(aiCrawlSiteInput)
    .output(aiCrawlSite),
  overview: oc
    .route({ method: "GET", path: "/sites/{id}/ai-crawl/overview", tags: ["ai-crawl"] })
    .input(overviewInput)
    .output(aiCrawlOverview),
};

export type AiCrawlGlobalSettings = z.infer<typeof aiCrawlGlobalSettings>;
export type AiCrawlSiteSettings = z.infer<typeof aiCrawlSiteSettings>;
export type AiCrawlSite = z.infer<typeof aiCrawlSite>;
export type AiCrawlRobots = z.infer<typeof aiCrawlRobots>;
export type AiCrawlOverview = z.infer<typeof aiCrawlOverview>;
export type AiCrawlCatalogue = z.infer<typeof catalogue>;

/** "0.01" → 10000. */
export function priceMicros(price: string): number {
  const [whole = "0", fraction = ""] = price.split(".");
  return Number(whole) * 1_000_000 + Number(fraction.padEnd(6, "0").slice(0, 6));
}

/** 10000 → "0.01" (the wire form after "USD "). */
export function formatPriceMicros(micros: number): string {
  const whole = Math.floor(micros / 1_000_000);
  const fraction = String(micros % 1_000_000)
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : String(whole);
}

export type AiCrawlActionSource =
  | "site_crawler"
  | "site_operator"
  | "global_crawler"
  | "global_operator"
  | "none";

/** A crawler's action and where it comes from; "none": only tagged. */
export function resolveAiCrawlAction(
  crawler: AiCrawler,
  site: Pick<AiCrawlSiteSettings, "crawlers" | "operators"> | null,
  global: Pick<AiCrawlGlobalSettings, "crawlers" | "operators">,
): { action: AiCrawlAction | null; source: AiCrawlActionSource } {
  const tokenOnly = !aiCrawlerDetectable(crawler);
  const usable = (a: AiCrawlAction | undefined) =>
    a !== undefined && (!tokenOnly || a === "allow" || a === "block") ? a : undefined;
  const steps: [AiCrawlAction | undefined, AiCrawlActionSource][] = [
    [usable(site?.crawlers[crawler.id]), "site_crawler"],
    [usable(site?.operators[crawler.operator]), "site_operator"],
    [usable(global.crawlers[crawler.id]), "global_crawler"],
    [usable(global.operators[crawler.operator]), "global_operator"],
  ];
  for (const [a, source] of steps) if (a) return { action: a, source };
  return { action: null, source: "none" };
}

/** Every crawler's resolved action (only those with one). */
export function effectiveAiCrawlActions(
  site: Pick<AiCrawlSiteSettings, "crawlers" | "operators"> | null,
  global: Pick<AiCrawlGlobalSettings, "crawlers" | "operators">,
): Map<string, AiCrawlAction> {
  const out = new Map<string, AiCrawlAction>();
  for (const c of AI_CRAWLERS) {
    const { action: a } = resolveAiCrawlAction(c, site, global);
    if (a) out.set(c.id, a);
  }
  return out;
}

/**
 * The text the edge puts before the origin's robots.txt: a content signal
 * line under `User-agent: *` when any signal is set, and `Disallow: /` for
 * every crawler that is blocked or challenged (crawlers that pay per crawl
 * are not disallowed). Empty when there is nothing to say.
 */
export function managedRobotsTxt(
  robots: AiCrawlRobots,
  actions: ReadonlyMap<string, AiCrawlAction>,
): string {
  if (!robots.managed) return "";
  const signals = (
    [
      ["search", robots.search],
      ["ai-input", robots.aiInput],
      ["ai-train", robots.aiTrain],
    ] as const
  )
    .filter(([, v]) => v !== "unset")
    .map(([k, v]) => `${k}=${v}`);
  const disallowed = AI_CRAWLERS.filter((c) => {
    const a = actions.get(c.id);
    return a === "block" || a === "challenge";
  });
  if (signals.length === 0 && disallowed.length === 0) return "";
  const lines = ["# BEGIN Edgeweir managed content"];
  if (signals.length > 0)
    lines.push("User-agent: *", `Content-Signal: ${signals.join(", ")}`, "Allow: /", "");
  for (const c of disallowed) lines.push(`User-agent: ${c.robots}`, "Disallow: /", "");
  lines.push("# END Edgeweir managed content", "", "");
  return lines.join("\n");
}
