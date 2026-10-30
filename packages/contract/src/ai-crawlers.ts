/**
 * The AI crawler catalogue (ADR-0070): which User-Agents claim which
 * crawler, who operates it, what it is for and how nodes verify a claim.
 * It ships with the console and changes with releases; the published IP
 * ranges are copied into `ai-crawler-ranges.json` by
 * `pnpm --filter @edgeweir/contract ai-crawlers:ranges`. Nodes never
 * download crawler lists: the console sends them in NodeConfig.ai_crawlers.
 */
import ranges from "./ai-crawler-ranges.json" with { type: "json" };

/**
 * What a crawler is for. `training`: collects content to train models;
 * `search`: indexes content for AI search answers; `assistant`: fetches a
 * page because a person asked an assistant; `search_engine`: a classic
 * search engine crawler (blocking it hurts search ranking).
 */
export const AI_CRAWLER_CATEGORIES = ["training", "search", "assistant", "search_engine"] as const;
export type AiCrawlerCategory = (typeof AI_CRAWLER_CATEGORIES)[number];

export interface AiCrawlerOperator {
  id: string;
  /** Proper name, not translated. */
  name: string;
}

export interface AiCrawler {
  id: string;
  /** Proper name as the operator writes it, not translated. */
  name: string;
  operator: string;
  category: AiCrawlerCategory;
  /**
   * Lowercase User-Agent substrings that claim the crawler. Empty for a
   * robots.txt token that never appears in requests (Google-Extended): it
   * only takes allow / block, which the managed robots.txt expresses.
   */
  tokens: string[];
  /** The robots.txt user-agent token. */
  robots: string;
  /** Reverse DNS domains the operator documents for verification. */
  domains: string[];
  /** Whether `ai-crawler-ranges.json` holds the operator's published ranges for it. */
  ranges: boolean;
}

export const AI_CRAWLER_OPERATORS: AiCrawlerOperator[] = [
  { id: "openai", name: "OpenAI" },
  { id: "anthropic", name: "Anthropic" },
  { id: "google", name: "Google" },
  { id: "microsoft", name: "Microsoft" },
  { id: "apple", name: "Apple" },
  { id: "bytedance", name: "ByteDance" },
  { id: "perplexity", name: "Perplexity" },
  { id: "common-crawl", name: "Common Crawl" },
  { id: "duckduckgo", name: "DuckDuckGo" },
  { id: "huawei", name: "Huawei" },
  { id: "meta", name: "Meta" },
  { id: "amazon", name: "Amazon" },
  { id: "mistral", name: "Mistral" },
  { id: "cohere", name: "Cohere" },
];

const GOOGLE_DOMAINS = ["google.com", "googlebot.com", "googleusercontent.com"];

/** Order is the display order within an operator. */
export const AI_CRAWLERS: AiCrawler[] = [
  crawler("gptbot", "GPTBot", "openai", "training", ["gptbot"], { ranges: true }),
  crawler("oai-searchbot", "OAI-SearchBot", "openai", "search", ["oai-searchbot"], {
    ranges: true,
  }),
  crawler("chatgpt-user", "ChatGPT-User", "openai", "assistant", ["chatgpt-user"], {
    ranges: true,
  }),
  crawler("claudebot", "ClaudeBot", "anthropic", "training", ["claudebot"]),
  crawler("claude-searchbot", "Claude-SearchBot", "anthropic", "search", ["claude-searchbot"]),
  crawler("claude-user", "Claude-User", "anthropic", "assistant", ["claude-user"]),
  crawler("googlebot", "Googlebot", "google", "search_engine", ["googlebot"], {
    ranges: true,
    domains: GOOGLE_DOMAINS,
  }),
  crawler(
    "google-cloudvertexbot",
    "Google-CloudVertexBot",
    "google",
    "training",
    ["google-cloudvertexbot"],
    {
      domains: GOOGLE_DOMAINS,
    },
  ),
  crawler("google-extended", "Google-Extended", "google", "training", []),
  crawler("bingbot", "BingBot", "microsoft", "search_engine", ["bingbot"], {
    ranges: true,
    domains: ["search.msn.com"],
  }),
  crawler("applebot", "Applebot", "apple", "search", ["applebot"], {
    ranges: true,
    domains: ["applebot.apple.com"],
  }),
  crawler("applebot-extended", "Applebot-Extended", "apple", "training", []),
  crawler("bytespider", "Bytespider", "bytedance", "training", ["bytespider"]),
  crawler("perplexitybot", "PerplexityBot", "perplexity", "search", ["perplexitybot"], {
    ranges: true,
  }),
  crawler("perplexity-user", "Perplexity-User", "perplexity", "assistant", ["perplexity-user"], {
    ranges: true,
  }),
  crawler("ccbot", "CCBot", "common-crawl", "training", ["ccbot"], { ranges: true }),
  crawler("duckassistbot", "DuckAssistBot", "duckduckgo", "assistant", ["duckassistbot"], {
    ranges: true,
  }),
  crawler("petalbot", "PetalBot", "huawei", "search", ["petalbot"], {
    domains: ["petalsearch.com"],
  }),
  crawler("meta-externalagent", "Meta-ExternalAgent", "meta", "training", ["meta-externalagent"], {
    robots: "meta-externalagent",
  }),
  crawler(
    "meta-externalfetcher",
    "Meta-ExternalFetcher",
    "meta",
    "assistant",
    ["meta-externalfetcher"],
    {
      robots: "meta-externalfetcher",
    },
  ),
  crawler("facebookbot", "FacebookBot", "meta", "training", ["facebookbot"]),
  crawler("amazonbot", "Amazonbot", "amazon", "training", ["amazonbot"], {
    domains: ["crawl.amazonbot.amazon"],
  }),
  crawler("mistralai-user", "MistralAI-User", "mistral", "assistant", ["mistralai-user"], {
    ranges: true,
  }),
  crawler("cohere-ai", "cohere-ai", "cohere", "training", ["cohere-ai"]),
];

function crawler(
  id: string,
  name: string,
  operator: string,
  category: AiCrawlerCategory,
  tokens: string[],
  more: { ranges?: boolean; domains?: string[]; robots?: string } = {},
): AiCrawler {
  return {
    id,
    name,
    operator,
    category,
    tokens,
    robots: more.robots ?? name,
    domains: more.domains ?? [],
    ranges: more.ranges ?? false,
  };
}

const byId = new Map(AI_CRAWLERS.map((c) => [c.id, c]));

export function aiCrawler(id: string): AiCrawler | undefined {
  return byId.get(id);
}

/** Whether requests can carry the crawler's name (robots.txt-only tokens cannot). */
export function aiCrawlerDetectable(c: AiCrawler): boolean {
  return c.tokens.length > 0;
}

/** Whether the operator publishes a way to verify the crawler. */
export function aiCrawlerVerifiable(c: AiCrawler): boolean {
  return c.domains.length > 0 || aiCrawlerCidrs(c.id).length > 0;
}

const RANGES = (ranges as { crawlers: Record<string, string[]> }).crawlers;

/** The crawler's published ranges in canonical form (copied at release time). */
export function aiCrawlerCidrs(id: string): string[] {
  return RANGES[id] ?? [];
}

/** When `ai-crawler-ranges.json` was last refreshed (ISO 8601). */
export const AI_CRAWLER_RANGES_UPDATED = (ranges as { updated: string }).updated;

/**
 * The crawler a User-Agent claims, by the rule nodes apply: the longest
 * matching token wins, then the smaller id.
 */
export function claimedAiCrawler(userAgent: string): AiCrawler | undefined {
  const ua = userAgent.toLowerCase();
  let best: AiCrawler | undefined;
  let bestLength = 0;
  for (const c of [...AI_CRAWLERS].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    for (const token of c.tokens) {
      if (token.length > bestLength && ua.includes(token)) {
        best = c;
        bestLength = token.length;
      }
    }
  }
  return best;
}
