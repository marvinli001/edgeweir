# API and endpoints

Console HTTP endpoints, public API authentication and error format, and a summary of the node channel.

## Endpoints

These paths are served on the web port (`PORT`, default `3000`) by `ROLE=app` and `all` only.

| Path | Authentication | Purpose |
| --- | --- | --- |
| `/api/v1/*` | `x-api-key` | Public API (OpenAPI); cookies are stripped from requests |
| `/api/v1/openapi.json` | None | OpenAPI document |
| `/rpc/*` | Session cookie + `x-csrf-token: orpc` | Web UI only (oRPC); `x-api-key` is stripped from requests |
| `/api/auth/*` | Per endpoint | Allow-listed better-auth endpoints; everything else returns 404 |
| `/healthz` | None | Health check |
| `/install.sh` | None | Node installer |
| `/downloads/*` | None | Release file mirror; 404 unless `EDGEWEIR_DOWNLOADS_DIR` is set |
| Any other path | None | Web UI |

Unmatched requests under `/api/*`, `/rpc/*`, `/downloads/*`, `/install.sh`, and `/healthz` return 404 with `{"error":"not found"}` and never fall back to the web UI.

## Public API

`/api/v1` and `/rpc` are generated from the same oRPC contract in `packages/contract`. The OpenAPI document is at `/api/v1/openapi.json`, with `servers` set to `<EDGEWEIR_PUBLIC_URL>/api/v1`; "OpenAPI" in **System** links to it.

```bash
curl -fsS https://cdn-admin.example.com/api/v1/openapi.json
```

### Authentication

- Header `x-api-key: <key>`: an AccessKey (starts with `ewk_`) or a service account key (starts with `ews_`).
- An AccessKey acts as the operator (the only account, created by the setup wizard); its scope decides which procedures it can call, see [AccessKey](#accesskey). A service account key can call only the procedures listed under [Service accounts](#service-accounts).
- Invalid, revoked, or missing key: 401.
- Each AccessKey allows up to 600 requests in a row; the count restarts when more than 60 seconds pass since the previous request. Beyond that the answer is 429 `API_KEY_RATE_LIMITED` with `data.retryAfterSeconds`. Use a service account key for continuous polling; service account keys are not counted.
- Procedures that need no key (`security: []` in OpenAPI): `GET /system/status` and `POST /system/setup`.
- `GET /me` returns the caller: `{ user: { id, name, email, twoFactorEnabled }, serviceAccount }`; with an AccessKey, `serviceAccount` is `null`.

### AccessKey

Managed in **Settings → Access keys** (user menu), or through `accessKeys.*` on `/rpc` with a signed-in session.

| Action | Where | Notes |
| --- | --- | --- |
| Create | Enter "Name" (up to 64 characters), choose "Scope", click "Create" | Default "Read and write". The key is shown once. Keys are created only from a signed-in console session; `POST /access-keys` on `/api/v1` with a key returns 403 `ACCESS_KEY_SESSION_REQUIRED`. |
| View | Key list; `GET /api/v1/access-keys` | Prefix, scope, state, last use |
| Revoke | "Revoke key"; `DELETE /api/v1/access-keys/{id}` | Requests with the key return 401 afterwards; the key stays in the list marked "Revoked" |

| Scope | Callable procedures |
| --- | --- |
| Read only | `GET` procedures and `POST /rules/validate`; other methods return 403 `ACCESS_KEY_READ_ONLY` |
| Read and write | Every procedure except creating AccessKeys |

Keys without a scope count as read and write. Creation and revocation are written to the audit log (`api_key.create`, `api_key.revoke`); actions performed with an AccessKey appear in the audit log with actor type `api_key`. better-auth's `/api/auth/api-key/*` endpoints are closed and return 404.

### Service accounts

A service account is a machine identity for integrations calling `/api/v1`. It cannot sign in: it has no password, passkey or session, only keys. Service accounts are managed on the **Service accounts** page.

| Action | Notes |
| --- | --- |
| Create, edit | Name (up to 64 characters, unique), scopes, enabled. A disabled account's keys return 401 |
| Create key | Keys start with `ews_` and are shown once; only their SHA-256 is stored. The list shows the prefix and the last use (1-minute resolution) |
| Revoke key | Requests with the key return 401 afterwards |
| Delete | Deletes every key too |

These changes are written to the audit log (`service_account.create`, `service_account.update`, `service_account.delete`, `service_account.key_create`, `service_account.key_revoke`); actions of a service account appear with actor type `service_account`. Service account keys work on `/api/v1` only.

A service account can call only the procedures below, each with its scope:

| Procedure | Endpoint | Scope |
| --- | --- | --- |
| `system.status` | `GET /system/status` | — |
| `account.me` | `GET /me` | — |
| `dns.catalog` | `GET /dns/catalog` | — |
| `settings.get` | `GET /settings` | `system:read` |
| `clusters.list`, `clusters.get` | `GET /clusters`, `GET /clusters/{id}` | `clusters:read` |
| `sites.list`, `sites.get` | `GET /sites`, `GET /sites/{id}` | `sites:read` |
| `sites.setEnabled` | `PUT /sites/{id}/enabled` | `sites:write` |
| `dns.siteTarget` | `GET /sites/{siteId}/cname` | `sites:read` |
| `usage.list`, `usage.changes` | `GET /usage`, `GET /usage/changes` | `usage:read` |

| Case | Response |
| --- | --- |
| Missing scope | 403 `SCOPE_REQUIRED`; `data.scope` names the scope |
| Procedure not in the table | 403 `SERVICE_ACCOUNT_FORBIDDEN` |
| Invalid or revoked key, disabled account | 401 |
| The change needs a capability an active node of the cluster lacks | 409 `NODE_CAPABILITY_REQUIRED`, see [Node capabilities](#node-capabilities) |

For a service account, `GET /me` returns `serviceAccount: { id, name, scopes }`; `user` carries the service account's id and name (empty `email`, `twoFactorEnabled` `false`). Scopes apply to service accounts only; AccessKeys use the read-only / read-and-write scopes.

### Idempotency keys

`POST`, `PUT` and `PATCH` on `/api/v1` accept the `Idempotency-Key` header: 1–255 printable ASCII characters, as an RFC 8941 string (`"key"`) or bare.

| Case | Response |
| --- | --- |
| First request | Runs normally; method, path (with query), request body SHA-256 and the final response are kept |
| Same caller, same key, same request | The stored response (status and body) with `Idempotent-Replayed: true` |
| Same key, other method, path or body | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| The first request is still running | 409 `IDEMPOTENCY_IN_PROGRESS` |
| Invalid key | 400 `IDEMPOTENCY_KEY_INVALID` |
| The response carries a credential shown once: `POST /access-keys`, `POST /service-accounts/{id}/keys`, `POST /enrollment-tokens`, `POST /probe-tokens` | 400 `IDEMPOTENCY_KEY_UNSUPPORTED`, nothing runs; send it again without the header |

- Keys are per caller: all AccessKeys share one set, each service account has its own.
- Records are kept 24 hours; expired ones are deleted hourly.
- 5xx responses are not kept, so the caller can retry with the same key; neither are 401 and 429 (the procedure did not run). 4xx responses are kept and replayed.
- A record still running after 10 minutes counts as interrupted (a crashed console instance); the next request takes it over and runs again.
- `GET` and `DELETE` ignore the header.

### Optimistic concurrency

These writes accept an optional `expectedUpdatedAt` (ISO 8601, the `updatedAt` the caller read). A different value returns 409 `UPDATED_AT_MISMATCH` with the current value in `data.updatedAt`.

| Procedure | `updatedAt` of |
| --- | --- |
| `sites.setEnabled` | The site |
| `clusters.setRolloutPolicy` | The cluster's canary policy |
| `l4Apps.update`, `l4Apps.setEnabled` | The L4 app |

When a site or L4 app is already enabled or disabled as requested, `sites.setEnabled` and `l4Apps.setEnabled` return the current state without comparing `expectedUpdatedAt`.

### Enabling and disabling sites

`PUT /sites/{id}/enabled` (procedure `sites.setEnabled`) with the body `{"enabled":false}`. The operator (session or read-and-write AccessKey) and `sites:write` service accounts can call it.

- A disabled site is not shipped to nodes and nodes answer 404 for its domains; its DNS records stay; certificate renewal continues and HTTP-01 challenges are answered.
- A change publishes a configuration revision (reason codes `site_enabled`, `site_disabled`) and writes an audit entry (`site.enable`, `site.disable`); an unchanged state returns the current state without a revision or audit entry.
- Purging or prefetching a disabled site: 409 `SITE_DISABLED`.
- The response is `{ site, revision }`; `site.enabled` holds the current state.

### Node capabilities

When a change makes the configuration need a capability that an active node of the cluster lacks (nodes report theirs in `supportedFeatures`, e.g. `challenge-v1`, `modsecurity-v1`):

| Caller | Result |
| --- | --- |
| The operator (session or AccessKey) | Saved and published; nodes lacking the capability keep their configuration and show "Upgrade required" in **Clusters & nodes** |
| Service account | 409 `NODE_CAPABILITY_REQUIRED`; `data.features` lists the missing capabilities (comma separated); nothing is saved |

Automatic console jobs that publish configurations are held to the same rule as service accounts. Upgrading nodes: [Node upgrades](../guide/node-upgrades.en.md).

### Bans

| Procedure | Endpoint |
| --- | --- |
| `bans.list` | `GET /bans` |
| `bans.create` | `POST /bans` |
| `bans.delete` | `DELETE /bans/{id}` |
| `settings.bans`, `settings.setBans` | `GET`, `PUT /settings/bans` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only. `scope`: `site` covers one site, `platform` covers every site (shown as "Global" in the UI).

| Request | Fields |
| --- | --- |
| `POST /bans` | `scope` (`site` / `platform`), `siteId` (required with `site`, not allowed with `platform`), `cidr` (IP address or CIDR), `reason` (`abuse`, `attack`, `scanner`, `spam`, `other`), `durationSeconds` (60–604800) |
| `GET /bans` | Query parameters `scope`, `siteId`, `source` (`manual` / `auto`), `page`, `pageSize` (1–100, default 50) |
| `PUT /settings/bans` | `maxTotal` (100–100000, default 10000), `shareAutoBans` (default `true`) |

Lists answer `{ items, total }` with active bans only (neither expired nor lifted), newest first. Ban fields:

| Field | Description |
| --- | --- |
| `id`, `scope`, `cidr` | `cidr` is canonical, e.g. `203.0.113.7/32` |
| `reason`, `source` | `source` is `manual` or `auto`; automatic bans have the `reason` `cc_ip_rate` |
| `siteId`, `siteName` | `null` for `platform` bans |
| `node`, `trigger` | The node `{ id, name }` and trigger `{ metric, observed, threshold, windowSeconds }` of an automatic ban; `null` for manual bans |
| `createdBy` | Who created a manual ban `{ type, id, name }` |
| `createdAt`, `expiresAt` | ISO 8601 |
| `seq` | Ban change sequence (decimal string) |
| `distributed` | Whether nodes receive it; `false` for automatic bans that are not shared |
| `unappliedNodes` | Online nodes that report they could not hold the ban |

- When an active manual ban of the same scope, site and address exists, `create` sets the new `reason` and expiry and returns the same `id` (audit `ban.update`); otherwise the audit entry is `ban.create`. `delete` lifts any active ban, manual or automatic, and writes `ban.delete`.
- `maxTotal` caps the active manual bans, site and global bans together; a renewal does not count as a new ban. `shareAutoBans` decides whether automatic bans reach the other nodes of the cluster. `setBans` is audited as `system.bans_update`.
- A node's ban state: `banStatus` of `GET /nodes/{id}` (`appliedSequence`, `entries`, `capacity`, `unappliedIds`, `unapplied`, `kernelEntries`, `autoEvicted`, `reportedAt`), `null` when the node reports none; capabilities are in `supportedFeatures` (`bans-v1`, `kernel-ban-v1`).

| Error code | Status | When |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | Not an IP address or CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | Prefix shorter than `/16` (IPv4) or `/48` (IPv6); `data.min` is the minimum |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` outside 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | Covers a node address, loopback or an unspecified address, or overlaps an "Allow" IP list; `data.address` is the conflicting address |
| `BAN_PLATFORM_LIMIT` | 409 | Active manual bans reached `maxTotal`; `data.limit` |
| `BAN_NOT_FOUND` | 404 | The ban does not exist, expired, or was lifted |
| `SITE_NOT_FOUND` | 404 | No site has the given `siteId` |

```bash
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"scope":"platform","cidr":"203.0.113.0/24","reason":"attack","durationSeconds":86400}' \
  https://cdn-admin.example.com/api/v1/bans
```

Behavior: [Bans](../guide/bans.en.md).

### Challenges and CC mitigation

| Procedure | Endpoint |
| --- | --- |
| `protection.get` | `GET /sites/{id}/protection` |
| `protection.update` | `PATCH /sites/{id}/protection` |
| `security.state` | `GET /sites/{id}/security` |
| `security.events` | `GET /sites/{id}/security/events` |
| `settings.protection`, `settings.setProtection` | `GET`, `PUT /settings/protection` |
| `settings.ccTemplate`, `settings.setCcTemplate` | `GET`, `PUT /settings/cc-template` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only. Challenge types and CC levels: `cookie302`, `js`, `pow`, `captcha` (levels also `normal`).

| Request | Fields |
| --- | --- |
| `PATCH /sites/{id}/protection` | Changes only the fields given: `underAttack`, `underAttackChallenge`, `passTtlSeconds` (300–86400), `powDifficulty` (8–24), `powHighDifficulty` (8–26, at least `powDifficulty`), `logJa4`, `cc` (any of its fields, merged into the saved policy) |
| `cc` | `enabled`, `followTemplate`, `maxLevel`, `highPowInsteadOfCaptcha`, `windowSeconds` (5–60), `siteQps`, `urlQps`, `ipQps` (0–1000000, 0 turns the trigger off), `ipBanSeconds` (60–86400), `originErrorPercent` (0–100), `originErrorMinRequests`, `escalateAfterSeconds` (1–3600), `cooldownSeconds` (1–86400) |
| `GET /sites/{id}/security` | Query parameter `hours` (1–168, default 24) |
| `GET /sites/{id}/security/events` | Query parameters `kind` (`site_level` / `path_level` / `ip_banned`), `page`, `pageSize` (1–100, default 50) |
| `PUT /settings/protection` | `underAttack` (global Under Attack), `underAttackChallenge`, `eventRetentionDays` (7–365, default 30) |
| `PUT /settings/cc-template` | Every field of `cc` except `enabled` and `followTemplate` |

Responses:

| Procedure | Content |
| --- | --- |
| `protection.get`, `protection.update` | The fields above plus `siteId`, `cc` (template thresholds while it follows the template), `ccTemplate` (the current CC template), `effectiveCc` (thresholds the nodes use, `null` while the policy is off), `platformUnderAttack` (whether global Under Attack is on), `updatedAt` |
| `security.state` | `nodes`: `{ id, name, online, level, escalatedPaths, reportedAt }` for every active node of the cluster; `topIps`, `topPaths`: `{ value, count }` from the events of the last `hours` hours (up to 10 each, approximate); `hours` |
| `security.events` | `{ items, total }`, newest first; event fields `id`, `node` (`{ id, name }`, `null` once the node is deleted), `occurredAt`, `kind`, `level`, `previousLevel`, `path`, `address`, `metric`, `observed`, `threshold`, `topIps`, `topPaths` |

- A change publishes the site's cluster (reason `site_protection_updated`) and is audited as `site.protection_update`; a change of global Under Attack publishes every cluster (`platform_protection_updated`), audited as `system.protection_update`; a template change publishes clusters with sites that follow it (`cc_template_updated`), audited as `system.cc_template_update`. The daily key rotation publishes `challenge_keys_rotated`.
- Challenges, Under Attack, and CC need the node capability `challenge-v1`; `logJa4` also needs `ja4-v1`. When an active node of the cluster lacks one, see [Node capabilities](#node-capabilities).

| Error code | Status | When |
| --- | --- | --- |
| `PROTECTION_POW_DIFFICULTY` | 400 | `powHighDifficulty` is below `powDifficulty`; `data.min` is the lowest allowed value |
| `SITE_NOT_FOUND` | 404 | The site does not exist |

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"underAttack":true,"underAttackChallenge":"pow","cc":{"enabled":true,"followTemplate":true}}' \
  https://cdn-admin.example.com/api/v1/sites/<site ID>/protection
```

Behavior: [Challenges and CC mitigation](../guide/challenges.en.md).

### Compression and OWASP CRS

| Procedure | Endpoint |
| --- | --- |
| `https.get`, `https.update` | `GET`, `PUT /sites/{id}/https` |
| `sites.features` | `GET /sites/{id}/features` |
| `waf.get` | `GET /sites/{id}/waf` |
| `waf.update` | `PATCH /sites/{id}/waf` |
| `waf.topRules` | `GET /sites/{id}/waf/rules` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call `GET` only.

| Request | Fields |
| --- | --- |
| `PUT /sites/{id}/https` | `settings` replaces all HTTPS settings of the site; missing fields take their defaults, so `GET` first and change what you need. Compression fields: `brotli`, `brotliLevel` (1–11, default 6), `brotliMinLength`, `brotliTypes`; `zstd`, `zstdLevel` (1–19, default 3), `zstdMinLength`, `zstdTypes`; `gzip`, `gzipMinLength`, `gzipTypes`; minimum lengths 1–1048576 (default 256), types are arrays of MIME types (up to 32) |
| `PATCH /sites/{id}/waf` | Changes only the fields given: `mode` (`off` / `detect` / `block`), `paranoiaLevel` (1–4), `anomalyThreshold` (1–1000), `excludedRuleIds` (900000–999999, unique, up to 200), `requestBodyLimit` (0–134217728 bytes) |
| `GET /sites/{id}/waf/rules` | Query parameters `range` (`1h` / `6h` / `24h` / `7d` / `30d`, default `24h`), `limit` (1–50, default 10) |

Responses:

| Procedure | Content |
| --- | --- |
| `sites.features` | `brotli`, `zstd`, `crs`, each `{ available, reason }`; when an active node of the cluster lacks `brotli-v1` / `zstd-v1` / `modsecurity-v1`, `available` is `false` and `reason` is `nodes`; otherwise `reason` is `null` |
| `waf.get`, `waf.update` | `siteId`, the fields above (`excludedRuleIds` ascending), `updatedAt` (`null` until first saved, with the defaults `off`, 1, 5, `[]`, 131072) |
| `waf.topRules` | `{ approximate: true, items: [{ ruleId, requests }] }`, most matched first |

- `https.update` publishes the site's cluster (reason `certificate_updated`), audited as `site.https_update`; `waf.update` publishes (`site_waf_updated`), audited as `site.waf_update`.
- A feature with `available` `false` can still be turned on through the API; see [Node capabilities](#node-capabilities).
- Unknown site: 404 `SITE_NOT_FOUND`.

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"mode":"block","paranoiaLevel":1,"excludedRuleIds":[920350]}' \
  https://cdn-admin.example.com/api/v1/sites/<site ID>/waf
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  'https://cdn-admin.example.com/api/v1/sites/<site ID>/waf/rules?range=1h'
```

Behavior: [HTTPS and certificates](../guide/https.en.md#compression) and [OWASP CRS managed rules](../guide/waf.en.md).

### Purge, prefetch, origins and error pages

| Procedure | Endpoint |
| --- | --- |
| `cacheTasks.create`, `cacheTasks.get`, `cacheTasks.list` | `POST /cache-tasks`, `GET /cache-tasks/{id}`, `GET /cache-tasks` |
| `sites.update` | `PATCH /sites/{id}` (`originSettings`, `cacheSettings`) |
| `sites.originHealth` | `GET /sites/{id}/origin-health` |
| `errorPages.get` | `GET /sites/{id}/error-pages` |
| `errorPages.update` | `PUT /sites/{id}/error-pages` |
| `settings.errorPages`, `settings.setErrorPages` | `GET`, `PUT /settings/error-pages` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call only `GET`.

| Request | Fields |
| --- | --- |
| `POST /cache-tasks` | `type`: `url`, `prefix`, `site`, `prefetch`, `host`, `tag`, `sitemap`. `host`: `hosts` (up to 500 host names, without port or wildcard); `tag`: `siteIds` (1–100) and `tags` (1–500, trimmed and stored in lowercase, each 1–128 bytes of printable ASCII without commas); `sitemap`: `urls` with exactly one sitemap URL, `maxUrls` (1–10000, default 1000); `prefetch` and `sitemap`: `variants` (`desktop` / `mobile`, default `["desktop"]`) |
| `PATCH /sites/{id}` | `originSettings.activeHealthCheck`: `enabled`, `path`, `method` (`GET` / `HEAD`), `expectedStatusMin`, `expectedStatusMax`, `host`, `intervalSeconds` (5–300), `timeoutSeconds` (1–60, not above the interval), `healthyThreshold`, `unhealthyThreshold` (1–10); `originSettings.sessionAffinity`: `enabled`, `ttlSeconds` (60–604800); `cacheSettings.keepCacheTag`. Omitted, these three keep their values; the other fields of `originSettings` and `cacheSettings` are still replaced as a whole, so `GET` first |
| `PUT /sites/{id}/error-pages` | `pages`: `[{ status, template }]`, `status` one of 403, 429, 502, 503, 504, at most once each, `template` 1–65536 bytes (UTF-8); `interceptOriginErrors`; optional `expectedUpdatedAt`. Replaces everything |
| `PUT /settings/error-pages` | `unknownHost`, `siteDisabled`: templates, an empty string meaning the built-in page, at most 65536 bytes each |

Responses:

| Procedure | Content |
| --- | --- |
| `cacheTasks.*` | Tasks add `variants` (`[]` for purges) and `maxUrls` (`null` except for sitemap tasks); `targets` holds the hosts, the normalized tags, or the sitemap URL; node results add the error codes `sitemap_failed` and `sitemap_empty` |
| `sites.originHealth` | Each origin's `nodes` has one entry per node and source, with `source` (`passive` / `active`); `downNodes` counts online nodes with an unhealthy entry of either source, each node once |
| `sites.features` | Adds `activeHealthCheck`, `sessionAffinity`, `errorPages`, `purgeByTag`, `prefetchVariants` |
| `errorPages.get`, `errorPages.update` | `siteId`, `pages` (sorted by status), `interceptOriginErrors`, `updatedAt` (`null` until first saved) |
| `logs.query`, `logs.export` | Query parameter `requestId` (exact, up to 128 characters); entries add `requestId`, the CSV a `requestId` column |

- `errorPages.update` publishes the site's cluster (reason `site_error_pages_updated`) and is audited as `site.error_pages_update`; `settings.setErrorPages` publishes every cluster (`error_pages_updated`) and is audited as `system.error_pages_update`.

| Error code | Status | Case |
| --- | --- | --- |
| `CACHE_TASK_HOST_INVALID` | 400 | A host has a port or wildcard or is not a valid host name; `data.hosts` |
| `CACHE_TASK_TAG_INVALID` | 400 | A tag breaks the rules; `data.tags` |
| `CACHE_TASK_HOST_UNKNOWN` | 400 | A host, or the sitemap's host, belongs to no site; `data.hosts` |
| `NODE_CAPABILITY_REQUIRED` | 409 | Tasks: an active node of the cluster lacks `purge-tag-v1` (hosts, tags) or `prefetch-v2` (mobile, sitemaps); `data.features` |
| `ERROR_PAGE_TOO_LARGE` | 400 | A template exceeds 65536 bytes; `data.status`, `data.limit` (`status` 404 or 503 for platform templates) |

```bash
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"tag","siteIds":["<site ID>"],"tags":["product-42"]}' \
  https://cdn-admin.example.com/api/v1/cache-tasks
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"type":"sitemap","urls":["https://www.example.com/sitemap.xml"],"maxUrls":2000,"variants":["desktop","mobile"]}' \
  https://cdn-admin.example.com/api/v1/cache-tasks
```

Behavior: [Origins and cache](../guide/origins-and-cache.en.md) and [Error pages](../guide/error-pages.en.md).

### Rules and bulk redirects

| Procedure | Endpoint |
| --- | --- |
| `rules.get`, `rules.save` | `GET`, `PUT /sites/{id}/rules` |
| `platformRules.get`, `platformRules.save` (global rules) | `GET`, `PUT /platform-rules` |
| `rules.validate` | `POST /rules/validate` |
| `bulkRedirects.get` | `GET /sites/{id}/bulk-redirects` |
| `bulkRedirects.save` | `PUT /sites/{id}/bulk-redirects` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call only `GET` and `POST /rules/validate`.

| Request | Fields |
| --- | --- |
| `PUT /sites/{id}/rules`, `PUT /platform-rules` | `rules`: replaces everything, up to 64 per site and 32 for the platform; each with `id` (optional; an id that is not one of this site's or the platform's rules gets a new one, so rules read elsewhere can be saved as they are), `name` (1–100 characters), `phase`, `expression` (up to 4096 characters), `enabled`, `action`. `phase`: `request-transform`, `redirect`, `config`, `waf-custom`, `ratelimit`, `cache`, `origin`, `response-transform`, `compression` |
| `action` (`kind: "redirect"`) | Exactly one of `value` (static target) and `target` (value expression); `statusCode` (301, 302, 307, 308, default 301); `preserveQuery` (default `false`); `setQuery` (`[{ name, value }]`, up to 16, unique names); `removeQuery` (parameter names, up to 16, none also in `setQuery`). Names `[A-Za-z0-9._~-]{1,64}`, values printable ASCII up to 256 characters |
| `action` (`kind: "rewrite"`) | As `redirect` without `statusCode`; `preserveQuery` defaults to `true` |
| `action` (`kind: "config"`) | At least one field. `cacheBypass`, `forceHttps`, `gzip` (booleans); in the `config` phase only: `brotli`, `zstd`, `websocket`, `underAttack`, `ccEnabled` (booleans), `ccMaxLevel` (`cookie302`, `js`, `pow`, `captcha`), `originConnectTimeoutMs` (100–120000), `originSendTimeoutMs`, `originReadTimeoutMs` (100–3600000), `logSampleRate` (0–10000, in 1/10,000). Omitted fields override nothing |
| `action` (`kind: "origin"`) | `origin` phase. `originGroup` (an origin group of the site, empty for the default group; always empty in global rules), `hostHeader`, `sni` (host names, empty overrides nothing), `port` (0–65535, 0 overrides nothing); at least one change |
| `action` (`kind: "compression"`) | `compression` phase. `algorithms`: unique entries of `zstd`, `br`, `gzip` in preference order; `[]` turns compression off |
| `POST /sites`, `PATCH /sites/{id}` | `cacheRules[]` adds `expression` (a condition of the `cache` phase, up to 16384 characters; when empty, `pathPrefixes`, `paths`, and `extensions` build it; when set, those are empty or equal its builder form) and `browserTtlSeconds` (0–31536000, 0 keeps the origin's `Cache-Control`); `origins[]` adds `group` (`[a-z0-9_-]{0,32}`, empty for the default group, at least one origin in the default group) |
| `PUT /sites/{id}/bulk-redirects` | `redirects`: replaces everything, up to 5000, unique `source`; each with `source` (`/path` or `host/path`, 2–512 bytes without whitespace, `?`, or control characters, lowercase host), `target` (static redirect target, up to 1024 bytes), `statusCode` (default 301), `preserveQuery` (default `false`) |
| `POST /rules/validate` | `expression` (up to 16384 characters), `phase`, `kind`: `condition` (default, a rule condition), `value` (a redirect target or rewrite path of `phase`), `cacheRule` (a cache rule condition; `phase` is ignored) |

Responses:

| Procedure | Content |
| --- | --- |
| `rules.*`, `platformRules.*` | The rules in saved order, with `id` |
| `bulkRedirects.*` | `[{ source, target, statusCode, preserveQuery }]` in saved order |
| `sites.get`; `site` of `sites.create` and `sites.update` | `cacheRules[]` always carry `expression` (`"true"` matches every request); `pathPrefixes`, `paths`, and `extensions` hold its structured form when the condition has the builder's shape and are empty otherwise; `browserTtlSeconds` is added. `origins[]` carry `group` |
| `rules.validate` | `{ valid, position, message }`; when invalid, `position` is the character where it fails and `message` is `invalid_expression` |
| `sites.features` | Adds `rulesV2`; `reason` `nodes` means an active node of the cluster lacks `rules-v2` |

- `rules.save` publishes the site's cluster (reason `rules_updated`) and is audited as `site.rules_update`; `platformRules.save` publishes every cluster and is audited as `platform.rules_update`; `bulkRedirects.save` publishes the site's cluster (`rules_updated`) and is audited as `site.bulk_redirects_update` (with the entry count).
- Configurations that use functions, the new fields, value expressions, query parameter edits, `origin` or `compression` actions, the new `config` phase fields, `gzip: true`, cache rule conditions not in the builder's shape, `browserTtlSeconds`, bulk redirects, or origin groups other than the default need the node capability `rules-v2`.

| Error code | Status | Case |
| --- | --- | --- |
| `RULE_INVALID` | 400 | An `origin` action picks an origin group the site does not have, or a global rule picks one; `sites.update` removes an origin group a rule still picks; a saved rule or cache rule condition no longer compiles |
| `BULK_REDIRECT_HOST_UNKNOWN` | 400 | The host of a `host/path` source is not a domain of the site (one label under a wildcard domain of the site is fine); `data.hosts` (comma-separated, up to 5) |
| `IP_LIST_NOT_FOUND` | 404 | A rule or cache rule condition references an IP list that does not exist or is not visible |
| `NODE_CAPABILITY_REQUIRED` | 409 | An active node of the cluster lacks `rules-v2` (changes by service accounts and background jobs); `data.features` |
| `SITE_NOT_FOUND` | 404 | The site does not exist or is outside the caller's scope |

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"redirects":[{"source":"/old","target":"/new","statusCode":301,"preserveQuery":true}]}' \
  https://cdn-admin.example.com/api/v1/sites/<site ID>/bulk-redirects
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"expression":"regex_replace(http.request.uri.path, \"^/old/\", \"/new/\")","phase":"redirect","kind":"value"}' \
  https://cdn-admin.example.com/api/v1/rules/validate
```

Behavior: [Rules, IP lists, and GeoIP](../guide/rules.en.md) and [Origins and cache](../guide/origins-and-cache.en.md#origin-groups).

### Usage

One record per site and UTC 5-minute window `[windowStart, windowEnd)`, summing the minute statistics every node reported for the window.

| Procedure | Endpoint | Query parameters |
| --- | --- | --- |
| `usage.list` | `GET /usage` | `from`, `to` (5-minute aligned, UTC, half-open), `siteId`, `cursor`, `limit` (1–5000, default 1000) |
| `usage.changes` | `GET /usage/changes` | `afterSeq` (default `"0"`), `limit` (1–5000, default 1000) |

Record fields:

| Field | Notes |
| --- | --- |
| `id` | `<siteId>.<Unix seconds of windowStart>`; always the same for a site and window |
| `siteId` | Records remain after the site is deleted |
| `windowStart`, `windowEnd` | ISO 8601 |
| `requests`, `bytesSent`, `bytesReceived` | Decimal integer strings (bytes out and in), exact beyond 2^53 |
| `revision` | Starts at 1; +1 when a recomputation changes a value |
| `seq` | Globally increasing (decimal string, gaps allowed); assigned on creation and revision |
| `updatedAt` | Last write |

- `usage.list` is ordered by (window, site) and returns `{ items, nextCursor, completeUntil }`; `nextCursor` `null` means the last page. Unaligned `from` / `to`, or `to` not after `from`: 400 `USAGE_RANGE_INVALID`; an invalid cursor: 400 `USAGE_CURSOR_INVALID`.
- `usage.changes` returns records created or revised after `afterSeq`, in `seq` order, as `{ items, lastSeq, completeUntil }`; pass `lastSeq` as the next `afterSeq`. Revised records appear again.
- Windows without traffic have no record.
- Closed windows are recomputed every minute; late data that changes a value increments `revision` and assigns a new `seq`; otherwise neither changes. A statistics batch reported twice does not change the result.
- Kept 100 days by default, adjustable in **System → Usage** (35–400 days).

`completeUntil` (ISO 8601 or `null`): windows that end at or before it contain the data of every node that was active then.

| Rule | Notes |
| --- | --- |
| Node watermark | Once every statistics batch is acknowledged, a node reports `complete_until`: the start of the minute of its last successful statistics drain; every earlier minute has been uploaded. While the console is unreachable the node keeps draining statistics into its local spool, and before it stops it saves them, the current minute included; after the spool limit made it drop statistics, the watermark stays at the first dropped minute for 24 hours |
| Nodes taken into account | Enabled nodes with a heartbeat within the offline threshold: 60 minutes by default, adjustable in **System → Usage** (5–1440 minutes) |
| Computation | The lowest watermark of those nodes; a node that never reported one (older node versions) counts from its enrollment; a node more than the offline threshold behind counts as now minus the threshold (like an offline node, what it sends later is a revision); windows still waiting to be recomputed hold it back; rounded down to 5 minutes |
| Monotonic | It only moves forward. Data a node sends after being offline longer than the threshold is a revision (`revision` + 1) |
| Disabled or deleted nodes | Not taken into account |

### Node upgrades

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `upgrades.release` | `GET /node-releases/{version}` | The version's release files per architecture in the release source |
| `upgrades.list` | `GET /node-upgrades` | Upgrades; query parameter `clusterId` |
| `upgrades.create` | `POST /node-upgrades` | `{ version, nodeGroupId }`: `version` without the `v` prefix, `nodeGroupId` is the canary node group |
| `upgrades.promote` | `POST /node-upgrades/{id}/promote` | Promotes the remaining nodes |
| `upgrades.cancel` | `POST /node-upgrades/{id}/cancel` | Cancels node tasks that are "Waiting for canary" or "Pending" |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only.

| Error code | Status | When |
| --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | The release source has no readable manifest for the version, or the manifest lists no supported archive |
| `UPGRADE_NODES_UNAVAILABLE` | 409 | The chosen node group has no enabled node, or an enabled node of the cluster does not meet the upgrade requirements |
| `UPGRADE_BUSY` | 409 | A node already has an active upgrade; on cancel, a node is upgrading or the upgrade has finished |
| `UPGRADE_NOT_READY` | 409 | The canary group does not meet the promotion condition yet |
| `UPGRADE_NOT_FOUND` | 404 | The upgrade does not exist |

Requirements, states, and node-side verification: [Node upgrades](../guide/node-upgrades.en.md).

### Regional probes, scheduling addresses, and scheduling

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `probes.list` | `GET /probes` | Every probe |
| `probes.createToken` | `POST /probe-tokens` | A one-time probe enrollment token |
| `probes.update` | `PATCH /probes/{id}` | Renames, disables, or enables a probe |
| `probes.delete` | `DELETE /probes/{id}` | Deletes a probe and revokes its certificate |
| `probes.results` | `GET /probe-results` | Latest probe results |
| `settings.probes`, `settings.setProbes` | `GET`, `PUT /settings/probes` | Probe settings |
| `nodes.setAddresses` | `PUT /nodes/{id}/addresses` | A node's scheduling addresses and levels |
| `nodes.setProbe` | `PUT /nodes/{id}/probe` | Lets a node also probe |
| `scheduling.list` | `GET /scheduling/rules` | Scheduling rules; query parameter `clusterId` (optional) |
| `scheduling.create` | `POST /scheduling/rules` | Creates a rule, returns 201 |
| `scheduling.update` | `PATCH /scheduling/rules/{id}` | Changes only the given fields |
| `scheduling.delete` | `DELETE /scheduling/rules/{id}` | Deletes a rule; its actions in effect end |
| `scheduling.preview` | `GET /clusters/{clusterId}/scheduling/preview` | Every rule under the current metrics; writes nothing |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only. `POST /probe-tokens` refuses an `Idempotency-Key` (see [Idempotency keys](#idempotency-keys)).

| Request | Fields |
| --- | --- |
| `POST /probe-tokens` | `name` (1–64 characters), `regionId`, `ttlMinutes` (5–10080, default 60) |
| `PATCH /probes/{id}` | `name` (1–64 characters), `enabled`, both optional. Disabling deletes the probe's results |
| `GET /probe-results` | Query parameters `probeId` (a probe ID, or the ID of a node that also probes) and `nodeId` (the measured node), both optional |
| `PUT /settings/probes` | Replaces the settings: `intervalSeconds` (5–60), `timeoutMs` (500–10000, at most `intervalSeconds × 1000`), `attempts` (1–10), `lossPercent` (1–100), `ipDownSeconds`, `ipUpSeconds` (5–3600) |
| `PUT /nodes/{id}/addresses` | `addresses`: replaces the list, at most 8 `{ address, level }`; `address` is a single unicast IP (private allowed), no duplicates; `level` is 0 (primary), 1 (backup 1), or 2 (backup 2), and a non-empty list needs a `level` 0; `[]` goes back to the reported addresses. Publishes the cluster's DNS revision (reason `manual`) |
| `PUT /nodes/{id}/probe` | `enabled`; turning it off deletes the node's probe results |
| `POST /scheduling/rules` | `clusterId`, `lineName` (a line name of the cluster's DNS binding, `null` for every line, default `null`; required by `backup_group`), `name` (1–100 characters), `enabled` (default `true`), `match` (`all` by default / `any`), `conditions`, `action` (`remove_node`, `backup_group`, `backup_ip`), `holdSeconds`, `recoverSeconds` (0–86400, default 300) |
| `conditions[]` | 1–8 of: `metric` (`cpu_percent`, `load1`, `memory_percent`, `egress_mbps`, `connections`, `probe_loss_percent`, `probe_latency_ms`), `aggregate` (`avg` by default / `max` / `min`), `comparator` (`gt`, `ge`, `lt`, `le`), `threshold` (0–10¹²), `durationSeconds` (0–3600, default 0), `regionId` (only for `probe_loss_percent` and `probe_latency_ms`, default `null`) |
| `PATCH /scheduling/rules/{id}` | The fields of `POST` except `clusterId`, all optional. `enabled: false`, or a different `lineName`, `match`, `action`, or `conditions`, ends the actions in effect first and the states start over; changing only `name`, `holdSeconds`, or `recoverSeconds` does not. `lineName` is checked only when `lineName` or `action` changes |

| Procedure | Response |
| --- | --- |
| `probes.list`, `probes.update` | Probe: `id`, `name`, `regionId`, `regionName`, `regionCode`, `enabled`, `online`, `lastSeenAt`, `enrolledAt`, `hostname`, `agentVersion`, `os`, `arch`, `certNotAfter`, `targets`, `lastRound` (`{ checkedAt, results, failed, lossPercent, avgRttMs }`, `null` without results), `createdAt` |
| `probes.createToken` | `tokenId`, `token` (`ewp_…`, returned once), `expiresAt`, `serverUrl` (node channel), `caSha256`, `command` (the `docker run` start command) |
| `probes.delete`, `scheduling.delete` | `{ ok: true }` |
| `probes.results` | Sorted by node, address, port, and prober, at most 5000: `proberKind` (`probe` / `node`), `proberId`, `proberName`, `regionId`, `regionName`, `nodeId`, `nodeName`, `address`, `port`, `method` (`tcp` / `http` / `https`), `sent`, `lost`, `lossPercent`, `rttMs` (median of successful attempts, 0 when all were lost), `error` (`timeout`, `refused`, `reset`, `tls`, `status`, `unreachable`), `checkedAt` |
| `settings.probes`, `settings.setProbes` | The probe settings; the defaults 10, 3000, 3, 50, 30, 60 until saved |
| Nodes returned by `nodes.*` | Add `probeEnabled`; `metrics` (`{ cpuPercent, load1, load5, load15, memoryUsedBytes, memoryTotalBytes, egressBps, activeConnections, reportedAt }`, `null` when the latest heartbeat carried none, as from nodes without `metrics-v1`); `schedulingAddresses` (`[{ address, level, source, reachable }]`, `source` is `reported` or `configured`); `schedulingLevel` (the level DNS uses now) |
| `scheduling.list`, `scheduling.create`, `scheduling.update` | Rule: `id`, `clusterId`, the request fields (conditions with defaults filled in), `activeNodes` (`[{ nodeId, nodeName, since }]`, nodes in `active` or `recovering`), `createdAt`, `updatedAt` |
| `scheduling.preview` | `{ clusterId, evaluatedAt, rules }`. Per rule: `ruleId`, `ruleName`, `enabled`, `lineName`, `match`, `action`, `nodes`. Per node: `nodeId`, `nodeName`, `state` (`idle`, `pending`, `active`, `recovering`), `conditions` (the condition fields plus `value` (`null` without data), `holds`, `heldSeconds`, `satisfied`), `matches`, `inEffect`, `wouldActivate`, `wouldRecover`, `activeSince`, `recoveringSince`, `recoversAt` |

New fields of DNS bindings and records:

| Request or response | Fields |
| --- | --- |
| `binding.lines[]` of `PUT /clusters/{clusterId}/dns` | Add `resolutionLine` (`default` by default, `telecom`, `unicom`, `mobile`, `edu`, `overseas`), `backupNodeGroupIds` (node groups of this cluster, at most 4, no duplicates, not the line's own group, default `[]`), `minHealthyIps` (1–64, default 1). `GET` returns the defaults for lines saved before |
| `records[]` of `GET /clusters/{clusterId}/dns` and `GET /clusters/{clusterId}/dns/export` | Add `line`: the record's resolution line; absent on default-line records |
| DNS revisions (`revision`, `blocked`, `GET /clusters/{clusterId}/dns/revisions`, …) | `reason` is `manual`, `health`, `rollback`, `force`, or `scheduling`; add `reasonParams`: for `scheduling`, `ruleId`, `rule`, `nodeId`, `node`, `action`, and `event` (`activated` / `recovered`); `{}` for the other reasons |
| `GET /dns/catalog` | `capabilities.lines` changes from a boolean to the array of resolution lines the provider supports |

| Error code | Status | When |
| --- | --- | --- |
| `DNS_LINE_UNSUPPORTED` | 400 | A binding line's `resolutionLine` is not among the lines of the account's provider; `data.line` |
| `REGION_IN_USE` | 409 | Deleting a region that still has probes (`regions.delete`); `data.probes` is the probe count |
| `PROBE_NOT_FOUND` | 404 | The probe does not exist; `probeId` of `probes.results` is neither a probe nor a node |
| `NODE_REGION_REQUIRED` | 409 | `nodes.setProbe` turns probing on while the node's node group has no region |
| `NODE_ADDRESS_INVALID` | 400 | A scheduling address is not a single unicast IP (a CIDR, a host name, loopback, link-local, multicast, …) or is a duplicate; `data.address` |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | The rule does not exist |
| `SCHEDULING_RULE_INVALID` | 400 | `backup_group` without `lineName`, or a `lineName` missing from the cluster's DNS binding |
| `REGION_NOT_FOUND` | 404 | The `regionId` of `probes.createToken` or of a condition does not exist |
| `NODE_NOT_FOUND` | 404 | The node does not exist, including `nodeId` of `probes.results` |
| `CLUSTER_NOT_FOUND` | 404 | The cluster of a rule or preview does not exist |
| `BAD_REQUEST` | 400 | Input validation, for example `timeoutMs` longer than the interval, scheduling addresses without a `level` 0, or `regionId` on a node metric |

Behavior: [Regional probes and scheduling](../guide/scheduling.en.md) and [DNS steering and alerts](../guide/dns-and-alerts.en.md#records-per-resolution-line).

### Port pools and L4 apps

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `clusters.portPools` | `GET /clusters/{clusterId}/port-pools` | The cluster's port pools, reserved ports, and nodes without `l4-v1` |
| `clusters.setPortPools` | `PUT /clusters/{clusterId}/port-pools` | Replaces the port pools; publishes no configuration revision |
| `l4Apps.list` | `GET /l4-apps` | L4 apps sorted by port and protocol; query parameter `clusterId` (optional) |
| `l4Apps.get` | `GET /l4-apps/{id}` | One app |
| `l4Apps.create` | `POST /l4-apps` | Creates an app, returns 201 |
| `l4Apps.update` | `PATCH /l4-apps/{id}` | Changes only the given fields |
| `l4Apps.setEnabled` | `PUT /l4-apps/{id}/enabled` | Disables or enables an app |
| `l4Apps.delete` | `DELETE /l4-apps/{id}` | Deletes an app with its origins and statistics |
| `l4Apps.stats` | `GET /l4-apps/{id}/stats` | Per-minute statistics |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only.

| Request | Fields |
| --- | --- |
| `PUT /clusters/{clusterId}/port-pools` | `pools`: replaces the list, at most 64 `{ protocol, from, to }`; `protocol` is `tcp`, `udp`, or `both`, `from` and `to` are 1024–65535, `from` not above `to` |
| `POST /l4-apps` | `clusterId`, `name` (1–100 characters, trimmed), `protocol` (`tcp` / `udp`), `port` (1024–65535), `origins`; optional: `enabled` (default `true`), `acceptProxyProtocol` (default `false`), `proxyProtocolVersion` (0–2, 0 sends none, default 0), `maxFails` (1–100, default 3), `failTimeoutSeconds` (1–3600, default 30), `connectTimeoutMs` (100–60000, default 5000), `idleTimeoutSeconds` (1–86400; omitted: 600 for TCP, 30 for UDP), `allowListIds`, `blockListIds` (IP list IDs, at most 16 each, deduplicated, default `[]`), `maxConnections` (0–10000000), `newConnectionsPerSecond` (0–1000000); 0 means no limit for the last two, default 0 |
| `origins[]` | 1–32 `{ address, port, weight, backup }`: `address` is a host name or IP under the rules for site origins; `port` 1–65535; `weight` 1–100, default 1; `backup` default `false`. At least one origin has `backup` `false` |
| `PATCH /l4-apps/{id}` | The fields of `POST` except `clusterId` and `enabled`, all optional; `origins` replaces the list, and origins whose address and port stay keep their ID (and with it the nodes' passive health state); changing `protocol` leaves `idleTimeoutSeconds` as it is; optional `expectedUpdatedAt` |
| `PUT /l4-apps/{id}/enabled` | `enabled`; optional `expectedUpdatedAt` |
| `GET /l4-apps/{id}/stats` | Query parameters `from` and `to` (ISO 8601), `from` before `to`, at most 7 days |

| Procedure | Response |
| --- | --- |
| `clusters.portPools`, `clusters.setPortPools` | `clusterId`; `pools` (sorted by first port, then protocol); `reservedPorts` (the ports of the cluster's HTTP / HTTPS listeners, never part of a pool); `nodesWithoutL4` (`[{ id, name }]`, active nodes of the cluster that do not report `l4-v1`) |
| The app returned by `l4Apps.list`, `l4Apps.get`, and the other procedures | `id`, `clusterId`, `clusterName`, `name`, `protocol`, `port`, `enabled`, `acceptProxyProtocol`, `proxyProtocolVersion`, `origins` (`[{ id, address, port, weight, backup }]`, in the saved order), `maxFails`, `failTimeoutSeconds`, `connectTimeoutMs`, `idleTimeoutSeconds`, `allowListIds`, `blockListIds`, `maxConnections`, `newConnectionsPerSecond`, `dnsTarget`, `dnsLines`, `createdAt`, `updatedAt` |
| `dnsTarget` | The CNAME clients connect to, `<app ID>.<cluster domain>`, published only while the app is enabled; `null` while the cluster's DNS is **Not managed** |
| `dnsLines` | Per binding line `{ name, target }`: `target` is `<line>.<app ID>.<cluster domain>` with line aliases, else `<line>.<cluster domain>` |
| `l4Apps.create`, `l4Apps.update`, `l4Apps.setEnabled` | `{ app, revision }` |
| `l4Apps.delete` | `{ revision }` |
| `l4Apps.stats` | `appId`, `from`, `to`; `bucketSeconds`: 60 for ranges up to a day, 300 up to five days, else 3600; `points`: one per bucket from the bucket of `from`, oldest first, empty buckets zero; `totals`; `nodes`: every reporting node `{ nodeId, nodeName, … }`, busiest first |
| Statistics counters | `connections` (connections or UDP sessions accepted), `refused` (refused by the IP lists or limits), `peakConcurrent`, `bytesReceived` (from clients), `bytesSent` (to clients). In `points` and `totals`, `peakConcurrent` is the highest per-minute sum of the nodes' peaks in the bucket or range; in `nodes` it is the node's own highest value |

- `create` and `update` publish the cluster's configuration revision (reasons `l4_app_created`, `l4_app_updated`) and audit `l4_app.create`, `l4_app.update`; `setEnabled` publishes when the state changes (`l4_app_updated`) and audits `l4_app.enable` or `l4_app.disable`, and returns the latest revision without publishing or auditing when it does not; `delete` publishes (`l4_app_deleted`) and audits `l4_app.delete`. `setPortPools` audits `cluster.port_pools_update`.
- A configuration with an enabled app needs the node capability `l4-v1`, see [Node capabilities](#node-capabilities).

| Error code | Status | When |
| --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | The app does not exist |
| `L4_APP_LIMIT` | 409 | The cluster has 256 apps (disabled ones included); `data.limit` |
| `L4_PORT_OUTSIDE_POOL` | 400 | The port is outside the cluster's port pools for the protocol; `data.port` |
| `L4_PORT_IN_USE` | 409 | Another app of the cluster (disabled ones included) uses the port and protocol, or the new pools would leave an app's port outside; `data.apps` (`name (port/protocol)`, comma-separated) |
| `L4_PORT_RESERVED` | 400 | A pool or an app port is a port of the cluster's HTTP / HTTPS listeners; `data.port` |
| `L4_PORT_POOL_OVERLAP` | 400 | Pools of one protocol overlap, and `both` overlaps `tcp` and `udp`; `data.pools` (`from-to/protocol`, comma-separated) |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` | 400 | A UDP app with `acceptProxyProtocol` or a non-zero `proxyProtocolVersion` |
| `IP_LIST_NOT_FOUND` | 404 | A list of `allowListIds` or `blockListIds` does not exist |
| `IP_LIST_IN_USE` | 409 | `DELETE /ip-lists/{id}` on a list a rule, a cache rule condition, or an L4 app still references |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | An origin is a special-purpose address outside the origin allow list; `data.address`, `data.range` |
| `UPDATED_AT_MISMATCH` | 409 | `expectedUpdatedAt` is not the current value |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |
| `BAD_REQUEST` | 400 | Input validation, for example a port below 1024, `from` above `to`, only backup origins, or a statistics range over 7 days |

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"pools":[{"protocol":"both","from":20000,"to":20100}]}' \
  https://cdn-admin.example.com/api/v1/clusters/<cluster ID>/port-pools
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"clusterId":"<cluster ID>","name":"game","protocol":"tcp","port":20000,"origins":[{"address":"game-origin.example.com","port":7000}],"proxyProtocolVersion":2}' \
  https://cdn-admin.example.com/api/v1/l4-apps
```

Behavior: [Layer-4 forwarding](../guide/l4.en.md).

### Example

List sites (procedure `sites.list`, `GET /api/v1/sites`):

```bash
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites?page=1&pageSize=20"
```

| Query parameter | Description |
| --- | --- |
| `search` | Matches the site name or any of its domains; up to 100 characters |
| `clusterId` | Cluster UUID |
| `page` | Page number, default `1` |
| `pageSize` | Items per page, 1–100, default `20` |

Response: `{"items":[…],"total":<count>}`.

### Error format

```json
{
  "defined": false,
  "code": "ACCESS_KEY_READ_ONLY",
  "status": 403,
  "message": "access key is read only",
  "data": {}
}
```

| Field | Description |
| --- | --- |
| `code` | Stable error code. Full list of codes and HTTP statuses: [`packages/contract/src/errors.ts`](https://github.com/marvinli001/edgeweir/blob/master/packages/contract/src/errors.ts) |
| `status` | HTTP status code |
| `message` | English text for clients that do not know the code |
| `data` | Message parameters |

Authentication and input validation failures use the generic oRPC codes `UNAUTHORIZED` (401) and `BAD_REQUEST` (400).

## Web UI RPC

`/rpc/*` uses the oRPC RPC protocol for the web UI; the path is the procedure path, e.g. `POST /rpc/sites/list`.

| Requirement | Description |
| --- | --- |
| Session cookie | Issued by the sign-in endpoints under `/api/auth` |
| `x-csrf-token: orpc` | 403 when missing |
| `x-api-key` | Stripped; cannot replace the session cookie |

Third-party integrations use `/api/v1`.

## Authentication endpoints

better-auth handles `/api/auth/*`, limited to the paths and methods below. Matching is exact (no prefixes, encoded variants, or trailing slashes); every other request returns 404. `x-api-key` is stripped from requests; the client IP is resolved according to `EDGEWEIR_TRUSTED_PROXIES` before it reaches better-auth. There is no public sign-up: the setup wizard creates the only account. AccessKeys are managed through `accessKeys.*`. With `NODE_ENV=production`, rate limiting is on, with counters in PostgreSQL.

| Path | Method |
| --- | --- |
| `/api/auth/get-session` | `GET` |
| `/api/auth/sign-in/email` | `POST` |
| `/api/auth/sign-out` | `POST` |
| `/api/auth/change-password` | `POST` |
| `/api/auth/two-factor/enable` | `POST` |
| `/api/auth/two-factor/disable` | `POST` |
| `/api/auth/two-factor/verify-totp` | `POST` |
| `/api/auth/two-factor/verify-backup-code` | `POST` |
| `/api/auth/passkey/generate-register-options` | `GET` |
| `/api/auth/passkey/verify-registration` | `POST` |
| `/api/auth/passkey/generate-authenticate-options` | `GET` |
| `/api/auth/passkey/verify-authentication` | `POST` |
| `/api/auth/passkey/list-user-passkeys` | `GET` |
| `/api/auth/passkey/delete-passkey` | `POST` |

## Health check

`GET /healthz` returns 200:

```json
{ "status": "ok", "version": "20260929-a1b2c3d" }
```

| Field | Description |
| --- | --- |
| `status` | Always `ok` |
| `version` | Running version (`EDGEWEIR_VERSION`); `dev` from source |

The response comes from the listening HTTP server; the database is not checked. Container health check: [Command line](cli.en.md#container).

## Installer and release mirror

`GET /install.sh` returns the node installer (`text/x-shellscript`, `cache-control: no-store`) with the console URL replaced by `EDGEWEIR_PUBLIC_URL`. Options: [Command line](cli.en.md#node-installer).

`GET` and `HEAD` on `/downloads/*` serve files from `EDGEWEIR_DOWNLOADS_DIR`; the URL path equals the relative path in the directory:

| Path | Content | `cache-control` |
| --- | --- | --- |
| `/downloads/<project>/latest` | Latest version number, text | `no-cache` |
| `/downloads/<project>/v<semver>/<file>` | Release file | `public, max-age=86400, immutable` |

`<project>` is `edgeweir-node` or `cosign`; the `edgeweir-openresty` and `edgeweir-openresty-modsecurity` packages go into the same version directory as `edgeweir-node`. Other paths, missing files, and symbolic links leading out of the directory return 404. Preparing the directory: [Adding nodes](../deploy/nodes.en.md).

## Node channel

| Item | Value |
| --- | --- |
| Protocol | Connect-RPC over HTTPS (HTTP/2, HTTP/1.1 accepted), TLS 1.2 or later |
| Listener | `NODE_API_HOST:NODE_API_PORT`, default `8443` |
| Services | `edgeweir.node.v1.NodeService` (nodes) and `edgeweir.node.v1.ProbeService` (regional probes and nodes that also probe), defined in [`proto/edgeweir/node/v1/node.proto`](https://github.com/marvinli001/edgeweir/blob/master/proto/edgeweir/node/v1/node.proto) and [`probe.proto`](https://github.com/marvinli001/edgeweir/blob/master/proto/edgeweir/node/v1/probe.proto) |
| Server certificate | Issued by the console's internal CA at every start; names: [Environment variables](environment.en.md#addresses-and-network) |
| Authentication | `Enroll`, `EnrollProbe`: a one-time enrollment token (`ewt_`, `ewp_`); the node or probe pins the internal CA's SHA-256 fingerprint beforehand. Every other RPC: a client certificate issued by the internal CA (mTLS), with the node ID (`O=Edgeweir Node`) or probe ID (`O=Edgeweir Probe`) as CN; probe certificates call `ProbeService` only, node certificates call `GetProbeTargets` and `ReportProbeResults` only while the node also probes |
| Other paths | 404 |

> [!WARNING]
> The node channel must be reached directly or through TCP passthrough; a proxy that terminates TLS breaks node mTLS. See [Ports, reverse proxy, and trusted proxies](../deploy/networking.en.md).
