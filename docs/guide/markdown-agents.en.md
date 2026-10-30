# Markdown for Agents

When a request lists `text/markdown` in `Accept`, the node converts the site's HTML response to Markdown for AI agents and crawlers; browsers and other clients still get HTML. The behaviour is compatible with Cloudflare's Markdown for Agents. When conversion fails or is out of range, the original HTML is returned.

## Concepts

| Term | Definition |
| --- | --- |
| Markdown request | A GET or HEAD whose `Accept` names `text/markdown` with q > 0. `text/*` and `*/*` do not count. |
| Eligible path | The last path segment has no extension, or one of `html` `htm` `xhtml` `shtml` `php` `asp` `aspx` `jsp` `jspx` `cfm` `cgi` `pl` `do` `action` (case-insensitive); the path starts with an include prefix (no include prefixes: every path) and with no exclude prefix. |
| Variant | A cached request has two cached objects under one URL: HTML and Markdown. The cache key separates only these two, not the visitor's `Accept`. |
| Markdown responses | Complete 200 GET responses returned as Markdown (cache hits included). |

## Turning it on

1. Open **Sites** → choose a site → the **Cache** tab.
2. On the **Markdown for Agents** card, turn on **Enabled**, fill in include and exclude path prefixes if needed (one per line), and click **Save**.
3. The **Markdown responses** card shows the number of Markdown responses in the chosen range.

No cache rule is needed: uncached requests are converted every time. Settings apply live without reloading nginx. When an active node in the cluster does not support `markdown-v1`, the card shows that some nodes do not support it; a site that has it on can still turn it off.

## Settings

| Setting | Default | Range | Notes |
| --- | --- | --- | --- |
| Enabled | Off | — | Turning it off keeps the prefixes |
| Include prefixes | Empty (every path) | Up to 32, each up to 256 bytes | Visible ASCII starting with `/`, compared byte by byte, case-sensitive |
| Exclude prefixes | Empty | Same | Win over include prefixes |

## Behaviour

| Case | Result |
| --- | --- |
| The path is not eligible | Not converted; the response is the same as when off, without `Vary: Accept` |
| An eligible path returns `text/html`, `application/xhtml+xml` or `text/markdown` | The response carries `Vary: Accept` (HTML too) |
| Markdown request | The node fetches the whole document from the origin (no ranges; HEAD is fetched as GET) and converts a 2xx `text/html` to `text/markdown; charset=utf-8` |
| Converted document | YAML frontmatter (`title`, `description`, `image`, from `<meta name>`, then `og:`, with `<title>` as the last fallback for the title), the body, then the page's JSON-LD (a `json` code block). Navigation, page headers and footers, sidebars, forms, scripts, styles and hidden elements are removed; when the page has exactly one visible `<main>` (or `role="main"`), only that is converted. Headings, lists, links, images, tables, code and quotes are kept; link and image URLs become absolute (from `<base href>` and the page URL) |
| Response headers | `X-Markdown-Tokens` (an estimated token count); `Content-Signal: ai-train=yes, search=yes, ai-input=yes` when the origin sends no `Content-Signal`; `ETag`, `Last-Modified`, `Content-Encoding`, `Content-Range` and `Accept-Ranges` are dropped |
| Charset | From the `Content-Type` `charset`, then the document's own declaration (GBK, Shift_JIS, …); the output is always UTF-8 |
| The origin's response is not 2xx (or is 204, 205 or 206), not HTML, over 6 MiB (after gzip decoding), has a `Content-Encoding` other than gzip, or converts to nothing (a single-page app that is only scripts) | Passed through unchanged and cached as usual under the Markdown variant |
| Conversion fails or times out | The original HTML, cached as usual |
| The node is busy (conversion slots or memory taken, waiting 1 second), or the origin did not send the whole document within `--markdown-timeout` | The original HTML, cached for at most 60 seconds, then retried |
| Cache hit | The cached Markdown, without converting again |
| Purge by URL, prefix, host or Cache-Tag, or clearing the site's cache | Purges the HTML and Markdown variants together |
| Range | Not split; the whole Markdown is returned |

Markdown responses count complete 200 GET responses only; HEAD is not counted.

## Limits on the node

Conversions run in child processes of the node agent, each on one CPU. These are node flags (also settable as environment variables `EDGEWEIR_<NAME>`); restart `edgeweir-node` after changing them:

| Flag | Default | Notes |
| --- | --- | --- |
| `--markdown-workers` | min(4, max(1, CPUs / 2)) | Concurrent conversions; 0 turns conversion off and the node does not report `markdown-v1` |
| `--markdown-memory-mb` | `512` | Memory the running conversions may use together. Each conversion is estimated from the HTML's size (24 × bytes + 48 MiB); HTML waiting to be converted counts against the same total in the agent's memory |
| `--markdown-timeout` | `5s` | Longest single conversion; on timeout the original HTML is returned |

A 300 KB page converts in about 10 milliseconds.

## Checking

```bash
# Markdown: MISS the first time, HIT the second
curl -s -D - -H 'Accept: text/markdown' https://docs.example.com/guide/ | head -20
# Browsers get HTML
curl -s -o /dev/null -D - -H 'Accept: text/html' https://docs.example.com/guide/ | grep -iE '^(x-cache|content-type|vary):'
```

The node log has one `Markdown converted` line per conversion (HTML bytes, Markdown bytes, time); failures and timeouts log `Markdown conversion failed` / `Markdown conversion timed out`, and a busy node logs `HTML kept for now`.

## Limitations

- Only HTML is converted; PDF, images, JSON and the rest pass through unchanged.
- JavaScript is not run: pages rendered by scripts return the original HTML.
- For cached URLs, the HTML and the Markdown each take their own cache space.
- Agents and browsers are not told apart: any request that lists `text/markdown` gets Markdown.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Always HTML | Whether `Accept` names `text/markdown` explicitly; whether the path is eligible (extension, include and exclude prefixes); whether the origin returns a 2xx `text/html` of at most 6 MiB; whether the page is rendered by scripts; the node log |
| The card cannot be turned on | Upgrade every active node in the cluster to a version that supports `markdown-v1`, and do not run them with `--markdown-workers 0` |
| **Markdown responses** says some nodes are not counted | Active nodes in the cluster do not support `markdown-v1`; their responses are not counted |
| The Markdown lacks content | The content sits in `<nav>`, `<aside>`, a page-level `<header>` / `<footer>` or a hidden element; or the page has one `<main>` and the content is outside it |
