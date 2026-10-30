# Analytics and access logs

Traffic analytics and dimensions; access log sampling, search, export, retention and storage; the live view on a node; access keys for the API.

## Concepts

| Term | Definition |
| --- | --- |
| Analytics | Complete per-minute counts from nodes: requests, traffic, cache hits, status codes, and approximate top URLs and IPs. |
| Access logs | Individual requests recorded at a sample rate. Bounded diagnostic data, not a lossless audit record. |
| Sample rate | The share of requests recorded; a percentage in the UI, an integer in 1/10,000 units (0–10000) in the API. |
| Block reason | Why a node refused or challenged a request, such as `rule`, `ip_banned` or `region`, see [Block reasons](#block-reasons). |
| Statistics dimensions | Bounded classes nodes count per minute: country, network (ASN), referring host, browser / operating system / device, HTTP and TLS version, block reason, challenges. |
| Analytics mode | The value of the environment variable `EDGEWEIR_ANALYTICS`: `lite` (PostgreSQL, default) or `clickhouse`; it decides where access logs are stored. |
| Access key | A key (prefix `ewk_`) that calls `/api/v1` as the console account, see [Access keys](#access-keys). |

## View analytics

| Location | Scope |
| --- | --- |
| **Overview** (`/overview`) | All sites and nodes, including **Top sites by requests** and **Top nodes by requests**, see [Overview](overview.en.md) |
| **Sites** → the site → the **Analytics** tab (`/sites/<site ID>?tab=analytics`) | One site |

1. Open a page from the table and select a range: **Last hour**, **Last 6 hours**, **Last 24 hours**, **Last 7 days**, or **Last 30 days**. On a site's **Analytics** tab the range goes into the address parameter `range` (`1h`, `6h`, `24h`, `7d`, `30d`).
2. Read **Total requests**, **Data transferred**, **Cache hit ratio**, **Peak bandwidth**, **4xx rate**, **5xx rate**, **Status codes**, **Top URLs (approximate)**, and **Top IPs (approximate)**; click a metric for details. A site's **Analytics** tab also has **Countries**, **Networks (approximate)**, **Referrers (approximate)**, **Clients** and **Protocols** cards, and the overview **Top countries by traffic** (by data transferred), see [Statistics dimensions](#statistics-dimensions).
3. Click **Refresh** to reload.
4. Click **Customize cards** to choose which cards show; the choice on a site's **Analytics** tab applies to every site and is kept apart from the overview's, see [Customize cards](overview.en.md#customize-cards).
5. To act on an entry, click **⋯** at the end of its row: a top IP offers **Ban IP** (with the site filled in on a site's **Analytics** tab, with the **Global** scope on the overview); a top URL on a site's **Analytics** tab offers **Purge URL**, which expands the path to each of the site's domains that is not a wildcard and lists the URLs before it submits the purge.

Readouts with a fixed window and no range to pick:

| Location | Content |
| --- | --- |
| **Right now** on the **Overview** | Request rate and egress of all sites in the last full minute, cache hit ratio over the last hour, see [Right now](overview.en.md#right-now) |
| **Requests (24h)** in the **Sites** list | Each site's requests over the last 24 hours, with a trend line; shown only with at most 20 sites and no search or filter on the list |
| **Sites** → **Overview** tab → **Live requests** | An enabled site's requests per second over the last hour, minute by minute (the minute still being counted is left out), refreshed every minute; hover to read a minute |

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
| | **Clients** | **Browsers**, **Operating systems** and **Devices** (the node's User-Agent classification) |
| | **Protocols** | **HTTP versions** (1.0, 1.1, 2, 3) and **TLS versions** (1.2, 1.3, plain) |
| A site's **Security** tab | **Block reasons** | Requests per [block reason](#block-reasons) |
| | **Challenge pass rate** | Challenges sent (challenge pages and cookie302 redirects), passes issued after a verified answer, and their ratio |
| **Overview** | **Top countries by traffic** | Countries of all sites by data transferred |

| Item | Behavior |
| --- | --- |
| Classification | Browsers: Chrome, Edge, Firefox, Safari, Opera, Samsung Internet, UC, QQ Browser, WeChat, Yandex, IE, crawlers, command-line tools, other; operating systems: Windows, macOS, iOS, Android, Linux, ChromeOS, HarmonyOS, other; devices: desktop, phone, tablet, crawler, other. The node uses no large UA parser: classes come from keywords and can differ from a browser's actual brand |
| Bounds | Per site and minute: at most 250 countries; networks and referring hosts keep the top 50 each (each worker tracks 64 candidates, approximate counts); the other dimensions have fixed keys |
| Rollups and retention | As for the other analytics: minute detail 7 days, hourly rollups 90 days, daily rollups 365 days |
| Requests counted | Requests refused once the site is known are counted (client certificate, ban and maintenance refusals included); an SNI that does not match the Host, the PURGE method and unknown hosts are not |
| Nodes | Needs node capability `stats-dims-v1` (statistics only; it never holds a publish); while an active node of the cluster lacks it, the cards note "Some nodes in the cluster do not report these statistics" |
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

Page: **Sites** → the site → the **Logs** tab (`/sites/<site ID>?tab=logs`). The card on top holds the log settings, the one below the search.

1. Select **Off**, **1%**, **10%** or **100%** in **Access log sample rate**. The choice is saved at once and publishes a new configuration revision of the site's cluster ("Site {site} updated"); the console shows **Saved**.
2. Turn on **Always log blocked, challenged and refused requests**, **Log query strings** or **Log the peer address** as needed, enter header names in **Log request headers**, and click **Save**. Only what changed is sent, and it publishes a new configuration revision too.
3. Verify: after some requests, click **Search** in the query form; records appear.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Access log sample rate | **Off** / **1%** / **10%** / **100%** | **Off** | Share of requests recorded; `sampleRate` in the API takes an integer of 0–10000 in 1/10,000 units |
| Always log blocked, challenged and refused requests | On / off | Off | Requests with a [block reason](#block-reasons) get a line whatever the sample rate, recorded at 100% |
| Log query strings | On / off | Off | Lines carry the request's query string (without `?`, at most 2,048 bytes) |
| Log request headers | Up to 8 header names separated by commas or spaces; each 1–64 letters, digits and `-`, lowercased and deduplicated on save | Empty | Lines carry these headers' values (each at most 512 bytes, several values joined with `, `); `Authorization`, `Cookie` and `Proxy-Authorization` cannot be chosen |
| Log the peer address | On / off | Off | When client addresses come from the PROXY protocol or a trusted header (the non-direct modes of [Client IP](../deploy/nodes.en.md#client-ip)), lines also carry the connection's peer address; not recorded when it equals the client IP |

| Item | Behavior |
| --- | --- |
| Applying | Nodes update their site table in place, without reloading nginx |
| Audit | `site.logs_configure` ("Access log sample rate updated"), with only what changed |
| Header errors | "{name} cannot be logged" (a forbidden header), "Invalid header name: {name}", "At most 8 headers"; **Save** sends nothing |
| Node capability | The last four need `access-logs-v2`: while an active node of the cluster lacks it, these options can only be turned off, and the card notes "Some nodes in the cluster do not support it" |
| Privacy note | The bottom of the card shows "Logs kept {days} days; may contain personal data", the [retention](#retention) of the current analytics mode |

| Recorded fields | Not recorded |
| --- | --- |
| Time, client IP, method, Host, path, status, bytes sent, duration (ms), cache status, sample rate, node ID, request ID; User-Agent (at most 512 bytes), Referer (without query string and fragment, at most 1,024 bytes), HTTP version, scheme (http / https), TLS version, country, network (AS number and name), request bytes, the response's `Content-Type` (media type), origin address, origin status and origin time (empty for cache hits and the node's own answers), the block reason and the rule behind it | Cookies, `Authorization`, request and response bodies; query strings, other request headers and the peer address only while the site turns the option on |

Client IPs, User-Agents, Referers, query strings and request headers can be personal data: turn options on only as needed and shorten the retention as needed (see [Retention](#retention)).

The origin fields come from the node's origin layer: the origin address is the origin that answered (the last one after retries; not recorded for cache revalidations, `REVALIDATED`); the origin status and time cover the node's whole exchange with its origin layer, retries included. Query strings and request headers are the client's (after a signed URL's signature is removed, before rules change them); requests refused before that (bans, client certificates) record no query string, and on a site whose signed URLs carry the signature in the path (kinds B and C) no path either (empty in the log, not in the top URLs).

Country and network come from the node's GeoIP lookups: each worker caches recent addresses and makes at most 200 lookups per second that miss the cache; beyond that, or when the agent does not answer, they are unknown.

Forced lines share the budget of 100 lines per site and second on each node with **Write access log** rules; beyond it, the sample rate applies as usual. While the site's sample rate is **Off**, the console keeps these lines as long as forced logging is on (only lines with a block reason).

With **Record JA4 in access logs** on (the **Challenges** card on the site's **Security** tab), logs also record the JA4 TLS client fingerprint (empty over plain HTTP): the table shows **JA4** and the fingerprint under the request, and the CSV has a `ja4` column. Once it is off, the console stops keeping the field. JA4 format: [JA4](challenges.en.md#ja4).

With [OWASP CRS](waf.en.md) on, requests that matched rules also record the rule IDs (at most 16 per request, ascending) and whether CRS blocked them: the table shows **CRS** under the request (rule IDs and a **Blocked** badge) and the CSV has `wafRuleIds` (space-separated) and `wafBlocked` columns.

Rules of the configuration phase can set a sample rate for the requests they match with **Log sample rate (%)**; those logs are kept even while the site's sample rate is **Off**, see [Override settings](rules.en.md#override-settings).

With **Write access log** on, a **Log** rule of the custom WAF phase writes a line for every request it matches whatever the sample rate (at most 100 per site and second on each node), carrying the ids of these rules (at most 8): the list shows **Rules** and the rule names under the request (global rules as "{name} (global)", deleted rules by id), and the CSV has a `ruleIds` column (space separated). These lines are kept while the site's sample rate is **Off** as well; a line written only because of a rule has a sample rate of 100%. See [WAF actions](rules.en.md#waf-actions).

Access logs need the node capability `access-logs-v1`, JA4 also `ja4-v1`, forced logging and the optional fields also `access-logs-v2`. A configuration rollback keeps the current sample rate and JA4, keeps only the log options both the target and the current configuration have, and never re-enables logging or fields that were turned off.

### Block reasons

| Reason | Name in the list | When |
| --- | --- | --- |
| `ip_banned` | IP banned | The ban list (console, automatic and rule bans) matched |
| `ip_blocked` | Block list | A platform or site block list |
| `rule` | Custom rule | A custom WAF rule's block, ban, close or 4xx / 5xx custom response (with the rule) |
| `rate_limit` | Rate limit | A rate limit was exceeded (with the rule), the greylist rate limit |
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

Nodes record the reason where they refuse; reasons match the `X-Edgeweir-Error` codes of error pages (`ip-banned`, `ip-blocked`, `policy-denied`, `ip-greylisted`, `waf-blocked`, `geo-denied`, `hotlink-denied`, `ua-denied`, `cors-origin-denied`, `websocket-origin-denied`, `client-cert-required`, `maintenance`, `auth-*`, see [Error pages](error-pages.en.md#set-a-sites-error-pages)). A forced HTTPS answer without a certificate (503), WebSocket turned off, an oversized body and unknown hosts are not blocks.

## Search and export logs

1. On the **Logs** tab, enter **From** and **To**, and optionally **Status**, **Client IP**, **Path prefix**, and **Request ID**; the other conditions are under **More filters** (shown as "More filters ({count})" while some are set).
2. Click **Search**.
3. For a file, click **Export CSV**.
4. To act on a request, click **⋯** at the end of its row; the action runs on the same page:

   | Action | Behavior |
   | --- | --- |
   | Ban IP | Opens the ban dialog with the site and the client IP filled in; the **Scope** can change to **Global**, see [Bans](bans.en.md) |
   | Purge URL | Only for lines with a Host; after a confirmation, creates a URL purge of the request's host and path, see [Purge and prefetch](origins-and-cache.en.md#purge-and-prefetch) |
   | Exclude CRS rule N | Only on rows that matched CRS rules, one item per matched rule; after a confirmation, the rule ID is added to the site's whole-site exclusion, see [OWASP CRS](waf.en.md#exclusions). Initialization, blocking evaluation and correlation rules (901xxx, 949xxx, 959xxx, 980xxx) are not offered: excluding them turns blocking off |
   | Exclude by path | As above, with a dialog holding the matched rule IDs and the request's path, which can be a prefix or an exact path; after a confirmation an exclusion is added, see [overrides and exclusions by path](waf.en.md#overrides-and-exclusions-by-path) |

   The toast that follows links to the bans, the purge tasks or the CRS settings.

The columns are **Time**, **Client IP**, **Request**, **Status**, **Bytes**, **Duration (ms)** and **Cache**. Rows with a block reason show its badge under the request (grey for challenges, red otherwise) with the rule name (deleted rules by id); **Request ID**, **JA4**, **CRS** and **Rules** also show under the request when set. A click anywhere in the row (or on the arrow before the request) opens the **Details**: User-Agent, Referer, protocol, country, network, origin ("address · status · ms"), request bytes, content type, query string, request headers and peer address; empty fields are left out.

| Filter | Values | Match |
| --- | --- | --- |
| From, To | Local time; From defaults to an hour ago, To to a minute from now; while **To** is untouched, every search takes a minute from now again | From ≤ time < To; To must be after From, else "End time must be after start time" |
| Status | 100–599 | Exact |
| Client IP | At most 64 characters | Exact |
| Path prefix | At most 2048 characters | Prefix |
| Request ID | At most 128 characters | Exact |
| **More filters** → **Host** | At most 253 characters | Host, exact, any case |
| **Method** | **All**, GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS | Exact |
| **Status class** | **All**, 1xx–5xx | With **Status** set too, both must hold |
| **Cache status** | **All**, HIT, MISS, BYPASS, EXPIRED, STALE, UPDATING, REVALIDATED | Exact |
| **Block reason** | **All**, **Any reason** or one of the [block reasons](#block-reasons) | **Any reason** matches every line with a block reason |
| **Country code** | Two letters (ISO 3166-1) | Exact; invalid: "Enter a two-letter country code" |
| **ASN** | 1–4294967295 | Exact; invalid: "Must be a whole number from 1 to 4294967295" |
| **User-Agent contains**, **Referer contains** | At most 256 characters each | Contains, any case |
| **Min duration (ms)** | 0–86400000 | Duration at least this; invalid: "Must be a whole number from 0 to 86400000" |
| **Client network (CIDR)** | A CIDR or single address, such as `203.0.113.0/24`, host bits cleared | Client IP inside it; invalid: "Invalid network" |

| Item | Behavior |
| --- | --- |
| Conditions | All must hold |
| Time range | The part before UTC midnight of the retention's first day (6 days ago by default) and after 5 minutes from now is not searched |
| Request ID | Each entry shows the request ID the node settled (the same as the `X-Request-Id` response header and the one on [error pages](error-pages.en.md#request-ids)), in the CSV as the `requestId` column; empty for logs of older nodes |
| Rows | The UI shows at most 100 rows ("First 100 rows only; narrow the search"); CSV holds at most 1,000 rows ("First 1,000 rows only; narrow the time range"); newest first |
| CSV file | `edgeweir-logs-<site ID>.csv`, UTF-8 with a BOM, CRLF line ends; uses the conditions of the last **Search** |
| CSV content | Every cell is quoted with quotes escaped; values starting with `=`, `+`, `-`, or `@` after leading white space get a leading `'` so spreadsheets do not treat them as formulas; arrays are joined with spaces. Columns: `time`, `clientIp`, `method`, `host`, `path`, `status`, `bytesSent`, `durationMs`, `cacheStatus`, `sampleRate`, `nodeId`, `requestId`, `ja4`, `wafRuleIds`, `wafBlocked`, `ruleIds`, `userAgent`, `referer`, `httpVersion`, `scheme`, `country`, `asn`, `asName`, `upstreamAddr`, `upstreamStatus`, `upstreamMs`, `requestBytes`, `contentType`, `tlsVersion`, `blockReason`, `blockRuleId`, `query`, `headers` (`name: value` joined with `; `), `peerIp` |
| Demo account | Client and peer addresses are reduced, and request headers are left out |

### Jump parameters

Other pages open the **Logs** tab with the conditions in the address, such as **View logs** on the **Attacks** tab:

```text
/sites/<site ID>?tab=logs&blockReason=any&ip=203.0.113.7&from=2026-10-30T08:00:00.000Z&to=2026-10-30T09:01:00.000Z
```

| Parameter | Values | Fills in |
| --- | --- | --- |
| `blockReason` | One of the [block reasons](#block-reasons) or `any` | **Block reason** |
| `ip` | At most 64 characters | **Client IP** |
| `cidr` | At most 64 characters | **Client network (CIDR)** |
| `path` | At most 2048 characters | **Path prefix** |
| `from`, `to` | ISO 8601 times | **From**, **To**; without `to`, To is a minute from now and moves with each search |

With conditions under **More filters**, that area opens. The page searches with these conditions at once.

## Log collection and storage

| Item | Behavior |
| --- | --- |
| Collection | Nodes report in batches of up to 1,000 over mTLS; a durable per-node cursor stops retries from writing twice |
| Ingest filter | While the site's sample rate is **Off** and no rule samples or has **Write access log**, only lines with a block reason are kept (with forced logging on), or none; JA4, query strings, request headers and the peer address are kept only while the site currently turns them on; lines before the retention or more than 5 minutes ahead are dropped |
| Node memory queue | About 2,000 entries (8 MiB); when full, new entries are dropped |
| Node disk queue | `logs-spool.json` (0600) in the state directory, up to 10,000 entries and 32 MiB; when full, the oldest unsent batches are dropped with a warning |
| Loss | A process or host crash between the end of a request and the batch reaching disk loses those entries |
| `lite` storage | The PostgreSQL table `access_log`, partitioned by UTC day, keeping today and the previous "retention − 1" days; a background job creates and drops partitions by the setting every minute |
| `clickhouse` storage | The table `access_log`, a ReplacingMergeTree with daily partitions and a TTL of the retention, deduplicated with `FINAL` at query time; when a ClickHouse write fails the batch is not acknowledged and the node retries, with no fallback to PostgreSQL |

### Retention

Page: **System settings** → the **General** tab → the **Access logs** card. Its **Retention (days)** field shows the days of the current analytics mode only; the other mode's days are kept as they are on save.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Retention (days), analytics mode `lite` | 1–30 | 7 | PostgreSQL keeps today and the days before it |
| Retention (days), analytics mode `clickhouse` | 1–90 | 7 | The TTL of the ClickHouse `access_log` |

| Item | Behavior |
| --- | --- |
| Takes effect | PostgreSQL: the next minute's maintenance drops older partitions, and writes and searches use the new days at once; ClickHouse: `ALTER TABLE access_log MODIFY TTL` runs on save and at the first maintenance after the console starts, and existing data is cleaned by the new TTL |
| No revision | Changing the retention publishes no configuration revision |
| Audit | `system.log_retention_update` ("Access log retention updated") |
| Analytics | Unaffected (minutes 7 days, hours 90 days, days 365 days) |

## View requests live on a node

On the node host (or in its container), run:

```bash
edgeweir-node accesslog --site <site id> --json
```

| Option | Effect |
| --- | --- |
| `--site <id>` | Only this site (1–128 letters, digits, `_`, `-`); without it, every request (unknown hosts included, with an empty site id) |
| `--json` | One JSON object per line (JSON Lines); without it, text: time (UTC), client IP, method, Host, path, status, bytes sent, duration, cache status, and `blocked=<reason>` when there is a block reason |
| `--control-socket <path>` (short `--socket`) | The control socket, `/run/edgeweir-node/control.sock` by default |

| Item | Behavior |
| --- | --- |
| Collection | Only while someone views (the command renews every 250 ms; collection stops 5 seconds after it exits); independent of the sample rate; never enters the console's access logs |
| Bounds | At most 2,000 requests per node and second, kept for 10 seconds; when reading falls behind or the bound is hit, the number missed is printed to standard error |
| Content | The [recorded fields](#enable-access-logs) except query strings, request headers and the peer address |
| Permissions | Access to the control socket (as for `edgeweir-node bans` and `security`) |

Press Ctrl-C to exit. Command reference: [CLI reference](../reference/cli.en.md).

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

3. Verify: under **System** on the **System settings** page, **Analytics** shows `clickhouse`.

| Environment variable | Default | Notes |
| --- | --- | --- |
| `EDGEWEIR_ANALYTICS` | `lite` | `lite` or `clickhouse` |
| `EDGEWEIR_CLICKHOUSE_URL` | `http://clickhouse:8123` | `http` / `https`, without user information, query or fragment |
| `EDGEWEIR_CLICKHOUSE_DATABASE` | `edgeweir` | Starts with a letter or `_`, at most 64 letters, digits or `_` |
| `EDGEWEIR_CLICKHOUSE_USER` | `edgeweir` | |
| `EDGEWEIR_CLICKHOUSE_PASSWORD` | Empty (`edgeweir` in `compose.yml`) | Can be read from a file with `EDGEWEIR_CLICKHOUSE_PASSWORD_FILE` |

Settings for an external ClickHouse are in [Environment variables](../reference/environment.en.md).

| Item | Behavior |
| --- | --- |
| Switching | Affects new writes only; historical logs and analytics are not migrated |
| Minute analytics | Also written to the ClickHouse `minute_stats` table (ReplacingMergeTree versioned by the node batch sequence, TTL 7 days); use `FINAL` for direct analysis |
| Charts and alerts | Still use the exact PostgreSQL minute, hour, and day rollups, so both modes count the same way; sampled logs are never used as full traffic counts |
| Site deletion | The console stops authorizing queries for the site's logs at once; raw ClickHouse data expires by the TTL of `access_log` (the retention) |

## Access keys

An access key (prefix `ewk_`) calls `/api/v1` as the console account, in the `x-api-key` request header. Create, edit and revoke keys in the **Access keys** card of **Personal settings** in the user menu, see [Personal settings](account.en.md#personal-settings); scopes, requests per minute and error codes are in the [API reference](../reference/api.en.md#accesskey).

```bash
curl -s -H 'x-api-key: <key>' \
  'https://console.example.com/api/v1/sites/<site ID>/logs?from=2026-10-30T00:00:00Z&to=2026-10-30T01:00:00Z&blockReason=any'
```

A read-only key can read the log settings, search, export and read analytics; changing the sample rate, log options and retention needs a read-write key.

## API

| Operation | Procedure | Method and path (`/api/v1`) |
| --- | --- | --- |
| Read a site's log settings | `logs.settings` | `GET /sites/{siteId}/logs/settings` |
| Change the sample rate and log options | `logs.configure` | `PUT /sites/{siteId}/logs/settings` |
| Search logs | `logs.query` | `GET /sites/{siteId}/logs` |
| Export CSV | `logs.export` | `GET /sites/{siteId}/logs/export` |
| Read the retention | `settings.logRetention` | `GET /settings/log-retention` |
| Change the retention | `settings.setLogRetention` | `PUT /settings/log-retention` |
| Traffic series | `analytics.traffic` | `GET /analytics/traffic` |
| Top URLs / IPs | `analytics.topRequests` | `GET /analytics/top-requests` |
| Top sites / nodes | `analytics.topSites`, `analytics.topNodes` | `GET /analytics/top-sites`, `GET /analytics/top-nodes` |
| Trends by site, node, status or block reason | `analytics.breakdown` | `GET /analytics/breakdown` |
| Statistics dimensions | `analytics.dimensions` | `GET /analytics/dimensions` |

| Request / response | Fields |
| --- | --- |
| `GET /sites/{siteId}/logs/settings` | Response `sampleRate`, `storage` (`lite` / `clickhouse`), `retentionDays` (the current mode's retention), `logBlocked`, `logQuery`, `logHeaders`, `logPeer` |
| `PUT /sites/{siteId}/logs/settings` | Every field optional, omitted ones unchanged: `sampleRate` (0–10000), `logBlocked`, `logQuery`, `logPeer`, `logHeaders`; response `{ ok: true }` |
| `GET /sites/{siteId}/logs`, `/logs/export` | Required `from`, `to` (ISO 8601); optional `status`, `ip`, `path`, `requestId`, `host`, `method`, `statusClass`, `cacheStatus`, `blockReason`, `country`, `asn`, `ua`, `referer`, `minDuration`, `cidr`; `limit` (1–1000, default 100). Search responds `{ entries, truncated }`, export `{ csv, truncated }` |
| `PUT /settings/log-retention` | `postgresDays` (1–30), `clickhouseDays` (1–90), both required; the response adds `storage` |
| `analytics.*` | `range` (`1h`, `6h`, `24h`, `7d`, `30d`, default `24h`); `siteId` for one site (except `analytics.topSites` and `analytics.topNodes`) |

A read-only access key can call `GET` only; service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`). Log fields: [API reference](../reference/api/monitoring.en.md#access-logs).

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
| "No matching logs" | Sample rate off or too low; time range before retention; the node has not applied the revision that enables logs or lacks `access-logs-v1`; **More filters** too narrow | Check the sample rate, time range, filters, and the node's applied revision |
| Blocked requests have no lines | **Always log blocked, challenged and refused requests** is off, or more than 100 per second | Turn the option on; beyond the bound the sample rate applies |
| Log options disabled with "Some nodes in the cluster do not support it" | An active node of the cluster lacks `access-logs-v2` | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| Statistics cards note "Some nodes in the cluster do not report these statistics" | An active node of the cluster lacks `stats-dims-v1` | Upgrade the node |
| Country or network empty or **Unknown** | The node has no GeoIP database, or the client address is private | See [System settings](system.en.md#geoip-databases) |
| "End time must be after start time" | Invalid time range | Adjust the times |
| "Enter a two-letter country code", "Invalid network" and the like, with **More filters** opened | A filter is malformed | Fix the marked filter |
| "{name} cannot be logged", "Invalid header name: {name}", "At most 8 headers" | A logged header is forbidden, malformed, or over 8 | Fix the header list |
| "First 100 rows only; narrow the search" | More than 100 matches | Narrow the range, add filters, or export CSV |
| "First 1,000 rows only; narrow the time range" | More than 1,000 matches | Export in several ranges |
| Analytics charts are empty | The site has no traffic, or nodes are not reporting | Check node heartbeats and whether the site's domains are published |
| A node shows **Upgrade required** | The node does not support sequenced analytics reports or a capability the current configuration needs | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| "Site not found" (`SITE_NOT_FOUND`, 404) | Wrong `siteId`, or the site was deleted | Check the site ID |
| "Invalid input" (`BAD_REQUEST`, 400) | Invalid API parameters: `from` / `to` not ISO 8601, `limit` over 1000, `sampleRate` outside 0–10000, an invalid header name | Fix the request as in [API](#api) |
| "This access key is read only" (`ACCESS_KEY_READ_ONLY`, 403) | A read-only key called a change | Use a read-write key |
| "Service accounts cannot call this" (`SERVICE_ACCOUNT_FORBIDDEN`, 403) | A service account key called a log or analytics endpoint | Use an access key |
