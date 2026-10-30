# Error pages

The error pages nodes answer with: a site's templates and redirects, maintenance mode, platform pages, built-in pages, `X-Edgeweir-Error` codes and request IDs.

## Concepts

| Term | Definition |
| --- | --- |
| Site error page | An HTML template or redirect URL a site sets for a status or for **Other 4xx** / **Other 5xx**, replacing the node's built-in page and, optionally, the origin's error responses. |
| Maintenance mode | The site is paused: every request but those from allowed addresses and paths gets the 503 maintenance page. |
| Platform error page | An HTML template for unknown hosts and disabled sites, in force for every cluster. |
| Built-in page | The page nodes use without a template, in Chinese or English by `Accept-Language`. |
| `X-Edgeweir-Error` | The response header of error responses a node generates itself; its value is an error code (such as `policy-denied`) that says why the request was refused or failed. |
| Request ID | The ID a node settles for each request; it appears in the `X-Request-Id` response header, in error pages and in sampled logs. |
| Offline host | A domain of a disabled site; nodes answer it with the platform's disabled page instead of the unknown host page. |

## Set a site's error pages

Page: **Sites** → the site → the **Error pages** tab (`/sites/<site ID>?tab=errors`). The tab holds the **Maintenance mode** card on top (see [Maintenance mode](#maintenance-mode)) and the **Error pages** card below.

1. In the **Error pages** card, find the row of the status. The switch at the top right of the row chooses **HTML template** or **Redirect to URL**.
2. **HTML template**: enter the template in the field; its size shows as "{bytes} / 65,536 bytes". To send it with another status, fill in **Response status**. **Redirect to URL**: enter the URL (placeholder example `/error?code={{status}}`). Rows left empty use the built-in page.
3. To replace errors the origin returns itself, turn on **Replace origin error responses**.
4. Click **Save**. The console publishes a new configuration revision of the site's cluster ("Error pages of {site} updated"); nodes hot-update without reloading nginx.
5. Verify:

   ```bash
   curl -s -D - -H 'Host: www.example.com' http://<node IP>/<a path a rule denies>
   ```

   The answer is 403 with `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store` and the template.

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| Mode | **HTML template** / **Redirect to URL** | **HTML template** | One page per status, one or the other; the switch is hidden while an active node of the cluster lacks `site-content-v1` |
| Template | HTML, 1–65536 bytes (UTF-8) | Empty (built-in page) | Rules in [Templates](#templates); over the limit the field shows "The {status} error page is larger than 65,536 bytes" and cannot be saved |
| Redirect URL | See [Redirect pages](#redirect-pages) | Empty | An invalid URL shows "Check “Redirect to URL”" and cannot be saved |
| Response status | A whole number of 200–599 | Empty (keeps the status) | Template pages only; out of range it shows "A whole number from 200 to 599" |
| Replace origin error responses | On / off | Off | See "Replace origin error responses" below |

The bottom of the card lists the placeholders templates can use ("Variables (values are HTML-escaped):"). Saving replaces every page: a row cleared deletes that status's page. Changes are audited as `site.error_pages_update` (the statuses that changed, template sizes and redirect pages, not the templates).

| Status | Responses that use the page | `X-Edgeweir-Error` |
| --- | --- | --- |
| 400 Bad request | Requests the node cannot parse, request headers too large, plain HTTP on an HTTPS port (when the site is known); a request body the OWASP CRS cannot parse | `bad-request`, `header-too-large`, `https-required`, `waf-blocked` |
| 401 Unauthorized | [Access authentication](access-control.en.md) by Basic without or with wrong credentials (with `WWW-Authenticate`); also to replace the origin's 401 | `auth-required`; the origin's `origin-error` |
| 403 Forbidden | Rule and IP list denials (including rate limit rules set to 403), bans and automatic CC bans, OWASP CRS blocks, WebSocket upgrades while WebSocket is off, signed URLs that fail, forward authentication refusals, [access control](access-control.en.md) refusals, a site requiring a client certificate the request lacks | `policy-denied`, `ip-banned`, `waf-blocked`, `websocket-disabled`, `auth-denied`, `auth-expired`, `ip-blocked`, `geo-denied`, `cors-origin-denied`, `hotlink-denied`, `ua-denied`, `websocket-origin-denied`, `client-cert-required` |
| 404 Not found | Only to replace errors the origin returns | `origin-error` |
| 405 Method not allowed | Methods an S3 origin does not take | `method-not-allowed` |
| 410 Gone | Only to replace errors the origin returns | `origin-error` |
| 429 Too many requests | Rate limit rules, the [greylist](bans.en.md#greylist) rate limit, the Basic failure limit | `policy-denied`, `ip-greylisted`, `auth-rate-limited` |
| 500 Server error | The node failed while handling the request (when the site is known) | `internal-error` |
| 502 Bad gateway | The node cannot connect to the origin, every origin was dropped before the attempt, origin signing failed | `origin-unreachable`, `no-origin`, `origin-signing` |
| 503 Service unavailable | The node cannot complete a check for now (for example, challenge keys not delivered yet, a missing rate limit partition), the forward authentication service is unavailable | `challenge-unavailable`, `policy-unavailable`, `rate-limit-unavailable`, `auth-unavailable` |
| 504 Gateway timeout | The origin timed out | `origin-timeout` |
| Other 4xx / Other 5xx | The 4xx / 5xx without a page of their own above: the node's 413 and 414, other statuses from the origin | As for the status |
| The status a rule sets | A rule's **Custom response** with **Use error page** on (4xx, 5xx), see [WAF actions](rules.en.md#waf-actions) | `rule-response` |

| Lookup order | Description |
| --- | --- |
| 1 | The status's own page |
| 2 | **Other 4xx** or **Other 5xx** |
| 3 | The built-in page; an origin error without a page passes through |

| Item | Behavior |
| --- | --- |
| Replace origin error responses | When on and the origin itself returns 400–599 and the lookup finds a page of the site, the node returns that page instead (`origin-error`) and drops the origin's `Content-Encoding`, `ETag`, `Last-Modified` and `Expires`; without a page the origin's response passes through |
| 401 | With `WWW-Authenticate`, always status 401: when the 401 page is a redirect page, the **Other 4xx** template page is used instead, else the built-in page; **Response status** does not apply |
| Maintenance mode | Its 503 uses the maintenance page, not the 503 page, see [Maintenance mode](#maintenance-mode) |
| Stale content first | When a rule sets **Stale if error (s)** and the node holds an expired copy, the stale copy wins over the error page; once the expired copy may no longer be served, the answer is the 502 page (`origin-unreachable`) |
| Not cached | Error pages carry `Cache-Control: no-store`, and nodes never store them in the cache |
| Other statuses | The node's own 404 (ACME challenge not found), 421 (`sni-host-mismatch`), 508 (`loop-detected`) and others stay plain text; a non-GET/HEAD request without a pass refused by a challenge (`X-Edgeweir-Challenge: required`) is plain text too; answers to the PURGE method are JSON |

## Redirect pages

With **Redirect to URL**, responses of that status become a 302 redirect.

| Item | Rule |
| --- | --- |
| URL | An absolute `http://` / `https://` URL or a path starting with a single `/`; 1–2048 printable ASCII characters without spaces or `\`; every `%` followed by two hex digits |
| Host of an absolute URL | A dotted-quad IPv4 address, a domain whose last label starts with a letter, or a bracketed IPv6 address; no user information, an optional port |
| Placeholders | Only `{{status}}` and `{{request_id}}`, not in the host or port, URL-encoded when inserted, e.g. `/error?code={{status}}&id={{request_id}}` |
| Response | 302, `Location`, `Cache-Control: no-store`, `X-Edgeweir-Error`, an empty body |
| Response status | Redirect pages are always 302; an HTML template page can set 200–599 to change the status it is sent with, empty keeps the status |

## Maintenance mode

In the **Maintenance mode** card on the **Error pages** tab, turn on **Enabled**, fill in **Retry-After (seconds)**, **Allowed addresses**, **Allowed path prefixes** and **Maintenance page** as needed, and click **Save**. The other settings are kept while it is off.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Enabled | On / off | Off | Turns maintenance mode on |
| Retry-After (seconds) | A whole number of 0–86400 | 0 (not sent) | `Retry-After` of the 503 response |
| Allowed addresses | IPs or CIDRs of at most 64 characters each, up to 64; separated by commas, spaces or new lines; host bits are cleared, IPv4-mapped `::ffff:` addresses are saved as the IPv4 they map, mapped prefixes under /96 are refused (as in IP lists); duplicates merge | Empty | Requests from these addresses are served as usual |
| Allowed path prefixes | Start with `/`, no `?`, `#` or control characters, at most 1024 bytes of UTF-8 each, up to 32; separated as above | Empty | Requests whose path starts with one of them are served as usual |
| Maintenance page | HTML template of 0–65536 bytes, rules as for [templates](#templates) | Empty (built-in maintenance page) | The page of the 503 response |

| Item | Behavior |
| --- | --- |
| Response | 503, `X-Edgeweir-Error: maintenance`, `Cache-Control: no-store`; no cache lookup and no origin request, and nothing answered during maintenance enters the cache |
| Where | After bans and PURGE, before the rules; allowed addresses are matched against the visitor address (the rules' `ip.src`, set by the cluster's [client IP](../deploy/nodes.en.md#client-ip)), allowed prefixes against the normalized path before rule rewrites |
| ACME | HTTP-01 validation requests for certificates are not affected |
| Applying | Saving publishes a revision ("Maintenance of {site} updated"); nodes hot-update |
| Audit | `site.maintenance_update` (the fields and the page's size, not the page) |
| Usage protection | The **Turn on maintenance** action of [usage protection](usage-protection.en.md) switches **Enabled** only and keeps the other settings saved here; turning maintenance off here restores that action by hand |
| Node requirement | `site-content-v1`; while an active node of the cluster lacks it, the card shows "Some nodes in the cluster do not support it" and maintenance cannot be turned on; it can be turned off |

## Templates

| Item | Rule |
| --- | --- |
| Size | 1–65536 bytes (UTF-8) per template; the maintenance page may be empty |
| Content | Sent as is; nodes neither check nor escape the template itself, and the site answers for the scripts, styles and images it references |
| Placeholders | The six below; values are HTML-escaped (`&`, `<`, `>`, `"`, `'`) before they are inserted; any other `{{…}}` stays as it is |
| Response headers | `Content-Type: text/html; charset=utf-8`, `Cache-Control: no-store`, `X-Edgeweir-Error`, `X-Request-Id` |

| Placeholder | Value |
| --- | --- |
| `{{status}}` | The status, e.g. `403` |
| `{{request_id}}` | The request ID, the same as the `X-Request-Id` response header |
| `{{client_ip}}` | The visitor's IP, the same as `ip.src` in rules (under the cluster's [client IP](../deploy/nodes.en.md#client-ip) setting) |
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
| Authentication required / Access denied / Too many requests / Origin unreachable / Service unavailable / Origin timed out | 401 / 403 / 429 / 502 / 503 / 504 | See the status table of [Set a site's error pages](#set-a-sites-error-pages) |
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

Page: **System settings** → the **General** tab → the **Platform error pages** card. Its fields are the two templates **Unknown host** and **Site disabled**, with the rules of site templates; empty fields use the built-in page. Saving publishes a revision for every cluster ("Platform error pages updated") and is audited as `system.error_pages_update`, see [System settings](system.en.md#platform-error-pages). A template that uses `{{time}}` or `{{path}}` makes the card note "{time} and {path} need rules-v3; older nodes keep their last configuration".

| Field | Requests it applies to | Status | `X-Edgeweir-Error` |
| --- | --- | --- | --- |
| Unknown host | The Host belongs to no site of the cluster and is no offline host, while the cluster's [unknown host settings](domains.en.md#unknown-hosts-and-node-ip-access) are **Unknown host page (404)** | 404 | `unknown-host` |
| Site disabled | The Host is a domain of a disabled site | 503 | `site-disabled` |

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
| Site error pages | Node feature `error-pages-v1`; while an active node of the cluster lacks it, the **Error pages** card shows "Some nodes in the cluster do not support it" and its rows cannot be edited |
| Platform error pages, offline hosts | No feature needed; older nodes ignore them, keep their plain-text answers and answer offline hosts with 404 |
| `{{time}}`, `{{path}}` | A site template or platform page that uses them makes the configuration need the node feature `rules-v3`; while an active node of the site's cluster lacks it, the **Error pages** card leaves the two placeholders out and shows "Some nodes in the cluster do not support it" when a template uses them. Nodes without the feature keep their last-known-good configuration, see [Node capabilities and publishing](rules.en.md#node-capabilities-and-publishing) |
| Built-in pages for refused requests and internal errors | No feature needed; older nodes answer with nginx's own error pages |
| 400, 401, 404, 405, 410, 500, **Other 4xx**, **Other 5xx**, redirect pages, response status, maintenance mode | Node feature `site-content-v1`; while an active node of the cluster lacks it, the **Error pages** card takes new templates for 403, 429, 502, 503 and 504 only, hides the **HTML template** / **Redirect to URL** switch and **Response status**, and shows "Some nodes in the cluster do not support it"; pages already saved can still be changed or cleared |
| Saving through the API | The console account (session or access key) publishes changes that need a new feature as usual; nodes without it show **Upgrade required** and keep their previous configuration |
| Template space | Templates travel with the site table into the node's shared memory; with many sites and large templates raise the node flag `--sites-dict-mb` (default 64) |

## API

| Operation | Procedure | Method and path (`/api/v1`) |
| --- | --- | --- |
| Read a site's error pages | `errorPages.get` | `GET /sites/{id}/error-pages` |
| Save a site's error pages | `errorPages.update` | `PUT /sites/{id}/error-pages` |
| Read maintenance mode | `maintenance.get` | `GET /sites/{id}/maintenance` |
| Save maintenance mode | `maintenance.update` | `PUT /sites/{id}/maintenance` |
| Read the platform pages | `settings.errorPages` | `GET /settings/error-pages` |
| Save the platform pages | `settings.setErrorPages` | `PUT /settings/error-pages` |

| Request | Fields |
| --- | --- |
| `PUT /sites/{id}/error-pages` | `pages`: at most 13 entries, at most one per status, `{ status, template, redirectUrl, responseStatus }`; `status` is 400, 401, 403, 404, 405, 410, 429, 500, 502, 503, 504 or `"4xx"`, `"5xx"`; either `template` or `redirectUrl`; `responseStatus` is 0 (unchanged) or 200–599, and 0 for redirect pages. `interceptOriginErrors` (default `false`). Optional `expectedUpdatedAt`. Replaces every page |
| `PUT /sites/{id}/maintenance` | `enabled`, `template` (default `""`), `retryAfterSeconds` (default 0), `allowedCidrs`, `allowedPathPrefixes` (default `[]`), optional `expectedUpdatedAt` |
| `PUT /settings/error-pages` | `unknownHost`, `siteDisabled` (default `""`) |

`updatedAt` in responses is `null` until the first save. A read-only access key can call `GET` only; service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`). Full field descriptions: [API reference](../reference/api.en.md).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Still a plain-text error | The node is too old; the node's own status has no page (404, 421, 508) | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| An error page ending in "openresty" | The node is too old: that is nginx's own page | Upgrade the node |
| The origin's error page is not replaced | **Replace origin error responses** is off, or neither the status nor its class has a page | Turn it on and set a page for the status or for **Other 4xx** / **Other 5xx** |
| The redirect URL shows "Check “Redirect to URL”" | The URL is no `http(s)` URL or path starting with a single `/`, has spaces or other placeholders, has a placeholder in the host, or exceeds 2048 characters | Fix the URL; use only `{{status}}` and `{{request_id}}` |
| "A whole number from 200 to 599" | **Response status** is out of range or not a whole number | Enter 200–599, or leave it empty |
| Saving shows "The {status} error page is larger than 65536 bytes" (`ERROR_PAGE_TOO_LARGE`, 400) | The template exceeds 64 KiB in UTF-8 | Shorten the template; host large images elsewhere |
| Saving shows "It changed since you loaded it; reload and try again" (`UPDATED_AT_MISMATCH`, 409) | The error pages or maintenance mode changed in another session after they were read | Reload the page and make the change again |
| "Invalid input" (`BAD_REQUEST`, 400) | An API request has invalid fields: both or neither of template and redirect URL, a status twice, `responseStatus` on a redirect page, an allowed address that is no IP or CIDR | Fix the request as in [API](#api) |
| "Some nodes in the cluster do not support it", fields locked | An active node of the cluster lacks `error-pages-v1`, `site-content-v1` or `rules-v3` | Upgrade the nodes, see [Node requirements](#node-requirements) |
| Every visitor sees the maintenance page | Maintenance mode is on and the visitor's address and path are not allowed | Turn maintenance off, or add allowed addresses or path prefixes |
| Maintenance turned itself on | Usage protection's action is **Turn on maintenance** and a limit was reached | See [Usage protection](usage-protection.en.md) |
| An allowed address still gets the maintenance page | With a proxy in front of the node and the cluster's client IP set to direct, the visitor address is the proxy's | Set the cluster's [client IP](../deploy/nodes.en.md#client-ip) to PROXY protocol or a trusted proxy header, or allow the proxy's range |
| A disabled site answers 404 | The node is too old to know offline hosts | Upgrade the node |
| The request ID of a page is not in the logs | Access logs are off or the request was not sampled | Raise the sample rate on the **Logs** tab, or turn on **Always log blocked, challenged and refused requests** |
