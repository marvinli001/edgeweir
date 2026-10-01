# Access logs and access keys

Traffic analytics, access log sampling, search, and export, analytics storage modes, and creating and revoking access keys.

## Concepts

| Term | Definition |
| --- | --- |
| Analytics | Complete per-minute counts from nodes: requests, traffic, cache hits, status codes, and approximate top URLs and IPs. |
| Access logs | Individual requests recorded at a sample rate. Bounded diagnostic data, not a lossless audit record. |
| Sample rate | The share of requests recorded; a percentage in the UI, an integer in 1/10,000 units (0–10000) in the API. |
| Analytics mode | The value of `EDGEWEIR_ANALYTICS`: `lite` (PostgreSQL, default) or `clickhouse`. |
| Access key | A key for calling `/api/v1`, owned by the user who created it. |

## View analytics

| Location | Scope |
| --- | --- |
| **Console → Overview** | All sites of the current organization, including **Top sites** |
| **Console → Sites** → **Analytics** tab | One site |
| **Admin → Platform** | The whole platform, including **Top nodes**; platform administrators only |

1. Open a page from the table and select a range: **Last hour**, **Last 6 hours**, **Last 24 hours**, **Last 7 days**, or **Last 30 days**.
2. Read **Total requests**, **Data transferred**, **Cache hit ratio**, **Peak bandwidth**, **4xx rate**, **5xx rate**, **Status codes**, **Top URLs (approximate)**, and **Top IPs (approximate)**; click a metric for details.
3. Click **Refresh** to reload.

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

### Reporting and deduplication

| Item | Behavior |
| --- | --- |
| Batches | Nodes write analytics batches with a monotonic sequence number to `traffic-spool.json` (0600) in the state directory, then report over the node channel (mTLS) |
| Deduplication | A lost receipt, a node restart, or a failed local receipt write resends the same sequence; the console updates the counts and the node's cursor in one transaction, so a repeated sequence is not counted twice; a node that loses its local sequence file resynchronizes from the console cursor |
| Offline queue | Up to 10,000 buckets and 32 MiB; overflow is dropped and logged |
| In-memory counts | Counts not yet moved to disk expire after 2 hours; a crash before the first persist loses in-memory counts |
| Semantics | Deduplication of retried batches, not billing-grade per-request exactly-once |
| Old nodes | Reports without a sequence number are refused; such nodes show **Upgrade required** in the admin area |

## Enable access logs

1. Open **Console → Sites**, select the site, and open the **Logs** tab.
2. Select **1%**, **10%**, or **100%** in **Access log sample rate**. The choice is saved at once and publishes a new configuration revision; the console shows **Saved**.
3. Verify: after some requests, click **Search** in the query form; records appear.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Access log sample rate | Off / 1% / 10% / 100% | Off | Share of requests recorded; the API takes an integer of 0–10000 in 1/10,000 units |

| Recorded fields | Not recorded |
| --- | --- |
| Time, client IP, method, Host, path, status, bytes sent, duration (ms), cache status, sample rate, node ID | Query strings, request headers, cookies, request and response bodies |

With **Record JA4 in access logs** on (**Security → Challenges** of the site), logs also record the JA4 TLS client fingerprint (empty over plain HTTP): the table gets a **JA4** column and the CSV a `ja4` column. Once it is off, the console stops keeping the field. JA4 format: [JA4](challenges.en.md#ja4).

With [OWASP CRS](waf.en.md) on, requests that matched rules also record the rule IDs (at most 16 per request, ascending) and whether CRS blocked them: the table gets a **CRS** column (rule IDs and a **Blocked** badge) and the CSV `wafRuleIds` (space-separated) and `wafBlocked` columns.

Rules of the configuration phase can set a sample rate for the requests they match with **Log sample rate (%)**; those logs are kept even while the site's sample rate is **Off**, see [Override settings](rules.en.md#override-settings).

Access logs need the node capability `access-logs-v1`, and JA4 also `ja4-v1`. A configuration rollback keeps the current sample rate and JA4 setting and never re-enables logging that was turned off.

## Search and export logs

1. On the **Logs** tab, enter **From** and **To**, and optionally **Status**, **Client IP**, **Path prefix**, and **Request ID**.
2. Click **Search**.
3. For a file, click **Export CSV**.

| Item | Behavior |
| --- | --- |
| Time range | Defaults to the last hour; the earliest is UTC midnight 6 days ago and the latest 5 minutes from now; the end must be after the start |
| Filters | Status: exact; client IP: exact; path: prefix; request ID: exact |
| Request ID | Each entry shows the request ID the node settled (the same as the `X-Request-Id` response header and the one on [error pages](error-pages.en.md#request-ids)), in the CSV as the `requestId` column; empty for logs of older nodes |
| Rows | The UI shows at most 100 rows ("Showing the first 100 rows. Narrow your search."); CSV holds at most 1,000 rows ("Exported the first 1,000 rows. Narrow the time range for other records.") |
| CSV | Every cell is quoted with quotes escaped; values starting with `=`, `+`, `-`, or `@` get a leading `'` so spreadsheets do not treat them as formulas |
| Permissions | Follow site ownership; tenants cannot query other organizations' sites |

## Log collection and storage

| Item | Behavior |
| --- | --- |
| Collection | Nodes report in batches of up to 1,000 over mTLS; a durable per-node cursor stops retries from writing twice |
| Node memory queue | About 2,000 entries (8 MiB); when full, new entries are dropped |
| Node disk queue | `logs-spool.json` (0600) in the state directory, up to 10,000 entries and 32 MiB; when full, the oldest unsent batches are dropped with a warning |
| Loss | A process or host crash between the end of a request and the batch reaching disk loses those entries |
| `lite` storage | PostgreSQL partitions by UTC day, keeping today and the previous 6 days; a background job maintains partitions every minute |
| `clickhouse` storage | ReplacingMergeTree with daily partitions and a 7-day TTL, deduplicated with `FINAL` at query time; when a ClickHouse write fails the batch is not acknowledged and the node retries, with no fallback to PostgreSQL |

## Use ClickHouse storage

1. In the console's `.env`, set the analytics mode and the ClickHouse password:

   ```bash title=".env"
   EDGEWEIR_ANALYTICS=clickhouse
   EDGEWEIR_CLICKHOUSE_PASSWORD=<password>
   ```

2. Start the Compose deployment with the `analytics` profile:

   ```bash
   docker compose --profile analytics up -d
   ```

3. Verify: in **Admin → System**, the **System** card shows **Analytics** `clickhouse`.

Defaults of `EDGEWEIR_CLICKHOUSE_URL`, `EDGEWEIR_CLICKHOUSE_DATABASE`, and `EDGEWEIR_CLICKHOUSE_USER` and settings for an external ClickHouse are in [Environment variables](../reference/environment.en.md).

| Item | Behavior |
| --- | --- |
| Switching | Affects new writes only; historical logs and analytics are not migrated |
| Minute analytics | Also written to the ClickHouse `minute_stats` table (ReplacingMergeTree versioned by the node batch sequence); use `FINAL` for direct analysis |
| Charts and alerts | Still use the exact PostgreSQL minute, hour, and day rollups, so both modes count the same way; sampled logs are never used as full traffic counts |
| Site deletion | The console stops authorizing queries for the site's logs at once; raw ClickHouse data expires by the 7-day TTL |

## Create an access key

1. Open **Console → Settings** and find the **Access keys** card.
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
| Scope | Read only / Read and write | Read and write | Read-only keys get 403 (`ACCESS_KEY_READ_ONLY`) on write endpoints |

Request format and endpoints are in [API and endpoints](../reference/api.en.md).

## Revoke an access key

1. In the **Access keys** card of **Console → Settings**, click **Revoke key** for the key and confirm.
2. Verify: the key shows **Revoked**; requests with it return 401.

| Item | Behavior |
| --- | --- |
| Ownership | A key belongs to its creator; the list shows only the signed-in user's keys, with scope and "Last used: …" |
| Issuing | Keys can be created only in a signed-in console session; no access key, including read-write and legacy keys, can create new keys (`ACCESS_KEY_SESSION_REQUIRED`) |
| Legacy keys | Legacy keys without a scope keep read-write access; revoke and recreate them by purpose |

## Limits

| Item | Description |
| --- | --- |
| Sample rate | The UI offers Off, 1%, 10%, and 100%; other rates through the API |
| Log retention | About 7 days in both storage modes; not configurable |
| Completeness | Access logs have bounded queues and can lose entries; they are not an audit ledger; analytics are not billing-grade counts |
| Top URLs / IPs | Estimates that can miss infrequent items |
| History migration | Switching the analytics mode migrates no history |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "No matching logs" | Sample rate off or too low; time range before retention; the node has not applied the revision that enables logs or lacks `access-logs-v1` | Check the sample rate, time range, and the node's **Applied** revision |
| "End time must be after start time" | Invalid time range | Adjust the times |
| "Showing the first 100 rows. Narrow your search." | More than 100 matches | Narrow the range, add filters, or export CSV |
| "Exported the first 1,000 rows. …" | More than 1,000 matches | Export in several ranges |
| Analytics charts are empty | The site has no traffic, or nodes are not reporting | Check node heartbeats and whether the site's domains are published |
| A node shows **Upgrade required** | The node does not support sequenced analytics reports or a capability the current configuration needs | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| "Sign in to create an access key" | The create endpoint was called with an access key | Create keys in a signed-in console session |
| "This access key is read only" | A read-only key called a write endpoint | Create a read-write key |
