import type {
  AiCrawlAction,
  AiCrawlCatalogue,
  AiCrawlerCategory,
  AiCrawlerVerification,
} from "@edgeweir/contract";
import { getLocale, m } from "@/lib/i18n";

type CatalogueCrawler = AiCrawlCatalogue["crawlers"][number];

export const aiCrawlActionLabel = (action: AiCrawlAction) =>
  ({
    allow: m.ai_crawl_action_allow,
    block: m.ai_crawl_action_block,
    challenge: m.ai_crawl_action_challenge,
    charge: m.ai_crawl_action_charge,
  })[action]();

/** A resolved action, or "tag only" when no setting picks one. */
export const resolvedActionLabel = (action: AiCrawlAction | null) =>
  action ? aiCrawlActionLabel(action) : m.ai_crawl_action_none();

export const aiCrawlerCategoryLabel = (category: AiCrawlerCategory) =>
  ({
    training: m.ai_crawl_category_training,
    search: m.ai_crawl_category_search,
    assistant: m.ai_crawl_category_assistant,
    search_engine: m.ai_crawl_category_search_engine,
  })[category]();

export const impersonatorActionLabel = (action: "none" | "block" | "challenge") =>
  ({
    none: m.ai_crawl_impersonators_none,
    block: m.ai_crawl_action_block,
    challenge: m.ai_crawl_action_challenge,
  })[action]();

export const contentSignalLabel = (value: "unset" | "yes" | "no") =>
  ({
    unset: m.ai_crawl_signal_unset,
    yes: m.ai_crawl_signal_yes,
    no: m.ai_crawl_signal_no,
  })[value]();

/** What a node found when it checked a claim (CrawlerCounter.verification). */
export const verificationLabel = (value: AiCrawlerVerification | string) =>
  (
    ({
      verified: m.ai_crawl_verified,
      failed: m.ai_crawl_impersonated,
      unverifiable: m.ai_crawl_unverifiable,
      pending: m.ai_crawl_pending,
    }) as Record<string, () => string>
  )[value]?.() ?? value;

/** How nodes check that a request claiming the crawler comes from its operator. */
export function verifiedByLabel(crawler: CatalogueCrawler): string {
  if (!crawler.detectable) return m.ai_crawl_robots_only();
  if (crawler.cidrs > 0 && crawler.domains.length > 0) return m.ai_crawl_verify_both();
  if (crawler.cidrs > 0) return m.ai_crawl_verify_ranges();
  if (crawler.domains.length > 0) return m.ai_crawl_verify_dns();
  return m.ai_crawl_unverifiable();
}

/** USD amounts the way pay per crawl writes them, from millionths of a US dollar. */
export function formatUsd(micros: number): string {
  return m.ai_crawl_usd({
    amount: new Intl.NumberFormat(getLocale(), {
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(micros / 1_000_000),
  });
}
