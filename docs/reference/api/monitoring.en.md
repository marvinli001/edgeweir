# API: Overview, analytics and alerts

Procedures, parameters, responses and errors for the overview, traffic analytics, access logs, usage records, the audit log and alerts.

Access levels, authentication, idempotency keys and the error format: [API overview](../api.en.md).

## Overview

Behavior: [Overview](../../guide/overview.en.md).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`overview.get`](#overviewget) | `GET /overview` | read |

### `overview.get`

`GET /overview` · read

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `clusters` | integer | Number of clusters |
| `nodes` | integer | Number of nodes (disabled ones included) |
| `onlineNodes` | integer | Nodes with a heartbeat within the last 3 heartbeat intervals (45 seconds), disabled ones included |
| `sites` | integer | Number of sites (disabled ones included) |
| `revisions` | array<[revision](#revision-object)> | The 10 configuration revisions published last across all clusters, newest first |
| `attention` | array<[attention item](#attention-item-object)> | What needs the operator, in the `kind` order of the [attention item object](#attention-item-object), clusters by name within a `kind`; `[]` when nothing does |

## Analytics

The data comes from the statistics nodes report every minute and covers existing sites only. Behavior: [Overview: Analytics](../../guide/overview.en.md#analytics) and [Statistics dimensions](../../guide/access-logs.en.md#statistics-dimensions).

| `range` | Length | Bucket width (`bucketSeconds`) | Buckets | Source |
| --- | --- | --- | --- | --- |
| `1h` | 1 hour | 60 | 60 | Minute statistics |
| `6h` | 6 hours | 300 | 72 | Minute statistics |
| `24h` | 24 hours | 600 | 144 | Minute statistics |
| `7d` | 7 days | 3600 | 168 | Hourly rollups |
| `30d` | 30 days | 21600 | 120 | Hourly rollups |

- Buckets are aligned to the Unix epoch (UTC); the last bucket of a range contains the current time (still filling up), and the response's `to` is the current time.
- Procedures with `siteId`: 404 `SITE_NOT_FOUND` when the site does not exist.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`analytics.traffic`](#analyticstraffic) | `GET /analytics/traffic` | read |
| [`analytics.breakdown`](#analyticsbreakdown) | `GET /analytics/breakdown` | read |
| [`analytics.topSites`](#analyticstopsites) | `GET /analytics/top-sites` | read |
| [`analytics.topNodes`](#analyticstopnodes) | `GET /analytics/top-nodes` | read |
| [`analytics.topRequests`](#analyticstoprequests) | `GET /analytics/top-requests` | read |
| [`analytics.dimensions`](#analyticsdimensions) | `GET /analytics/dimensions` | read |

### `analytics.traffic`

`GET /analytics/traffic` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `siteId` | query | uuid | no | — | Only this site; omitted: every site |

Response: [traffic object](#traffic-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The `siteId` site does not exist |

### `analytics.breakdown`

`GET /analytics/breakdown` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `siteId` | query | uuid | no | — | Only this site; omitted: every site |
| `by` | query | enum | yes | `site` / `node` / `status` / `block_reason` | Break down by site, edge node, HTTP status code or block reason (requests refused or challenged) |
| `metric` | query | enum | no | `requests` / `bytesSent`, default `requests` | What items are ranked and plotted by; applies to `site` and `node` only, `status` and `block_reason` always count requests |
| `statusClass` | query | integer | no | 1–5 | With `by: status` only: keeps the codes that start with this digit (`4` → 4xx) |
| `limit` | query | integer | no | 1–20, default `10` | Number of items returned |

Response: [breakdown object](#breakdown-object).

- `items` holds only items with a total above 0, largest first; on equal totals sites and nodes are ordered by name, status codes and block reasons by code.
- `total` and `totalSeries` cover everything the breakdown covers (only the class's codes with `statusClass`); subtracting `items` gives the remainder.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The `siteId` site does not exist |

### `analytics.topSites`

`GET /analytics/top-sites` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `limit` | query | integer | no | 1–50, default `5` | Number of sites returned |

Response: array<[top item](#top-item-object)>: sites with statistics in the range, most requests first, then by name; `parentId` and `parentName` are the site's cluster.

### `analytics.topNodes`

`GET /analytics/top-nodes` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `limit` | query | integer | no | 1–50, default `5` | Number of nodes returned |

Response: array<[top item](#top-item-object)>: nodes (of every cluster) with statistics in the range, most requests first, then by name; `parentId` and `parentName` are the node's cluster.

### `analytics.topRequests`

`GET /analytics/top-requests` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `siteId` | query | uuid | no | — | Only this site; omitted: every site |
| `by` | query | enum | yes | `url` / `ip` | Rank URLs or client IPs |
| `limit` | query | integer | no | 1–50, default `10` | Number of items returned |

> [!WARNING]
> `limit` is validated without converting strings to numbers: a `limit` in the query string returns 400 `BAD_REQUEST`. Omit it to get the default `10`.

Response: `{ approximate: true, items: [{ value, requests }] }`. `value` is a URL or client IP, `requests` the sum of the heavy hitters nodes pre-aggregate per minute; `approximate` is always `true`. `items` are ordered by `requests`, most first, then by `value`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The `siteId` site does not exist |

### `analytics.dimensions`

`GET /analytics/dimensions` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `range` | query | enum | no | `1h` / `6h` / `24h` / `7d` / `30d`, default `24h` | Time range |
| `siteId` | query | uuid | no | — | Only this site; omitted: every site |

Response: [statistics dimensions object](#statistics-dimensions-object). Nodes count the dimensions with node feature `stats-dims-v1`; they serve statistics only and do not affect publishing.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The `siteId` site does not exist |

## Access logs

- `EDGEWEIR_ANALYTICS` selects the storage: `lite` (PostgreSQL) or `clickhouse`; the retention days are the system setting `settings.logRetention`.
- Behavior: [Enable access logs](../../guide/access-logs.en.md#enable-access-logs), [Search and export logs](../../guide/access-logs.en.md#search-and-export-logs) and [Retention](../../guide/access-logs.en.md#retention).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`logs.settings`](#logssettings) | `GET /sites/{siteId}/logs/settings` | read |
| [`logs.configure`](#logsconfigure) | `PUT /sites/{siteId}/logs/settings` | write |
| [`logs.query`](#logsquery) | `GET /sites/{siteId}/logs` | read |
| [`logs.export`](#logsexport) | `GET /sites/{siteId}/logs/export` | read |

### `logs.settings`

`GET /sites/{siteId}/logs/settings` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | yes | — | Site ID |

Response: [log settings object](#log-settings-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `logs.configure`

`PUT /sites/{siteId}/logs/settings` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | yes | — | Site ID |
| `sampleRate` | body | integer | no | 0–10000, unchanged when omitted | Sample rate in basis points (`10000` every request, `0` none) |
| `logBlocked` | body | boolean | no | Unchanged when omitted | Blocked, challenged and authentication-refused requests always get a line |
| `logQuery` | body | boolean | no | Unchanged when omitted | Lines carry the query string |
| `logHeaders` | body | `array<string>` | no | At most 8; each, trimmed and lowercased, must be 1–64 characters of `a-z`, `0-9`, `-` and not `authorization`, `cookie` or `proxy-authorization`; deduplicated; unchanged when omitted | Request header names lines carry; replaces the list |
| `logPeer` | body | boolean | no | Unchanged when omitted | Lines carry the connection's peer address when it differs from the client's |

Response: `{ ok: true }`.

- Publishes a revision of the site's cluster (reason code `site_updated`); no new revision when the configuration content is unchanged.
- Audit `site.logs_configure`; the metadata holds the changed fields (their new values), or `{ sampleRate }` when nothing changed.
- A configuration with a site whose `sampleRate` is above 0 requires node feature `access-logs-v1`; `logBlocked`, `logQuery`, `logPeer` turned on or a non-empty `logHeaders` require `access-logs-v2`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `logs.query`

`GET /sites/{siteId}/logs` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `siteId` | path | uuid | yes | — | Site ID |
| `from` | query | datetime | yes | Must end in `Z` (UTC); offsets are refused | Start (inclusive) |
| `to` | query | datetime | yes | Must end in `Z` (UTC); offsets are refused | End (exclusive) |
| `status` | query | integer | no | 100–599 | Status code equals this |
| `statusClass` | query | enum | no | `1xx` / `2xx` / `3xx` / `4xx` / `5xx` | Status class; with `status` both must hold |
| `ip` | query | string | no | ≤64 characters, default `""` (no filter) | Client IP equals this |
| `cidr` | query | string | no | ≤64 characters; an IPv4 or IPv6 network (e.g. `10.0.0.0/8`) or a single address; host bits are cleared | Client IP within this network |
| `path` | query | string | no | ≤2048 characters, default `""` (no filter) | Path starts with this |
| `requestId` | query | string | no | ≤128 characters | Request ID (`X-Request-Id`) equals this; omitted or empty: no filter |
| `host` | query | string | no | ≤253 characters after trimming | Host equals this, any case |
| `method` | query | string | no | 0–32 letters, `_`, `-` | Method equals this, any case |
| `cacheStatus` | query | enum | no | `HIT` / `MISS` / `BYPASS` / `EXPIRED` / `STALE` / `UPDATING` / `REVALIDATED` | Cache status |
| `blockReason` | query | enum | no | One of the [block reasons](#statistics-dimensions-object), or `any` | Block reason equals this; `any` matches every request with one |
| `country` | query | string | no | Empty or 2 letters, any case | Client country or region (ISO 3166-1 alpha-2) |
| `asn` | query | integer | no | 1–4294967295 | AS number of the client's network |
| `ua` | query | string | no | ≤256 characters | User-Agent contains this, any case |
| `referer` | query | string | no | ≤256 characters | Referer contains this, any case |
| `minDuration` | query | integer | no | 0–86400000 | Duration at least this many milliseconds |
| `limit` | query | integer | no | 1–1000, default `100` | Number of entries returned |

Response: `{ entries: [log entry](#log-entry-object)[], truncated }`. `entries` are newest first (equal times by `id`, descending); `truncated` is `true` when more than `limit` entries match.

- Every given filter must hold; omitted filters do not filter.
- A `from` before the start of retention (00:00 UTC today minus `retentionDays - 1` days) counts as that start; a `to` later than now plus 5 minutes counts as now plus 5 minutes; when `from` is then not before `to` the list is empty.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

### `logs.export`

`GET /sites/{siteId}/logs/export` · read

Parameters: as [`logs.query`](#logsquery).

Response: `{ csv, truncated }`. `csv` is the CSV text of the same result as [`logs.query`](#logsquery); `truncated` as in `logs.query`.

- The first line holds the column names; lines are separated by CRLF. Columns in order: `time`, `clientIp`, `method`, `host`, `path`, `status`, `bytesSent`, `durationMs`, `cacheStatus`, `sampleRate`, `nodeId`, `requestId`, `ja4`, `wafRuleIds`, `wafBlocked`, `ruleIds`, `userAgent`, `referer`, `httpVersion`, `scheme`, `country`, `asn`, `asName`, `upstreamAddr`, `upstreamStatus`, `upstreamMs`, `requestBytes`, `contentType`, `tlsVersion`, `blockReason`, `blockRuleId`, `query`, `headers`, `peerIp`.
- Every cell is in double quotes, an inner `"` written as `""`; arrays are joined by spaces; `headers` is written as `name: value` joined by `; `; a cell that starts, after leading whitespace, with `=`, `+`, `@` or `-` is prefixed with `'`.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

## Usage

- One [usage record](#usage-record-object) per site and UTC 5-minute window `[windowStart, windowEnd)`; the values are the sum of the minute statistics every node reported for the window. Only windows that received statistics have a record. Records outlive their site.
- Every minute the background worker recomputes closed windows with new statistics: when the values change, `revision` goes up by 1 and the record gets a new `seq`; when they do not, neither changes.
- Records are kept `retentionDays` days (default 100, 35–400); the offline threshold of `completeUntil` is `offlineThresholdMinutes` (default 60, 5–1440). `settings.usage` / `settings.setUsage` read and change both; see [System settings: Usage](../../guide/system.en.md#usage).

`completeUntil` (datetime or `null`; both procedures return the same value): windows that end at or before it hold the statistics of every node taken into account at the time; statistics for those windows that arrive later appear as a revision (`revision` + 1).

| Item | Rule |
| --- | --- |
| Node watermark | Once every statistics batch is acknowledged, the node reports `complete_until`: the start of the minute in which its last successful drain began; every earlier minute has been uploaded. After the node dropped statistics because its local spool was full, the watermark stays at the first dropped minute for 24 hours. The console truncates the watermark to whole minutes, keeps it at most 1 minute ahead of the console clock, and never lowers it |
| Nodes taken into account | Nodes with status `active` (enabled) and a heartbeat within the last `offlineThresholdMinutes` minutes; disabled or deleted nodes and nodes without a heartbeat for longer do not count |
| Value of a node | Its watermark; a node that never reported one (older node versions) counts from its enrollment (its creation when there is none); a value earlier than "now − `offlineThresholdMinutes`" counts as that time, so a node holds `completeUntil` back by at most the threshold |
| Computation | The minimum of the current time, the values of the nodes taken into account, and the start of the earliest window still waiting to be recomputed (the current window included), rounded down to 5 minutes |
| Monotonic | Saved only when later than the saved value; `completeUntil` only moves forward |
| Frequency | Computed once a minute, after the worker recomputes windows |
| `null` | Not computed yet |

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`usage.list`](#usagelist) | `GET /usage` | read; service account `usage:read` |
| [`usage.changes`](#usagechanges) | `GET /usage/changes` | read; service account `usage:read` |

### `usage.list`

`GET /usage` · read · service account `usage:read`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `from` | query | datetime | yes | A multiple of 5 minutes (Unix time) | Start; includes the window starting at it |
| `to` | query | datetime | yes | A multiple of 5 minutes, after `from` | End; excludes the window starting at it |
| `siteId` | query | uuid | no | — | Only this site's records; the ID of a deleted site works too |
| `cursor` | query | string | no | ≤200 characters | `nextCursor` of the previous page |
| `limit` | query | integer | no | 1–5000, default `1000` | Page size |

Response: `{ items: [usage record](#usage-record-object)[], nextCursor, completeUntil }`.

- `items` are ordered by (`windowStart`, `siteId`), ascending.
- `nextCursor`: a string, or `null` (no next page). The cursor holds the window and site of the page's last record; the next page starts after it. Keep `from`, `to` and `siteId` while paging.

| Error | Status | Condition |
| --- | --- | --- |
| `USAGE_RANGE_INVALID` | 400 | `from` or `to` is not a multiple of 5 minutes, or `to` is not after `from` |
| `USAGE_CURSOR_INVALID` | 400 | `cursor` cannot be parsed |

### `usage.changes`

`GET /usage/changes` · read · service account `usage:read`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `afterSeq` | query | string | no | A non-negative decimal integer without leading zeros, ≤9223372036854775807, default `"0"` | Returns records with a higher `seq`; `"0"` starts from the beginning |
| `limit` | query | integer | no | 1–5000, default `1000` | Number of records returned |

Response: `{ items: [usage record](#usage-record-object)[], lastSeq, completeUntil }`.

- `items` are the records created or revised after `afterSeq`, by `seq`, ascending; a revised record appears again with its new `seq`.
- `lastSeq`: the `seq` of the last record returned; `afterSeq` when none was. Pass it as the next `afterSeq`.

| Error | Status | Condition |
| --- | --- | --- |
| `USAGE_CURSOR_INVALID` | 400 | `afterSeq` is above 9223372036854775807 |

## Audit log

- Management actions write the audit log in the change's transaction; the audit log is never pruned. Field meanings: [Audit log](../../guide/system.en.md#audit-log).
- Every action code and target type: [Audit actions](#audit-actions).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`auditLogs.list`](#auditlogslist) | `GET /audit-logs` | read |
| [`auditLogs.facets`](#auditlogsfacets) | `GET /audit-logs/facets` | read |

### `auditLogs.list`

`GET /audit-logs` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `action` | query | string | no | ≤100 characters after trimming | Action code equals this (e.g. `site.create`) |
| `targetType` | query | string | no | ≤100 characters after trimming | Target type equals this (e.g. `site`) |
| `from` | query | datetime | no | — | `occurredAt` at or after this time |
| `to` | query | datetime | no | — | `occurredAt` at or before this time |
| `limit` | query | integer | no | 1–200, default `50` | Page size |
| `offset` | query | integer | no | ≥0, default `0` | Entries skipped |

Response: `{ items: [audit entry](#audit-entry-object)[], total }`. `items` are newest first (by `id`, descending); `total` is the number of entries the filters match.

- Every given filter must hold; an empty `action` or `targetType` does not filter.
- `action` and `targetType` are not checked against the known values; an unknown value returns an empty list.

### `auditLogs.facets`

`GET /audit-logs/facets` · read

No parameters.

Response: `{ actions, targetTypes }`, both `array<string>`: the action codes and target types present in the audit log, distinct, ascending; `targetTypes` leaves out the empty string. Older codes that are no longer in [Audit actions](#audit-actions) are included.

## Alert channels

- At most 32 channels. Channel configurations (addresses, tokens, secrets) are encrypted with `EDGEWEIR_MASTER_KEY`; no procedure returns them.
- A channel with `platform` `true` receives every alert, cluster and DNS alerts included; other channels receive only alerts their [subscription](#alert-subscriptions) covers. `locale` is the notification language.
- `email` channels use the SMTP settings.
- Behavior: [Configure alert channels](../../guide/alerts.en.md#configure-alert-channels), [SMS channels](../../guide/alerts.en.md#sms-channels), [SMTP](../../guide/alerts.en.md#smtp) and [Delivery behavior](../../guide/alerts.en.md#delivery-behavior).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`alerts.channels`](#alertschannels) | `GET /alerts/channels` | read |
| [`alerts.createChannel`](#alertscreatechannel) | `POST /alerts/channels` | write |
| [`alerts.updateChannel`](#alertsupdatechannel) | `PUT /alerts/channels/{id}` | write |
| [`alerts.deleteChannel`](#alertsdeletechannel) | `DELETE /alerts/channels/{id}` | write |
| [`alerts.testChannel`](#alertstestchannel) | `POST /alerts/channels/{id}/test` | write |
| [`alerts.smtp`](#alertssmtp) | `GET /alerts/smtp` | read |
| [`alerts.setSmtp`](#alertssetsmtp) | `PUT /alerts/smtp` | write |

### `alerts.channels`

`GET /alerts/channels` · read

No parameters.

Response: array<[channel](#channel-object)>, by name.

### `alerts.createChannel`

`POST /alerts/channels` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–100 characters after trimming | Name |
| `enabled` | body | boolean | no | Default `true` | Enabled |
| `platform` | body | boolean | no | Default `false` | Receives every alert |
| `locale` | body | enum | no | `zh-CN` / `en`, default `zh-CN` | Notification language |
| `config` | body | object | yes | See [Channel configuration](#channel-configuration) | Channel type (`config.kind`) and its configuration |

Response: [channel](#channel-object). Audit `alert.channel_create` (`kind`, `platform`).

| Error | Status | Condition |
| --- | --- | --- |
| `ALERT_CHANNEL_LIMIT` | 409 | 32 channels exist already |

### `alerts.updateChannel`

`PUT /alerts/channels/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Channel ID |
| `name` | body | string | no | 1–100 characters after trimming, unchanged when omitted | Name |
| `enabled` | body | boolean | no | Unchanged when omitted | Enabled |
| `platform` | body | boolean | no | Unchanged when omitted | Receives every alert |
| `locale` | body | enum | no | `zh-CN` / `en`, unchanged when omitted | Notification language |
| `config` | body | object | no | See [Channel configuration](#channel-configuration), unchanged when omitted | Replaces the configuration; may change the channel type |

Response: [channel](#channel-object).

- With `config`, `lastError` is cleared and the channel's failed notifications (attempts used up) are queued again with their attempts reset.
- Audit `alert.channel_update` (`credentialsRotated`: whether `config` was given; `previousKind`: the type before).

| Error | Status | Condition |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | The channel does not exist |

### `alerts.deleteChannel`

`DELETE /alerts/channels/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Channel ID |

Response: `{ ok: true }`. The channel's subscription is deleted with it. Audit `alert.channel_delete`.

| Error | Status | Condition |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | The channel does not exist |

### `alerts.testChannel`

`POST /alerts/channels/{id}/test` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Channel ID |

Response: `{ ok: true }`.

- Sends a test notification now (object name `Edgeweir`, status firing), also through a disabled channel; on SMS channels the test counts towards the send limits.
- Audit `alert.channel_test_request` before sending, `alert.channel_test` after a successful send.

| Error | Status | Condition |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | The channel does not exist |
| `ALERT_SMTP_NOT_CONFIGURED` | 412 | An `email` channel, and SMTP is not set or has no password |
| `ALERT_RATE_LIMITED` | 429 | An SMS channel reached its hourly or daily send limit; `data.retryAt` is when the next send fits |
| `ALERT_SMS_REJECTED` | 502 | The SMS provider refused the message; `data.code` is the provider's error code |
| `ALERT_SEND_FAILED` | 502 | Any other send failure |

### `alerts.smtp`

`GET /alerts/smtp` · read

No parameters.

Response: [SMTP settings](#smtp-settings-object), or `null` when not set.

### `alerts.setSmtp`

`PUT /alerts/smtp` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `host` | body | string | yes | 1–253 characters after trimming | SMTP server |
| `port` | body | integer | no | 1–65535, default `465` | Port |
| `secure` | body | boolean | no | Default `true` | `true`: TLS from the start; `false`: STARTTLS required |
| `from` | body | string | yes | An e-mail address | Sender |
| `username` | body | string | yes | 1–320 characters | User name |
| `password` | body | string | no | 1–4096 characters | Password; omitted: the saved password is kept |
| `ca` | body | string | no | ≤65536 characters after trimming, default `""` | PEM certificates only; they replace the system trust store for this server; empty: `EDGEWEIR_SMTP_CA_FILE` or the system trust store |

Response: `{ ok: true }`.

- Replaces the settings: an omitted `port`, `secure` or `ca` takes its default.
- `password` is required when none is saved, or when `host`, `port`, `secure`, `username` or `ca` differ from the saved ones.
- Audit `alert.smtp_update` (`host`; `credentialsRotated`: whether `password` was given; `customCa`: whether `ca` is non-empty).

| Error | Status | Condition |
| --- | --- | --- |
| `SMTP_PASSWORD_REQUIRED` | 400 | A password is required and `password` is missing |
| `SMTP_CA_INVALID` | 400 | `ca` is non-empty and holds anything but PEM certificates, or a certificate does not parse |

## Alert rules

Triggers and recovery of each alert kind: [Set alert rules](../../guide/alerts.en.md#set-alert-rules) and [Cluster and DNS alerts](../../guide/alerts.en.md#cluster-and-dns-alerts).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`alerts.policy`](#alertspolicy) | `GET /alerts/policy` | read |
| [`alerts.setPolicy`](#alertssetpolicy) | `PUT /alerts/policy` | write |

### `alerts.policy`

`GET /alerts/policy` · read

No parameters.

Response: [alert policy object](#alert-policy-object).

### `alerts.setPolicy`

`PUT /alerts/policy` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `nodeOfflineSeconds` | body | integer | no | 45–3600, default `90` | See the [alert policy object](#alert-policy-object) |
| `certificateHours` | body | integer | no | 1–720, default `72` | As above |
| `errorRatio` | body | number | no | 0.01–1, default `0.2` | As above |
| `minimumRequests` | body | integer | no | 1–1000000, default `100` | As above |
| `windowMinutes` | body | integer | no | 1–60, default `5` | As above |
| `clockSkewSeconds` | body | integer | no | 5–3600, default `30` | As above |

Response: [alert policy object](#alert-policy-object).

- Replaces the policy: omitted fields take their defaults, not their previous values.
- Audit `alert.policy_update`; the metadata holds every saved field.

## Alert subscriptions

- Subscriptions belong to the operator's account; a channel has at most one. Only the 8 subscribable [alert kinds](#alert-kinds) can be subscribed to.
- Behavior: [Subscribe to alerts](../../guide/alerts.en.md#subscribe-to-alerts).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`alerts.subscriptions`](#alertssubscriptions) | `GET /alerts/subscriptions` | read |
| [`alerts.subscribe`](#alertssubscribe) | `POST /alerts/subscriptions` | write |
| [`alerts.updateSubscription`](#alertsupdatesubscription) | `PUT /alerts/subscriptions/{id}` | write |
| [`alerts.unsubscribe`](#alertsunsubscribe) | `DELETE /alerts/subscriptions/{id}` | write |

### `alerts.subscriptions`

`GET /alerts/subscriptions` · read

No parameters.

Response: array<[subscription](#subscription-object)>, by channel name.

### `alerts.subscribe`

`POST /alerts/subscriptions` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `channelId` | body | uuid | yes | — | Channel ID |
| `kinds` | body | `array<enum>` | yes | 1–8 subscribable [alert kinds](#alert-kinds), deduplicated | Alert kinds sent |
| `allSites` | body | boolean | no | Default `false` | Every site, future ones included |
| `siteIds` | body | `array<uuid>` | no | At most 1000, default `[]` | Sites covered |
| `enabled` | body | boolean | no | Default `true` | Enabled |

Exactly one of `allSites` `true` and a non-empty `siteIds` must hold; otherwise 400 `BAD_REQUEST` (`siteIds`).

Response: [subscription](#subscription-object).

- Creates the channel's subscription, or replaces the kinds, sites and `enabled` of the one it has (the ID stays).
- Audit `alert.subscribe` (`channelId`, `kinds`, `allSites`, `siteIds`, `enabled`).

| Error | Status | Condition |
| --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | The channel does not exist or is disabled |
| `SITE_NOT_FOUND` | 404 | A site in `siteIds` does not exist |

### `alerts.updateSubscription`

`PUT /alerts/subscriptions/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Subscription ID |
| `kinds` | body | `array<enum>` | yes | 1–8 subscribable [alert kinds](#alert-kinds), deduplicated | Alert kinds sent |
| `allSites` | body | boolean | no | Default `false` | Every site, future ones included |
| `siteIds` | body | `array<uuid>` | no | At most 1000, default `[]` | Sites covered |
| `enabled` | body | boolean | no | Default `true` | Enabled |

Exactly one of `allSites` `true` and a non-empty `siteIds` must hold; otherwise 400 `BAD_REQUEST` (`siteIds`).

Response: [subscription](#subscription-object).

- Replaces the subscription: an omitted `allSites`, `siteIds` or `enabled` takes its default. The channel cannot change.
- Audit `alert.subscription_update` (fields as for `alert.subscribe`).

| Error | Status | Condition |
| --- | --- | --- |
| `ALERT_SUBSCRIPTION_NOT_FOUND` | 404 | The subscription does not exist |
| `SITE_NOT_FOUND` | 404 | A site in `siteIds` does not exist |

### `alerts.unsubscribe`

`DELETE /alerts/subscriptions/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Subscription ID |

Response: `{ ok: true }`. Audit `alert.unsubscribe`.

| Error | Status | Condition |
| --- | --- | --- |
| `ALERT_SUBSCRIPTION_NOT_FOUND` | 404 | The subscription does not exist |

## Alert events

- A condition produces one event when it starts firing and one when it resolves; events are kept 90 days.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`alerts.events`](#alertsevents) | `GET /alerts/events` | read |

### `alerts.events`

`GET /alerts/events` · read

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `siteId` | query | uuid | no | — | Only this site's alerts, plus `node_offline` and `node_clock_skew` of the nodes in the site's cluster |

Response: array<[alert event](#alert-event-object)>, newest first, at most 100. Without `siteId`: cluster and DNS alerts, node alerts and alerts of existing sites.

| Error | Status | Condition |
| --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | The `siteId` site does not exist |

## Objects

### Revision object

| Field | Type | Description |
| --- | --- | --- |
| `clusterId` | uuid | Cluster ID |
| `revision` | integer | Revision number |
| `contentHash` | string | Hash of the configuration content |
| `siteCount` | integer | Sites in the revision |
| `reason` | string | Publish reason as English text |
| `reasonCode` | string | Reason code; empty for revisions published before reason codes existed |
| `reasonParams` | object | Reason parameters; values are strings or numbers |
| `createdAt` | datetime | Publish time |

### Attention item object

| Field | Type | Description |
| --- | --- | --- |
| `kind` | enum | The item; values below |
| `clusterId` | uuid | Cluster ID |
| `clusterName` | string | Cluster name |
| `revision` | integer or `null` | See below; `null` when it does not apply |
| `at` | datetime or `null` | See below; `null` when it does not apply |
| `count` | integer | Number of nodes; `0` when it does not apply |
| `version` | string | Target version; empty when it does not apply |

`kind`, in this order:

| `kind` | Condition | Fields |
| --- | --- | --- |
| `nodes_unhealthy` | Enabled nodes that connected before are offline, failed to apply their configuration, had their certificate refused, or report the data plane down after applying a configuration | `count` |
| `dns_failed` | The cluster's DNS binding is not off and its latest DNS revision failed | `revision`: DNS revision |
| `dns_blocked` | Mass removal protection blocked a DNS publication | — |
| `upgrade_failed` | The cluster's newest node upgrade failed or has failed nodes, within the last 24 hours | `version` |
| `canary_rolled_back` | The configuration canary rolled back within the last 24 hours | `revision`: candidate revision; `at`: rollback time |
| `canary_awaiting_promotion` | The configuration canary awaits promotion | `revision`: candidate revision |
| `canary_running` | The configuration canary is being observed | `revision`: candidate revision; `at`: end of the observation window (`null` before the window started) |
| `nodes_lagging` | Enabled, online, healthy nodes behind their target revision, or needing an upgrade to run it | `count` |
| `nodes_no_address` | The cluster's DNS binding is not off, and enabled online nodes have no public address DNS can use | `count` |

How each item is determined: [Needs attention](../../guide/overview.en.md#needs-attention).

### Traffic counters

Every point and total of the [traffic object](#traffic-object) has these fields (all integers), summed over every node and the selected sites:

| Field | Description |
| --- | --- |
| `requests` | Requests |
| `bytesSent` | Bytes sent |
| `bytesReceived` | Bytes received |
| `cacheHits` | Cache hits |
| `cacheMisses` | Cache misses |
| `status2xx`, `status3xx`, `status4xx`, `status5xx` | Responses per status class |

### Traffic object

| Field | Type | Description |
| --- | --- | --- |
| `range` | enum | The requested `range` |
| `bucketSeconds` | integer | Width of one point, in seconds |
| `from` | datetime | Start of the first bucket |
| `to` | datetime | The current time |
| `points` | `array<object>` | One point per bucket, oldest first: `time` (datetime, start of the bucket) and the [traffic counters](#traffic-counters); buckets without statistics are zero |
| `totals` | object | The [traffic counters](#traffic-counters) summed over the range, plus `peakBytesPerSecond` (number): bytes sent per second in the busiest bucket |
| `previous` | object | The same totals for the same-length period right before `from` |

### Top item object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Site or node ID |
| `name` | string | Site or node name |
| `parentId` | string | ID of its cluster |
| `parentName` | string | Name of its cluster |
| `requests` | integer | Requests |
| `bytesSent` | integer | Bytes sent |
| `cacheHits` | integer | Cache hits |
| `cacheMisses` | integer | Cache misses |

### Breakdown object

| Field | Type | Description |
| --- | --- | --- |
| `range` | enum | The requested `range` |
| `bucketSeconds` | integer | Bucket width, in seconds |
| `from` | datetime | Start of the first bucket |
| `to` | datetime | The current time |
| `times` | `array<datetime>` | Start of each bucket, oldest first |
| `items` | `array<object>` | The leading items, largest first; fields below |
| `total` | integer | The metric over everything the breakdown covers |
| `totalSeries` | `array<integer>` | The metric per bucket, aligned with `times` |

Elements of `items`:

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Site or node ID, the status code (e.g. `"404"`) or the block reason (e.g. `"cc"`) |
| `name` | string | Site or node name; the same as `id` for status codes and block reasons |
| `parentId` | string or `null` | ID of the site's or node's cluster; `null` for status codes and block reasons |
| `parentName` | string or `null` | Name of that cluster; `null` for status codes and block reasons |
| `total` | integer | The item's metric over the range |
| `series` | `array<integer>` | The item's value per bucket, aligned with `times` |

### Statistics dimensions object

| Field | Type | Description |
| --- | --- | --- |
| `countries` | `array<object>` | `{ country, requests, bytesSent }`, most requests first, at most 250; `country` is ISO 3166-1 alpha-2, the empty string is unknown |
| `asns` | `array<object>` | `{ asn, name, requests }`: client networks, at most 50, approximate; `name` is empty when unknown |
| `referers` | `array<object>` | `{ host, requests }`: referring hosts, at most 50, approximate |
| `browsers` | `array<object>` | `{ key, requests }`: browsers |
| `oses` | `array<object>` | `{ key, requests }`: operating systems |
| `devices` | `array<object>` | `{ key, requests }`: devices |
| `httpVersions` | `array<object>` | `{ key, requests }`: HTTP versions |
| `tlsVersions` | `array<object>` | `{ key, requests }`: TLS versions |
| `blockReasons` | `array<object>` | `{ key, requests }`: block reasons |
| `challenges` | object | `{ issued, passed }`: challenges issued and passed |
| `unsupportedNodes` | integer | Enabled nodes without `stats-dims-v1` (those of the site's cluster with `siteId`, otherwise every node); above 0 the dimensions are partial |

Arrays hold only keys with more than 0 requests, most requests first, then by key. Values of `key`:

| Dimension | Values |
| --- | --- |
| `browsers` | `chrome`, `edge`, `firefox`, `safari`, `opera`, `samsung`, `uc`, `qq`, `wechat`, `yandex`, `ie`, `crawler`, `tool`, `other` |
| `oses` | `windows`, `macos`, `ios`, `android`, `linux`, `chromeos`, `harmonyos`, `other` |
| `devices` | `desktop`, `mobile`, `tablet`, `crawler`, `other` |
| `httpVersions` | `1.0`, `1.1`, `2`, `3`, `other` |
| `tlsVersions` | `1.2`, `1.3`, `none`, `other` |
| `blockReasons` | `ip_banned`, `ip_blocked`, `rule`, `rate_limit`, `crs`, `cc`, `challenge`, `auth`, `referer`, `user_agent`, `region`, `cors`, `websocket_origin`, `client_cert`, `maintenance` |

What each block reason means: [Block reasons](../../guide/access-logs.en.md#block-reasons).

### Log settings object

| Field | Type | Description |
| --- | --- | --- |
| `sampleRate` | integer | Sample rate in basis points (0–10000) |
| `storage` | enum | `lite` / `clickhouse`: the storage in use |
| `retentionDays` | integer | Days the storage in use keeps logs |
| `logBlocked` | boolean | Blocked, challenged and authentication-refused requests always get a line |
| `logQuery` | boolean | Lines carry the query string |
| `logHeaders` | `array<string>` | Request header names lines carry (lowercase) |
| `logPeer` | boolean | Lines carry the connection's peer address when it differs from the client's |

### Log entry object

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Log ID: `<node ID>/<batch sequence>/<index in the batch>` |
| `time` | datetime | Request time |
| `nodeId` | string | Node ID |
| `siteId` | string | Site ID |
| `clientIp` | string | Client IP |
| `method` | string | Method |
| `host` | string | Host (≤253 characters) |
| `path` | string | Path without query string and fragment (≤2048 characters) |
| `status` | integer | Status code |
| `bytesSent` | integer | Bytes sent |
| `durationMs` | integer | Duration in milliseconds |
| `cacheStatus` | string | `HIT`, `MISS`, `BYPASS`, `EXPIRED`, `STALE`, `UPDATING`, `REVALIDATED` or empty |
| `sampleRate` | integer | Sample rate the line was written with (basis points, 1–10000) |
| `ja4` | string | JA4 TLS client fingerprint; empty unless the site records it |
| `wafRuleIds` | `array<integer>` | OWASP CRS rules the request matched, ascending, at most 16 |
| `wafBlocked` | boolean | CRS blocked the request |
| `requestId` | string | The request ID the node answered with (`X-Request-Id`); empty for older nodes |
| `ruleIds` | `array<string>` | Log rules that wrote this line whatever the sample rate, at most 8 |
| `userAgent` | string | User-Agent (≤512 characters) |
| `referer` | string | Referer without query string and fragment (≤1024 characters) |
| `httpVersion` | string | `1.0`, `1.1`, `2`, `3` or empty |
| `scheme` | string | `http`, `https` or empty |
| `country` | string | Client country or region (ISO 3166-1 alpha-2); empty when unknown |
| `asn` | integer | AS number of the client's network; `0` when unknown |
| `asName` | string | AS name |
| `upstreamAddr` | string | The origin address that answered; empty without the origin |
| `upstreamStatus` | integer | The origin's status; `0` without the origin |
| `upstreamMs` | integer | Time to the origin in milliseconds; `0` without the origin |
| `requestBytes` | integer | Request bytes |
| `contentType` | string | Response media type, lowercase, without parameters |
| `tlsVersion` | string | `1.2` or `1.3`; empty on plain HTTP |
| `blockReason` | string | The [block reason](#statistics-dimensions-object); empty when not blocked |
| `blockRuleId` | string | ID of the rule behind the block reason (a WAF, rate limit or access authentication rule); empty when none |
| `query` | string | Query string (without `?`); recorded while the site has `logQuery` on |
| `headers` | object | Recorded request headers (lowercase name → value); recorded while the site sets `logHeaders` |
| `peerIp` | string | The connection's peer when it differs from `clientIp`; recorded while the site has `logPeer` on |

### Usage record object

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | `<siteId>.<windowStart in Unix seconds>`; fixed per site and window |
| `siteId` | uuid | Site ID; kept after the site is deleted |
| `windowStart` | datetime | Window start (UTC, aligned to 5 minutes) |
| `windowEnd` | datetime | Window end (`windowStart` plus 5 minutes) |
| `requests` | string | Requests, as a decimal integer string (exact beyond 2^53) |
| `bytesSent` | string | Bytes sent, as a decimal integer string |
| `bytesReceived` | string | Bytes received, as a decimal integer string |
| `revision` | integer | Starts at 1; goes up by 1 when a recomputation changes the values |
| `seq` | string | Decimal integer string; increases across all records (with gaps), assigned on creation and revision |
| `updatedAt` | datetime | Last write |

### Audit entry object

| Field | Type | Description |
| --- | --- | --- |
| `id` | integer | Entry ID, increasing in write order |
| `occurredAt` | datetime | Time of the action |
| `actorType` | string | `user`, `api_key`, `service_account`, `node`, `probe` or `system` |
| `actorId` | string | Actor ID; empty for `system` |
| `actorName` | string | Actor name recorded with the action; for older entries without one, the user's or node's current name, empty when not found |
| `ip` | string | Client address of the request; empty for actions no request carried |
| `userAgent` | string | User-Agent of the request; empty for actions no request carried |
| `action` | string | Action code; see [Audit actions](#audit-actions) |
| `targetType` | string | Target type; see [Audit actions](#audit-actions); empty when there is no target |
| `targetId` | string | Target ID |
| `targetName` | string | Target name recorded with the action; for older entries without one, the current name of the user, node, site or cluster, empty when not found |
| `metadata` | object | Parameters of the action and values before and after |

### Audit actions

Action codes (`action`) the console writes:

| Prefix | Actions |
| --- | --- |
| `account` | `account.passkey_add`, `account.passkey_delete`, `account.password_change`, `account.recover`, `account.two_factor_disable`, `account.two_factor_enable` |
| `acme_account` | `acme_account.delete` |
| `alert` | `alert.channel_create`, `alert.channel_delete`, `alert.channel_test`, `alert.channel_test_request`, `alert.channel_update`, `alert.policy_update`, `alert.smtp_update`, `alert.subscribe`, `alert.subscription_update`, `alert.unsubscribe` |
| `api_key` | `api_key.create`, `api_key.revoke`, `api_key.update` |
| `auth` | `auth.sign_in`, `auth.sign_in_failed` |
| `ban` | `ban.create`, `ban.delete`, `ban.update` |
| `cache` | `cache.prefetch`, `cache.purge` |
| `certificate` | `certificate.delete`, `certificate.issued`, `certificate.names_extended`, `certificate.renew`, `certificate.renewal_rescheduled`, `certificate.request`, `certificate.unloadable`, `certificate.upload` |
| `cluster` | `cluster.cache_update`, `cluster.challenge_keys_rotate`, `cluster.client_ip_update`, `cluster.connection_limits_update`, `cluster.create`, `cluster.delete`, `cluster.listen_ports_update`, `cluster.port_pools_update`, `cluster.rollback`, `cluster.rollout_abort`, `cluster.rollout_direct`, `cluster.rollout_policy_update`, `cluster.rollout_promote`, `cluster.rollout_rollback`, `cluster.session_ticket_keys_rotate`, `cluster.unknown_hosts_update`, `cluster.update` |
| `dns` | `dns.applied`, `dns.binding_update`, `dns.force_publish`, `dns.protection_update`, `dns.provider_create`, `dns.provider_delete`, `dns.provider_update`, `dns.rollback` |
| `dns_credential` | `dns_credential.create`, `dns_credential.delete`, `dns_credential.update` |
| `enrollment_token` | `enrollment_token.create` |
| `greylist` | `greylist.create`, `greylist.delete`, `greylist.update` |
| `ip_list` | `ip_list.create`, `ip_list.delete`, `ip_list.update` |
| `l4` | `l4.cname_update` |
| `l4_app` | `l4_app.create`, `l4_app.delete`, `l4_app.disable`, `l4_app.enable`, `l4_app.update` |
| `node` | `node.cache_update`, `node.certificate_renew`, `node.debug_logs_pull`, `node.delete`, `node.disable`, `node.enable`, `node.enroll`, `node.move`, `node.set_addresses`, `node.set_probe`, `node.update`, `node.upgrade_cancel`, `node.upgrade_create`, `node.upgrade_promote`, `node.upgrade_result` |
| `node_group` | `node_group.create`, `node_group.delete`, `node_group.update` |
| `origin_ca` | `origin_ca.create`, `origin_ca.retire`, `origin_ca.rotation_cancel`, `origin_ca.rotation_start` |
| `origin_certificate` | `origin_certificate.issue`, `origin_certificate.revoke` |
| `origin_client_ca` | `origin_client_ca.activate`, `origin_client_ca.create`, `origin_client_ca.retire`, `origin_client_ca.rotation_cancel`, `origin_client_ca.rotation_start` |
| `origin_client_certificate` | `origin_client_certificate.rotate` |
| `platform` | `platform.rule_restore`, `platform.rules_update` |
| `probe` | `probe.certificate_renew`, `probe.delete`, `probe.enroll`, `probe.token_create`, `probe.update` |
| `region` | `region.create`, `region.delete`, `region.update` |
| `scheduling` | `scheduling.activate`, `scheduling.recover`, `scheduling.rule_create`, `scheduling.rule_delete`, `scheduling.rule_update` |
| `service_account` | `service_account.create`, `service_account.delete`, `service_account.key_create`, `service_account.key_revoke`, `service_account.update` |
| `site` | `site.access_control_update`, `site.auth_identity_forget`, `site.auth_sign_url`, `site.auth_update`, `site.auto_mitigation_apply`, `site.auto_mitigation_release`, `site.auto_mitigation_restore`, `site.auto_mitigation_update`, `site.bulk_redirects_update`, `site.clone`, `site.cname_update`, `site.create`, `site.delete`, `site.disable`, `site.enable`, `site.error_pages_update`, `site.https_update`, `site.image_convert_update`, `site.logs_configure`, `site.maintenance_update`, `site.protection_update`, `site.purge_all`, `site.rule_restore`, `site.rules_update`, `site.settings_copied`, `site.tags_update`, `site.update`, `site.usage_guard_apply`, `site.usage_guard_delete`, `site.usage_guard_release`, `site.usage_guard_restore`, `site.usage_guard_update`, `site.waf_update` |
| `site_tag` | `site_tag.delete`, `site_tag.rename` |
| `system` | `system.acme_directory_update`, `system.bans_update`, `system.cc_template_update`, `system.demo_update`, `system.error_pages_update`, `system.log_retention_update`, `system.login_allow_list_update`, `system.node_channel_update`, `system.node_log_retention_update`, `system.origin_allow_list_update`, `system.probes_update`, `system.protection_update`, `system.recompile`, `system.release_source_update`, `system.setup`, `system.setup_rejected`, `system.usage_update` |

Target types (`targetType`): `acme_account`, `alert_channel`, `alert_subscription`, `api_key`, `ban`, `cache_task`, `certificate`, `certificate_authority`, `cluster`, `dns_credential`, `dns_provider`, `greylist`, `ip_list`, `l4_app`, `node`, `node_group`, `node_upgrade`, `origin_certificate`, `origin_client_certificate`, `platform`, `probe`, `region`, `scheduling_rule`, `service_account`, `site`, `site_tag`, `system`, `system_setting`, `user`.

Older entries may carry codes that are not in these lists.

### Channel object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Channel ID |
| `name` | string | Name |
| `kind` | string | Channel type; see [Channel configuration](#channel-configuration) |
| `enabled` | boolean | Enabled |
| `platform` | boolean | Receives every alert |
| `locale` | enum | `zh-CN` / `en`: notification language |
| `lastError` | string | Why the last delivery failed: `alert_send_failed`, `alert_smtp_not_configured`, `alert_rate_limited` or `alert_sms_rejected:<provider error code>`; empty after a successful delivery or a new `config` |

### Channel configuration

`config.kind` determines the other fields:

| `kind` | Field | Type | Required | Constraints and default |
| --- | --- | --- | --- | --- |
| `webhook` | `url` | string | yes | An `http` or `https` URL, ≤4096 characters, without user name, password or fragment |
| `webhook` | `bearer` | string | no | ≤4096 characters; sent as a Bearer token |
| `email` | `to` | `array<string>` | yes | 1–20 e-mail addresses |
| `dingtalk` | `url` | string | yes | As `webhook.url`; the host must be `oapi.dingtalk.com` |
| `dingtalk` | `secret` | string | no | ≤4096 characters; signing secret |
| `wecom` | `url` | string | yes | As `webhook.url`; the host must be `qyapi.weixin.qq.com` |
| `telegram` | `token` | string | yes | Bot token: `<digits>:<20–200 letters, digits, _, ->` |
| `telegram` | `chatId` | string | yes | 1–24 digits with an optional `-`, or `@` followed by 5–32 letters, digits or `_` starting with a letter |
| `aliyun_sms` | `accessKeyId` | string | yes | 1–128 letters or digits |
| `aliyun_sms` | `accessKeySecret` | string | yes | 1–256 characters |
| `aliyun_sms` | `signName` | string | yes | 1–64 characters after trimming; SMS signature |
| `aliyun_sms` | `templateCode` | string | yes | 1–64 letters, digits or `_` |
| `aliyun_sms` | `maxParamLength` | integer | no | 1–100, default `35`; maximum characters per template variable |
| `tencent_sms` | `secretId` | string | yes | 1–128 letters or digits |
| `tencent_sms` | `secretKey` | string | yes | 1–256 characters |
| `tencent_sms` | `sdkAppId` | string | yes | 1–20 digits |
| `tencent_sms` | `region` | enum | no | `ap-guangzhou` / `ap-beijing` / `ap-nanjing`, default `ap-guangzhou` |
| `tencent_sms` | `signName` | string | yes | 1–64 characters after trimming; SMS signature |
| `tencent_sms` | `templateId` | string | yes | 1–20 digits |
| `tencent_sms` | `maxParamLength` | integer | no | 1–100, default `6`; maximum characters per template variable |
| `aliyun_sms`, `tencent_sms` | `phoneNumbers` | `array<string>` | yes | 1–20, each 5–15 digits with an optional `+` (E.164; mainland China numbers may omit `+86`) |
| `aliyun_sms`, `tencent_sms` | `hourlyLimit` | integer | no | 1–100, default `10`; sends per sliding hour at most (tests included) |
| `aliyun_sms`, `tencent_sms` | `dailyLimit` | integer | no | 1–1000, default `50`; sends per sliding 24 hours at most (tests included) |

### Alert kinds

| Value | Name | Concerns | Subscribable |
| --- | --- | --- | --- |
| `node_offline` | Node offline | Node | yes |
| `node_clock_skew` | Node clock skewed | Node | yes |
| `certificate_expiring` | Certificate expiring | Site | yes |
| `origin_unavailable` | Origin unavailable | Site | yes |
| `high_5xx` | High server error ratio | Site | yes |
| `cc_mitigation` | CC mitigation raised | Site | yes |
| `usage_warning` | Usage near its limit | Site | yes |
| `usage_limit` | Usage limit reached | Site | yes |
| `config_rollout_failed` | Configuration canary rolled back | Cluster | no |
| `config_rollout_no_canary` | No canary node online; configuration published to every node | Cluster | no |
| `config_rule_invalid` | Stored rule no longer valid; its last compiled form is kept | Rule | no |
| `dns_mass_removal_blocked` | DNS mass removal blocked | Cluster | no |
| `scheduling_action` | Scheduling rule acting on a node | Scheduling rule and node | no |
| `certificate_unloadable` | A node cannot load a certificate | Certificate | no |
| `dns_reconcile_failed` | DNS reconciliation failing | Cluster | no |

Kinds that cannot be subscribed to go only to channels with `platform` `true`. Usage alerts: [Usage protection: Alerts](../../guide/usage-protection.en.md#alerts).

### Alert policy object

| Field | Type | Description |
| --- | --- | --- |
| `nodeOfflineSeconds` | integer | `node_offline` fires when an enabled node sends no heartbeat for this many seconds or reports the data plane down; nodes enrolled for less than this are not checked. Also how long origin health and clock skew reports stay valid |
| `certificateHours` | integer | `certificate_expiring` fires when a site's current certificate expires within this many hours |
| `errorRatio` | number | `high_5xx` fires when 5xx responses reach this share of requests in the window (a fraction: `0.2` is 20%) |
| `minimumRequests` | integer | `high_5xx` is checked only when the window has at least this many requests |
| `windowMinutes` | integer | The `high_5xx` window, in minutes |
| `clockSkewSeconds` | integer | `node_clock_skew` fires when the clock skew a node reports (ahead or behind) reaches this many seconds |

### SMTP settings object

| Field | Type | Description |
| --- | --- | --- |
| `host` | string | SMTP server |
| `port` | integer | Port |
| `secure` | boolean | `true`: TLS from the start; `false`: STARTTLS required |
| `from` | string | Sender |
| `username` | string | User name |
| `ca` | string | Saved PEM certificates; empty: `EDGEWEIR_SMTP_CA_FILE` or the system trust store |
| `caFile` | boolean | `EDGEWEIR_SMTP_CA_FILE` is set |

The password is never returned.

### Subscription object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Subscription ID |
| `channelId` | uuid | Channel ID |
| `channelName` | string | Channel name |
| `kinds` | `array<enum>` | [Alert kinds](#alert-kinds) sent |
| `enabled` | boolean | Enabled; a disabled subscription sends nothing |
| `allSites` | boolean | Every site, future ones included; `sites` is then `[]` |
| `sites` | `array<object>` | Sites covered, `{ id, name }`, by name; deleted sites drop out |

### Alert event object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Event ID |
| `siteId` | uuid or `null` | Site ID; `null` for node alerts and cluster and DNS alerts |
| `kind` | enum | [Alert kind](#alert-kinds) |
| `status` | enum | `firing` / `resolved` |
| `occurredAt` | datetime | Time of the event |
| `siteName` | string | Site name; for node alerts the node name, for cluster and DNS alerts the name of what the alert concerns (cluster, rule, certificate and so on) |
