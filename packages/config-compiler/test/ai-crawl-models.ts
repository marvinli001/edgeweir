import type { AiCrawlerModel, AiCrawlModel, CompileInput } from "../src/index";
import { site } from "./v0230-models";

/** A catalogue of three crawlers (tokens, ranges and domains out of order). */
export const crawlers: AiCrawlerModel[] = [
  {
    id: "gptbot",
    operator: "openai",
    tokens: ["gptbot"],
    cidrs: ["2001:db8::/48", "192.0.2.0/24"],
    domains: [],
  },
  { id: "claudebot", operator: "anthropic", tokens: ["claudebot"], cidrs: [], domains: [] },
  {
    id: "googlebot",
    operator: "google",
    tokens: ["googleother", "googlebot"],
    cidrs: ["203.0.113.0/25"],
    domains: ["googlebot.com", "google.com"],
  },
];

export const policy = (extra: Partial<AiCrawlModel> = {}): AiCrawlModel => ({
  actions: {},
  impersonators: "none",
  challenge: "js",
  blockStatus: 403,
  blockBody: "",
  robotsTxt: "",
  priceMicros: 0,
  dynamicPricing: false,
  ...extra,
});

/**
 * The console models behind the v1.9.0 AI crawl vector: site a blocks
 * GPTBot with a 402 and its own text, charges ClaudeBot USD 0.01 with
 * dynamic pricing, blocks impersonators and manages robots.txt; site b
 * only manages robots.txt; site c has none (crawlers are only tagged).
 */
export const aiCrawlModels = (): CompileInput => ({
  clusterId: "c1",
  aiCrawlers: { detection: true, crawlers },
  sites: [
    site("c"),
    site("b", {
      aiCrawl: policy({
        robotsTxt:
          "# BEGIN Edgeweir managed content\nUser-agent: *\nContent-Signal: ai-train=no\nAllow: /\n# END Edgeweir managed content\n",
      }),
    }),
    site("a", {
      aiCrawl: policy({
        actions: { gptbot: "block", claudebot: "charge", googlebot: "allow" },
        impersonators: "block",
        blockStatus: 402,
        blockBody: "No crawling\n",
        robotsTxt:
          "# BEGIN Edgeweir managed content\nUser-agent: GPTBot\nDisallow: /\n# END Edgeweir managed content\n",
        priceMicros: 10000,
        dynamicPricing: true,
      }),
    }),
  ],
});
