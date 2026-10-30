import { describe, expect, it } from "vitest";
import {
  AI_CRAWL_GLOBAL_DEFAULTS,
  AI_CRAWL_SITE_DEFAULTS,
  AI_CRAWLER_OPERATORS,
  AI_CRAWLERS,
  aiCrawlerCidrs,
  aiCrawlerDetectable,
  aiCrawlerVerifiable,
  aiCrawlGlobalSettings,
  aiCrawlSiteSettings,
  claimedAiCrawler,
  effectiveAiCrawlActions,
  formatPriceMicros,
  managedRobotsTxt,
  parseCidr,
  payPerCrawlPrice,
  priceMicros,
  resolveAiCrawlAction,
} from "../src/index";

const crawler = (id: string) => {
  const c = AI_CRAWLERS.find((x) => x.id === id);
  if (!c) throw new Error(id);
  return c;
};

describe("the AI crawler catalogue", () => {
  it("has unique ids, known operators and lowercase tokens", () => {
    expect(new Set(AI_CRAWLERS.map((c) => c.id)).size).toBe(AI_CRAWLERS.length);
    for (const c of AI_CRAWLERS) {
      expect(c.id).toMatch(/^[a-z0-9-]{1,40}$/);
      expect(AI_CRAWLER_OPERATORS.some((o) => o.id === c.operator)).toBe(true);
      for (const t of c.tokens) {
        expect(t).toBe(t.toLowerCase());
        expect(t).toMatch(/^[\x21-\x7e]{3,64}$/);
      }
    }
  });

  it("ships canonical published ranges for the crawlers that have them", () => {
    for (const c of AI_CRAWLERS) {
      const cidrs = aiCrawlerCidrs(c.id);
      expect(cidrs.length > 0).toBe(c.ranges);
      expect(cidrs.length).toBeLessThanOrEqual(4096);
      for (const text of cidrs) {
        const p = parseCidr(text);
        expect(p, text).not.toBeNull();
      }
    }
    expect(aiCrawlerVerifiable(crawler("gptbot"))).toBe(true);
    expect(aiCrawlerVerifiable(crawler("bingbot"))).toBe(true);
    expect(aiCrawlerVerifiable(crawler("claudebot"))).toBe(false);
    expect(aiCrawlerDetectable(crawler("google-extended"))).toBe(false);
  });

  it("matches User-Agents like nodes: case-insensitive, the longest token wins", () => {
    const claim = (ua: string) => claimedAiCrawler(ua)?.id;
    expect(
      claim(
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.2; +https://openai.com/gptbot",
      ),
    ).toBe("gptbot");
    expect(claim("Mozilla/5.0 (compatible; ChatGPT-User/1.0)")).toBe("chatgpt-user");
    expect(claim("Mozilla/5.0 (compatible; OAI-SearchBot/1.0)")).toBe("oai-searchbot");
    expect(claim("Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)")).toBe(
      "claudebot",
    );
    expect(claim("Claude-SearchBot/1.0")).toBe("claude-searchbot");
    expect(claim("Mozilla/5.0 (compatible; Googlebot/2.1)")).toBe("googlebot");
    expect(claim("Google-CloudVertexBot Googlebot")).toBe("google-cloudvertexbot");
    expect(claim("Mozilla/5.0 (compatible; PerplexityBot/1.0)")).toBe("perplexitybot");
    expect(claim("Perplexity-User/1.0")).toBe("perplexity-user");
    expect(claim("meta-externalagent/1.1")).toBe("meta-externalagent");
    expect(claim("Mozilla/5.0 (Windows NT 10.0) Firefox/120.0")).toBeUndefined();
    expect(claim("")).toBeUndefined();
  });
});

describe("AI crawl actions", () => {
  const global = {
    ...AI_CRAWL_GLOBAL_DEFAULTS,
    operators: { openai: "block" as const },
    crawlers: { ccbot: "block" as const },
  };

  it("resolves site crawler, site operator, global crawler, global operator", () => {
    const site = {
      crawlers: { gptbot: "allow" as const },
      operators: { anthropic: "challenge" as const },
    };
    expect(resolveAiCrawlAction(crawler("gptbot"), site, global)).toEqual({
      action: "allow",
      source: "site_crawler",
    });
    expect(resolveAiCrawlAction(crawler("claudebot"), site, global)).toEqual({
      action: "challenge",
      source: "site_operator",
    });
    expect(resolveAiCrawlAction(crawler("ccbot"), site, global)).toEqual({
      action: "block",
      source: "global_crawler",
    });
    expect(resolveAiCrawlAction(crawler("oai-searchbot"), site, global)).toEqual({
      action: "block",
      source: "global_operator",
    });
    expect(resolveAiCrawlAction(crawler("bytespider"), site, global)).toEqual({
      action: null,
      source: "none",
    });
    expect(resolveAiCrawlAction(crawler("gptbot"), null, global).source).toBe("global_operator");
  });

  it("gives robots.txt-only tokens only allow or block", () => {
    const site = { crawlers: {}, operators: { google: "challenge" as const } };
    expect(
      resolveAiCrawlAction(crawler("google-extended"), site, AI_CRAWL_GLOBAL_DEFAULTS).action,
    ).toBeNull();
    expect(
      aiCrawlSiteSettings.safeParse({
        ...AI_CRAWL_SITE_DEFAULTS,
        crawlers: { "google-extended": "challenge" },
      }).success,
    ).toBe(false);
    expect(
      aiCrawlSiteSettings.safeParse({
        ...AI_CRAWL_SITE_DEFAULTS,
        crawlers: { "google-extended": "block" },
      }).success,
    ).toBe(true);
  });

  it("refuses unknown crawlers and operators", () => {
    expect(
      aiCrawlGlobalSettings.safeParse({ ...AI_CRAWL_GLOBAL_DEFAULTS, crawlers: { nope: "block" } })
        .success,
    ).toBe(false);
    expect(
      aiCrawlGlobalSettings.safeParse({ ...AI_CRAWL_GLOBAL_DEFAULTS, operators: { nope: "block" } })
        .success,
    ).toBe(false);
  });
});

describe("the managed robots.txt", () => {
  const robots = { managed: true, search: "yes", aiInput: "unset", aiTrain: "no" } as const;

  it("disallows blocked and challenged crawlers and states the content signals", () => {
    const actions = effectiveAiCrawlActions(
      {
        crawlers: {
          gptbot: "block",
          claudebot: "challenge",
          ccbot: "charge",
          "google-extended": "block",
        },
        operators: {},
      },
      AI_CRAWL_GLOBAL_DEFAULTS,
    );
    expect(managedRobotsTxt(robots, actions)).toBe(
      [
        "# BEGIN Edgeweir managed content",
        "User-agent: *",
        "Content-Signal: search=yes, ai-train=no",
        "Allow: /",
        "",
        "User-agent: GPTBot",
        "Disallow: /",
        "",
        "User-agent: ClaudeBot",
        "Disallow: /",
        "",
        "User-agent: Google-Extended",
        "Disallow: /",
        "",
        "# END Edgeweir managed content",
        "",
        "",
      ].join("\n"),
    );
  });

  it("is empty when unmanaged or with nothing to say", () => {
    const actions = new Map([["gptbot", "block" as const]]);
    expect(managedRobotsTxt({ ...robots, managed: false }, actions)).toBe("");
    expect(
      managedRobotsTxt(
        { managed: true, search: "unset", aiInput: "unset", aiTrain: "unset" },
        new Map(),
      ),
    ).toBe("");
  });
});

describe("pay per crawl prices", () => {
  it("converts between US dollars and millionths", () => {
    expect(priceMicros("0.01")).toBe(10000);
    expect(priceMicros("1")).toBe(1_000_000);
    expect(priceMicros("0.000001")).toBe(1);
    expect(formatPriceMicros(10000)).toBe("0.01");
    expect(formatPriceMicros(1_500_000)).toBe("1.5");
    expect(formatPriceMicros(2_000_000)).toBe("2");
  });

  it("accepts USD 0.001 to 1000 with up to six decimals", () => {
    for (const ok of ["0.001", "0.01", "1", "1000", "12.345678"])
      expect(payPerCrawlPrice.safeParse(ok).success, ok).toBe(true);
    for (const bad of ["0.0009", "1000.000001", "01", "1.", "-1", "1e3", "0.1234567", ""])
      expect(payPerCrawlPrice.safeParse(bad).success, bad).toBe(false);
  });
});
