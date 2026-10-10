# Access logs and access keys

Traffic analytics and statistics dimensions, access log sampling, forced logging, search and export, retention, the live view on a node, analytics storage modes, and creating and revoking access keys.

## Concepts

| Term | Definition |
| --- | --- |
| Analytics | Complete per-minute counts from nodes: requests, traffic, cache hits, status codes, and approximate top URLs and IPs. |
| Access logs | Individual requests recorded at a sample rate. Bounded diagnostic data, not a lossless audit record. |
| Sample rate | The share of requests recorded; a percentage in the UI, an integer in 1/10,000 units (0–10000) in the API. |
| Block reason | Why a node refused or challenged a request, such as `rule`, `ip_banned` or `region`, see [Block reasons](#block-reasons). |
| Statistics dimensions | Bounded classes nodes count per minute: country, network (ASN), referring host, browser / operating system / device, HTTP and TLS version, block reason, challenges. |
| Analytics mode | The value of `EDGEWEIR_ANALYTICS`: `lite` (PostgreSQL, default) or `clickhouse`. |
| Access key | A key (prefix `ewk_`) that calls `/api/v1` as the console account; created and revoked in **Personal settings**. |

## View analytics

| Location | Scope |
| --- | --- |
| **Overview** | All sites and nodes, including **Top sites** and **Top nodes** |
| **Sites** → **Analytics** tab | One site |

1. Open a page from the table and select a range: **Last hour**, **Last 6 hours**, **Last 24 hours**, **Last 7 days**, or **Last 30 days**.
2. Read **Total requests**, **Data transferred**, **Cache hit ratio**, **Peak bandwidth**, **4xx rate**, **5xx rate**, **Status codes**, **Top URLs (approximate)**, and **Top IPs (approximate)**; click a metric for details. A site's **Analytics** tab also has **Countries**, **Networks (approximate)**, **Referrers (approximate)**, **Clients** and **Protocols** cards, and the overview **Top countries by traffic** (by data transferred), see [Statistics dimensions](#statistics-dimensions).
3. Click **Refresh** to reload.
4. To act on an entry, click **⋯** at the end of its row: a top IP offers **Ban IP** (with the site filled in on a site's **Analytics** tab, with the **Global** scope on the overview); a top URL on a site's **Analytics** tab offers **Purge URL**, which expands the path to each of the site's domains that is not a wildcard and lists the URLs before it submits the purge.

Readouts with a fixed window and no range to pick:

| Location | Content |
| --- | --- |
| **Right now** on the **Overview** | Request rate and egress of all sites in the last full minute, cache hit ratio over the last hour, see [Overview](account.en.md#overview) |
| **Requests (24h)** in the **Sites** list | Each site's requests over the last 24 hours, with a trend line; shown only with at most 20 sites and no search or filter on the list |
| **Sites** → **Overview** tab → **Live requests** | An enabled site's requests per second over the last hour, minute by minute (the minute still being counted is left out); hover to read a minute |

### Analytics data

| Item | Behavior |
| --- | --- |
| Retention | Minute detail for 7 days, hourly rollups for 90 days, daily rollups for 365 days; in `clickhouse` mode the console charts and alerts still use the PostgreSQL rollups |
| Late data | Late minute data triggers a recompute of its hour and day; data older than 7 days is discarded |
| Rollups | A background job rolls up incrementally every minute; UTC boundaries are fixed; long-range charts read completed hourly rollups plus detail not yet rolled up |
| Top URLs / IPs | Bounded Space-Saving estimates computed on the node and labeled "approximate": each worker tracks at most 128 site buckets per minute with up to 32 candidates each; the top 50 per bucket are kept; infrequent items can be missed; not for billing |
| URL content | No query strings or headers; paths over 512 bytes or containing `?` or control characters are not counted; paths themselves can still contain business identifiers |
| Counter ceiling | A cumulative counter per node, site, and time bucket stops at 9,007,199,254,740,991 (`Number.MAX_SAFE_INTEGER`) |
| Deletion | Deleting a node keeps the sites' historical analytics and logs; deleting a site deletes its analytics and its logs in PostgreSQL |

### Statistics dimensions

| Location | Card | Content |
| --- | --- | --- |
| A site's **Analytics** tab | **Countries** | Requests and data transferred per client country; addresses GeoIP does not know count as **Unknown** |
| | **Networks (approximate)** | Requests per client network (AS number and name), approximate, at most 50 |
| | **Referrers (approximate)** | Requests per host of the `Referer` (without port; not counted when it is the request's own Host), approximate, at most 50 |
| | **Clients** | Browsers, operating systems and device classes (the node's User-Agent classification) |
| | **Protocols** | HTTP versions (1.0, 1.1, 2, 3) and TLS versions (1.2, 1.3, plain) |
| A site's **Security** tab | **Block reasons** | Requests per [block reason](#block-reasons) |
| | **Challenge pass rate** | Challenges sent (challenge pages and cookie302 redirects), passes issued after a verified answer, and their ratio |
| **Overview** | **Top countries by traffic** | Countries of all sites by data transferred |

| Item | Behavior |
| --- | --- |
| Classification | Browsers: Chrome, Edge, Firefox, Safari, Opera, Samsung Internet, UC, QQ Browser, WeChat, Yandex, IE, crawlers, command-line tools, other; operating systems: Windows, macOS, iOS, Android, Linux, ChromeOS, HarmonyOS, other; devices: desktop, phone, tablet, crawler, other. The node uses no large UA parser: classes come from keywords and can differ from a browser's actual brand |
| Bounds | Per site and minute: at most 250 countries; networks and referring hosts keep the top 50 each (each worker tracks 64 candidates, approximate counts); the other dimensions have fixed keys |
| Rollups and retention | As for the other analytics: minute detail 7 days, hourly rollups 90 days, daily rollups 365 days |
| Requests counted | Requests refused once the site is known are counted (client certificate, ban and maintenance refusals included); an SNI that does not match the Host, the PURGE method and unknown hosts are not |
| Nodes | Needs node capability `stats-dims-v1` (statistics only; it never holds a publish); while an active node of the cluster lacks it, the cards note "Some nodes of the cluster do not report these statistics" |
| Approximation | Nodes sum per worker and write once a minute; each worker tracks at most 128 sites per minute, and a worker that exits abnormally loses its current minute's dimensions |

### Reporting and deduplication

| Item | Behavior |
| --- | --- |
| Batches | Nodes write analytics batches with a monotonic sequence number to `traffic-spool.json` (0600) in the state directory, then report over the node channel (mTLS) |
| Deduplication | A lost receipt, a node restart, or a failed local receipt write resends the same sequence; the console updates the counts and the node's cursor in one transaction, so a repeated sequence is not counted twice; a node that loses its local sequence file resynchronizes from the console cursor |
| Offline queue | Up to 10,000 buckets and 32 MiB; overflow is dropped and logged |
| In-memory counts | Counts not yet moved to disk expire after 2 hours; a crash before the first persist loses in-memory counts |
| Semantics | Deduplication of retried batches, not billing-grade per-request exactly-once |
| Old nodes | Reports without a sequence number are refused; such nodes show **Upgrade required** in **Clusters & nodes** |

## Enable access logs

1. Open **Sites**, select the site, and open the **Logs** tab.
2. Select **1%**, **10%**, or **100%** in **Access log sample rate**. The choice is saved at once and publishes a new configuration revision; the console shows **Saved**.
3. Turn on the switches below as needed, enter header names in **Log request headers** (comma separated), and click **Save**.
4. Verify: after some requests, click **Search** in the query form; records appear.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Access log sample rate | Off / 1% / 10% / 100% | Off | Share of requests recorded; the API takes an integer of 0–10000 in 1/10,000 units |
| Always log blocked, challenged and refused requests | On / off | Off | Requests with a [block reason](#block-reasons) get a line whatever the sample rate, recorded at 100% |
| Log query strings | On / off | Off | Lines carry the request's query string (without `?`, at most 2,048 bytes) |
| Log request headers | Up to 8 header names | None | Lines carry these headers' values (each at most 512 bytes, several values joined with `, `); `Authorization`, `Cookie` and `Proxy-Authorization` cannot be chosen |
| Log the peer address | On / off | Off | When client addresses come from the PROXY protocol or a trusted header (the non-direct modes of [Client IP](../deploy/nodes.en.md#client-ip)), lines also carry the connection's peer address; not recorded when it equals the client IP |

The last four publish a new configuration revision when saved; nodes update their site table in place, without reloading nginx. They need node capability `access-logs-v2`: while an active node of the cluster lacks it, these options can only be turned off, with "Some nodes of the site's cluster do not support it yet".

| Recorded fields | Not recorded |
| --- | --- |
| Time, client IP, method, Host, path, status, bytes sent, duration (ms), cache status, sample rate, node ID, request ID; User-Agent (at most 512 bytes), Referer (without query string and fragment, at most 1,024 bytes), HTTP version, scheme (http / https), TLS version, country, network (AS number and name), request bytes, the response's `Content-Type` (media type), origin address, origin status and origin time (empty for cache hits and the node's own answers), the block reason and the rule behind it | Cookies, `Authorization`, request and response bodies; query strings, other request headers and the peer address only while the site turns the option on |

Client IPs, User-Agents, Referers, query strings and request headers can be personal data: turn options on only as needed and shorten the retention as needed (see [Retention](#retention)).

The origin fields come from the node's origin layer: the origin address is the origin that answered (the last one after retries); the origin status and time cover the node's whole exchange with its origin layer, retries included.

Forced lines share the budget of 100 lines per site and second on each node with **Write access log** rules; beyond it, the sample rate applies as usual. While the site's sample rate is **Off**, the console keeps these lines as long as forced logging is on.

With **Record JA4 in access logs** on (**Security → Challenges** of the site), logs also record the JA4 TLS client fingerprint (empty over plain HTTP): the table shows **JA4** and the fingerprint under the request, and the CSV gets a `ja4` column. Once it is off, the console stops keeping the field. JA4 format: [JA4](challenges.en.md#ja4).

With [OWASP CRS](waf.en.md) on, requests that matched rules also record the rule IDs (at most 16 per request, ascending) and whether CRS blocked them: the table shows **CRS** under the request (rule IDs and a **Blocked** badge) and the CSV gets `wafRuleIds` (space-separated) and `wafBlocked` columns.

Rules of the configuration phase can set a sample rate for the requests they match with **Log sample rate (%)**; those logs are kept even while the site's sample rate is **Off**, see [Override settings](rules.en.md#override-settings).

With **Write access log** on, a **Log** rule of the custom WAF phase writes a line for every request it matches whatever the sample rate (at most 100 per site and second on each node), carrying the ids of these rules (at most 8): the list shows **Rules** and the rule names under the request (global rules marked **Global**, deleted rules by id), and the CSV adds a `ruleIds` column (space separated). These lines are kept while the site's sample rate is **Off** as well; a line written only because of a rule has a sample rate of 100%. See [WAF actions](rules.en.md#waf-actions).

Access logs need the node capability `access-logs-v1`, JA4 also `ja4-v1`, forced logging and the optional fields also `access-logs-v2`. A configuration rollback keeps the current sample rate, JA4 and log options and never re-enables logging that was turned off.

### Block reasons

| Reason | Name in the list | When |
| --- | --- | --- |
| `ip_banned` | IP banned | The ban list (console, automatic and rule bans) matched |
| `ip_blocked` | Block list | A platform or site block list |
| `rule` | Custom rule | A custom WAF rule's block, ban, close or 4xx / 5xx custom response (with the rule) |
| `rate_limit` | Rate limit | A rate limit was exceeded (with the rule) |
| `crs` | OWASP CRS | CRS blocked it |
| `cc` | CC protection | CC protection's per-address ban |
| `challenge` | Challenge | A challenge was sent (Under Attack, CC or a rule; a rule's challenge with the rule) |
| `auth` | Access authentication | Access authentication refused it (with the authentication rule) |
| `referer` | Hotlink protection | Hotlink protection refused or redirected it |
| `user_agent` | User-Agent list | The UA list refused it |
| `region` | Region restriction | Region restrictions |
| `cors` | CORS origin | The cross-origin Origin is not allowed |
| `websocket_origin` | WebSocket origin | The WebSocket Origin is not allowed |
| `client_cert` | Client certificate | The site requires a client certificate |
| `maintenance` | Maintenance mode | Maintenance mode |

Nodes record the reason where they refuse; reasons match the error codes of error pages (`ip-banned`, `ip-blocked`, `policy-denied`, `waf-blocked`, `geo-denied`, `hotlink-denied`, `ua-denied`, `cors-origin-denied`, `websocket-origin-denied`, `client-cert-required`, `maintenance`, `auth-*`). A forced HTTPS answer without a certificate (503), WebSocket turned off, an oversized body and unknown hosts are not blocks.

## Search and export logs

1. On the **Logs** tab, enter **From** and **To**, and optionally **Status**, **Client IP**, **Path prefix**, and **Request ID**; the other conditions are under **More filters**.
2. Click **Search**.
3. For a file, click **Export CSV**.
4. To act on a request, click **⋯** at the end of its row; the action runs on the same page:

   | Action | Behavior |
   | --- | --- |
   | Ban IP | Opens the ban dialog with the site and the client IP filled in; the **Scope** can change to **Global**, see [Bans](bans.en.md) |
   | Purge URL | After a confirmation, creates a URL purge of the request's host and path, see [Purge and prefetch](origins-and-cache.en.md#purge-and-prefetch) |
   | Exclude CRS rule N | Only on rows that matched CRS rules, one item per matched rule; after a confirmation, the rule ID is added to the site's whole-site exclusion, see [OWASP CRS](waf.en.md#exclusions). Initialization, blocking evaluation and correlation rules (901xxx, 949xxx, 959xxx, 980xxx) are not offered: excluding them turns blocking off |
   | Exclude by path | As above, with a dialog holding the rule ID and the request's path, which can be a prefix or an exact path; after a confirmation an exclusion is added, see [overrides and exclusions by path](waf.en.md#overrides-and-exclusions-by-path) |

   The toast that follows links to the bans, the purge tasks or the CRS settings.

Rows with a block reason show its badge under the request (grey for challenges, red otherwise) with the rule name (deleted rules by id). The arrow before the request opens the details: User-Agent, Referer, protocol, country, network, origin, request bytes, content type, query string, request headers and peer address; empty fields are left out.

| Item | Behavior |
| --- | --- |
| Time range | Defaults to the last hour; the earliest is UTC midnight of the retention's first day (6 days ago by default) and the latest 5 minutes from now; the end must be after the start |
| Filters | Status: exact; client IP: exact; path: prefix; request ID: exact. **More filters**: **Host** (exact, any case), **Method**, **Status class** (1xx–5xx), **Cache status**, **Block reason** (or **Any reason**), **Country code**, **ASN**, **User-Agent contains**, **Referer contains** (any case), **Min duration (ms)**, **Client network (CIDR)** (such as `203.0.113.0/24`). All conditions must hold |
| Request ID | Each entry shows the request ID the node settled (the same as the `X-Request-Id` response header and the one on [error pages](error-pages.en.md#request-ids)), in the CSV as the `requestId` column; empty for logs of older nodes |
| Rows | The UI shows at most 100 rows ("Showing the first 100 rows. Narrow your search."); CSV holds at most 1,000 rows ("Exported the first 1,000 rows. Narrow the time range for other records.") |
| CSV | Every cell is quoted with quotes escaped; values starting with `=`, `+`, `-`, or `@` get a leading `'` so spreadsheets do not treat them as formulas. Columns: `time`, `clientIp`, `method`, `host`, `path`, `status`, `bytesSent`, `durationMs`, `cacheStatus`, `sampleRate`, `nodeId`, `requestId`, `ja4`, `wafRuleIds`, `wafBlocked`, `ruleIds`, `userAgent`, `referer`, `httpVersion`, `scheme`, `country`, `asn`, `asName`, `upstreamAddr`, `upstreamStatus`, `upstreamMs`, `requestBytes`, `contentType`, `tlsVersion`, `blockReason`, `blockRuleId`, `query`, `headers` (`name: value` joined with `; `), `peerIp` |
| Callers | A console session or an access key, read-only keys included; service accounts cannot call it |

## Log collection and storage

| Item | Behavior |
| --- | --- |
| Collection | Nodes report in batches of up to 1,000 over mTLS; a durable per-node cursor stops retries from writing twice |
| Node memory queue | About 2,000 entries (8 MiB); when full, new entries are dropped |
| Node disk queue | `logs-spool.json` (0600) in the state directory, up to 10,000 entries and 32 MiB; when full, the oldest unsent batches are dropped with a warning |
| Loss | A process or host crash between the end of a request and the batch reaching disk loses those entries |
| `lite` storage | PostgreSQL partitions by UTC day, keeping today and the previous "retention − 1" days; a background job creates and drops partitions by the setting every minute |
| `clickhouse` storage | ReplacingMergeTree with daily partitions and a TTL of the retention, deduplicated with `FINAL` at query time; when a ClickHouse write fails the batch is not acknowledged and the node retries, with no fallback to PostgreSQL |

### Retention

Page: the **Access logs** card on the **General** tab of **System settings**; it shows the days of the current analytics mode only.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Retention days (PostgreSQL) | 1–30 | 7 | `lite` storage keeps today and the days before it |
| Retention days (ClickHouse) | 1–90 | 7 | The TTL of `access_log` in `clickhouse` storage |

| Item | Behavior |
| --- | --- |
| Takes effect | PostgreSQL: the next minute's maintenance drops older partitions, and writes and searches use the new days at once; ClickHouse: `ALTER TABLE access_log MODIFY TTL` runs on save and at the first maintenance after the console starts, and existing data is cleaned by the new TTL |
| Audit | `system.log_retention_update` |
| Analytics | Unaffected (minutes 7 days, hours 90 days, days 365 days) |

## View requests live on a node

On the node host (or in its container), run:

```bash
edgeweir-node accesslog --site <site id> --json
```

| Option | Effect |
| --- | --- |
| `--site <id>` | Only this site; without it, every request (unknown hosts included, with an empty site id) |
| `--json` | One JSON object per line (JSON Lines); without it, text: time (UTC), client IP, method, Host, path, status, bytes sent, duration, cache status, and `blocked=<reason>` when there is a block reason |
| `--socket <path>` | The control socket, `/run/edgeweir-node/control.sock` by default |

| Item | Behavior |
| --- | --- |
| Collection | Only while someone views (the command renews every 250 ms; collection stops 5 seconds after it exits); independent of the sample rate; never enters the console's access logs |
| Bounds | At most 2,000 requests per node and second, kept for 10 seconds; when reading falls behind or the bound is hit, the number missed is printed to standard error |
| Content | The [recorded fields](#enable-access-logs) except query strings, request headers and the peer address |
| Permissions | Access to the control socket (as for `edgeweir-node bans` and `security`) |

Press Ctrl-C to exit.

## Use ClickHouse storage

1. In the console's `.env`, enable the `analytics` profile and set the analytics mode and the ClickHouse password:

   ```bash title=".env"
   COMPOSE_PROFILES=analytics
   EDGEWEIR_ANALYTICS=clickhouse
   EDGEWEIR_CLICKHOUSE_PASSWORD=<password>
   ```

2. Start the Compose deployment; with `COMPOSE_PROFILES`, every later `docker compose` command includes ClickHouse:

   ```bash
   docker compose up -d
   ```

3. Verify: on the **System settings** page, **Analytics** shows `clickhouse`.

Defaults of `EDGEWEIR_CLICKHOUSE_URL`, `EDGEWEIR_CLICKHOUSE_DATABASE`, and `EDGEWEIR_CLICKHOUSE_USER` and settings for an external ClickHouse are in [Environment variables](../reference/environment.en.md).

| Item | Behavior |
| --- | --- |
| Switching | Affects new writes only; historical logs and analytics are not migrated |
| Minute analytics | Also written to the ClickHouse `minute_stats` table (ReplacingMergeTree versioned by the node batch sequence); use `FINAL` for direct analysis |
| Charts and alerts | Still use the exact PostgreSQL minute, hour, and day rollups, so both modes count the same way; sampled logs are never used as full traffic counts |
| Site deletion | The console stops authorizing queries for the site's logs at once; raw ClickHouse data expires by the 7-day TTL |

## Create an access key

1. Open **Personal settings** from the user menu (bottom of the sidebar) and find the **Access keys** card.
2. Enter **Name** (1–64 characters; `default` when empty) and select **Scope**.
3. Click **Create**.
4. Copy the key shown. It is shown once (**Shown once**).
5. Verify:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' -H 'x-api-key: <key>' https://console.example.com/api/v1/sites
   ```

   The output is `200`.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Name | 1–64 characters | `default` | Display name in the list |
| Scope | Read only / Read and write | Read and write | Read-only keys call only GET endpoints and `rules.validate`; other endpoints return 403 (`ACCESS_KEY_READ_ONLY`) |

Request format and endpoints are in [API and endpoints](../reference/api.en.md).

## Revoke an access key

1. In the **Access keys** card of **Personal settings**, click **Revoke key** for the key and confirm.
2. Verify: the key shows **Revoked**; requests with it return 401.

| Item | Behavior |
| --- | --- |
| List | The **Access keys** card lists every key, with scope and "Last used: …" |
| Identity | A key calls the API as the console account; the audit log shows the actor type AccessKey |
| Issuing | Keys can be created only in a signed-in console session (the **Personal settings** page, or `accessKeys.create` over `/rpc`); no access key, including read-write and legacy keys, can create new keys: `POST /api/v1/access-keys` returns 403 (`ACCESS_KEY_SESSION_REQUIRED`) |
| Legacy keys | Legacy keys without a scope keep read-write access; revoke and recreate them by purpose |

## Limits

| Item | Description |
| --- | --- |
| Sample rate | The UI offers Off, 1%, 10%, and 100%; other rates through the API |
| Log retention | At most 30 days in PostgreSQL and 90 days in ClickHouse; with 30 days and a high sample rate PostgreSQL grows large, ClickHouse fits better |
| Completeness | Access logs have bounded queues and can lose entries; they are not an audit ledger; analytics are not billing-grade counts |
| Top URLs / IPs | Estimates that can miss infrequent items |
| History migration | Switching the analytics mode migrates no history |
| Statistics dimensions | Networks and referrers are estimates; client classes come from keywords |
| Local files on nodes | Nodes do not write access logs to local files; use `edgeweir-node accesslog` to watch live |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "No matching logs" | Sample rate off or too low; time range before retention; the node has not applied the revision that enables logs or lacks `access-logs-v1`; **More filters** too narrow | Check the sample rate, time range, filters, and the node's **Applied** revision |
| Blocked requests have no lines | **Always log blocked, challenged and refused requests** is off, or more than 100 per second | Turn the option on; beyond the bound the sample rate applies |
| Log options are disabled | An active node of the cluster lacks `access-logs-v2` | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| Statistics cards note "Some nodes of the cluster do not report these statistics" | An active node of the cluster lacks `stats-dims-v1` | Upgrade the node |
| Country or network empty or **Unknown** | The node has no GeoIP database, or the client address is private | See [System settings](system.en.md#geoip-databases) |
| "End time must be after start time" | Invalid time range | Adjust the times |
| "Showing the first 100 rows. Narrow your search." | More than 100 matches | Narrow the range, add filters, or export CSV |
| "Exported the first 1,000 rows. …" | More than 1,000 matches | Export in several ranges |
| Analytics charts are empty | The site has no traffic, or nodes are not reporting | Check node heartbeats and whether the site's domains are published |
| A node shows **Upgrade required** | The node does not support sequenced analytics reports or a capability the current configuration needs | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| "Sign in to create an access key" | The create endpoint was called with an access key | Create keys in a signed-in console session |
| "This access key is read only" | A read-only key called a write endpoint | Create a read-write key |
