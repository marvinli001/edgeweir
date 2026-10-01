# Origins and cache

A site's origin pool, origin connections, cache rules, cache key, and purge and prefetch.

## Concepts

| Term | Definition |
| --- | --- |
| Origin pool | All origins of a site plus load balancing, health check, timeout, and keep-alive settings. One pool per site. |
| Primary / backup origin | Origins without **Backup** are primaries and receive traffic by the load balancing policy; backups receive traffic only when every primary is down. |
| Cache rule | A rule matched in list order that decides whether and for how long a response is cached. |
| Cache key | The request attributes that tell cached objects apart; applies to all cache rules of the site. |
| Cache generation | A per-site counter that is part of the cache key; **Purge cache** increments it and every cached object of the site becomes stale. |

## Configure origins

1. Open **Sites**, select the site, and open the **Origins** tab.
2. In the **Origins** card, edit an existing origin or click **Add origin**.
3. Enter **Origin**, **Port**, **Protocol**, and **Weight**; set **Origin Host** and **SNI** as needed; turn on **Backup** or **S3 signing** as needed.
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
| Backup | On / off | Off | Makes the origin a backup |
| S3 signing | On / off | Off | Signs origin requests with AWS Signature V4, see [S3-compatible object storage](#s3-compatible-object-storage) |

Each site has 1–32 origins.

### Pool settings

The **Pool settings** card is saved separately.

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

No probe requests are sent; health is judged from real traffic only.

| Item | Behavior |
| --- | --- |
| Counted as failure | Connection failure, timeout, origin response 502/503/504, DNS resolution failure, only special-purpose addresses in the DNS answer, missing S3 credentials, missing CA file on the node for a verified origin |
| Reset | Any other response resets the failure count |
| Down | After **Failures before down** consecutive failures, the origin is not selected for **Retry after (seconds)** |
| Recovery | After that period the origin receives traffic again; one success marks it healthy, one more failure marks it down again immediately |
| Fail open | When every origin is down, the node still tries primaries, then backups |
| Scope | Health state is shared by all workers of one node; each node decides on its own |
| Reporting | Nodes report with their heartbeat (every 15 seconds by default); the **Origins** tab shows "Down on {down} of {total} nodes" and the last error |

| Error code | UI text |
| --- | --- |
| `connect_failed` | Cannot connect to the origin |
| `timeout` | The origin timed out |
| `upstream_status` | The origin answered HTTP {status} (only when the origin itself returned 502/503/504) |
| `dns_failed` | Cannot resolve {host} |
| `address_forbidden` | {address} is a special-purpose address outside the origin allow list |
| `tls_failed` | TLS handshake or certificate verification failed |

Error codes need node proto v0.2.1 or later; other errors and older nodes show the node's own text.

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
| Allow list | Ranges are allowed in **System → Origin allow list**; saving publishes to every cluster, see [Origin allow list](system.en.md#origin-allow-list); `localhost` cannot be allowed |
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

1. Open **Sites**, select the site, and open the **Cache** tab.
2. In the **Cache rules** card, click **Add rule**.
3. Enter **Path prefix** and **Extensions**, select **Action**, enter **TTL (seconds)**, and turn on **Respect origin** as needed.
4. For more conditions, click **More** and fill in **Exact paths**, **Status codes**, **Min size (KB)**, **Max size (KB)**, **Stale while revalidate (s)**, **Stale if error (s)**, or turn on **Cache requests with Authorization**.
5. Drag the handle on the left of a rule to reorder.
6. Click **Save**.
7. Verify: request the same URL twice; the second response is a cache hit:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/static/app.js | grep -i x-cache
   ```

   The second run prints `X-Cache: HIT`.

### Rule fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Path prefix | Starts with `/`, comma-separated, up to 32 | `/` | The request path starts with one of them |
| Extensions | 1–16 lowercase letters or digits, comma-separated, up to 64 | Empty | The request path ends with one of them, for example `css, js, png` |
| Action | Cache / Bypass | Cache | Cache or bypass on match |
| TTL (seconds) | 0–31536000 | 3600 | The rule's cache lifetime |
| Respect origin | On / off | Off | Off: override origin cache headers; on: follow origin `Cache-Control` / `Expires` |
| Exact paths | Start with `/`, up to 32 | Empty | The request path equals one of them |
| Status codes | 100–599, up to 16 | Empty | Empty: only the default cacheable status codes |
| Min size (KB) / Max size (KB) | 0 or more; max not below min | Empty (no limit) | Response size range |
| Stale while revalidate (s) | 0–2592000 | Empty (off) | stale-while-revalidate |
| Stale if error (s) | 0–2592000 | Empty (off) | stale-if-error |
| Cache requests with Authorization | On / off | Off | Allows caching requests with `Authorization` |

Each site has at most 64 rules. Without rules the card shows **No caching** and the site caches nothing.

### Matching

| Item | Behavior |
| --- | --- |
| Order | Rules match in list order; the first applicable rule decides caching and TTL; without an applicable rule nothing is cached |
| Combination | Any entry within one condition type may match; all condition types must match; empty conditions do not restrict |
| Request conditions | Path prefix, exact path, extension; the path is normalized and taken before rule rewrites |
| Response conditions | Status code, response size. When request conditions match but response conditions do not, later rules are evaluated |
| Response size | From `Content-Length`; for 206 responses the full size in `Content-Range`; an unknown size fails size conditions |

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

Both have no effect when the TTL is 0. Visitors receive the origin's original `Cache-Control`; when the origin sent none, none is added.

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

1. Open **Purge & prefetch**.
2. Select **Purge URLs**, **Purge directories**, **Purge sites**, or **Prefetch URLs**.
3. For URL tasks, enter one URL per line; for **Purge sites**, check the sites.
4. Click **Submit**.
5. Verify: the task appears under **Tasks**; expanded, each node shows **Succeeded**; after a purge, the next request returns `X-Cache: MISS`.

Tasks go to every enabled node of the site's cluster, with a result per node. Disabled sites cannot be purged or prefetched ("The site is disabled").

### Task types

| Type | Input | Behavior |
| --- | --- | --- |
| Purge URLs | Full URLs, query allowed | Purges the device, header, cookie, and slice variants of the URL. Query and Host are compared by the site's cache key; only objects whose normalized query equals the target's are purged. Paths are compared in the node's normalized form (percent-decoding, merged slashes, resolved `.` and `..`), so `/%73tatic/a.js` equals `/static/a.js` |
| Purge directories | URL prefixes without a query | Purges every object under that Host whose path starts with the prefix; the prefix is normalized the same way and compared as a string prefix; with **Include Host** off, the Host is not compared |
| Purge sites | Sites | Purges the whole cache of each site |
| Prefetch URLs | Full `http://` URLs | The node requests the URL as a normal request and caches it; a status below 400 is success; redirects are not followed; with **Separate mobile and desktop** on, only the desktop variant is warmed |

URLs must start with `http://` or `https://`, must not carry credentials, and their Host must be a domain of a site (including subdomains under a wildcard).

### Purge a site's cache

On the site's **Overview** tab, click **Purge cache** and confirm. The console increments the site's cache generation and publishes a revision ("Site {site} purged"); every cached object of the site becomes stale. A disabled site cannot be purged.

### Task limits

| Item | Limit |
| --- | --- |
| Per task | Up to 500 URLs or 100 sites; each URL up to 2048 characters |
| Node purge markers | Up to 1000 URL and directory markers per site (node flag `--purge-markers-per-site`); beyond that they merge into one whole-site purge |
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
| Make-up whole-site purge | A node that reconnects after more than 7 days offline, or is re-enabled, does not run the purges it missed; it gets one whole-site purge for each affected site instead: all in one task, source "System (make-up whole-site purge)", sent only to that node; deleted sites are left out. The original task shows "Made up with a whole-site purge when the node came back" for that node |
| Prefetch | Missed prefetches are not made up |

## Limits

| Item | Description |
| --- | --- |
| Counts | Per site: 1–50 domains, 1–32 origins, up to 64 cache rules |
| Health checks | Passive only; no probe requests |
| Cache zone | Size and inactive time cannot be changed in the console |
| HTTPS prefetch | Not supported; `https://` URLs fail ("the node has no HTTPS listener yet"). The cache key includes the scheme, so `http://` prefetch warms only the HTTP cache |
| Authorization switch | Needs node proto v0.2.1 or later; older nodes ignore **Cache requests with Authorization** |
| WebSocket | Only `Upgrade: websocket` is recognized |

## Troubleshooting

Errors the node returns itself carry `X-Edgeweir-Error` and `Cache-Control: no-store`. `X-Cache` is the nginx cache status: `MISS`, `HIT`, `BYPASS`, `EXPIRED`, `STALE`, `UPDATING`, or `REVALIDATED`.

| Symptom | Cause | Action |
| --- | --- | --- |
| Saving shows "Origin address … is in the special-purpose range …, which the origin allow list does not include" | The origin IP literal is in a special-purpose range | Use a public address, or add the range to the origin allow list |
| The origin shows "… is a special-purpose address outside the origin allow list" | Every DNS answer for the origin name is a special-purpose address | Same as above |
| An HTTPS origin returns 502 and shows "TLS handshake or certificate verification failed" | Self-signed certificate, certificate not covering the SNI, or incomplete chain; missing CA file on the node | Use a trusted certificate or the correct **SNI**; for self-signed origins turn off **Verify origin certificates**; point the node at a CA file with `--trusted-ca` |
| 502 with `X-Edgeweir-Error: no-origin` | Every origin was dropped before the attempt (resolution failure, forbidden address, missing S3 credentials) | Read the error on the **Origins** tab |
| 404 with `X-Edgeweir-Error: unknown-host` | The Host belongs to no site the node applied: the site is disabled or deleted, or the node has not applied the latest revision | Check the **Status** on the site's **Overview** tab and the node's **Applied** revision |
| 508 with `X-Edgeweir-Error: loop-detected` | The origin points back at this node or at a CDN in front of it | Change the origin address |
| 403 with `X-Edgeweir-Error: websocket-disabled` | WebSocket is off for the site | Turn on **WebSocket** |
| 405 with `X-Edgeweir-Error: method-not-allowed` | S3 origins accept only `GET` and `HEAD` | Add a non-S3 origin for write requests |
| Requests with `Authorization` always show `X-Cache: BYPASS` | Bypassed by default | Turn on **Cache requests with Authorization** on the rule |
| Responses always show `X-Cache: MISS` | No applicable rule; in respect mode the origin sent no lifetime; the response has `Set-Cookie`; the TTL is 0 | Check rule order, conditions, and origin headers |
| "No site serves …" | The URL's Host is not a domain of any site | Check the spelling of the domain |
| "The site is disabled" | A task or **Purge cache** concerns a disabled site | Enable the site on its **Overview** tab, then submit again |
| "Invalid URL: …" | Not an `http(s)` URL, carries credentials, or a directory purge has a query | Fix the URL |
| Prefetch fails with "the node has no HTTPS listener yet" | Prefetch supports only `http://` | Use `http://` URLs |
| "Ran out of time after … URLs" | The 4-minute budget ran out | Split into several tasks |
| "The node does not support this task type (…); upgrade edgeweir-node" | The node is too old | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
