# Rules, IP lists, and GeoIP

Site rules, global rules, bulk redirects, IP lists, and the node-local GeoIP databases.

## Concepts

| Term | Definition |
| --- | --- |
| Rule | An expression plus an action in one phase. Site rules apply to one site; global rules apply to every site in every cluster. |
| Phase | A fixed point in request processing where rules run; there are 9. |
| Expression | A typed, wirefilter-style condition, for example `ip.src in $blocked`. |
| Value expression | An expression that computes a string per request, used as a redirect target, a rewrite path, a request or response header value, or the value of a set query parameter, for example `concat("/new", http.request.uri.path)`. |
| Bulk redirects | A site's table of exact-match redirects, up to 5000 per site. |
| IP list | A named set of IP addresses and CIDRs that expressions reference as `$name`; allow and block lists also apply to every site directly. |

The console parses expressions and checks their fields, types, and actions before publishing a syntax tree; nodes validate the whole configuration and compile the tree. The configuration contains no executable Lua text.

## Edit site rules

1. Open **Sites**, select the site, and open the **Rules** tab.
2. Click **Add rule** next to the target phase.
3. Enter the rule name and **Expression**. **Insert condition** appends a common condition (path prefix, Host equals, file extension, IP range, IP list, country, ASN, User-Agent contains, request method, Cookie equals, query parameter equals, User-Agent wildcard, Referer wildcard) and selects its example value, so typing replaces it; **Insert field** appends a field, and for **Cookie**, **Query parameter**, and **Request header** you first enter the name in the field that appears and press Enter or click **Insert**; both join with `and`. When the expression is invalid, "Character N: reason" appears below the editor, for example "Character 11: Ordered comparisons need a number field"; an expression the console refuses on save shows its position and reason the same way.
4. Select **Action**, fill in its fields, and turn on **Enabled**. A new rule starts disabled with the expression `true` (every request), as does a rule saved through the API without `enabled`; check the condition and the action before you save.
5. Drag the handle on the left of a rule to reorder rules within a phase.
6. Click **Save**. The console shows **Saved** and publishes a new configuration revision ("Rules and IP lists updated").
7. Verify: for example, the expression `http.request.uri.path eq "/blocked"` with the **Block** action:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/blocked
   ```

   The response is 403 with `X-Edgeweir-Error: policy-denied`.

Global rules are edited on the **Global rules** page with the same editor (**Origin override** has no **Origin group**), apply to every site, and are published to every cluster on save. API: `GET` and `PUT /api/v1/platform-rules`.

Disabled rules are not sent to nodes.

## Phases and actions

Phases run in the order of this table.

| Phase | Actions | Effect |
| --- | --- | --- |
| Request transform | Rewrite path, Request header | Rewrites the origin path and query parameters; sets or removes request headers |
| Redirect | Redirect | Returns 301, 302, 303, 307, or 308; [bulk redirects](#bulk-redirects) are looked up after the rules |
| Configuration | Override settings | Overrides site settings per request, see [Override settings](#override-settings) |
| Custom WAF | Block, Log, Allow, Challenge | Block returns 403 or 451; Log only writes a log line; Allow skips the remaining custom WAF rules of the same scope; Challenge makes visitors pass a challenge first |
| Rate limit | Rate limit | Fixed-window counting; over the limit returns 429 or 403 |
| Cache | Override settings | Overrides only cache bypass, HTTPS redirect, and Gzip |
| Origin | Request header, Origin override | Sets or removes headers sent to the origin; picks an origin group and overrides the origin Host, SNI, and port |
| Response transform | Response header | Sets, appends, or removes response headers based on status and response headers |
| Compression | Compression algorithms | Limits the compression algorithms of the response and their preference order |

### Action fields

| Action | Field | Values | Default |
| --- | --- | --- | --- |
| Block | Status code | 403 / 451 | 403 |
| Challenge | Challenge type | Cookie redirect / JavaScript / Proof of work / Image captcha | JavaScript |
| Redirect | Target | **Static**: an absolute path on the site (starts with `/`, not `//`), or an `http(s)` URL without credentials or whitespace; no backslashes or control characters, up to 4096 characters. **Expression**: a value expression, see [Dynamic targets and query parameters](#dynamic-targets-and-query-parameters) | Static, `/` |
| Redirect | Status code | 301 / 302 / 303 / 307 / 308 | 301 |
| Redirect | Keep query string | On / off | Off |
| Rewrite path | Target | **Static**: starts with `/`, not `//`; no `?`, `#`, or `\`. **Expression**: a value expression | Static, `/` |
| Rewrite path | Keep query string | On / off | On |
| Redirect / Rewrite path | Set query parameters | Up to 16 pairs of **Parameter name** and **Parameter value**, one more per **Add parameter**; names are 1–64 letters, digits, or `.` `_` `~` `-`, unique; a **Static** value is printable ASCII, up to 256 characters, an **Expression** value a value expression, see [Header and query parameter values](#header-and-query-parameter-values) | None |
| Redirect / Rewrite path | Remove query parameters | Parameter names, comma-separated, up to 16; not also in **Set query parameters** | Empty |
| Request header / Response header | Header name | 1–64 token characters, not a protected header | `x-custom` |
| Request header / Response header | Value | **Static**: up to 4096 characters, no control characters. **Expression**: a value expression, see [Header and query parameter values](#header-and-query-parameter-values) | Static, empty |
| Request header / Response header | Remove header | On / off; a removed header has no value | Off |
| Response header | Append | On / off; on, adds a line next to the response's lines of the same header (for example `Link` or `Vary`); off, replaces them | Off |
| Override settings | Each setting | See [Override settings](#override-settings) | **Bypass cache** On, everything else Unchanged |
| Origin override | Origin group | **Default group** or one of the site's origin groups, see [Origin groups](origins-and-cache.en.md#origin-groups) | The site's first origin group; **Default group** without one |
| Origin override | Origin Host | Host name or IP, optionally with a port, as an origin's [Origin Host](origins-and-cache.en.md#origin-fields); empty leaves it unchanged | Empty |
| Origin override | SNI | Host name; empty leaves it unchanged | Empty |
| Origin override | Port | 1–65535; empty leaves it unchanged | Empty |
| Compression algorithms | Preference order | Some of Zstandard, Brotli, and Gzip: **Add algorithm** appends one, the arrows reorder them; an empty list shows **No compression** | No compression |
| Rate limit | Preset | Loose (300 per minute), Standard (100 per minute), Strict (20 per minute), or Custom; Custom shows the next two fields | Standard |
| Rate limit | Requests per window | 1–100000 | 100 |
| Rate limit | Window (seconds) | 1–3600 | 60 |
| Rate limit | Rate limit key | `ip.src`, `http.host`, `tls.ja4`, or `http.request.headers.<name>` (pick **Request header** and enter the name) | `ip.src` |
| Rate limit | Status code | 429 / 403 | 429 |

Protected headers cannot be set or removed by rules: `Host`, `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Trailer`, `CDN-Loop`, and headers starting with `X-Edgeweir-`.

> [!WARNING]
> Static request and response header values and value expressions are written into the configuration revision and sent to nodes. Do not put API keys or other secrets in them.

**Origin override** changes at least one thing: an origin group other than **Default group**, or one of **Origin Host**, **SNI**, and **Port**.

### Override settings

Every setting of **Override settings** starts as **Unchanged**; numbers left empty stay unchanged.

| Field | Values | Phases | Effect |
| --- | --- | --- | --- |
| Bypass cache | Unchanged / On / Off | Configuration, Cache | Bypasses or uses the cache for the request |
| Redirect HTTP to HTTPS | Unchanged / On / Off | Configuration, Cache | Redirects HTTP requests to HTTPS |
| Gzip | Unchanged / On / Off | Configuration, Cache | **Off**: the response does not use gzip; **On**: allows gzip again after an earlier rule turned it off |
| Brotli, Zstandard | Unchanged / On / Off | Configuration | As Gzip |
| WebSocket | Unchanged / On / Off | Configuration | Overrides the site's **WebSocket** |
| Under Attack | Unchanged / On / Off | Configuration | Overrides the site's Under Attack; global Under Attack is unaffected |
| CC mitigation | Unchanged / On / Off | Configuration | **Off**: the request is exempt from CC level challenges and automatic per-IP bans; it is still counted |
| CC highest level | Unchanged / Cookie redirect / JavaScript / Proof of work / Image captcha | Configuration | The request's CC level does not exceed the chosen level |
| Origin connect timeout (s) | 0.1–120 | Configuration | Overrides the pool's connect timeout |
| Origin send timeout (s), Origin read timeout (s) | 0.1–3600 | Configuration | Override the pool's send and read timeouts |
| Log sample rate (%) | 0–100 | Configuration | The access log sample rate of the request |
| Body limit (MiB) | 0–10240, 0 for no limit | Configuration | Overrides the site's [request body limit](origins-and-cache.en.md#request-body-limit); needs the node capability `site-content-v1` |

A later matching rule overrides an earlier one setting by setting. Compression switches apply only among the algorithms the site has turned on; rules cannot turn on an algorithm the site has off.

### Dynamic targets and query parameters

1. Next to **Target** of a redirect or rewrite path rule, select **Expression**.
2. Enter a value expression. When "Character N: reason" appears below the editor, fix it using [Functions](#functions) and [Fields](#fields).
3. Switch **Keep query string** as needed, and fill in **Set query parameters** and **Remove query parameters**.
4. Click **Save**.
5. Verify: for example, a redirect rule with the expression `starts_with(http.request.uri.path, "/old/")`, the target `regex_replace(http.request.uri.path, "^/old/", "/new/")`, **Keep query string** on, and `utm_source` in **Remove query parameters**:

   ```bash
   curl -sI -H 'Host: www.example.com' 'http://<node IP>/old/a?utm_source=x&id=1'
   ```

   The response is 301 with `Location: /new/a?id=1`.

A value expression is a string literal, a string field, or a function call that returns a string:

```text
concat("https://www.example.com", http.request.uri.path)
regex_replace(http.request.uri.path, "^/old/(.*)$", "/new/${1}")
wildcard_replace(http.request.full_uri, "https://*.example.com/*", "https://example.com/${1}/${2}")
```

| Item | Behavior |
| --- | --- |
| Redirect result | A path starting with a single `/`, or an `http(s)` URL with a host and without credentials; no whitespace, control characters, or backslashes |
| Rewrite result | Starts with a single `/`; no `?`, `#`, `\`, or control characters |
| Invalid result | The request gets 503 (`X-Edgeweir-Error: policy-unavailable`) |
| Default query string | Redirects drop the request's query string; rewrites keep it |
| Order | A redirect with **Keep query string** on first appends the request's query string to the target (with `&` when the target has one); a rewrite with **Keep query string** off first clears the query string. Then parameters named in **Remove query parameters** or **Set query parameters** are removed from the whole query string, and **Set query parameters** are appended in name order |
| Parameter names | The part of each parameter before its first `=`, case-sensitive |
| Parameter values | Every character other than letters, digits, and `-` `.` `_` `~` is percent-encoded |
| Fragment and empty query | A fragment after `#` in the target stays last; without parameters no `?` is left |

### Header and query parameter values

1. Next to **Value** of a request or response header rule, or after the name in a row of **Set query parameters**, select **Expression**.
2. Enter a value expression, for example `ip.geoip.country` for a request header `X-Client-Country` of the origin phase and `http.request.id` for `X-Req`. When "Character N: reason" appears below the editor, fix it using [Functions](#functions) and [Fields](#fields).
3. Turn on **Append** when a response header needs another line next to the response's own.
4. Click **Save**. Rule changes are hot updates; nginx does not reload.
5. Verify: for example, with a request header rule `X-Req` = `http.request.id` in the origin phase, the origin receives an `X-Req` equal to the response header `X-Request-Id`; two response transform rules that append `Link` give the response two `Link` lines:

   ```bash
   curl -sI -H 'Host: www.example.com' 'http://<node IP>/' | grep -i '^link:'
   ```

| Item | Behavior |
| --- | --- |
| Phases | Request headers: request transform and origin; response headers: response transform (response fields available); query parameters: the phases of redirects and rewrites |
| Header values | At most 4096 bytes without control characters (`\x00`–`\x1f`, `\x7f`); an invalid result or a failed evaluation (a pattern over its execution budget, a function result over 8192 bytes) **skips that header action** and the request goes on; there is no 503 |
| Logging skipped values | Each rule writes at most one NOTICE-level nginx error log line per node per 60 seconds, `edgeweir: header value skipped site=<site ID> rule=<rule ID>`, without the header name or value; nginx appends the client IP, request line, and Host to log lines written during a request |
| Append | Adds one more line next to the lines of the same header, without merging or deduplicating; later rules that read `http.response.headers["name"]` see every line joined with `, `; not together with **Remove header** |
| Query parameter values | Percent-encoded as before (every byte other than letters, digits, and `-` `.` `_` `~`); a failed evaluation gets the request a 503 (`X-Edgeweir-Error: policy-unavailable`), as with dynamic targets |
| When values are computed | Request phase values use the request at that point (the path, query string, and `http.request.uri.args` after rewrites); response header values are computed in the edge layer's header filter, for cache hits and origin responses alike |
| Node requirement | `rules-v3`, see [Node capabilities and publishing](#node-capabilities-and-publishing) |

### Execution order

| Item | Behavior |
| --- | --- |
| Allow and block lists | Run first. An address in a block list gets 403; an address in an allow list is exempt from the block lists but not from rules; an address in both is allowed |
| Scope | In each phase, global rules run before site rules; within a scope, in list order |
| Terminating actions | Block, redirect (bulk redirects included), and exceeding a rate limit end the request |
| Bulk redirects | Looked up after the global and site rules of the redirect phase |
| Allow | Skips only the remaining custom WAF rules of the same scope, not the other scope and not rate limits; a site allow rule cannot bypass a block in the global rules |
| Stacking | Other actions accumulate; a later action overrides an earlier setting; override settings and origin overrides apply field by field, and a later compression rule replaces an earlier one |
| Ordering | Dragging changes order only within a phase |

### Action behavior

| Action | Behavior |
| --- | --- |
| Rewrite path | Changes the path and query string sent to the origin; expressions in later phases see the rewritten path, query string, query parameters, and extension (`http.request.full_uri` stays the same); cache rules, the cache key, purges, and bulk redirects still use the request before the rewrite |
| Response transform | Applies to cache hits and origin responses |
| Override settings: Gzip, Brotli, Zstandard | Affect only the response and never bypass the cache. On sites that compress at the edge (any algorithm on), the cache still holds the same uncompressed object; on sites that do not, **Gzip** off removes `Accept-Encoding` towards the origin and the cache tells variants apart by the origin's `Vary`; when the origin sends no `Vary: Accept-Encoding`, the request may hit a previously cached compressed object |
| Override settings: Redirect HTTP to HTTPS | Requests get 503 when the site has no certificate |
| Override settings: Log sample rate | Records matching requests at that rate; their logs are kept even when the site's access log sample rate is **Off**, see [Access logs](access-logs.en.md) |
| Origin override | Load balancing, retries, health checks, and session affinity work as usual among the origins of the chosen group; **Port** applies to every origin of the group; **Origin Host** does not affect S3 origins; the cache key does not include the origin group, see [Origin groups](origins-and-cache.en.md#origin-groups) |
| Compression algorithms | Only algorithms on the list that the site has on and override settings did not turn off are negotiated by the q-values of the request's `Accept-Encoding`, with the list order breaking ties; **No compression** turns compression off; the cache is not bypassed |
| Block, rate limit exceeded | Response header `X-Edgeweir-Error: policy-denied`; rate-limited responses also carry `Retry-After` (the window in seconds) |
| Challenge | A request with a pass of a sufficient level continues with the following rules; otherwise it gets the challenge page (non-GET/HEAD requests get 403 with `X-Edgeweir-Challenge: required`). Allow rules skip Under Attack and CC challenges, but a challenge rule that matched before the allow still applies. See [Challenges and CC mitigation](challenges.en.md) |
| Log | Does not change the response. Nodes count the matching requests per rule and minute (not the node's own prefetches), and the **Log rule matches** card on the site's **Security** tab lists the most-matched rules over a time range (global rules marked "(global)", deleted rules shown as "Deleted rule"); the numbers are approximate: each node reports at most 20 rules per minute. While some nodes of the site's cluster lack the capability `rule-log-v1`, the card shows "Some nodes of the site's cluster do not report these matches". Each rule also writes at most one NOTICE-level nginx error log line per node per 60 seconds, containing the site ID and rule ID; nginx appends the client IP, request line, and Host to log lines written during a request |

### Rate limiting

| Item | Behavior |
| --- | --- |
| Scope | A fixed window per node, not a network-wide quota; each site counts separately, and rate limits in the global rules are also counted per site |
| Key | Counted by an MD5 digest of the scope, rule ID, and key value |
| Memory | A fixed 256 KiB shared memory partition per published site (node flag `--rate-limit-dict-kb`), holding about 1980 counters, never borrowed across sites; at most 512 published sites per cluster (128 MiB in total by default); log deduplication uses another 1 MiB |
| Out of memory | When a site's partition is full, requests of new clients pass uncounted while clients that already have a counter stay limited; the node writes at most one WARN-level nginx error log line per site per minute with the running total. A node without the site's partition returns 503 (`X-Edgeweir-Error: rate-limit-unavailable`) |
| Reload and restart | Counters survive an nginx reload; they reset when the node restarts or when a site is removed and added back |
| Hot updates | Rule and list changes for the same set of sites do not reload; adding or removing sites reloads, and existing partitions keep their names and sizes |

## Expressions

```text
ip.src in $blocked
http.request.uri.path matches "^/(admin|private)/" and not ssl eq true
http.request.method in {"POST" "PUT"}
http.request.headers["x-region"] eq "nz"
ip.geoip.country eq "NZ" and ip.geoip.asnum in {64512 64513}
http.response.code ge 500
lower(http.host) eq "www.example.com"
len(http.request.uri.query) gt 1024
url_decode(http.request.uri.query) contains "<script"
not starts_with(http.request.uri.path, "/api/")
http.request.uri.path.extension in {"jpg" "png" "webp"}
http.request.cookies["role"] eq "admin"
http.user_agent wildcard "*curl*"
http.referer strict wildcard "https://*.example.com/*"
substring(sha256(http.request.uri.path), 0, 8) eq "a1b2c3d4"
```

### Fields

| Field | Type | Value |
| --- | --- | --- |
| `http.host` | String | The request Host |
| `http.request.method` | String | The request method |
| `http.request.uri.path` | String | The path after nginx normalization |
| `http.request.uri.path.extension` | String | The text after the last `.` of the path's last segment, lowercase; empty string without one |
| `http.request.uri.query` | String | The query string without `?` |
| `http.request.uri` | String | The raw request URI (path plus query) |
| `http.request.full_uri` | String | `scheme://`, the Host (lowercase, without port), and the raw request URI; rewrites do not change it |
| `http.request.headers["name"]` | String | Case-insensitive name; multiple values joined with `, ` |
| `http.request.cookies["name"]` | String | The raw value (not decoded, quotes kept) of the first cookie of that name in the request's `Cookie` header; the name is case-sensitive, 1–64 token characters; empty string without one. Cookies are separated by `;`, spaces and tabs around a pair, its name, and its value are ignored, and a part without `=` is skipped; several `Cookie` headers are joined with `; ` |
| `http.request.uri.args["name"]` | String | The raw value of the first query parameter of that name (neither name nor value decoded; combine with `url_decode`); the name is the part before the first `=`, case-sensitive, 1–64 printable ASCII characters other than `"` `#` `&` `=`; a parameter without `=` has an empty value; empty string without the parameter; follows rewrites |
| `http.referer`, `http.user_agent` | String | The same as `http.request.headers["referer"]` and `["user-agent"]`, changed by request header rules too |
| `http.request.version` | String | `HTTP/1.0`, `HTTP/1.1`, `HTTP/2.0`, or `HTTP/3.0` |
| `http.request.scheme` | String | `http` or `https` |
| `http.request.id` | String | The node's request ID, the same as the response header `X-Request-Id` |
| `http.request.timestamp.sec` | Integer | Unix seconds when the node received the request |
| `edge.server_port` | Integer | The port of the listener that received the request |
| `http.response.code` | Integer | Response status; response transform and compression phases only |
| `http.response.headers["name"]` | String | Response header; response transform and compression phases only |
| `http.response.content_type.media_type` | String | The response's `Content-Type` without parameters, lowercase; response transform and compression phases only |
| `http.response.cache_status` | String | The edge cache's status: `HIT`, `MISS`, `BYPASS`, `EXPIRED`, `STALE`, `UPDATING`, or `REVALIDATED` (as `X-Cache`); empty string for responses the node made itself (blocks, redirects, error pages) and for WebSocket and gRPC, which never pass the cache; response transform and compression phases only |
| `ip.src` | IP | The visitor address under the cluster's [client IP](../deploy/nodes.en.md#client-ip) setting: the TCP client address when direct; the address in the PROXY header with the PROXY protocol (the UDP peer for HTTP/3); the address the trusted proxies' header names in the trusted header mode |
| `ip.peer` | IP | The direct peer: the TCP client address (the UDP peer for HTTP/3), whatever the client IP setting; equal to `ip.src` in direct mode. Needs `client-ip-v1` |
| `ssl` | Boolean | `true` for HTTPS requests |
| `ip.geoip.country` | String | ISO country code; empty string without a record |
| `ip.geoip.subdivision` | String | First-level subdivision code from the City MMDB, or its English name when it has no code; empty string without a record or when the City MMDB's country differs from `ip.geoip.country` |
| `ip.geoip.asnum` | Integer | ASN; 0 without a record |
| `ip.geoip.as_name` | String | AS name from the database that gave the ASN: IPinfo Lite's `as_name` or the ASN MMDB's `autonomous_system_organization`; empty string without a record |
| `tls.ja4` | String | JA4 TLS client fingerprint of the connection; empty string over plain HTTP, see [JA4](challenges.en.md#ja4) |

### Operators and literals

| Syntax | Types | Description |
| --- | --- | --- |
| `eq`, `ne` | All | IP values compare by address or CIDR containment |
| `lt`, `le`, `gt`, `ge` | Integer | Ordered comparison |
| `contains` | String | Substring match |
| `matches` | String | Regular expression match |
| `wildcard "pattern"` | String | Whole-string wildcard match: `*` matches zero or more bytes (at most 8 of them), `\*` and `\\` are literals, other backslashes are invalid; ASCII letters are case-insensitive; patterns are at most 1024 bytes without control characters |
| `strict wildcard "pattern"` | String | As `wildcard`, case-sensitive |
| `in {…}` | All | Set, elements separated by whitespace |
| `in $name` | IP | References an IP list; fields only, not function results |
| `not`, `and`, `or`, `( )` | — | Precedence `not` → `and` → `or` |
| Literals | — | Strings in double quotes (JSON escapes); integers; `true` / `false`; IPs and CIDRs unquoted; a bare `true` is a valid expression |
| `function(argument, …)` | — | A function can be the left side of a comparison, with the operators of its return type; a function that returns a boolean can be a condition on its own |

### Functions

Every string is handled as UTF-8 bytes. Arguments are fields, string literals, or other function calls.

| Function | Returns | Description |
| --- | --- | --- |
| `lower(s)`, `upper(s)` | String | Converts ASCII letters only |
| `len(s)` | Integer | Number of bytes |
| `starts_with(s, prefix)`, `ends_with(s, suffix)` | Boolean | Byte-wise prefix or suffix; an empty string always matches |
| `url_decode(s)` | String | Decodes once: `%XX` (hexadecimal, case-insensitive) becomes a byte and `+` a space; incomplete or non-hexadecimal `%` sequences stay as they are |
| `concat(s1, s2, …)` | String | Joins 2–8 arguments in order |
| `regex_replace(s, "pattern", "replacement")` | String | Replaces the first match; patterns as in [Regular expressions](#regular-expressions); without a match the string is returned unchanged |
| `wildcard_replace(s, "wildcard", "replacement"[, "s"])` | String | The wildcard pattern must match the whole string: `*` matches zero or more bytes (at most 8 of them), `\*` and `\\` are literals; ASCII case-insensitive by default, case-sensitive with a fourth argument `"s"`; earlier `*` take the shortest match; without a match the string is returned unchanged |
| `url_encode(s)` | String | Encodes every byte other than the RFC 3986 unreserved characters (letters, digits, and `-` `.` `_` `~`) as `%XX` (uppercase hexadecimal) |
| `base64_encode(s)` | String | Standard alphabet with padding |
| `base64_decode(s)` | String | Accepts the standard and the URL-safe alphabet (mixed too), with or without padding, and ignores unused trailing bits; other characters, whitespace, misplaced or excess padding, or a length that leaves 1 when divided by 4 give an empty string |
| `md5(s)`, `sha1(s)`, `sha256(s)` | String | The digest in lowercase hexadecimal |
| `substring(s, start[, length])` | String | Bytes from `start` (0-based; negative counts from the end, clamped to the first byte), up to the end without a length; empty when the start is not below the length of `s`. `start` is an integer literal from -65536 to 65536, `length` from 0 to 65536 |
| `to_string(x)` | String | Integers in decimal, booleans as `true` / `false`, IPs as the address text the node sees, strings unchanged; the argument can be a field or function of any type |

| Item | Rule |
| --- | --- |
| Where | Conditions (cache rule conditions included) can use every function except `regex_replace` and `wildcard_replace`; value expressions can use all of them, `regex_replace` and `wildcard_replace` at most once each per expression |
| Argument types | Strings, except `to_string` (any type) and the start and length of `substring` (integer literals) |
| Literal arguments | Patterns, wildcards, replacements, and `"s"` must be string literals; wildcards and replacements are at most 1024 bytes without control characters |
| Replacements | `${1}`–`${8}` refer to the pattern's capture groups or the wildcard's `*`, up to their number; groups that did not take part in the match become empty; any other `$` is a literal; captures keep the case of the original string |
| Nesting | At most 4 levels |
| Result length | A function result longer than 8192 bytes fails evaluation |
| Evaluation failure | A pattern over its execution budget, a result that is too long, or an invalid dynamic target gets the request a 503 (`X-Edgeweir-Error: policy-unavailable`) |

### IP semantics

| Item | Behavior |
| --- | --- |
| IPv4-mapped addresses | `::ffff:a.b.c.d` equals the IPv4 address; mapped CIDRs with a prefix shorter than 96 bits are ambiguous and refused |
| IPv4-compatible form | `::a.b.c.d` is a plain IPv6 address (`::1.2.3.4` is saved as `::102:304/128`), not equal to IPv4 |
| NAT64 | A distinct IPv6 address, not equal to IPv4 |
| CIDR | Host bits are cleared before saving |
| Refused | Leading zeros (octal ambiguity) and zone IDs (`%`) |

### Regular expressions

`matches` and `regex_replace` use the same subset. Console validation, node validation and node execution (PCRE) accept the same subset; constructs whose meaning differs between the engines are refused.

| Item | Rule |
| --- | --- |
| Subject | The value's UTF-8 bytes, case-sensitive; `.`, `[^…]`, `\D`, `\W` match one byte (a CJK character is 3 bytes) |
| Length and characters | Up to 256 printable ASCII characters; write others as `\t` `\n` `\r` `\f` or `\x00`–`\x7f` |
| Anchors | `^` start of the value; `$` end of the value; `\b` `\B` ASCII word boundary |
| Characters | `.` is any byte except `\n`; `\d` `\D` `\w` `\W` are ASCII; a backslash before ASCII punctuation matches that character; escape literal `]` `{` `}` |
| Classes | `[…]` `[^…]` of characters, `\d` `\D` `\w` `\W` and ranges such as `a-z`; `-` is literal only first or last, elsewhere `\-`; escape `[` inside a class |
| Quantifiers | `*` `+` `?` `{n}` `{n,}` `{n,m}` (n ≤ m ≤ 1000, no leading zeros), optionally lazy with `?`; only after a character, class or escape |
| Groups | `( )` and `\|`; groups take no quantifier |
| Unsupported | `\s` `\S` `\v` (write an explicit class such as `[ \t\r\n\f]`), `\xHH` above `\x7f`, `\z` `\A` `\Q` `\p{…}` `\K` and other escapes, backreferences and octal, groups starting with `(?`, possessive and stacked quantifiers, `{,n}`, `[[:alpha:]]`, empty classes and `[]…]` |
| Execution budget | Nodes use PCRE with a match limit of 10000 and a depth limit of 100; an execution error returns 503 (`X-Edgeweir-Error: policy-unavailable`) |

A saved rule or cache rule condition that uses a construct no longer supported (such as `\s`) makes saving its site or its rules fail with `RULE_INVALID`; rewrite it and save again. Other publications (other sites, ACME challenges, system settings) go on: the rule keeps its last compiled form and the alert "Stored rule no longer valid; its last compiled form is kept" fires; such a rule that was never compiled holds its site back from the nodes. Rules of disabled sites are not compiled.

The language is a wirefilter-style subset, not a complete wirefilter implementation.

### Complexity limits

| Item | Limit |
| --- | --- |
| Expression length | 4096 characters; 16384 for cache rule conditions |
| Tokens | 512 |
| Nesting | 16 levels |
| Basic conditions, functions, and arguments | 128 in total |
| Set elements | 256 |
| Function nesting | 4 levels |
| Function results | 8192 bytes |
| Rules | 64 per site; 32 global rules |
| Bulk redirects | 5000 per site |

## Bulk redirects

A site's table of exact-match redirects: each entry redirects one source to one static target. For prefix or wildcard redirects, use a redirect rule with `wildcard_replace`.

1. Open **Sites**, select the site, and open the **Bulk redirects** tab.
2. Click **Add redirect**, enter **Source** and **Target**, select **Status code**, and turn on **Keep query string** as needed.
3. Or click **Import**, enter one entry per line in **Import redirects** ("One per line: source target [status]"), turn on **Replace existing entries** as needed, and click **Import**.
4. Click **Save**. The console shows **Saved** and publishes a new configuration revision ("Rules and IP lists updated").
5. Verify:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/old
   ```

   The response has the entry's status code and its target in `Location`.

| Field | Values | Default |
| --- | --- | --- |
| Source | `/path` (every domain of the site) or `host/path` (that domain only); 2–512 bytes without whitespace, `?`, or control characters; the host is lowercase and one of the site's exact domains or one label under a wildcard domain of the site (not a host only a `.` suffix or pattern domain matches) | `/` |
| Target | As a static redirect target, up to 1024 bytes | `/` |
| Status code | 301 / 302 / 307 / 308 | 301 |
| Keep query string | On / off; on appends the request's query string to the target (with `&` when the target has one) | Off |

| Item | Behavior |
| --- | --- |
| Matching | Exact match on the Host (lowercase, without port) and normalized path of the client's original request, before any rewrite; the query string takes no part; `host/path` entries are looked up before `/path` entries |
| Order | After the global and site rules of the redirect phase; a request that matched a redirect rule never reaches the table |
| Import | Fields separated by whitespace (by commas when a line has no whitespace), status 301 by default; empty lines and lines starting with `#` are skipped; an entry with the same source as an existing one replaces it; **Replace existing entries** replaces the whole table; an invalid line shows "Line N is invalid" and nothing is imported |
| List | 50 entries per page; **Filter** searches sources and targets |
| Updates | Nodes apply them without reloading nginx |
| Audit | Changes are audited as `site.bulk_redirects_update` (with the entry count) |
| Limit | 5000 entries per site, sources unique |
| Node requirement | `rules-v2`, see [Node capabilities and publishing](#node-capabilities-and-publishing) |

## IP lists

1. Open **IP lists** and click **Create list**.
2. Enter **Name**: starts with a letter or underscore, contains only letters, digits, and underscores, 1–64 characters.
3. Select **Action**: **Referenced by rules**, **Block**, or **Allow**.
4. Enter entries in **IP addresses and CIDRs**, separated by newlines, spaces, or commas.
5. Click **Save**.
6. Verify: the list shows `$name`, "N entries", and the first entries (with more than 6, the first 5 and the count of the rest), block and allow lists also a **Block** or **Allow** badge; reference it in rules or cache rule conditions with `ip.src in $name`.

| Action | Effect |
| --- | --- |
| Referenced by rules | Only a set for rules to reference |
| Block | A block list: applies to every site of every cluster without a rule; matching addresses get 403 before any rule runs |
| Allow | An allow list: applies to every site of every cluster; matching addresses are exempt from block lists and bans, but not from rules |

| Item | Behavior |
| --- | --- |
| Name | All lists share one namespace and names are unique; a name cannot change after creation; saving rules binds names to list IDs |
| References | Any site rule, global rule, or cache rule condition can reference any list, block and allow lists included; the **Allow lists** and **Block lists** of [L4 apps](l4.en.md#ip-lists-and-connection-limits) can use any list as well |
| L4 apps | The **Block** and **Allow** actions apply to sites only; L4 apps check only the lists they selected |
| Changes | Entries and **Action** can change at any time; creating, changing, or deleting a list publishes a new revision to every cluster ("Rules and IP lists updated"); nodes apply it without reload |
| Deletion | A list referenced by a rule, a cache rule condition, or an L4 app cannot be deleted ("The IP list is used by …", naming the first 5 users: rule names, site rules with their site; sites whose cache rules use it; L4 app names) |
| Entries | IPv4 / IPv6 addresses or CIDRs; host bits cleared, deduplicated, sorted; leading zeros and zone IDs refused |
| Quota | Up to 128 lists and 50,000 entries in total; up to 10,000 entries per list; a change that does not add entries always saves |
| Rollback | Site configuration rollbacks keep the current lists and global rules; a rollback that references a deleted list is refused |

API: `GET` and `POST /api/v1/ip-lists`, `PUT` and `DELETE /api/v1/ip-lists/{id}`.

## Node capabilities and publishing

| Item | Behavior |
| --- | --- |
| Capabilities | Rules and block/allow lists need the node capability `rules-v1`; `ip.geoip.country` and `ip.geoip.subdivision` need `geoip-city-v1`; `ip.geoip.asnum` needs `geoip-asn-v1`; the challenge action needs `challenge-v1`; `tls.ja4` (field or rate limit key) needs `ja4-v1`; when `ip.geoip.subdivision` is used, the console also checks `geoip-subdivision-v1` (not written into the configuration) |
| Rule engine extensions | Any of these needs `rules-v2`: functions and `http.request.full_uri`, `http.request.uri.path.extension`, `http.response.content_type.media_type`; expression targets, query parameter edits, and a redirect with **Keep query string** on or a rewrite with it off; origin overrides; the compression phase; the overrides available only in the configuration phase and **Gzip** On; cache rule conditions not in the [builder](origins-and-cache.en.md#request-conditions)'s shape and **Browser TTL (s)**; bulk redirects; origin groups other than the default group |
| Expression fields and header values | Any of these needs `rules-v3`: `http.request.cookies[…]`, `http.request.uri.args[…]`, `http.referer`, `http.user_agent`, `http.request.version`, `http.request.scheme`, `http.request.id`, `http.request.timestamp.sec`, `edge.server_port`, `ip.geoip.as_name` (also `geoip-asn-v1`), `http.response.cache_status`; `url_encode`, `base64_encode`, `base64_decode`, `md5`, `sha1`, `sha256`, `substring`, `to_string`; `wildcard` and `strict wildcard`; expression values of request headers, response headers, and query parameters; response header **Append**; redirect status 303; `{{time}}` and `{{path}}` in [error pages](error-pages.en.md) |
| Direct peer | Configurations that read `ip.peer` need `client-ip-v1` |
| Existing configurations | Configurations that use none of the extensions stay as they were and do not need `rules-v2`; cache rules in the builder's shape are still sent as the former structured conditions; configurations that use none of the `rules-v3` items stay byte for byte the same as well |
| Console and AccessKeys | A save is published even when an active node of the cluster lacks a required capability; such nodes keep their last-known-good configuration and **Clusters & nodes** shows **Upgrade required**, see [Node upgrades](node-upgrades.en.md) |
| Service accounts and background jobs | When a configuration they publish introduces a new capability, every active node of the cluster is checked, including temporarily offline ones; if any lacks it, the publish is refused (`NODE_CAPABILITY_REQUIRED`, "Some nodes don't support … yet: {nodes}") and the configuration and revision stay unchanged |
| UI | While an active node of the cluster lacks `rules-v2`, the **Rules**, **Cache**, and **Bulk redirects** tabs show "Some nodes of the site's cluster do not support the rule extensions yet"; the extensions cannot be picked there, and settings already in place can still be changed or cleared; **Bulk redirects** is read-only. While one lacks `rules-v3`, the **Rules** tab shows "Some nodes of the site's cluster do not support it yet": the menus leave out the `rules-v3` fields and conditions, and **Expression** values, **Append**, and 303 cannot be newly picked, while those in place can still be changed or cleared; the **Error pages** tab leaves out `{{time}}` and `{{path}}` and shows the same note when a template uses them |
| Unknown capabilities | Nodes reject configurations with unknown capabilities or enum values and keep last-known-good |

## Configure GeoIP databases

GeoIP fields read MMDB files on the node. Nodes download no updates and send no visitor addresses to data vendors.

| Database | Fields | Source | License and updates | Attribution |
| --- | --- | --- | --- | --- |
| [IPinfo Lite](https://ipinfo.io/lite) | Country, ASN | Bundled in node release images; package and archive nodes download it from IPinfo (free account) | CC BY-SA 4.0; IPinfo updates daily, images carry a snapshot from their build day | IP address data is powered by [IPinfo](https://ipinfo.io) |
| City MMDB, e.g. [DB-IP Lite](https://db-ip.com/db/lite.php) City | Country, first-level subdivision | Downloaded by the operator | DB-IP Lite: CC BY 4.0, monthly updates | [IP Geolocation by DB-IP](https://db-ip.com) |
| ASN MMDB, e.g. DB-IP Lite ASN | ASN | Downloaded by the operator | Same as above | Same as above |

| Item | Behavior |
| --- | --- |
| Precedence | Country and ASN come from IPinfo Lite first, then from the City / ASN MMDB when IPinfo has no record |
| Subdivision | Comes only from the City MMDB, and only when the City MMDB's country matches the final country |
| Bundled data | `/usr/share/edgeweir-node/geoip/ipinfo_lite.mmdb`, checked at build time against the sha256 IPinfo publishes; `NOTICE` in the same directory records the download time and sha256 |
| Console attribution | **Protection settings → GeoIP databases** carries the IPinfo attribution link |

1. Container nodes running a release image need no configuration for country and ASN; for newer data, pull a newer image, or mount a separately downloaded copy and set `EDGEWEIR_GEOIP_IPINFO`.
2. Package or archive nodes: download `ipinfo_lite.mmdb` from IPinfo. To match on subdivisions, also download a City MMDB. Check source, license, and integrity, and record the download date.
3. Put the files in a read-only directory the node can read, and set the node environment variables:

   ```bash title="/etc/default/edgeweir-node"
   EDGEWEIR_GEOIP_IPINFO=/etc/edgeweir-node/geoip/ipinfo_lite.mmdb
   EDGEWEIR_GEOIP_CITY=/etc/edgeweir-node/geoip/dbip-city-lite.mmdb
   ```

   For container deployments, mount the directory and pass the same variables with `-e`.
4. Restart the node to load the databases:

   ```bash
   sudo systemctl restart edgeweir-node
   ```

5. Verify: in **Protection settings → GeoIP databases**, the node's row shows "Ready" under "Country" and "ASN", and under "Subdivision" too when a City MMDB is configured.

| Variable | Flag | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_GEOIP_IPINFO` | `--geoip-ipinfo` | `auto` | IPinfo Lite MMDB path; `auto` uses the database bundled in the image when present, `off` disables it |
| `EDGEWEIR_GEOIP_CITY` | `--geoip-city` | Empty | City MMDB path |
| `EDGEWEIR_GEOIP_ASN` | `--geoip-asn` | Empty | ASN MMDB path |

| Item | Behavior |
| --- | --- |
| Capability reporting | A node with country data (IPinfo Lite or a City MMDB) reports `geoip-city-v1`, one with a City MMDB reports `geoip-subdivision-v1`, one with ASN data reports `geoip-asn-v1`; current nodes also report `geoip-country-v1` |
| Older nodes | A node that does not report `geoip-country-v1` reports `geoip-city-v1` only with a City MMDB, and the console treats it as having `geoip-subdivision-v1` |
| Missing capability | A node rejects configurations that use GeoIP fields it lacks and keeps last-known-good |
| Invalid file | The node agent does not start when a configured MMDB file is invalid or of the wrong database type; an invalid bundled IPinfo Lite database is logged and left unused |
| Lookups | The agent reads the files and serves results to Lua workers over a local Unix socket with mode 0600; each worker caches up to 10,000 results for 5 minutes; a lookup times out after 200 milliseconds |
| Lookup failure | When site rules, global rules (value expressions included), or cache rule conditions use GeoIP fields, every request of that site needs a lookup; while the service is unavailable, those requests get 503 |
| Updates | Replace the file or image on one node, restart, and verify before updating the others; never overwrite an MMDB file in use |

## Limits

| Item | Description |
| --- | --- |
| Rate limiting | Per-node fixed windows only; no network-wide quota and no sliding window |
| Expressions | A wirefilter-style subset; built-in functions only, no custom functions or raw Lua |
| String replacement | `regex_replace` and `wildcard_replace` only in value expressions (redirect targets, rewrite paths, header values, and query parameter values), once each per expression; `regex_replace` replaces only the first match |
| Cookies and query parameters | Read by name, the first value, not decoded; there is no list of every cookie or parameter, and names take no wildcards |
| Bulk redirects | Exact matches only, static targets |
| Protected headers | See [Action fields](#action-fields); rules cannot change them |
| Compression | Override settings and compression rules choose only among the algorithms the site has on |
| Origin groups | The cache key does not include the origin group |
| GeoIP data | The bundled IPinfo Lite database is a snapshot from the image build day; subdivisions need an operator-provided City MMDB; accuracy depends on the chosen database |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "Character N: reason" below the editor | Unsupported syntax, field, type, function, or regular expression at that position; the reason names the problem | Fix it using the syntax tables above |
| Saving shows "Check field of rule “name”" | That field of the rule is invalid, for example the target format, a repeated parameter name, or a parameter both set and removed; an invalid expression shows the position and reason | Fix it using the action field table |
| Saving shows "Invalid rule" | The action does not belong to the phase, a protected header, or an invalid redirect target or rewrite path; an origin override picks an origin group the site does not have | Fix it using the action field table; add an origin of that group on the **Origins** tab first |
| "The site does not serve …" | A bulk redirect source names a host that is not a domain of the site | Use a domain of the site, or write `/path` |
| "Line N is invalid" | The field count, source, target, or status code of that imported line is invalid | Fix the line and import again |
| "N invalid" | The bulk redirect table has invalid entries or repeated sources | Fix the marked entries |
| "Some nodes of the site's cluster do not support the rule extensions yet" | An active node of the cluster lacks `rules-v2` | Upgrade the nodes, see [Node upgrades](node-upgrades.en.md) |
| "No such IP list: …" | The referenced lists (named) do not exist | Create the list in **IP lists** first, or fix the name |
| "IP list name already exists" | A list with that name exists | Use another name |
| "The IP list is used by …" | Deleting a list the listed rules, sites' cache rule conditions, or L4 apps still reference | Remove the reference from those rules and L4 apps first |
| "IP list limit reached (128 lists, 50,000 entries)" | Over quota | Merge or delete lists |
| A node shows **Upgrade required** | The node lacks a capability the configuration needs (`rules-v1`, `rules-v2`, a GeoIP capability, and so on) and keeps its last-known-good configuration | Upgrade the node or configure the GeoIP databases |
| "Some nodes don't support … yet: {nodes}" | A configuration published by a service account or a background job needs `rules-v1`, `rules-v2`, or a GeoIP capability that an active node of the cluster lacks | Upgrade the nodes or configure the GeoIP databases |
| 503 with `X-Edgeweir-Error: policy-unavailable` | A regular expression exceeded its budget, a function result exceeded 8192 bytes, a dynamic target, rewrite path, or query parameter value expression was invalid, or a GeoIP lookup failed | Simplify the pattern or expression; check what the value expression computes; check the node's GeoIP service |
| A request or response header with an expression value is missing, and the node logs `header value skipped site=… rule=…` | The value the rule computed exceeds 4096 bytes, has a control character, or its evaluation failed; the node skips that header action | Limit or clean the value with `substring`, `url_encode`, and the like; a rule logs once per 60 seconds |
| "Some nodes of the site's cluster do not support it yet" (Rules tab) | An active node of the cluster lacks `rules-v3` | Upgrade the nodes, see [Node upgrades](node-upgrades.en.md) |
| A rule that redirects HTTP to HTTPS makes requests return 503 | The site has no certificate | Select a certificate on the **HTTPS** tab |
| Rate limits are not shared across nodes | Rate limits count per node | Scale the threshold by the number of nodes |
| Some visitors are not rate limited and the node log shows `rate limit partition full` | The site's rate-limit partition is full and new clients are not counted | Raise the node flag `--rate-limit-dict-kb` |
