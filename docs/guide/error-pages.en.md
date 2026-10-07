# Error pages

The error pages nodes answer with: a site's templates and redirects, maintenance mode, platform templates, built-in pages, and the request ID of every request.

## Concepts

| Term | Definition |
| --- | --- |
| Site error page | An HTML template or redirect URL a site sets for a status or for **Other 4xx** / **Other 5xx**, replacing the node's built-in page and, optionally, the origin's error responses. |
| Maintenance mode | The site is paused: every request but those from allowed addresses and paths gets the 503 maintenance page. |
| Platform error page | An HTML template for unknown hosts and disabled sites. |
| Built-in page | The page nodes use without a template, in Chinese or English by `Accept-Language`. |
| Request ID | The ID a node settles for each request; it appears in the `X-Request-Id` response header, in error pages and in sampled logs. |
| Offline host | A domain of a disabled site; nodes answer it with the platform's disabled page instead of the unknown host page. |

## Set a site's error pages

1. Open **Sites**, select the site, and go to the **Error pages** tab.
2. Enter an HTML template in the field of a status; statuses left empty use the built-in page. To redirect instead, choose **Redirect to URL** above the status and enter the URL; a template page can change the status it is sent with in **Response status**.
3. To replace errors the origin returns itself, turn on **Replace origin error responses**.
4. Click **Save**. The console publishes a revision ("Error pages of {site} updated"); nodes hot-update without a reload.
5. Verify:

   ```bash
   curl -s -D - -H 'Host: www.example.com' http://<node IP>/<a path a rule denies>
   ```

   The answer is 403 with `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store` and the template.

| Status | Responses that use the page | `X-Edgeweir-Error` |
| --- | --- | --- |
| 403 Forbidden | Rule and IP list denials (including rate limit rules set to 403), bans and automatic CC bans, OWASP CRS blocks, WebSocket upgrades while WebSocket is off | `policy-denied`, `ip-banned`, `waf-blocked`, `websocket-disabled` |
| 429 Too Many Requests | Rate limit rules | `policy-denied` |
| 502 Bad Gateway | The node cannot connect to the origin, every origin was dropped before the attempt, origin signing failed | `origin-unreachable`, `no-origin`, and others |
| 503 Service Unavailable | The node cannot complete a check for now (for example, challenge keys not delivered yet) | `challenge-unavailable`, `policy-unavailable` |
| 504 Gateway Timeout | The origin timed out | `origin-timeout` |
| 400 Bad request | Requests the node cannot parse, request headers too large, plain HTTP on an HTTPS port (when the site is known) | `bad-request`, `header-too-large`, `https-required`, `waf-blocked` |
| 405 Method not allowed | Methods an S3 origin does not take | `method-not-allowed` |
| 500 Server error | The node failed while handling the request (when the site is known) | `internal-error` |
| 401 Unauthorized, 404 Not found, 410 Gone | Only to replace errors the origin returns | `origin-error` |
| Other 4xx / Other 5xx | The 4xx / 5xx without a page of their own above: the node's 413 and 414 and other statuses from the origin | As for the status |

| Lookup order | Description |
| --- | --- |
| 1 | The status's own page |
| 2 | **Other 4xx** or **Other 5xx** |
| 3 | The built-in page; an origin error without a page passes through |

| Item | Behavior |
| --- | --- |
| Replace origin error responses | When on and the origin itself returns 400–599 and the lookup finds a page, the node returns that page instead (`origin-error`); without a page the origin's response passes through |
| Stale content first | When a rule sets **Stale if error (s)** and the node holds an expired copy, the stale copy wins over the error page; once the expired copy may no longer be served, the answer is the 502 page (`origin-unreachable`) |
| Not cached | Error pages carry `Cache-Control: no-store`, and nodes never store them in the cache |
| Other statuses | The node's own 404 (ACME challenge not found), 421, 508 and others stay plain text; a non-GET/HEAD request without a pass refused by a challenge (`X-Edgeweir-Challenge: required`) is plain text too |
| Audit | Changes are audited as `site.error_pages_update` (the statuses that changed and their sizes, not the templates) |

## Redirect pages

With **Redirect to URL**, responses of that status become a 302 redirect.

| Item | Rule |
| --- | --- |
| URL | An absolute `http://` / `https://` URL (lower-case scheme, a domain or a bracketed IPv6 address as host, no user information, an optional port) or a path starting with a single `/`; 1–2048 printable ASCII characters without spaces or `\`; every `%` followed by two hex digits |
| Placeholders | Only `{{status}}` and `{{request_id}}`, URL-encoded when inserted, e.g. `/error?code={{status}}&id={{request_id}}` |
| Response | 302, `Location`, `Cache-Control: no-store`, `X-Edgeweir-Error`, an empty body |
| Response status | Redirect pages are always 302; an HTML template page can set 200–599 to change the status it is sent with, empty keeps the status |

## Maintenance mode

In the **Maintenance mode** card on the **Error pages** tab, turn on **Enabled**, fill in **Retry-After (seconds)**, **Allowed addresses**, **Allowed path prefixes** and **Maintenance page** as needed, and click **Save**. The other settings are kept while it is off.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Enabled | On / off | Off | Turns maintenance mode on |
| Retry-After (seconds) | 0–86400 | 0 (not sent) | `Retry-After` of the 503 response |
| Allowed addresses | IPs or CIDRs, up to 64; IPv4-mapped `::ffff:` addresses are saved as the IPv4 they map | Empty | Requests from these addresses are served as usual |
| Allowed path prefixes | Start with `/`, no query or fragment, at most 1024 bytes of UTF-8 each, up to 32 | Empty | Requests whose path starts with one of them are served as usual |
| Maintenance page | HTML template, rules as for [templates](#templates) | Empty (built-in maintenance page) | The page of the 503 response |

| Item | Behavior |
| --- | --- |
| Response | 503, `X-Edgeweir-Error: maintenance`, `Cache-Control: no-store`; no cache lookup and no origin request, and nothing answered during maintenance enters the cache |
| Where | After bans and PURGE, before the rules; allowed addresses are matched against the visitor's TCP address, allowed prefixes against the normalized path before rule rewrites |
| ACME | HTTP-01 validation requests for certificates are not affected |
| Applying | Saving publishes a revision ("Maintenance of {site} updated"); nodes hot-update |
| Audit | `site.maintenance_update` |
| Node requirement | `site-content-v1`; while an active node of the cluster lacks it, maintenance cannot be turned on, but it can be turned off |

## Templates

| Item | Rule |
| --- | --- |
| Size | 1–65536 bytes (UTF-8) per template |
| Content | Sent as is; nodes neither check nor escape the template itself, and the site answers for the scripts, styles and images it references |
| Placeholders | The six below; values are HTML-escaped (`&`, `<`, `>`, `"`, `'`) before they are inserted; any other `{{…}}` stays as it is |
| Response headers | `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Edgeweir-Error`, `X-Request-Id` |

| Placeholder | Value |
| --- | --- |
| `{{status}}` | The status, e.g. `403` |
| `{{request_id}}` | The request ID, the same as the `X-Request-Id` response header |
| `{{client_ip}}` | The visitor's IP, i.e. the TCP client address (the same as `ip.src` in rules) |
| `{{host}}` | The request's Host, lowercase, without the port; empty when the request has no valid Host |
| `{{time}}` | When the node answered, UTC, RFC 3339, e.g. `2026-10-06T12:34:56Z`; needs `rules-v3` |
| `{{path}}` | The request path (`$uri` after nginx normalization, the same as `http.request.uri.path` in rules: the rewritten path after a rewrite); needs `rules-v3` |

Example:

```html
<!doctype html>
<html lang="en">
<meta charset="utf-8">
<title>{{status}}</title>
<h1>We could not complete your request</h1>
<p>Request ID: {{request_id}}</p>
<p>{{time}} · {{path}}</p>
```

## Built-in pages

Without a template, nodes answer with a self-contained built-in page: no external resources, no script, light or dark with the system. The page shows the status and the path from the visitor through the edge node to the origin, marking the hop that failed (the visitor, the edge node or the origin) and its state; below come the title, what the visitor can do, **Reload** where reloading can help, and the request ID, the time the node answered (UTC), the host and the visitor's IP (shown on click). Motion is CSS only and stops when the system asks for reduced motion. The language is Chinese or English, whichever ranks highest in `Accept-Language`; English when neither is listed.

| Page | Status | `X-Edgeweir-Error` |
| --- | --- | --- |
| Access denied / Too many requests / Origin unreachable / Service unavailable / Origin timed out | 403 / 429 / 502 / 503 / 504 | See above |
| Method not allowed | 405 | `method-not-allowed` |
| Under maintenance | 503 | `maintenance` |
| Site not found | 404 | `unknown-host` |
| Site disabled | 503 | `site-disabled` |

Requests the node refuses and the node's internal errors use the site's pages in the [lookup order](#set-a-sites-error-pages) when the site is known, else the built-in page. A refused request marks the visitor on the path, an internal error the edge node:

| Page | Status | Requests | `X-Edgeweir-Error` |
| --- | --- | --- | --- |
| Bad request | 400 | Requests that do not parse (for example a TLS handshake on an HTTP port), a missing or invalid Host; a request body the OWASP CRS cannot parse | `bad-request`; `waf-blocked` when the CRS refuses it |
| Request header too large | 400 | A request header over 8 KB or all headers over 32 KB, usually too many cookies | `header-too-large` |
| HTTPS required | 400 | Plain HTTP sent to an HTTPS port | `https-required` |
| URL too long | 414 | A request line over 8 KB | `uri-too-long` |
| Request too large | 413 | A request body over the site's or a rule's [request body limit](origins-and-cache.en.md#request-body-limit), or a chunked request over the node-wide limit | `body-too-large` |
| Edge error | 500 | The node failed while handling the request | `internal-error` |

## Platform error pages

Set them under **System settings → Platform error pages**, with the rules of site templates; empty fields use the built-in page. Saving publishes a revision for every cluster ("Platform error pages updated") and is audited as `system.error_pages_update`, see [System settings](system.en.md#platform-error-pages).

| Field | Requests it applies to | Status |
| --- | --- | --- |
| Unknown host | The Host belongs to no site of the cluster and is no offline host | 404 |
| Site disabled | The Host is a domain of a disabled site | 503 |

Nodes recognize disabled sites from the offline host list in their configuration (the domains of disabled sites); wildcards match as site domains do. Once the site is enabled again, the host is served again; once the site is deleted or the domain removed from it, the host is no offline host any more and answers 404. Both pages are for HTTP requests only: nodes complete no TLS handshake for these hosts, so HTTPS requests fail in the handshake.

## Request IDs

| Item | Behavior |
| --- | --- |
| Settled | An `X-Request-Id` request header matching `^[A-Za-z0-9._:-]{8,128}$` is kept; otherwise the node generates a 32-character hexadecimal ID |
| Response | Every response carries `X-Request-Id`; an `X-Request-Id` the origin returns is replaced |
| Origin | Forwarded to the origin as the `X-Request-Id` request header |
| Logs | Sampled access logs record it; the **Logs** tab looks it up exactly by **Request ID**, and the CSV has a `requestId` column, see [Access logs](access-logs.en.md) |

## Node requirements

| Feature | Requirement |
| --- | --- |
| Site error pages | Node feature `error-pages-v1`; while an active node of the cluster lacks it, pages cannot be saved ("Some nodes of the site's cluster do not support it yet") |
| Platform error pages, offline hosts | No feature needed; older nodes ignore them, keep their plain-text answers and answer offline hosts with 404 |
| `{{time}}`, `{{path}}` | A site template or platform page that uses them makes the configuration need the node feature `rules-v3`; while an active node of the site's cluster lacks it, the **Error pages** tab leaves the two placeholders out and shows "Some nodes of the site's cluster do not support it yet" when a template uses them; a platform page that uses them shows "{{time}} and {{path}} need nodes with rules-v3; older nodes keep their last configuration". Nodes without the feature keep their last-known-good configuration, see [Node capabilities and publishing](rules.en.md#node-capabilities-and-publishing) |
| Built-in pages for refused requests and internal errors | No feature needed; older nodes answer with nginx's own error pages |
| 400, 401, 404, 405, 410, 500, **Other 4xx**, **Other 5xx**, redirect pages, response status, maintenance mode | Node feature `site-content-v1`; while an active node of the cluster lacks it, the **Error pages** tab lists only the original five statuses, offers no redirect or response status, and shows "Some nodes of the site's cluster do not support it yet" |
| Template space | Templates travel with the site table into the node's shared memory; with many sites and large templates raise the node flag `--sites-dict-mb` (default 64) |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Still a plain-text error | The node is too old; the node's own status has no page (404, 421, 508) | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| An error page ending in "openresty" | The node is too old: that is nginx's own page | Upgrade the node |
| The origin's error page is not replaced | **Replace origin error responses** is off, or neither the status nor its class has a page | Turn it on and set a page for the status or for **Other 4xx** / **Other 5xx** |
| The redirect URL shows "Check “Redirect to URL”" | The URL is no `http(s)` URL or path starting with `/`, has spaces or other placeholders, or exceeds 2048 characters | Fix the URL; use only `{{status}}` and `{{request_id}}` |
| Every visitor sees the maintenance page | Maintenance mode is on and the visitor's address and path are not allowed | Turn maintenance off, or add allowed addresses or path prefixes |
| An allowed address still gets the maintenance page | With a proxy in front of the node, the TCP address is the proxy's | Allow the proxy's range, or allow on the proxy |
| Saving shows "The … error page is larger than 65536 bytes" | The template exceeds 64 KiB in UTF-8 | Shorten the template; host large images elsewhere |
| A disabled site answers 404 | The node is too old to know offline hosts | Upgrade the node |
| The request ID of a page is not in the logs | Access logs are off or the request was not sampled | Raise the sample rate on the **Logs** tab |
