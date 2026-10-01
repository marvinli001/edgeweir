# Origins and cache

A site's origin pool and origin groups, health checks and session affinity, origin connections, cache rules, cache key, and purge and prefetch.

## Concepts

| Term | Definition |
| --- | --- |
| Origin pool | All origins of a site plus load balancing, health check, timeout, and keep-alive settings. One pool per site. |
| Primary / backup origin | Origins without **Backup** are primaries and receive traffic by the load balancing policy; backups receive traffic only when every primary is down. |
| Origin group | A group label on an origin; empty is the default group. Requests go to the default group unless an **Origin override** rule sends them to another group. |
| Cache rule | A rule matched in list order that decides whether and for how long a response is cached. |
| Cache key | The request attributes that tell cached objects apart; applies to all cache rules of the site. |
| Cache generation | A per-site counter that is part of the cache key; **Purge cache** increments it and every cached object of the site becomes stale. |
| Cache tag | A tag the origin names in the `Cache-Tag` response header; a purge by tag purges only the cached objects that carry it. |

## Configure origins

1. Open **Console → Sites**, select the site, and open the **Origins** tab.
2. In the **Origins** card, edit an existing origin or click **Add origin**.
3. Enter **Origin**, **Port**, **Protocol**, and **Weight**; set **Origin Host**, **SNI**, and **Origin group** as needed; turn on **Backup** or **S3 signing** as needed.
4. Click **Save** at the bottom of the card. The console shows **Saved, revision #N**.
5. Verify: after the node applies the revision, request the site through the node:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/
   ```

   The origin's status code comes back; once traffic flows, the origin shows **Healthy**.

### Origin fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Origin | Host name or IPv4/IPv6 literal without port or brackets, up to 253 characters | None | Origin target, subject to [origin address restrictions](#origin-address-restrictions) |
| Port | 1–65535 | 80 | Origin port; change it to the origin's HTTPS port when selecting HTTPS |
| Protocol | HTTP / HTTPS | HTTP | Protocol from node to origin |
| Weight | 1–100 | 1 | Weight used by all three load balancing policies |
| Origin Host | Host name, up to 253 characters | Empty (same as request) | `Host` sent to the origin. Empty: the visitor's Host (lowercase, port removed); for S3 origins the origin address, with the port unless it is 80 (HTTP) or 443 (HTTPS) |
| SNI | Host name | Empty (same as origin Host) | HTTPS only. Empty: the origin Host without port, then the origin address; no SNI is sent for an IP literal |
| Origin group | 1–32 lowercase letters, digits, `_`, or `-` | Empty (default group) | See [Origin groups](#origin-groups) |
| Backup | On / off | Off | Makes the origin a backup |
| S3 signing | On / off | Off | Signs origin requests with AWS Signature V4, see [S3-compatible object storage](#s3-compatible-object-storage) |

Each site has 1–32 origins, at least one of them in the default group.

### Pool settings

The **Pool settings** card is saved separately. It also holds the [active health check](#active-health-check) and [session affinity](#session-affinity).

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Load balancing | Weighted random / Round robin / Consistent hash | Weighted random | Selection among primaries |
| Verify origin certificates | On / off | On | Verifies HTTPS origin certificates, see [Origin TLS](#origin-tls) |
| WebSocket | On / off | On | Proxies WebSocket upgrades |
| Failures before down | 1–100 | 3 | Consecutive failures that mark an origin down |
| Retry after (seconds) | 1–3600 | 30 | Time before a down origin is tried again |
| Timeouts (seconds): Connect | 0.1–120 | 10 | Connection timeout |
| Timeouts (seconds): Send | 0.1–3600 | 60 | Timeout for sending the request to the origin |
| Timeouts (seconds): Read | 0.1–3600 | 60 | Timeout for reading the response; also the WebSocket idle timeout |
| Keep-alive: Enabled | On / off | On | Reuses origin connections |
| Keep-alive: Idle timeout (seconds) | 1–3600 | 60 | How long idle connections stay open |
| Keep-alive: Max requests | 1–100000 | 1000 | Requests per connection |

Rules of the configuration phase can override the three timeouts and **WebSocket** per request, see [Override settings](rules.en.md#override-settings).

### Load balancing and retries

| Policy | Behavior |
| --- | --- |
| Weighted random | Random pick by weight; retries take untried origins in weighted order |
| Round robin | Smooth weighted round robin (the nginx algorithm), counted per worker |
| Consistent hash | Hashes the raw request URI (path plus query) so a URI sticks to one origin; when an origin is down, only its URIs move |

| Item | Behavior |
| --- | --- |
| Attempts | At most 3 origins per request |
| Retry triggers | Connection failure, timeout (including a failed TLS handshake), origin response 502/503/504 |
| No retry | `POST`, `LOCK`, and `PATCH` requests are not retried once sent; `PUT` and `DELETE` are retried |
| Retry scope | Only within the currently usable group: healthy primaries while any exist; backups when every primary is down; never switches between HTTP and HTTPS origins within one request |
| Exclusion | Origins whose name fails to resolve, resolves only to special-purpose addresses, or lacks S3 credentials are dropped before the attempt, so fewer than 3 attempts can happen |

### Passive health check

No probe requests are sent; health is judged from real traffic only. With the active health check on, both are merged, see [Merge rule](#merge-rule).

| Item | Behavior |
| --- | --- |
| Counted as failure | Connection failure, timeout, origin response 502/503/504, DNS resolution failure, only special-purpose addresses in the DNS answer, missing S3 credentials, missing CA file on the node for a verified origin |
| Reset | Any other response resets the failure count |
| Down | After **Failures before down** consecutive failures, the origin is not selected for **Retry after (seconds)** |
| Recovery | After that period the origin receives traffic again; one success marks it healthy, one more failure marks it down again immediately |
| Fail open | When every origin is down, the node still tries primaries, then backups |
| Scope | Health state is shared by all workers of one node; each node decides on its own |
| Reporting | Nodes report with their heartbeat (every 15 seconds by default); the **Origins** tab shows "Down on {down} of {total} nodes" and the last error, and each node's result names its source, **Passive** or **Active** |

| Error code | UI text |
| --- | --- |
| `connect_failed` | Cannot connect to the origin |
| `timeout` | The origin timed out |
| `upstream_status` | The origin answered HTTP {status} (passive check: only when the origin itself returned 502/503/504; active check: a status outside the expected range) |
| `dns_failed` | Cannot resolve {host} |
| `address_forbidden` | {address} is a special-purpose address outside the origin allow list |
| `tls_failed` | TLS handshake or certificate verification failed |

Error codes need node proto v0.2.1 or later; other errors and older nodes show the node's own text.

### Active health check

1. On the **Origins** tab, in the **Pool settings** card, turn on **Enabled** under **Active health check**.
2. Enter the **Path**, choose the **Method**, and change other fields as needed.
3. Click **Save** at the bottom of the card.
4. Verify: make one origin's check path answer a status outside the expected range; after about interval × unhealthy threshold seconds the origin shows "Down on {down} of {total} nodes", the node results say **Active**, and requests stop going to it.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Enabled | On / off | Off | Values stay saved while off |
| Path | Starts with `/`, may carry a query, 1–1024 printable ASCII characters without spaces | `/` | Path of the probe |
| Method | GET / HEAD | GET | Method of the probe |
| Lowest / Highest status | 100–599, lowest not above highest | 200 / 399 | A status in the range is a success |
| Host | Host name | Empty (same as origin Host) | `Host` of the probe; empty uses the origin's **Origin Host**, then its address |
| Interval (seconds) | 5–300 | 30 | Time between two probes of an origin |
| Timeout (seconds) | 1–60, not above the interval | 5 | Time limit of one probe; a timeout is a failure |
| Healthy threshold | 1–10 | 2 | Consecutive successes that make an origin healthy again |
| Unhealthy threshold | 1–10 | 3 | Consecutive failures that mark an origin unhealthy |

| Item | Behavior |
| --- | --- |
| Who probes | The agent of every node probes every origin of the site; probe traffic grows with the number of nodes, so keep the interval reasonable |
| Address policy | As for origin requests: special-purpose addresses outside the allow list are dropped from DNS answers and only checked addresses are dialed; without a usable address the probe fails (`dns_failed`, `address_forbidden`) |
| Request | Scheme and port of the origin; HTTPS sends SNI (the origin's SNI, Origin Host or address) and verifies the certificate while **Verify origin certificates** is on; redirects are not followed; at most 64 KiB of the body is read |
| Failure | Connection failure, timeout, TLS failure, status outside the range; same error codes as the passive check |
| Initial state | Healthy; the first probe after a node start or a configuration change starts at a random point within one interval |
| Not probed | S3-compatible origins (an unsigned probe says nothing about signed requests) and origins whose address literal is forbidden |
| Node stops probing | The data plane's "actively down" marks expire after 3 × the longest interval (at least 90 seconds), back to the passive check only |
| Reporting | Origins that are unhealthy or have consecutive failures are reported with the heartbeat, source **Active**; the "Origin unavailable" alert uses both sources |
| Node requirement | Node feature `active-health-v1`; while an active node of the cluster lacks it, tenants cannot turn it on ("Some nodes of the site's cluster do not support it yet") |

#### Merge rule

| Active check | Passive check | Result |
| --- | --- | --- |
| Off | Any | As without an active check |
| Unhealthy | Any | Not selected |
| Healthy | Marked down | Not selected until the passive check's recovery time ends |
| Healthy | Up | Selected |

When every origin is down, the node still tries primaries, then backups (fail open).

### Session affinity

1. In the **Pool settings** card, turn on **Enabled** under **Session affinity** and change **Cookie lifetime (seconds)** as needed.
2. Click **Save**.
3. Verify: the first response from the origin carries `Set-Cookie: __ew_affinity=…`; later requests with that cookie go to the same origin.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Enabled | On / off | Off | Pins a visitor to one origin with a signed cookie |
| Cookie lifetime (seconds) | 60–604800 | 3600 | The cookie's `Max-Age` and the expiry inside its signature |

| Item | Behavior |
| --- | --- |
| Cookie | `__ew_affinity`, `Path=/; HttpOnly; SameSite=Lax`, plus `Secure` over HTTPS; the value holds the origin ID, the expiry and the signature |
| Signature | HMAC-SHA256 with the cluster's challenge keys (the keys of [challenge](challenges.en.md) passes), so any node of the cluster verifies it; after a key rotation the previous key still verifies |
| Issued | Only on responses from the origin (never on cache hits); not issued again while a valid cookie has more than half its lifetime left |
| Reselection | When the pinned origin is down (active or passive check), deleted, or outside the tier taking traffic (a backup while primaries are healthy), the node picks another origin by the load balancing policy and issues a new cookie; tampered or expired cookies are handled the same way |
| Retries | When the pinned origin fails during a request, the retry rules still move it to another origin, and the response pins the origin that answered |
| Node requirement | Node features `session-affinity-v1` and `challenge-v1`; while an active node of the cluster lacks them, tenants cannot turn it on |

### Origin TLS

| Item | Behavior |
| --- | --- |
| Certificate verification | With **Verify origin certificates** on, the node verifies HTTPS origin certificates against a CA file; the certificate must cover the SNI of the attempt, and a retry on another origin uses that origin's SNI |
| CA file | The first existing file of `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/ssl/cert.pem`; a node can set `--trusted-ca <absolute path>` |
| IP origins | HTTPS origins configured by IP need an **SNI** or **Origin Host** that the certificate covers |
| Verification off | Affects only that site; unverified HTTPS connections are not pooled |
| Connection pool | Keyed by origin IP, port, and SNI; verified connections are never reused for requests that verify another name |

### WebSocket

WebSocket upgrades (`Upgrade: websocket`) are proxied by default and never cached. With **WebSocket** off, upgrade requests get 403 with `X-Edgeweir-Error: websocket-disabled`.

### Origin groups

**Origin group** splits a site's origins into groups; empty is the default group. Requests that match no **Origin override** rule go to the default group only.

1. In the **Origins** card, enter an **Origin group** for an origin, for example `api`, and click **Save**. Keep at least one origin in the default group; otherwise the card shows "Keep at least one origin in the default group" and cannot be saved.
2. On the **Rules** tab, click **Add rule** in the **Origin** phase and enter an expression such as `starts_with(http.request.uri.path, "/api/")`; select the **Origin override** action, pick `api` as **Origin group**, set **Origin Host**, **SNI**, and **Port** as needed, and click **Save**. Fields: [Action fields](rules.en.md#action-fields).
3. Verify: requests below `/api/` reach the origins of the `api` group in their logs; other paths still reach the default group.

| Item | Behavior |
| --- | --- |
| Selection within the group | Load balancing, primaries and backups, retries, health checks, and session affinity all stay within the chosen group; round robin state and the consistent hash are kept per group |
| Overrides | The rule's **Port** applies to every origin of the group; **Origin Host** and **SNI** replace the origin's own settings, and **Origin Host** does not affect S3 origins; an empty SNI still follows the origin Host |
| Cache key | The origin group is not part of it. When a group is chosen by something outside the cache key (a request header, for example), responses of different groups share cached objects |
| References | Rules can pick only groups the site has; removing a group a rule still picks fails with "Invalid rule" |
| Platform rules | A platform **Origin override** cannot pick an origin group; it overrides only the origin Host, SNI, and port |
| Node requirement | `rules-v2`; while an active node of the cluster lacks it, tenants cannot move origins out of the default group ("Some nodes of the site's cluster do not support it yet") |

## Origin address restrictions

Origins cannot point at special-purpose addresses.

| Category | Ranges |
| --- | --- |
| IPv4 | `0.0.0.0/8`, `10.0.0.0/8`, `100.64.0.0/10`, `127.0.0.0/8`, `169.254.0.0/16`, `172.16.0.0/12`, `192.0.0.0/24`, `192.0.2.0/24`, `192.168.0.0/16`, `198.18.0.0/15`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4` |
| IPv6 | `::/128`, `::1/128`, `100::/64`, `2001:db8::/32`, `fc00::/7`, `fe80::/10`, `ff00::/8`; IPv4-mapped (`::ffff:0:0/96`) and NAT64 (`64:ff9b::/96`) addresses are judged by the embedded IPv4 address |
| Host names | `localhost` and `*.localhost` are always refused; names whose last label is numeric, such as `127.1`, `2130706433`, or `0x7f000001`, are not valid addresses |

| Checkpoint | Behavior |
| --- | --- |
| Console save | IP literals in these ranges are refused (`ORIGIN_ADDRESS_FORBIDDEN`) |
| Node | Applies the same list to configured addresses and to every DNS answer; special-purpose addresses in an answer are dropped, and when all are dropped the attempt fails with `address_forbidden` |
| Allow list | Platform administrators allow ranges in **Admin → System → Origin allow list** for every organization, see [Platform administration](admin.en.md); `localhost` cannot be allowed |
| Loop detection | Nodes send `CDN-Loop` (RFC 8586) to origins; a request that already carries the node's identifier gets 508 (`X-Edgeweir-Error: loop-detected`) |

## S3-compatible object storage

Turn on **S3 signing** on an origin and fill in these fields.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Region | Letters, digits, `-`, up to 64 characters | None | SigV4 signing region, for example `us-east-1` |
| Bucket | Bucket name of 3–63 characters | Empty | When set, path-style addressing `/<bucket>/<key>`; leave empty when the origin address already names the bucket (such as `assets.s3.us-east-1.amazonaws.com`) |
| Access key ID | Up to 128 characters | None | Access key ID |
| Secret key | Up to 256 characters | None | Write-only; after saving it shows "Stored, leave empty to keep"; changing **Access key ID** requires entering it again |

| Item | Behavior |
| --- | --- |
| Signing | AWS Signature V4 with an unsigned payload (`UNSIGNED-PAYLOAD`); the visitor's `x-amz-*` headers are removed |
| Methods | Only `GET` and `HEAD` are forwarded; other methods get 405 (`Allow: GET, HEAD`) when no non-S3 origin can take them |
| Query string | The visitor's query string is not forwarded to object storage |
| Secret storage | The secret key is envelope-encrypted with the master key, sent only over the node channel (mTLS), and kept in the node state directory's `credentials.json` (0600) so the node can restart while the console is unreachable |

## Configure cache rules

1. Open **Console → Sites**, select the site, and open the **Cache** tab.
2. In the **Cache rules** card, click **Add rule**.
3. In **Builder**, enter **Path prefix** and **Extensions**; or switch to **Advanced** and enter the condition in **Expression**, see [Request conditions](#request-conditions).
4. Select **Action**, enter **TTL (seconds)**, and set **Browser TTL (s)** and turn on **Respect origin** as needed.
5. For more conditions, click **More** and fill in **Exact paths** (builder only), **Status codes**, **Min size (KB)**, **Max size (KB)**, **Stale while revalidate (s)**, **Stale if error (s)**, or turn on **Cache requests with Authorization**.
6. Drag the handle on the left of a rule to reorder.
7. Click **Save**.
8. Verify: request the same URL twice; the second response is a cache hit:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/static/app.js | grep -i x-cache
   ```

   The second run prints `X-Cache: HIT`.

### Rule fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Condition type | Builder / Advanced | Builder | See [Request conditions](#request-conditions) |
| Path prefix | Starts with `/`, comma-separated, up to 32 | `/` | Builder: the request path starts with one of them |
| Extensions | 1–16 lowercase letters or digits, comma-separated, up to 64 | Empty | Builder: the request path's extension is one of them, for example `css, js, png` |
| Expression | A condition of the `cache` phase, up to 16384 characters | None | Advanced: the request condition |
| Action | Cache / Bypass | Cache | Cache or bypass on match |
| TTL (seconds) | 0–31536000 | 3600 | The rule's cache lifetime |
| Browser TTL (s) | 0–31536000 | Empty (origin's) | See [Browser TTL](#browser-ttl); unavailable for **Bypass** rules |
| Respect origin | On / off | Off | Off: override origin cache headers; on: follow origin `Cache-Control` / `Expires` |
| Exact paths | Start with `/`, up to 32 | Empty | Builder: the request path equals one of them |
| Status codes | 100–599, up to 16 | Empty | Empty: only the default cacheable status codes |
| Min size (KB) / Max size (KB) | 0 or more; max not below min | Empty (no limit) | Response size range |
| Stale while revalidate (s) | 0–2592000 | Empty (off) | stale-while-revalidate |
| Stale if error (s) | 0–2592000 | Empty (off) | stale-if-error |
| Cache requests with Authorization | On / off | Off | Allows caching requests with `Authorization` |

Each site has at most 64 rules. Without rules the card shows **No caching** and the site caches nothing.

### Matching

| Item | Behavior |
| --- | --- |
| Order | Rules match in list order; the first applicable rule decides caching, TTL, and browser TTL; without an applicable rule nothing is cached |
| Request condition | One expression, evaluated on the client's original request: the normalized path before rule rewrites, as for the cache key and purges |
| Response conditions | Status code, response size. When request conditions match but response conditions do not, later rules are evaluated |
| Response size | From `Content-Length`; for 206 responses the full size in `Content-Range`; an unknown size fails size conditions |

### Request conditions

The request condition is an expression of the `cache` phase, with the fields, functions, and IP list references of [rule expressions](rules.en.md#expressions); response fields, `regex_replace`, and `wildcard_replace` are not available. `true` matches every request.

| Condition type | Behavior |
| --- | --- |
| Builder | **Path prefix**, **Extensions**, and **Exact paths** build the expression: any entry within one condition type may match, all condition types must match, and empty conditions do not restrict. For example, the prefixes `/static/, /img/` and extensions `css, js` build `(starts_with(http.request.uri.path, "/static/") or starts_with(http.request.uri.path, "/img/")) and http.request.uri.path.extension in {"css" "js"}` |
| Advanced | Write the condition in **Expression**, for example `starts_with(http.request.uri.path, "/static/") and not ends_with(http.request.uri.path, ".html")` |
| Switching | Expressions in the builder's shape switch between both types; other expressions can be edited only in **Advanced** |
| Nodes | Conditions in the builder's shape (also when written in **Advanced**) are sent as the former structured conditions, so older nodes run them as before; other expressions need the node capability `rules-v2` |
| Upgrade | Cache rules saved before the upgrade were rewritten as equivalent builder expressions; they match exactly as before |

### Browser TTL

With **Browser TTL (s)** above 0, responses the rule caches reach visitors with `Cache-Control: max-age=N`.

| Item | Behavior |
| --- | --- |
| When | The rule that decides the response (as for the TTL) caches it: override mode with a TTL above 0, or respect mode with an origin `Cache-Control` without `no-store`, `no-cache`, or `private` |
| Effect | The `Cache-Control` visitors receive becomes `max-age=N`, on cache hits too; the edge cache keeps using the TTL |
| Otherwise | Visitors receive the origin's `Cache-Control` |
| Response transform | Response transform rules can still change `Cache-Control` |
| Node requirement | `rules-v2`; while an active node of the cluster lacks it, tenants cannot set it ("Some nodes of the site's cluster do not support the rule extensions yet") |

### TTL

| Mode | Behavior |
| --- | --- |
| Override (**Respect origin** off) | Uses the rule TTL and ignores origin `Cache-Control` and `Expires` (including `no-store` and `private`); without status codes only 200, 203, 206, 300, 301, and 308 are cached |
| Respect (**Respect origin** on) | Follows origin `Cache-Control` or `Expires` when present; the rule TTL applies only when neither is sent; a `Cache-Control` without a lifetime (for example only `public`) is not cached; `no-store` and `private` apply |
| Always | Responses with `Set-Cookie` are not cached |

### Authorization

Requests with `Authorization` bypass the cache by default, and their responses are not stored (RFC 9111 §3.5), even when the origin sends `public` or the rule overrides origin headers. With **Cache requests with Authorization** on, the rule caches them and every visitor holding any credential shares the same cached copy; use it only for content that does not depend on the credential.

### Stale content

| Field | Behavior |
| --- | --- |
| Stale while revalidate (s) | For this long after expiry, the stale object is served while it is refreshed in the background |
| Stale if error (s) | For this long after expiry, the stale object is served when the origin fails to connect, times out, or returns 5xx |

Both have no effect when the TTL is 0. Visitors receive the origin's original `Cache-Control`, and none when the origin sent none, unless a [browser TTL](#browser-ttl) is set.

## Cache key and slicing

The **Cache key & slicing** card is saved separately and applies to all rules of the site.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Query string | All parameters / Ignore / Only listed | All parameters | How the query string enters the key |
| Parameters | Parameter names, comma-separated, up to 32 | Empty | Parameters kept by **Only listed** |
| Sort parameters | On / off | Off | Makes `?a=1&b=2` and `?b=2&a=1` hit the same object; unavailable with **Ignore** |
| Headers | Header names, comma-separated, up to 8, not `Cookie` or `Host` | Empty | Different values are cached separately |
| Cookies | Cookie names, comma-separated, up to 8 | Empty | Different values are cached separately |
| Separate mobile and desktop | On / off | Off | Splits mobile (including tablets) and desktop user agents |
| Include Host | On / off | On | Off: all domains of the site share cached objects |
| Range slicing | On / off | Off | Cacheable `GET`/`HEAD` requests are fetched and cached in 1 MiB slices, so Range requests need only the slices they cover; the origin must support Range (206). Off: a Range request fetches the whole object first |

| Item | Behavior |
| --- | --- |
| Fixed parts | The scheme and cache generation are always part of the key; with **Include Host** off, HTTP and HTTPS are still cached separately |
| Mobile detection | The User-Agent matches `Mobi\|Android\|iPhone\|iPad\|iPod\|Windows Phone\|BlackBerry\|Opera Mini\|webOS` |
| After a change | Objects cached under the old key no longer hit and are evicted by the cache zone's inactive time |
| Cache zone | One zone per node: 10 GiB maximum size; objects not accessed for 7 days are evicted |

## Purge and prefetch

1. Open **Console → Purge & prefetch**.
2. Select **Purge URLs**, **Purge directories**, **Purge hosts**, **Purge cache tags**, **Purge sites**, **Prefetch URLs**, or **Prefetch a sitemap**.
3. For URL tasks, enter one URL per line; for **Purge hosts**, one host per line; for **Purge cache tags**, choose the site and enter one tag per line (or comma separated); for **Purge sites**, check the sites; for **Prefetch a sitemap**, enter the **Sitemap URL** and the **URL limit**. For prefetches, check **Desktop** and/or **Mobile** under **Devices**.
4. Click **Submit**.
5. Verify: the task appears under **Tasks**; expanded, each node shows **Succeeded**; after a purge, the next request returns `X-Cache: MISS`.

Tasks go to every enabled node of the site's cluster, with a result per node.

### Task types

| Type | Input | Behavior |
| --- | --- | --- |
| Purge URLs | Full URLs, query allowed | Purges the device, header, cookie, and slice variants of the URL. Query and Host are compared by the site's cache key; only objects whose normalized query equals the target's are purged. Paths are compared in the node's normalized form (percent-decoding, merged slashes, resolved `.` and `..`), so `/%73tatic/a.js` equals `/static/a.js` |
| Purge directories | URL prefixes without a query | Purges every object under that Host whose path starts with the prefix; the prefix is normalized the same way and compared as a string prefix; with **Include Host** off, the Host is not compared |
| Purge hosts | Host names, without port or wildcard | Purges every object of the host, like a directory purge of `/` on that host; for sites with **Include Host** off it purges the objects all domains share |
| Purge cache tags | One or more sites and up to 500 cache tags | Purges the objects of those sites whose response carried any of the tags, see [Cache-Tag](#cache-tag) |
| Purge sites | Sites | Purges the whole cache of each site |
| Prefetch URLs | Full `http://` or `https://` URLs; devices | The node requests the URL through its own edge layer as a normal request and caches it; a status below 400 is success; redirects are not followed. With **Separate mobile and desktop** on, each checked device is requested once (mobile with a mobile User-Agent); otherwise one request |
| Prefetch a sitemap | One sitemap URL, a URL limit (1–10000, default 1000); devices | The node fetches the sitemap through its own edge layer (so the origin address policy applies and the console makes no outbound request) and prefetches the site's URLs it lists, see [Sitemaps](#sitemaps) |

URLs must start with `http://` or `https://`, must not carry credentials, and their Host must be a domain of the organization's sites (including subdomains under a wildcard). `https://` URLs are prefetched through the node's first HTTPS listener without the PROXY protocol (the node's own certificate is not verified); without such a listener they fail ("the node has no HTTPS listener yet").

### Cache-Tag

The origin lists tags, comma separated, in the `Cache-Tag` response header, e.g. `Cache-Tag: product-42, category-7`.

| Item | Behavior |
| --- | --- |
| Parsing | Compared in lowercase after trimming spaces and tabs; printable ASCII only (no comma); a tag is at most 128 bytes, the whole header at most 4096 bytes (several lines are joined); tags beyond that are dropped and the response is cached as usual |
| Forwarding | Not forwarded to visitors by default (cache hits included); with **Forward Cache-Tag to clients** on in the **Cache-Tag** card of the site's **Cache** tab it is forwarded as is |
| Purge result | Once the task succeeded, no node returns an object carrying a purged tag, also not as stale content after it expired; all slices of a sliced object are purged together |
| Index | Nodes record the tags of every cached object of sites that use `Cache-Tag`, in shared memory (node flag `--tag-dict-mb`, default 64 MiB), evicting the least recently used |
| Extra origin requests | Objects the index does not know (evicted, after an nginx restart, cached before the site's first `Cache-Tag` response) go to the origin once while the site has tag purges on record, then hit again |
| Tag counts | Up to 500 tags per task; nodes keep up to 5000 tag purges per site (node flag `--purge-tags-per-site`) and merge beyond that into one whole-site purge |
| Node requirement | Node feature `purge-tag-v1`; while an active node of the cluster lacks it, host and tag purges are refused (`NODE_CAPABILITY_REQUIRED`), for platform administrators too |

### Sitemaps

| Item | Behavior |
| --- | --- |
| Sitemap URL | Must belong to a site of the organization; the node requests it from its own edge layer without following redirects, 30 seconds and at most 50 MiB unpacked per document; gzip-compressed sitemaps are recognized by their content |
| Format | `<loc>` of a `urlset`; a `sitemapindex` is followed one level, and its sitemaps must be on the site's domains too |
| Selection | Only `http(s)` URLs on the site's domains (wildcards included), de-duplicated, the first ones in document order up to the URL limit |
| Result | Each URL and device counts as one success or failure; a sitemap that cannot be fetched or parsed fails the task (`sitemap_failed`), one without URLs of the site too (`sitemap_empty`) |
| Node requirement | Node feature `prefetch-v2` (also for mobile prefetches); while an active node of the cluster lacks it the task is refused (`NODE_CAPABILITY_REQUIRED`) |

### Purge a site's cache

On the site's **Overview** tab, click **Purge cache** and confirm. The console increments the site's cache generation and publishes a revision ("Site {site} purged"); every cached object of the site becomes stale. It shares the organization rate limit with tasks and counts as one entry.

### Task limits

| Item | Limit |
| --- | --- |
| Per task | Up to 500 URLs, 500 hosts or 500 tags, or 100 sites; each URL up to 2048 characters; one sitemap per sitemap prefetch |
| Organization rate | Up to 10 tasks per minute and 2000 entries per hour (each URL, directory, host, or site is one entry; tags count per site and tag; a sitemap task is one entry; prefetch devices do not count extra); beyond that 429 (`CACHE_TASK_RATE_LIMITED`, with the seconds to wait) |
| Platform administrators | Not rate-limited; tasks they submit for an organization's sites count toward that organization's usage; whole-site purges the console sends on its own do not count |
| Node purge markers | Up to 1000 URL, directory and host markers per site (node flag `--purge-markers-per-site`) and 5000 tag markers (`--purge-tags-per-site`); beyond that they merge into one whole-site purge |
| Order | A node runs the purges of a batch before its prefetches |
| Prefetch time | A batch (up to 10 tasks) shares a 4-minute budget (node flag `--prefetch-budget`) counted from the pull; 60 seconds per URL; concurrency 4; URLs unfinished at the deadline fail (`prefetch_timeout`) |
| Files on disk | A purge does not delete files: the next request uses a new cache key and goes to the origin; old objects are evicted by the cache zone's inactive time and size limit |

### Node states

| State | Meaning |
| --- | --- |
| Pending | The node has not taken the task; stays pending while the node is offline |
| Running | The node took the task; without a result within 5 minutes it is handed out again |
| Succeeded / Failed | The result the node reported |
| Skipped | The node is disabled and the task was not sent (`node_disabled`); not counted in progress. Unfinished tasks of a node that gets disabled are also skipped |

| Case | Behavior |
| --- | --- |
| Not run within 7 days | Failed ("Not executed by the node within 7 days", `task_expired`) |
| Make-up whole-site purge | A node that reconnects after more than 7 days offline, or is re-enabled, does not run expired purges; it gets one whole-site purge for each affected site instead: one task per organization, source "System (make-up whole-site purge)", sent only to that node; the original task shows "Made up with a whole-site purge when the node came back" for that node |
| Prefetch | Missed prefetches are not made up |

## Limits

| Item | Description |
| --- | --- |
| Counts | Per site: 1–50 domains, 1–32 origins, up to 64 cache rules |
| Cache rule conditions | Up to 16384 characters; no response fields |
| Origin groups | The cache key does not include the origin group |
| Cache zone | Size and inactive time cannot be changed in the console |
| HTTPS prefetch | Needs an HTTPS listener without the PROXY protocol on the node; the cache key includes the scheme, so `http://` prefetch warms only the HTTP cache |
| Device variants | Desktop and mobile only (tablets count as mobile) |
| Authorization switch | Needs node proto v0.2.1 or later; older nodes ignore **Cache requests with Authorization** |
| WebSocket | Only `Upgrade: websocket` is recognized |

## Troubleshooting

Errors the node returns itself carry `X-Edgeweir-Error` and `Cache-Control: no-store`. `X-Cache` is the nginx cache status: `MISS`, `HIT`, `BYPASS`, `EXPIRED`, `STALE`, `UPDATING`, or `REVALIDATED`.

| Symptom | Cause | Action |
| --- | --- | --- |
| Saving shows "Origin address … is in the special-purpose range …, which the platform does not allow" | The origin IP literal is in a special-purpose range | Use a public address, or have a platform administrator add the range to the origin allow list |
| The origin shows "… is a special-purpose address outside the origin allow list" | Every DNS answer for the origin name is a special-purpose address | Same as above |
| An HTTPS origin returns 502 and shows "TLS handshake or certificate verification failed" | Self-signed certificate, certificate not covering the SNI, or incomplete chain; missing CA file on the node | Use a trusted certificate or the correct **SNI**; for self-signed origins turn off **Verify origin certificates**; point the node at a CA file with `--trusted-ca` |
| 502 with `X-Edgeweir-Error: no-origin` | Every origin was dropped before the attempt (resolution failure, forbidden address, missing S3 credentials) | Read the error on the **Origins** tab |
| 404 with `X-Edgeweir-Error: unknown-host` | The Host belongs to no site the node applied: unverified domain, deleted site, or the node has not applied the latest revision | Complete [domain ownership](dns-and-alerts.en.md#verify-domain-ownership); check the node's **Applied** revision |
| 508 with `X-Edgeweir-Error: loop-detected` | The origin points back at this node or at a CDN in front of it | Change the origin address |
| 403 with `X-Edgeweir-Error: websocket-disabled` | WebSocket is off for the site | Turn on **WebSocket** |
| 405 with `X-Edgeweir-Error: method-not-allowed` | S3 origins accept only `GET` and `HEAD` | Add a non-S3 origin for write requests |
| Requests with `Authorization` always show `X-Cache: BYPASS` | Bypassed by default | Turn on **Cache requests with Authorization** on the rule |
| Responses always show `X-Cache: MISS` | No applicable rule; in respect mode the origin sent no lifetime; the response has `Set-Cookie`; the TTL is 0 | Check rule order, conditions, and origin headers |
| The **Origins** card shows "Keep at least one origin in the default group" | Every origin has an **Origin group** | Clear **Origin group** on at least one origin |
| Saving origins or cache rules shows "Invalid rule" | An origin group that an **Origin override** rule still picks was removed; a cache rule condition is invalid | Change the rule first, or keep an origin in that group; fix the condition |
| "Cluster nodes need these capabilities first: rules-v2" | An active node of the cluster lacks `rules-v2` and the save uses origin groups, advanced conditions, or a browser TTL | Upgrade the nodes, see [Node upgrades](node-upgrades.en.md) |
| Requests sent to different origin groups get the same cached object | The cache key does not include the origin group | Pick origin groups by path, or add what decides the group to the cache key |
| "Too many purges: …" | The organization hit the rate limit | Retry after the stated seconds; merge URLs into a directory purge |
| "No site serves …" | The URL's Host is not a domain of the organization's sites | Check the domain and its organization |
| "Invalid URL: …" | Not an `http(s)` URL, carries credentials, or a directory purge has a query | Fix the URL |
| "Invalid host: …" | Has a port, is a wildcard, or is not a valid host name | Enter one host name per line |
| "Invalid cache tag: …" | The tag has a comma or non-ASCII characters, or is longer than 128 bytes | Fix the tag; the origin's `Cache-Tag` follows the same rules |
| "Some nodes … do not support …" (`NODE_CAPABILITY_REQUIRED`) | An active node of the cluster lacks `purge-tag-v1` or `prefetch-v2` | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| Prefetch fails with "the node has no HTTPS listener yet" | The node has no HTTPS listener without the PROXY protocol | Use `http://` URLs, or add an HTTPS listener to the node |
| "Could not fetch the sitemap … (…)" | The sitemap answered an error status or a redirect, timed out, is larger than 50 MiB, or is not a valid sitemap | Request the sitemap URL directly; enter the final address of a redirect |
| "The sitemap … lists no URL of the site" | The sitemap lists URLs of other domains only | Check the domains in the sitemap |
| Old content after a tag purge | The origin did not send that tag in the object's `Cache-Tag`, or the tag has characters that are not accepted | Turn on **Forward Cache-Tag to clients** and look at the response header |
| "Ran out of time after … URLs" | The 4-minute budget ran out | Split into several tasks |
| "The node does not support this task type (…); upgrade edgeweir-node" | The node is too old | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
