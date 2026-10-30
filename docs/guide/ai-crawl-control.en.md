# AI crawlers

Recognize requests that claim to be AI crawlers and verify them; allow, block, challenge or charge them per crawler or operator; manage robots.txt; see crawler traffic per site.

## Concepts

| Term | Definition |
| --- | --- |
| Catalogue | The crawler list built into the console: operator, purpose, User-Agent tokens, how to verify. It changes with console releases; nodes get it in their configuration and never download it at runtime. |
| Claim | The User-Agent contains one of a crawler's tokens (case-insensitive; with several matches the longest token wins, then the smaller id). |
| Verification | Verified: the address is in the operator's published ranges, or its reverse DNS name is in the operator's domains and resolves back to it. Impersonator: verifiable, but it failed. Unverifiable: the operator publishes no way to verify. Pending: a DNS lookup failed or has not finished. |
| Action | Allow, block, challenge, charge; none: the request is only tagged. |
| Pay per crawl | The pay per crawl protocol: HTTP 402 and price headers. Only the protocol; no payments are processed. |

## Catalogue

| Operator | Crawlers | Purpose | Verification |
| --- | --- | --- | --- |
| OpenAI | GPTBot, OAI-SearchBot, ChatGPT-User | Training, AI search, assistant | Published ranges |
| Anthropic | ClaudeBot, Claude-SearchBot, Claude-User | Training, AI search, assistant | Unverifiable |
| Google | Googlebot, Google-CloudVertexBot, Google-Extended | Search engine, training | Published ranges / reverse DNS; Google-Extended is a robots.txt token only |
| Microsoft | BingBot | Search engine | Published ranges / reverse DNS |
| Apple | Applebot, Applebot-Extended | AI search, training | Published ranges / reverse DNS; Applebot-Extended is a robots.txt token only |
| ByteDance | Bytespider | Training | Unverifiable |
| Perplexity | PerplexityBot, Perplexity-User | AI search, assistant | Published ranges |
| Common Crawl | CCBot | Training | Published ranges |
| DuckDuckGo | DuckAssistBot | Assistant | Published ranges |
| Huawei | PetalBot | AI search | Reverse DNS |
| Meta | Meta-ExternalAgent, Meta-ExternalFetcher, FacebookBot | Training, assistant | Unverifiable |
| Amazon | Amazonbot | Training | Reverse DNS |
| Mistral | MistralAI-User | Assistant | Published ranges |
| Cohere | cohere-ai | Training | Unverifiable |

robots.txt tokens (Google-Extended, Applebot-Extended) never appear in requests: they take allow or block only, and block goes into the managed robots.txt.

## Actions

| Action | What the node does |
| --- | --- |
| Allow | Forwards to the origin. Verified crawlers also skip Under Attack and CC challenges. |
| Block | Answers 403 (the built-in error page) or 402, optionally with your text. `X-Edgeweir-Error: ai-crawler-blocked`. |
| Challenge | Challenges with the chosen type; a pass of that level lets the request through. |
| Charge | Pay per crawl; blocks while pay per crawl is off. |

Order: the site's crawler action → the site's operator action → the global crawler action → the global operator action. Block, challenge and charge apply to every claimant, whatever the verification; the **Impersonators** setting (none / block / challenge) also applies to failed verifications, and a blocked crawler stays blocked.

`/robots.txt` is never blocked or challenged. Actions run after the site's rules; allow rules, rules that skip challenges, allow lists and ACME validation are unaffected. Blocks are logged with the block reason `ai_crawler`, pay per crawl refusals with `pay_per_crawl`.

## Settings

1. Global: **Protection settings → Protection → AI crawlers**. With **Detect AI crawlers** on, nodes tag crawlers in access logs and statistics; here you set every site's default actions, impersonators, challenge type and block response. Saving publishes every cluster.
2. Site: **Sites → (site) → AI crawlers**, the **AI crawl control** card. Override the global actions per crawler or operator; impersonators, challenge type and block response can follow the global settings. Saving hot-updates the site's cluster.

The cluster's active nodes need `ai-crawlers-v1`; detection alone does not.

## Managed robots.txt

When on, the console writes the text below and the node puts it before the origin's robots.txt on delivery:

```text
# BEGIN Edgeweir managed content
User-agent: *
Content-Signal: search=yes, ai-train=no
Allow: /

User-agent: GPTBot
Disallow: /

# END Edgeweir managed content
```

- The `Content-Signal` line appears only when a content signal (search, ai-input, ai-train: yes / no) is set.
- Each blocked or challenged crawler gets a `Disallow: /` group; charged crawlers do not.
- Only `GET` / `HEAD` of exactly `/robots.txt`: prepended when the origin answers 200 plain text without content encoding; alone for a 404, 410 or a 200 that is not text (an application's fallback page).
- The node drops `Accept-Encoding`, `Range` and conditional request headers when it fetches the file. The change happens on delivery: the cache keeps the origin's file.

## Pay per crawl

With pay per crawl on and a price set (USD 0.001–1000), crawlers set to **Charge** get:

| Request | Response |
| --- | --- |
| No price header | 402, `crawler-price: USD 0.01`, `crawler-error: MissingCrawlerPrice` |
| `crawler-exact-price` differs from the price | 402, `InvalidCrawlerExactPrice` |
| `crawler-max-price` below the price | 402, `InvalidCrawlerMaxPrice` |
| Both price headers | 400, `ConflictingPriceHeaders` |
| Malformed price | 400, `InvalidCrawlerPriceValue` |
| Unverified crawler with a price header | 400, `StrongAuthRequired` |
| Acceptable price, origin answers 2xx | The response with `crawler-charged: USD 0.01`; access logs and statistics record the charge |

Prices are `USD` with up to 6 decimals. `/robots.txt`, `/sitemap.xml`, `/security.txt`, `/.well-known/security.txt` and `/crawlers.json` are free. Only verified crawlers can pay.

**Origin sets the price**: the origin sets a response's price in its `crawler-price` response header (without it, the site's price applies); a malformed value gives 502 `InvalidContentPrice`. `crawler-price` reaches clients only on a 402.

Nodes record charges and collect nothing; settlement needs a payment provider, which Edgeweir does not include.

## Overview

**Sites → (site) → AI crawlers**, **AI crawler traffic**, filtered by range, operator and crawler:

| Item | Meaning |
| --- | --- |
| Requests | Requests that claimed an AI crawler, against the previous range of the same length |
| Allowed / Failed | Status below 400 and not refused / the rest (refused, 4xx, 5xx) |
| Blocked | Refused by AI crawler actions (block, challenge, pay per crawl) |
| Bytes | Bytes sent to crawlers |
| Charged | Requests sent with `crawler-charged` and their amount |
| robots.txt | robots.txt requests |
| Crawler cards | Grouped by operator: each crawler's requests, allowed and failed, verified / impersonator / unverifiable |
| Top paths | Approximate: each node keeps its 64 heaviest paths a minute |

The access log's **Crawler** column and filter show the claimed crawler, its verification and the amount charged.

## Limits

- No Web Bot Auth signature verification (it needs the operators' key directories at runtime), no `cf-pay-per-crawl` request header.
- Published ranges are refreshed before console releases (`pnpm --filter @edgeweir/contract ai-crawlers:ranges`); ranges an operator adds later fail verification until the next release.
- Blocking and charging unverifiable crawlers relies on the User-Agent: an impersonator escapes a charge by not claiming the crawler.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| A real crawler shows as an impersonator | Whether its address is in this release's published ranges (new ranges from the operator); whether reverse DNS works from the node |
| robots.txt lacks the managed text | Whether the origin answers 200 `text/plain`; whether the site sets a content signal or blocks / challenges a crawler |
| Settings cannot be saved | Upgrade the cluster's active nodes to a version with `ai-crawlers-v1` |
| The overview shows little | The unsupported node count on the page; older nodes report no crawler statistics |
