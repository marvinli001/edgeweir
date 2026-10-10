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

`/api/v1` and `/rpc` are generated from the same oRPC contract in `packages/contract`. The OpenAPI document is at `/api/v1/openapi.json`, with `servers` set to `<EDGEWEIR_PUBLIC_URL>/api/v1`; "OpenAPI" in **System settings** links to it.

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

Managed in **Personal settings → Access keys** (user menu), or through `accessKeys.*` on `/rpc` with a signed-in session.

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

A service account is a machine identity for integrations calling `/api/v1`. It cannot sign in: it has no password, passkey or session, only keys. Service accounts are managed in **System settings → Service accounts**.

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
| `sites.launch` | `GET /sites/{id}/launch` | `sites:read` |
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
| `clusters.setRolloutPolicy` | `policyUpdatedAt` of the cluster's canary policy (publications and canary progress leave it alone; the `updatedAt` read then passes too while nothing has changed since) |
| `l4Apps.update`, `l4Apps.setEnabled` | The L4 app |

When a site or L4 app is already enabled or disabled as requested, `sites.setEnabled` and `l4Apps.setEnabled` return the current state without comparing `expectedUpdatedAt`.

### Enabling and disabling sites

`PUT /sites/{id}/enabled` (procedure `sites.setEnabled`) with the body `{"enabled":false}`. The operator (session or read-and-write AccessKey) and `sites:write` service accounts can call it.

- A disabled site is not shipped to nodes; nodes answer HTTP requests for its domains with 503 (`X-Edgeweir-Error: site-disabled`) and fail the TLS handshake of HTTPS requests; its DNS records stay; certificate renewal continues and HTTP-01 challenges are answered.
- A change publishes a configuration revision (reason codes `site_enabled`, `site_disabled`) and writes an audit entry (`site.enable`, `site.disable`); an unchanged state returns the current state without a revision or audit entry.
- Purging or prefetching a disabled site: 409 `SITE_DISABLED`.
- The response is `{ site, revision }`; `site.enabled` holds the current state.

### Site delivery and launch check

Sites (`sites.list`, `sites.get` and the `site` that writes return) carry `delivery`:

| Field | Description |
| --- | --- |
| `state` | `pending`: no online node runs the site; `partial`: some online nodes run an older version or have an unhealthy data plane; `live`: every online node runs the latest version; `disabled` |
| `totalNodes` | Online active nodes of the site's cluster |
| `servingNodes` | Of those, nodes whose applied configuration has the site (any version); for a disabled site, the nodes that still run it |
| `currentNodes` | Of those, nodes running the site's latest version (canary candidates included) with a healthy data plane |
| `canary` | `{ endsAt, autoPromote }` while the cluster's configuration canary keeps the nodes outside the canary on the site's previous version (when the window ends; `autoPromote: false` waits for a manual promotion), otherwise `null` |

`name` may be left out when creating a site (`POST /sites`); it defaults to the first domain (cut at 100 characters).

`GET /sites/{id}/launch` (procedure `sites.launch`) resolves each of the site's domains when called, which can take seconds:

| Field | Description |
| --- | --- |
| `addresses` | The cluster's edge addresses (values for A / AAAA records): the primary scheduling addresses of its online active nodes, the configured ones of a node that has any, otherwise the public addresses it reports; IPv4 first |
| `domains[]` | `name` (as on the site: `a.com`, `*.a.com`, `.a.com`, `~pattern`; internationalized names in Punycode), `probe` (the name resolved; a wildcard resolves the fixed name `edgeweir-check.example.com` under it), `pointing` |
| `domains[].pointing` | `ok`: every address it resolves to belongs to an active node of the cluster (configured or reported public, backup addresses and offline nodes included); `elsewhere`: some address does not; `unresolved`: no A or AAAA record; `unchecked`: a `.` suffix or pattern domain (no single host name; `probe` is empty); `unknown`: the lookup failed (a timeout, for example) or the cluster's nodes have no known address |
| `certificate` | `state`: `none` (the site has no certificate), `covered` (the chain covers every domain), `uncovered` (it misses the domains in `uncovered`), `issuing` (an ACME issuance is queued or running), `failed` (the last issuance failed, `error` holds its code), `expired`; plus `id`, `name`, `uncovered`, `error` |
| `delivery` | As above |

### Node capabilities

When a change makes the configuration need a capability that an active node of the cluster lacks (nodes report theirs in `supportedFeatures`, e.g. `challenge-v1`, `modsecurity-v1`):

| Caller | Result |
| --- | --- |
| The operator (session or AccessKey) | Saved and published; nodes lacking the capability keep their configuration and show "Upgrade required" in **Clusters & nodes** |
| Service account | 409 `NODE_CAPABILITY_REQUIRED`; `data.features` lists the missing capabilities (comma separated) and `data.nodes` the nodes lacking them (the first 5, comma separated, ending in `+N` when there are more); nothing is saved |

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
| `GET /bans` | Query parameters `scope`, `siteId`, `source` (`manual` / `auto` / `rule`), `address` (an IP or CIDR: the bans that cover it or lie inside it; 400 `BAN_INVALID_CIDR` when invalid), `page`, `pageSize` (1–100, default 50) |
| `PUT /settings/bans` | `maxTotal` (100–100000, default 10000), `shareAutoBans` (default `true`) |

Lists answer `{ items, total }` with active bans only (neither expired nor lifted), newest first. Ban fields:

| Field | Description |
| --- | --- |
| `id`, `scope`, `cidr` | `cidr` is canonical, e.g. `203.0.113.7/32` |
| `reason`, `source` | `source` is `manual`, `auto` or `rule` (bans made by rules); automatic bans have the `reason` `cc_ip_rate`, `unknown_host_scan` or `challenge_failures`, rule bans `waf_rule` or `rate_limit` |
| `siteId`, `siteName` | `null` for `platform` bans |
| `node`, `trigger` | The node `{ id, name }` and trigger `{ metric, observed, threshold, windowSeconds, ruleId? }` of an automatic or rule ban; `null` for manual bans |
| `rule` | The rule `{ id, name, platform }` of a rule ban (`name` `null` once the rule is deleted); `null` otherwise |
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
| `https.check` | `GET /sites/{id}/https/check` |
| `sites.features` | `GET /sites/{id}/features` |
| `waf.get` | `GET /sites/{id}/waf` |
| `waf.update` | `PATCH /sites/{id}/waf` |
| `waf.topRules` | `GET /sites/{id}/waf/rules` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call `GET` only.

| Request | Fields |
| --- | --- |
| `PUT /sites/{id}/https` | `settings` replaces all HTTPS settings of the site; missing fields take their defaults, so `GET` first and change what you need. Compression fields: `brotli`, `brotliLevel` (1–11, default 6), `brotliMinLength`, `brotliTypes`; `zstd`, `zstdLevel` (1–19, default 3), `zstdMinLength`, `zstdTypes`; `gzip`, `gzipMinLength`, `gzipTypes`; minimum lengths 1–1048576 (default 256), types are arrays of MIME types (up to 32) |
| `PATCH /sites/{id}/waf` | Changes only the fields given: `mode` (`off` / `detect` / `block`), `paranoiaLevel` (1–4), `anomalyThreshold` (1–1000), `exclusions` (exclusion entries, see [WAF actions, request body fields, CRS by path and verified crawlers](#waf-actions-request-body-fields-crs-by-path-and-verified-crawlers); initialization and evaluation rules 901xxx, 949xxx, 959xxx, 980xxx return 400 `WAF_RULE_NOT_EXCLUDABLE` with them in `data.ids`), `requestBodyLimit` (0–134217728 bytes) |
| `GET /sites/{id}/waf/rules` | Query parameters `range` (`1h` / `6h` / `24h` / `7d` / `30d`, default `24h`), `limit` (1–50, default 10) |
| `GET /sites/{id}/https/check` | Query parameter `ca` (`letsencrypt` / `zerossl` / `google` / `custom`, default: `defaultCa` of `GET /certificates/settings`): the CA whose CAA permission is checked |

Responses:

| Procedure | Content |
| --- | --- |
| `sites.features` | `brotli`, `zstd`, `crs`, each `{ available, reason }`; when an active node of the cluster lacks `brotli-v1` / `zstd-v1` / `modsecurity-v1`, `available` is `false` and `reason` is `nodes`; otherwise `reason` is `null` |
| `waf.get`, `waf.update` | `siteId`, the fields above, `updatedAt` (`null` until first saved, with the defaults `off`, 1, 5, `[]`, 131072) |
| `waf.topRules` | `{ approximate: true, items: [{ ruleId, requests }] }`, most matched first; detection rules only, without 901xxx, 949xxx, 959xxx, 980xxx |
| `https.check` | `request`: the request one-click HTTPS sends (`name`, `names`, `email`, `challenge`, `dnsCredentialId`); `blockers`: everything in the way, each a `code` with parameters: `nodes_offline` (`cluster`), `nodes_lack_http01` (`nodes`), `dns_not_pointing` (`name`, `pointing`: `unresolved` / `elsewhere`), `dns_credential_missing` (`names`), `dns_credential_failed` (`credential`, `error`: an API error code), `caa_forbidden` (`name`); `certificates`: issued, unexpired certificates covering every domain of the site, `{ id, name }` |

- `https.update` publishes the site's cluster (reason `certificate_updated`), audited as `site.https_update`; `waf.update` publishes (`site_waf_updated`), audited as `site.waf_update`.
- `bindSiteId` of `POST /certificates/request`: once issued, the certificate is bound to that site (`forceHttps` and the other settings unchanged), the site's cluster is published, audited as `site.https_update` (actor system); `names` must cover every domain of the site (400 `CERTIFICATE_DOMAIN_MISMATCH`), and a site has at most one such request at a time (409 `CERTIFICATE_BUSY`). A certificate's `bindSiteId` is the site's ID until it is issued, then `null`.
- A feature with `available` `false` can still be turned on through the API; see [Node capabilities](#node-capabilities).
- Unknown site: 404 `SITE_NOT_FOUND`.

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"mode":"block","paranoiaLevel":1,"exclusions":[{"ruleIds":[920350]}]}' \
  https://cdn-admin.example.com/api/v1/sites/<site ID>/waf
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  'https://cdn-admin.example.com/api/v1/sites/<site ID>/waf/rules?range=1h'
```

Behavior: [HTTPS and certificates](../guide/https.en.md#compression) and [OWASP CRS managed rules](../guide/waf.en.md).

### Purge, prefetch, origins and error pages

| Procedure | Endpoint |
| --- | --- |
| `cacheTasks.create`, `cacheTasks.get`, `cacheTasks.list` | `POST /cache-tasks`, `GET /cache-tasks/{id}`, `GET /cache-tasks` |
| `sites.purgeAll` | `POST /sites/{id}/purge`: a whole-site purge, the same as `POST /cache-tasks` with `{"type":"site","siteIds":["<site ID>"]}`; returns the task (it no longer publishes a revision or changes `cacheGeneration`) |
| `sites.update` | `PATCH /sites/{id}` (`originSettings`, `cacheSettings`) |
| `sites.originHealth` | `GET /sites/{id}/origin-health` |
| `errorPages.get` | `GET /sites/{id}/error-pages` |
| `errorPages.update` | `PUT /sites/{id}/error-pages` |
| `settings.errorPages`, `settings.setErrorPages` | `GET`, `PUT /settings/error-pages` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call only `GET`.

| Request | Fields |
| --- | --- |
| `POST /cache-tasks` | `type`: `url`, `prefix`, `site`, `prefetch`, `host`, `tag`, `sitemap`. `host`: `hosts` (up to 500 host names, without port or wildcard); `tag`: `siteIds` (1–100) and `tags` (1–500, trimmed and stored in lowercase, each 1–128 bytes of printable ASCII without commas); `sitemap`: `urls` with exactly one sitemap URL, `maxUrls` (1–10000, default 1000); `prefetch` and `sitemap`: `variants` (`desktop` / `mobile`, default `["desktop"]`) |
| `PATCH /sites/{id}` | `originSettings.activeHealthCheck`: `enabled`, `path`, `method` (`GET` / `HEAD`), `expectedStatusMin`, `expectedStatusMax`, `host`, `intervalSeconds` (5–300), `timeoutSeconds` (1–60, not above the interval), `healthyThreshold`, `unhealthyThreshold` (1–10); `originSettings.sessionAffinity`: `enabled`, `ttlSeconds` (60–604800); `originSettings.protocol` (`http1` / `http2`), `originSettings.grpc` (`true` only with `http2`, otherwise 400 `ORIGIN_GRPC_REQUIRES_HTTP2`); `cacheSettings.keepCacheTag`. Omitted, these five keep their values; the other fields of `originSettings` and `cacheSettings` are still replaced as a whole, so `GET` first |
| `POST /sites`, `PATCH /sites/{id}` | `origins[].hostHeader`: empty (the request's), or a host name or IP, optionally with a port: IPv6 with a port as `[2001:db8::1]:8443`, without a port without brackets; at most 259 bytes, no whitespace, quotes, `/`, or `\`. Values nodes refuse get 400 `ORIGIN_HOST_HEADER_INVALID`; saved values still read back |
| `PUT /sites/{id}/error-pages` | `pages`: `[{ status, template }]`, `status` one of 403, 429, 502, 503, 504, at most once each, `template` 1–65536 bytes (UTF-8); `interceptOriginErrors`; optional `expectedUpdatedAt`. Replaces everything. Templates with `{{time}}` or `{{path}}` make the configuration need the node capability `rules-v3` |
| `PUT /settings/error-pages` | `unknownHost`, `siteDisabled`: templates, an empty string meaning the built-in page, at most 65536 bytes each; with `{{time}}` or `{{path}}` the configurations of every cluster need the node capability `rules-v3` |

Responses:

| Procedure | Content |
| --- | --- |
| `cacheTasks.*` | Tasks add `variants` (`[]` for purges) and `maxUrls` (`null` except for sitemap tasks); `targets` holds the hosts, the normalized tags, or the sitemap URL; node results add the error codes `sitemap_failed` and `sitemap_empty` |
| `sites.originHealth` | Each origin's `nodes` has one entry per node and source, with `source` (`passive` / `active`); `downNodes` counts online nodes with an unhealthy entry of either source, each node once |
| `sites.features` | Adds `activeHealthCheck`, `sessionAffinity`, `originHttp2`, `errorPages`, `purgeByTag`, `prefetchVariants` |
| `errorPages.get`, `errorPages.update` | `siteId`, `pages` (sorted by status), `interceptOriginErrors`, `updatedAt` (`null` until first saved) |
| `logs.query`, `logs.export` | Query parameter `requestId` (exact, up to 128 characters); entries add `requestId`, the CSV a `requestId` column |

- `errorPages.update` publishes the site's cluster (reason `site_error_pages_updated`) and is audited as `site.error_pages_update`; `settings.setErrorPages` publishes every cluster (`error_pages_updated`) and is audited as `system.error_pages_update`.

| Error code | Status | Case |
| --- | --- | --- |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | An origin's `hostHeader` is not a host name or IP that nodes accept (see above); `data.hostHeader` |
| `CACHE_TASK_HOST_INVALID` | 400 | A host has a port or wildcard or is not a valid host name; `data.hosts` |
| `CACHE_TASK_TAG_INVALID` | 400 | A tag breaks the rules; `data.tags` |
| `CACHE_TASK_HOST_UNKNOWN` | 400 | A host, or the sitemap's host, belongs to no site; `data.hosts` |
| `NODE_CAPABILITY_REQUIRED` | 409 | Tasks: an active node of the cluster lacks `purge-tag-v1` (hosts, tags) or `prefetch-v2` (mobile, sitemaps); `data.features`, `data.nodes` |
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

### Cache zone, PURGE method, content settings and maintenance

| Procedure | Endpoint |
| --- | --- |
| `clusters.setCache` | `PUT /clusters/{id}/cache` |
| `nodes.setCache` | `PUT /nodes/{id}/cache` |
| `maintenance.get`, `maintenance.update` | `GET`, `PUT /sites/{id}/maintenance` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call only `GET`.

| Request | Fields |
| --- | --- |
| `PUT /clusters/{id}/cache` | `maxSizeGb` (1–65536), `inactiveDays` (1–90); publishes the cluster (reason `cluster_cache_updated`), audited as `cluster.cache_update` |
| `PUT /nodes/{id}/cache` | `maxSizeGb` (1–65536, `null` follows the cluster); publishes the node's cluster (`node_cache_updated`), audited as `node.cache_update` |
| `PUT /sites/{id}/maintenance` | `enabled`, `template` (0–65536 bytes, empty for the built-in maintenance page), `retryAfterSeconds` (0–86400), `allowedCidrs` (up to 64, normalized like IP list entries: IPv4-mapped prefixes are saved as IPv4, mapped prefixes under /96 are refused), `allowedPathPrefixes` (starting with `/`, without `?`, `#`, or control characters, at most 1024 bytes of UTF-8 each, up to 32), optional `expectedUpdatedAt` (409 `UPDATED_AT_MISMATCH` when it differs); publishes (`site_maintenance_updated`), audited as `site.maintenance_update` |
| `POST /sites`, `PATCH /sites/{id}` | `originSettings.tries` (1–5, default 3), `originSettings.statusRetry` (default `true`); `cacheSettings.cacheKey.query` adds `exclude`, with `queryParams` the parameters left out, a name may end in `*`; `cacheSettings.xCache` (default `true`); `cacheSettings.purgeMethod`: `{ enabled, key? }`, `key` 16–256 printable characters, write-only, omitted keeps the saved key, enabling without a key gets 400 `PURGE_KEY_REQUIRED`; `cacheRules[].cacheSetCookie` (default `false`); `contentSettings`: `charset` (`{ name, force, uppercase }`, `name` one of `off`, `utf-8`, `gbk`, `gb18030`, `gb2312`, `big5`, `iso-8859-1`, `shift_jis`, `euc-kr`), `requestBodyLimit` (bytes, 0–10737418240, default 104857600, 0 for no limit). `PATCH` keeps `xCache`, `purgeMethod`, `originSettings.tries` and `originSettings.statusRetry` when omitted |
| `PUT /sites/{id}/https` | Adds `gzipLevel` (0–9, 0 for the node default) and `compressMaxLength` (bytes, 0 for no limit) |
| `PUT /sites/{id}/error-pages` | `status` adds 400, 401, 404, 405, 410, 500, `"4xx"`, and `"5xx"`; pages add `redirectUrl` (instead of `template`, see [Redirect pages](../guide/error-pages.en.md#redirect-pages)) and `responseStatus` (200–599, 0 keeps the status; only 0 for redirect pages) |
| `PUT /sites/{id}/rules` | Configuration actions add `requestBodyLimit` (bytes, 0–10737418240) |

Responses:

| Procedure | Content |
| --- | --- |
| `clusters.list`, `clusters.get` | Add `cache: { maxSizeGb, inactiveDays }` |
| `nodes.list`, `nodes.get` | Add `cache: { maxSizeGb, usage }`: `maxSizeGb` is the node's own size (`null` follows the cluster), `usage` the last report `{ usedBytes, maxBytes, measuredAt }` (`null` until reported) |
| `sites.get` | `cacheSettings.purgeMethod` is `{ enabled, keySet }`, never the key; adds `contentSettings` |
| `sites.features` | Adds `siteContent` |
| `maintenance.get`, `maintenance.update` | `siteId`, the fields above, `updatedAt` (`null` until first saved) |
| `cacheTasks.*` | `source` adds `purge_method` (created by a PURGE request; `createdByName` is the node's name) |

Configurations that use the new fields need the node capability `site-content-v1` (a node's own cache size needs `cache-zone-v1`), see [Node capabilities](#node-capabilities). Behavior: [Origins and cache](../guide/origins-and-cache.en.md) and [Error pages](../guide/error-pages.en.md).

### Rules and bulk redirects

| Procedure | Endpoint |
| --- | --- |
| `rules.get`, `rules.save` | `GET`, `PUT /sites/{id}/rules` |
| `platformRules.get`, `platformRules.save` (global rules) | `GET`, `PUT /platform-rules` |
| `rules.validate` | `POST /rules/validate` |
| `rules.topLogged` (log rule matches) | `GET /sites/{id}/rules/logged` |
| `bulkRedirects.get` | `GET /sites/{id}/bulk-redirects` |
| `bulkRedirects.save` | `PUT /sites/{id}/bulk-redirects` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call only `GET` and `POST /rules/validate`.

| Request | Fields |
| --- | --- |
| `PUT /sites/{id}/rules`, `PUT /platform-rules` | `rules`: replaces everything, up to 64 per site and 32 for the platform; each with `id` (optional; an id that is not one of this site's or the platform's rules gets a new one, so rules read elsewhere can be saved as they are), `name` (1–100 characters), `phase`, `expression` (up to 4096 characters), `enabled` (default `false`: a rule sent without it is saved disabled), `action`. `phase`: `request-transform`, `redirect`, `config`, `waf-custom`, `ratelimit`, `cache`, `origin`, `response-transform`, `compression` |
| `action` (`kind: "redirect"`) | Exactly one of `value` (static target) and `target` (value expression); `statusCode` (301, 302, 303, 307, 308, default 301); `preserveQuery` (default `false`); `setQuery` (`[{ name, value, expression }]`, up to 16, unique names); `removeQuery` (parameter names, up to 16, none also in `setQuery`). Names `[A-Za-z0-9._~-]{1,64}`, `value` printable ASCII up to 256 characters; with an `expression` (a value expression, default `""`) the `value` is empty, and nodes percent-encode what it computes per request |
| `action` (`kind: "rewrite"`) | As `redirect` without `statusCode`; `preserveQuery` defaults to `true` |
| `action` (`kind: "request_header"`, `"response_header"`) | `header` (1–64 token characters, lowercased, not a protected header), `value` (static value, up to 4096 characters without control characters), `expression` (a value expression, default `""`; with one the `value` is empty), `remove` (default `false`; with it `value` and `expression` are empty); `response_header` also has `append` (default `false`: adds a line next to the response's lines of the same header; not together with `remove`). Nodes skip the action when the expression's value exceeds 4096 bytes or has a control character |
| `action` (`kind: "config"`) | At least one field. `cacheBypass`, `forceHttps`, `gzip` (booleans); in the `config` phase only: `brotli`, `zstd`, `websocket`, `underAttack`, `ccEnabled` (booleans), `ccMaxLevel` (`cookie302`, `js`, `pow`, `captcha`), `originConnectTimeoutMs` (100–120000), `originSendTimeoutMs`, `originReadTimeoutMs` (100–3600000), `logSampleRate` (0–10000, in 1/10,000). Omitted fields override nothing |
| `action` (`kind: "origin"`) | `origin` phase. `originGroup` (an origin group of the site, empty for the default group; always empty in global rules), `hostHeader` (as an origin's `hostHeader`, empty overrides nothing), `sni` (a host name, empty overrides nothing), `port` (0–65535, 0 overrides nothing); at least one change |
| `action` (`kind: "compression"`) | `compression` phase. `algorithms`: unique entries of `zstd`, `br`, `gzip` in preference order; `[]` turns compression off |
| `POST /sites`, `PATCH /sites/{id}` | `cacheRules[]` adds `expression` (a condition of the `cache` phase, up to 16384 characters; when empty, `pathPrefixes`, `paths`, and `extensions` build it; when set, those are empty or equal its builder form) and `browserTtlSeconds` (0–31536000, 0 keeps the origin's `Cache-Control`); `origins[]` adds `group` (`[a-z0-9_-]{0,32}`, empty for the default group, at least one origin in the default group) |
| `PUT /sites/{id}/bulk-redirects` | `redirects`: replaces everything, up to 5000, unique `source`; each with `source` (`/path` or `host/path`, 2–512 bytes without whitespace, `?`, or control characters, lowercase host), `target` (static redirect target, up to 1024 bytes), `statusCode` (default 301), `preserveQuery` (default `false`) |
| `POST /rules/validate` | `expression` (up to 16384 characters), `phase`, `kind`: `condition` (default, a rule condition), `value` (a value expression of `phase`: a redirect target, rewrite path, header value, or query parameter value), `cacheRule` (a cache rule condition; `phase` is ignored) |
| `GET /sites/{id}/rules/logged` | `range` (`1h`, `6h`, `24h` (default), `7d`, `30d`), `limit` (1–50, default 10) |

Responses:

| Procedure | Content |
| --- | --- |
| `rules.get`, `rules.save`, `platformRules.*` | The rules in saved order, with `id` |
| `rules.topLogged` | `{ approximate: true, items: [{ ruleId, name, platform, requests }], unsupportedNodes }`: requests that matched the site's **Log** rules and global **Log** rules, most first; `name` is the rule's current name, `null` once it is deleted; `platform` marks global rules; `unsupportedNodes` counts the active nodes of the site's cluster that do not report matches (no node capability `rule-log-v1`) |
| `bulkRedirects.*` | `[{ source, target, statusCode, preserveQuery }]` in saved order |
| `sites.get`; `site` of `sites.create` and `sites.update` | `cacheRules[]` always carry `expression` (`"true"` matches every request); `pathPrefixes`, `paths`, and `extensions` hold its structured form when the condition has the builder's shape and are empty otherwise; `browserTtlSeconds` is added. `origins[]` carry `group` |
| `rules.validate` | `{ valid, position, message, code?, params? }`; when invalid, `position` is the character where it fails (from 0), `message` the reason in English, `code` a stable reason code (such as `unknown_field`, `ordered_comparison`, `expected_token`) and `params` the values the reason names (such as `token` of `expected_token`) |
| `sites.features` | Adds `rulesV2` and `rulesV3`; `reason` `nodes` means an active node of the cluster lacks `rules-v2` or `rules-v3` |

- `rules.save` publishes the site's cluster (reason `rules_updated`) and is audited as `site.rules_update`; `platformRules.save` publishes every cluster and is audited as `platform.rules_update`; `bulkRedirects.save` publishes the site's cluster (`rules_updated`) and is audited as `site.bulk_redirects_update` (with the entry count).
- Configurations that use functions, the new fields, value expressions, query parameter edits, `origin` or `compression` actions, the new `config` phase fields, `gzip: true`, cache rule conditions not in the builder's shape, `browserTtlSeconds`, bulk redirects, or origin groups other than the default need the node capability `rules-v2`.
- Configurations that use the `rules-v3` fields (`http.request.cookies[…]`, `http.request.uri.args[…]`, `http.referer`, `http.user_agent`, `http.request.version`, `http.request.scheme`, `http.request.id`, `http.request.timestamp.sec`, `edge.server_port`, `ip.geoip.as_name`, `http.response.cache_status`), functions (`url_encode`, `base64_encode`, `base64_decode`, `md5`, `sha1`, `sha256`, `substring`, `to_string`), `wildcard` / `strict wildcard`, an `expression` of a header or query parameter, `append`, `statusCode: 303`, or error page templates with `{{time}}` or `{{path}}` need the node capability `rules-v3`. Bulk redirects keep the statuses 301, 302, 307, and 308.
- The `code` of `rules.validate` adds `cookie_name`, `argument_name`, and `integer_argument` (`params` `min` and `max`).

| Error code | Status | Case |
| --- | --- | --- |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | The `hostHeader` of an `origin` action is not a host name or IP that nodes accept; `data.hostHeader` |
| `RULE_INVALID` | 400 | An `origin` action picks an origin group the site does not have, or a global rule picks one; `sites.update` removes an origin group a rule still picks; a saved rule or cache rule condition no longer compiles |
| `BULK_REDIRECT_HOST_UNKNOWN` | 400 | The host of a `host/path` source is not a domain of the site (one label under a wildcard domain of the site is fine); `data.hosts` (comma-separated, up to 5) |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | A rule or cache rule condition references IP lists that do not exist; `data.lists` names them (the first 5) |
| `NODE_CAPABILITY_REQUIRED` | 409 | An active node of the cluster lacks `rules-v2` or `rules-v3` (changes by service accounts and background jobs); `data.features`, `data.nodes` |
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
- Kept 100 days by default, adjustable in **System settings → Usage** (35–400 days).

`completeUntil` (ISO 8601 or `null`): windows that end at or before it contain the data of every node that was active then.

| Rule | Notes |
| --- | --- |
| Node watermark | Once every statistics batch is acknowledged, a node reports `complete_until`: the start of the minute of its last successful statistics drain; every earlier minute has been uploaded. While the console is unreachable the node keeps draining statistics into its local spool, and before it stops it saves them, the current minute included; after the spool limit made it drop statistics, the watermark stays at the first dropped minute for 24 hours |
| Nodes taken into account | Enabled nodes with a heartbeat within the offline threshold: 60 minutes by default, adjustable in **System settings → Usage** (5–1440 minutes) |
| Computation | The lowest watermark of those nodes; a node that never reported one (older node versions) counts from its enrollment; a node more than the offline threshold behind counts as now minus the threshold (like an offline node, what it sends later is a revision); windows still waiting to be recomputed hold it back; rounded down to 5 minutes |
| Monotonic | It only moves forward. Data a node sends after being offline longer than the threshold is a revision (`revision` + 1) |
| Disabled or deleted nodes | Not taken into account |

### Clusters and overview

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `clusters.list`, `clusters.get` | `GET /clusters`, `GET /clusters/{id}` | Clusters and their summary |
| `clusters.rollout` | `GET /clusters/{id}/rollout` | Configuration canary: policy, current rollout, and canary nodes |
| `clusters.rollbackPreview` | `GET /clusters/{id}/rollback-preview` | What a rollback to the query parameter `revision` would publish; refuses like the rollback, writes nothing |
| `overview.get` | `GET /overview` | Overview: cluster, node, and site counts, recent revisions, what needs attention |
| `settings.nodeChannelCheck` | `GET /settings/node-channel-check` | The console's TLS handshake with its own node channel URL |

Service accounts with `clusters:read` call `clusters.list` and `clusters.get`; they cannot call the others (403 `SERVICE_ACCOUNT_FORBIDDEN`). All are `GET`, so read-only AccessKeys call them.

| Procedure | Response fields |
| --- | --- |
| `clusters.list`, `clusters.get` | `liveNodeCount`: online enabled nodes; `appliedNodeCount`: those of them that run their target revision (while a canary runs, the canary nodes' target is the candidate and the other nodes' the stable revision) |
| `clusters.rollout` | `candidateChanges`: while a rollout runs, `{ sites: { added, changed, removed }, reasons }`; `sites` holds the sites the candidate adds, changes, and removes against the stable revision (`[{ id, name }]`), `reasons` the revisions published after the stable one (elements as in `GET /clusters/{id}/revisions`, without repeated reasons); `null` without a running rollout |
| `clusters.rollbackPreview` | `{ revision, currentRevision, unchanged, sites: { added, changed, removed } }`: `currentRevision` is the cluster's latest revision (`null` without one); `unchanged` is `true` when the content equals the latest revision; `sites` are the changes against it |
| `overview.get` | `attention`: `[{ kind, clusterId, clusterName, revision, at, count, version }]` in the order of the `kind` list below, `[]` when nothing needs attention. `kind`: `nodes_unhealthy`, `dns_failed`, `dns_blocked`, `upgrade_failed`, `canary_rolled_back`, `canary_awaiting_promotion`, `canary_running`, `nodes_lagging`, `nodes_no_address`. `revision`: the DNS revision or the candidate; `at`: the window end of `canary_running`, the rollback time of `canary_rolled_back`; `count`: the number of nodes; `version`: the target version of `upgrade_failed`. Fields that do not apply are `null`, `0`, or empty |
| `settings.nodeChannelCheck` | `{ url, result, checkedAt }`: `url` is the node channel URL in effect; `result` is `ok` (the chain includes the node channel CA), `unreachable` (no handshake within 3 seconds), `mismatch` (another chain answered, or the URL is not `https`), or `refused` (a URL saved in system settings resolves to a special-purpose address the outbound policy does not allow; no connection is made). A result is reused for 30 seconds; advisory only |

| Error code | Status | When |
| --- | --- | --- |
| `ROLLBACK_RESOURCE_UNAVAILABLE` | 409 | `rollbackPreview` and `rollback`: a site, domain, certificate, or IP list the chosen revision references was deleted or is unavailable, or the certificate has expired |
| `REVISION_NOT_FOUND` | 404 | The cluster has no such revision |
| `CLUSTER_NOT_FOUND` | 404 | The cluster does not exist |

Behavior: [Clusters and system](../guide/system.en.md) and [Adding nodes](../deploy/nodes.en.md#node-channel-connection-check).

### Node channel URL

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `settings.nodeChannel` | `GET /settings/node-channel` | `{ url, effectiveUrl, source }`: `url` is the URL saved in system settings (an empty string when none is); `effectiveUrl` the URL install commands carry; `source` is `setting`, `environment` (`EDGEWEIR_NODE_API_URL`), or `default` |
| `settings.setNodeChannel` | `PUT /settings/node-channel` | Body `{ url }`: `https://host[:port]` without a path, query, fragment, or credentials, otherwise 400; saved as its origin. An empty string clears the saved URL. Responds like `settings.nodeChannel`. Applies at once, the node channel certificate adds the new URL's name; audited as `system.node_channel_update` |

Service accounts cannot call them (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `settings.nodeChannel` only. Enrolled nodes keep the URL they enrolled with; see [Node channel URL and certificate](../deploy/networking.en.md#node-channel-url-and-certificate).

### Node upgrades

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `upgrades.release` | `GET /node-releases/{version}` | The version's release files per architecture in the release source |
| `upgrades.latestVersion` | `GET /node-upgrades/latest-version` | `{ version }`: the latest version of the release source, `null` when it cannot be told; cached for 10 minutes |
| `upgrades.list` | `GET /node-upgrades` | Upgrades; query parameter `clusterId` |
| `upgrades.create` | `POST /node-upgrades` | `{ version, nodeGroupId }`: a leading `v` of `version` is dropped, `nodeGroupId` is the canary node group |
| `upgrades.promote` | `POST /node-upgrades/{id}/promote` | Promotes the remaining nodes |
| `upgrades.cancel` | `POST /node-upgrades/{id}/cancel` | Cancels node tasks that are "Waiting for canary" or "Pending" |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only.

| Error code | Status | When |
| --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | The release source has no readable manifest for the version, or the manifest lists no supported archive |
| `UPGRADE_NODES_UNAVAILABLE` | 409 | Active nodes of the cluster do not meet the upgrade requirements; `data.nodes` lists them (at most 10, the rest as "+N") |
| `UPGRADE_CANARY_EMPTY` | 409 | The chosen node group has no active node |
| `UPGRADE_TOO_MANY_NODES` | 409 | The cluster has more active nodes than `data.limit` (1000) |
| `UPGRADE_BUSY` | 409 | Nodes already have an unfinished upgrade, or are upgrading during cancellation; `data.nodes` lists them |
| `UPGRADE_FINISHED` | 409 | Cancelling an upgrade that has ended |
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
| Nodes returned by `nodes.*` | Add `probeEnabled`; `metrics` (`{ cpuPercent, load1, load5, load15, memoryUsedBytes, memoryTotalBytes, egressBps, activeConnections, reportedAt }`, `null` when the latest heartbeat carried none, as from nodes without `metrics-v1`); `schedulingAddresses` (`[{ address, level, source, reachable }]`, `source` is `reported` or `configured`); `schedulingLevel` (the level DNS uses now); `remoteAddress` (source address of the node's enrollment and latest heartbeat connection; a proxy's when it connects through one); `dnsIssue` (`no_public_address` without scheduling addresses, else `null`); `authError` (why the node channel refused the node's own certificate since its last heartbeat, e.g. `CERT_HAS_EXPIRED`, else `null`) |
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

### Listener ports and client IP

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `clusters.listenPorts` | `GET /clusters/{clusterId}/listen-ports` | The cluster's extra HTTP / HTTPS ports and nodes without `edge-ports-v1` |
| `clusters.setListenPorts` | `PUT /clusters/{clusterId}/listen-ports` | Replaces the extra ports and publishes a revision |
| `clusters.clientIp` | `GET /clusters/{clusterId}/client-ip` | The client IP setting and nodes without `client-ip-v1` |
| `clusters.setClientIp` | `PUT /clusters/{clusterId}/client-ip` | Replaces the client IP setting and publishes a revision |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys only the `GET` ones.

| Request | Fields |
| --- | --- |
| `PUT /clusters/{clusterId}/listen-ports` | `httpPorts`, `httpsPorts`: at most 16 ports 1–65535 each, without 80 and 443, deduplicated and sorted; a port in both is refused (`LISTEN_PORT_CONFLICT`), as is one inside a port pool (`LISTEN_PORT_IN_POOL`); removing a port sites use returns `LISTEN_PORT_IN_USE` |
| `PUT /clusters/{clusterId}/client-ip` | `settings`: `mode` (`direct` / `proxy_protocol` / `header`, default `direct`); the `header` mode requires `trustedCidrs` (1–64 IPs or CIDRs, normalized, deduplicated and sorted; no IPv4-mapped IPv6) and `header` (a lowercase header name, `[a-z0-9-]`, 1–64 characters, never a hop-by-hop header, `Host`, `Cookie`, `Authorization`, `X-Request-Id` or `X-Edgeweir-*`); `direct` takes an optional `dropForwardedFor` |

A site's ports change with `ports` (`{ http, https }`) in `PATCH /sites/{id}`, and `POST /sites` takes the same optional field (omitted: 80 and 443); sites carry `ports`. Error codes: `SITE_PORT_UNAVAILABLE`, `SITE_PORTS_EMPTY`, `SITE_HTTPS_PORT_NEEDS_CERTIFICATE`. The settings of `PUT /sites/{id}/https` add `redirectStatus` (301, 302, 303, 307, 308, default 301), `redirectPort` (443 or an HTTPS port of the site, default 443, `HTTPS_REDIRECT_PORT_INVALID`) and `redirectExcludedDomains` (domains of the site, at most 50, `HTTPS_REDIRECT_DOMAIN_INVALID`). `GET /sites/{id}/features` adds `edgePorts` and `clientIp`; clusters of `GET /clusters` add `clientIpMode`.

### Domains, unknown hosts and CNAME prefixes

A site's `domains` (`POST /sites`, `PATCH /sites/{id}`) take four forms: `a.com`, `*.a.com` (one label), `.a.com` (subdomains at any depth, not `a.com`), `~pattern` (the whole lowercase Host, at most 256 characters, lowercase letters, no `"`, `\\`, whitespace or comma outside `{n,m}`, at most two repeating quantifiers, at most 16 combinations of alternatives and optional parts; see [Domains](../guide/domains.en.md)); 1–50 domains, at most 10 patterns. Unicode host names are stored as Punycode by UTS #46 (nontransitional processing), and responses return Punycode only; a name the conversion refuses returns 400 `DOMAIN_INVALID` (`data.domain`); a malformed domain or a pattern outside the shared subset (such as a lookahead `(?=…)`) is an input validation error (400 `BAD_REQUEST`). A name in one form belongs to one site only (`DOMAIN_IN_USE`). The `search` of `sites.list` also matches a Unicode term's Punycode and part of the decoded names. Site responses add `cnamePrefix`; `GET /sites/{id}/features` adds `domainsV2` (available while every active node of the cluster reports `domains-v2`). Purge tasks find sites as nodes do: among each cluster's enabled sites by precedence; when several clusters serve a host, the task holds each cluster's site. Prefetch and sitemap prefetch tasks go only to the cluster of the site the precedence picks over every cluster's sites, disabled ones included.

| Procedure | Endpoint | Description |
| --- | --- | --- |
| `clusters.unknownHosts` | `GET /clusters/{clusterId}/unknown-hosts` | The unknown host settings, the default site (`{ id, name, enabled, certificate }` or `null`) and the nodes lacking `unknown-host-v1` |
| `clusters.setUnknownHosts` | `PUT /clusters/{clusterId}/unknown-hosts` | Replaces the unknown host settings and publishes a configuration revision (reason `unknown_hosts_updated`); audit `cluster.unknown_hosts_update` |
| `sites.setCnamePrefix` | `PUT /sites/{id}/cname-prefix` | Changes a site's CNAME prefix and returns `{ prefix, retired: [{ prefix, expiresAt }] }`; audit `site.cname_update` |
| `l4Apps.setCnamePrefix` | `PUT /l4-apps/{id}/cname-prefix` | Changes an L4 app's CNAME prefix; audit `l4.cname_update` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call `GET` only.

| Request | Fields |
| --- | --- |
| `PUT /clusters/{clusterId}/unknown-hosts` | `settings`: `unknownHost`, `ipAccess` (`page` / `close` / `site`, default `page`); `defaultSiteId` (required with `site`: an enabled site of this cluster, else `DEFAULT_SITE_INVALID`; not kept without `site`); `defaultCertificate` (only with `unknownHost` `site`; the default site needs a certificate, else `DEFAULT_SITE_CERTIFICATE_REQUIRED`); `scan`: `enabled` (default `false`), `threshold` (10–10000, default 100), `banSeconds` (60–86400, default 3600) |
| `PUT /sites/{id}/cname-prefix`, `PUT /l4-apps/{id}/cname-prefix` | `prefix`: 1–30 of `[a-z0-9-]`, not starting or ending with `-`; without it a new random prefix; or an old prefix of the object itself still in its transition. A UUID is accepted only as the object's own UUID prefix from before the upgrade while it still resolves: its current prefix (no change) or an old one still in its transition (taking it back); any other UUID (such as the id of an object created with a random prefix) returns 400 `CNAME_PREFIX_INVALID`. A prefix in use, still in its 24-hour transition, `all` / `all-<n>`, or an all-lines record or line name of a DNS binding returns 409 `CNAME_PREFIX_CONFLICT` (`data.prefix`); in Automatic mode so does a name (with **Keep per-site line targets** also `<line name>.<prefix>.<cluster domain>`) that already holds a record in the DNS provider's zone the cluster does not manage (not checked when the zone cannot be read within 15 seconds). In Automatic mode an old prefix never written to a DNS provider (the one before a switch included) gets no transition |

`GET /sites/{siteId}/cname` adds `retired` (old names `{ name, expiresAt }`); DNS revision `reason` adds `cname` (`reasonParams.name`) and `cname_expired`. The `blockers` of `GET /sites/{id}/https/check` add `no_certificate_names` (a site with pattern domains only). Automatic bans add the `reason` `unknown_host_scan` (`scope` `platform`, `siteId` `null`, `trigger.metric` `unknown_host_requests`). Node capabilities add `domains-v2` and `unknown-host-v1`.

### Several certificates, client certificates, session resumption, and ACME CAs

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `acmeAccounts.list` | `GET /acme-accounts` | ACME accounts: `{ id, directoryUrl, ca, email, eabKid, createdAt, certificates }`; `ca` is a built-in CA, `custom` (the custom directory) or `null` (another directory), `certificates` counts the certificates issued with it |
| `acmeAccounts.delete` | `DELETE /acme-accounts/{id}` | Deletes an account no certificate uses (only the account and key the console stores), audited as `acme_account.delete`; 409 `ACME_ACCOUNT_IN_USE` (`data.certificates`, at most 5) while used, 404 `ACME_ACCOUNT_NOT_FOUND` when missing |
| `settings.acmeDirectory` | `GET /settings/acme-directory` | `{ url, effectiveUrl, source, eabKid, eabHmacKeySet, caPem, caSource, caaIdentities }`: `url`, `eabKid` and `caPem` are the saved values (empty strings when none), `effectiveUrl` the directory in effect, `source` and `caSource` are `setting`, `environment` (`EDGEWEIR_ACME_DIRECTORY` / `EDGEWEIR_ACME_CA_FILE`) or `default`; for the HMAC key only whether one is saved |
| `settings.setAcmeDirectory` | `PUT /settings/acme-directory` | See below; the response is that of `settings.acmeDirectory`, audited as `system.acme_directory_update` |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can only call `GET`.

| Request | Fields |
| --- | --- |
| `PUT /settings/acme-directory` | `url`: an `https://` URL (no credentials or fragment, at most 2048), an empty string clears the saved setting; read before saving (10 seconds, at most 1 MiB), 400 `ACME_DIRECTORY_INVALID` when it is not an ACME directory, private addresses allowed. `eabKid`, `eabHmacKey`: both or neither; the saved `eabKid` alone keeps its key, another one alone is 400 `ACME_DIRECTORY_EAB_INCOMPLETE`. `caPem`: 1–10 PEM certificates (at most 64 KiB), else 400 `ACME_DIRECTORY_CA_INVALID` |
| `POST /certificates/request` | Adds `ca` (`letsencrypt` / `zerossl` / `google` / `custom`; omitted: `defaultCa` of `GET /certificates/settings`) and `keyType` (`ec256` / `rsa2048`, default `ec256`). `zerossl` and `google` need `eabKid` and `eabHmacKey`; `custom` may omit them to use the system settings' EAB; 409 `ACME_DIRECTORY_NOT_CONFIGURED` without a custom directory |
| `PUT /sites/{id}/https` | `settings` adds `additionalCertificateIds` (0–3 certificate IDs, distinct, without `certificateId`; cleared when `certificateId` is `null`) and `clientCertificate`: `mode` (`off` / `optional` / `required`, default `off`), `caPem` (at most 65536 bytes; unless `off`, 1–10 current CA certificates, else 400 `CLIENT_CA_INVALID`), `depth` (1–5, default 2), `forwardHeaders` (default `false`). Every domain of the site must be covered by one of the certificates (400 `CERTIFICATE_DOMAIN_MISMATCH`); each must be issued and unexpired (409 `CERTIFICATE_UNAVAILABLE`); client certificates together with `http3` are 400 `CLIENT_CERTIFICATE_HTTP3` |

`GET /certificates/settings` adds `acmeDirectory` (the custom directory in effect, `null` without one), `acmeDirectoryEab` (the custom directory has a saved EAB) and `defaultCa` (`letsencrypt`, or `custom` while the custom directory comes from the environment only); `ca` of `GET /sites/{id}/https/check` adds `google` and `custom` and defaults to `defaultCa`. `GET /sites/{id}/features` adds `multiCertificate` and `clientCertificate`. A certificate's `lastError` adds `acme_directory_not_configured`. Revision reasons add `session_ticket_keys_rotated`, audit actions `cluster.session_ticket_keys_rotate`. Node capabilities add `multi-certificate-v1` and `client-cert-v1`; the node channel adds `GetSessionTicketKeys`.

### Access authentication

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `authRules.get` | `GET /sites/{id}/auth-rules` | `{ siteId, rules, updatedAt }`; each rule `{ id, kind, enabled, scope, basic, forward, url }`, `kind` one of `basic`, `forward`, `url_a`–`url_d`, the parts of other kinds `null`. Basic returns user names only (`users: [{ name }]`), signed URLs only `backupKey` (whether a backup key is set); password hashes and keys are never returned |
| `authRules.update` | `PUT /sites/{id}/auth-rules` | Replaces the rules, at most 16, matched in array order; optional `expectedUpdatedAt` (409 `UPDATED_AT_MISMATCH` when stale). Publishes a revision (reason `site_auth_updated`), audits `site.auth_update` |
| `authRules.signUrl` | `POST /sites/{id}/auth-rules/{ruleId}/sign` | `{ url, validitySeconds? }` → `{ url, expiresAt }`: signed with the rule's primary key; `url` is a path starting with `/` or an `http(s)` URL of one of the site's domains; audits `site.auth_sign_url` |
| `authRules.failures` | `GET /sites/{id}/auth-rules/failures?range=` | `{ requests, unsupportedNodes }`: requests authentication refused over the range; `unsupportedNodes` counts the active nodes that do not report them (no `access-auth-v1`) |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys can call the `GET` ones only (signing is a `POST`).

| Field | Values |
| --- | --- |
| `id` | Left out for a new rule; an existing rule's ID keeps its saved passwords and keys; another site's or a repeated ID answers 404 `AUTH_RULE_NOT_FOUND` |
| `kind`, `enabled` | As above; `enabled` defaults to `true`. A rule carries only the `basic`, `forward` or `url` part of its `kind` |
| `scope` | `domains` (the site's domains as `GET /sites/{id}` writes them; others answer 400 `AUTH_DOMAIN_UNKNOWN`), `pathPrefixes` (≤ 32), `extensions` (≤ 64, no dot), `excludePathPrefixes` (≤ 32) |
| `basic` | `realm` (1–64 characters, no `"` or `\`), `keepAuthorization` (default `false`), `userHeader` (default `false`), `users`: 1–100 `{ name, password? }`; `password` 8–128 characters, left out to keep the user's saved password; a new user without one answers 400 `AUTH_PASSWORD_REQUIRED` (`data.user`) |
| `forward` | `url` (`http(s)`; IP literals are checked against the origin address policy, 400 `ORIGIN_ADDRESS_FORBIDDEN`), `method` (`GET` / `HEAD`), `timeoutMs` (100–10000, default 5000), `requestHeaders` (≤ 16, default `authorization`, `cookie`), `responseHeaders` (≤ 8), `cacheSeconds` (0–300), `passRedirects`, `allowUnavailable` |
| `url` | `validitySeconds` (1–31536000, default 1800), `skewSeconds` (0–600, default 300), `signParam`, `timeParam` (`[A-Za-z0-9_-]{1,32}`, default `sign`, `t`; different for D), `primaryKey` (16–128 printable ASCII characters, left out to keep the saved one; 400 `AUTH_KEY_REQUIRED` without one), `backupKey` (left out: kept; `null`: removed) |

Signing errors: a rule that is not a signed URL rule answers 400 `AUTH_RULE_NOT_URL`; a URL that is neither a path nor an `http(s)` URL of the site's domains 400 `AUTH_SIGN_URL_INVALID`; `validitySeconds` above the rule's validity 400 `AUTH_SIGN_VALIDITY` (`data.max`). `GET /sites/{id}/features` adds `accessAuth`. Nodes add the capability `access-auth-v1`; the node channel's `GetOriginCredentials` also returns the rules' secrets, and `ReportStats` carries `MinuteStats.auth_failures`, the refused requests.

### Access control

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `accessControl.get` | `GET /sites/{id}/access-control` | `{ siteId, siteLists, hotlink, userAgents, cors, geo, websocket, securityHeaders, updatedAt }`; a site never saved returns the defaults with `updatedAt` `null` |
| `accessControl.update` | `PATCH /sites/{id}/access-control` | Replaces the parts in the request only; accepts `expectedUpdatedAt` (409 `UPDATED_AT_MISMATCH` when it differs). Publishes a revision (reason `site_access_control_updated`), audit `site.access_control_update` |
| `ipCheck.check` | `GET /ip-check?ip=&siteId=` | `{ ip, site, lists, bans, clusters, verdict }`, see below |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys only the `GET` ones.

| Part | Fields |
| --- | --- |
| `siteLists` | `blockListIds`, `allowListIds`: IP list ids, at most 16 each; an unknown list 404 `IP_LIST_NOT_FOUND`, one list on both sides 400 `SITE_LIST_CONFLICT` (`data.lists`) |
| `hotlink` | `enabled`, `allowEmpty` (default `true`), `allowSiteDomains` (default `true`), `allowed`, `denied` (at most 200 each: `a.com`, `*.a.com`, `.a.com` or `*`), `checkOrigin`, `extensions` (at most 64, 49 common types by default), `pathPrefixes`, `excludePathPrefixes` (at most 32 each), `action` (`deny` / `redirect`), `redirectUrl` (required for `redirect`: a site path or an `http(s)` URL, at most 2048) |
| `userAgents` | `rules`: at most 200 `{ pattern, action }` (`action` `allow` / `deny`, `pattern` a `wildcard` pattern of at most 512 printable ASCII characters, possibly empty); `pathPrefixes`, `excludePathPrefixes` |
| `cors` | `enabled`, `allowedOrigins` (at most 100: `scheme://host[:port]`, `https://*.a.com` or `*`; at least one while on), `allowCredentials` (with `*`: 400 `CORS_CREDENTIALS_WILDCARD`), `allowedMethods` (1–16, 7 by default), `allowedHeaders`, `exposedHeaders` (at most 64 each), `echoRequestHeaders`, `maxAgeSeconds` (0–86400, default 600), `preflightToOrigin`, `keepOriginHeaders`, `pathPrefixes` |
| `geo` | `enabled`, `mode` (`deny` / `allow`), `countries` (two-letter codes), `subdivisions` (`CC-subdivision`), `asns` (at most 256 each; at least one entry while on), `pathPrefixes`, `exceptPathPrefixes` |
| `websocket` | `allowAllOrigins` (default `true`), `origins` (at most 100; at least one when not every origin is allowed; no `*` alone), `idleTimeoutSeconds` (60–86400, default 3600) |
| `securityHeaders` | `nosniff`, `frameOptions` (`off` / `DENY` / `SAMEORIGIN`), `referrerPolicy` (`off` or one of 8 standard values), `permissionsPolicy` (at most 1024 printable ASCII characters, empty: not set), `hideServer`, `removePoweredBy` |

The `ip` of `ipCheck.check` is an IPv4 or IPv6 address (not a CIDR: 400 `IP_ADDRESS_INVALID`); an IPv4-mapped address comes back as IPv4. `lists`: the lists holding it, `{ id, name, kind, entries, siteRole }` (`entries` the matching entries, `siteRole` `block` / `allow` / `null`); `bans`: active bans covering it (the elements of `GET /bans`; with `siteId` global bans and that site's only); `clusters`: `{ id, name, clientIp, trustedProxy, nodeAddress }`; `verdict`: with `siteId` `{ outcome, platformAllowed, siteAllowed }`, `outcome` one of `platform_banned`, `site_banned`, `platform_blocked`, `site_blocked`, `allowed`, `none`; else `null`.

`GET /sites/{id}/features` adds `accessControl`. New revision reason `site_access_control_updated` and audit action `site.access_control_update`. New node capability `access-control-v1`; the configuration adds `Site.access_control` (proto `v0.28.0`).

### WAF actions, request body fields, CRS by path and verified crawlers

Rules, CRS and protection keep the procedures above (`rules.*`, `platformRules.*`, `waf.*`, `protection.*`, `sites.update`) with these fields. Service accounts cannot call them (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys only call `GET`.

| Request | Fields |
| --- | --- |
| `action` (`kind: "ban"`) | Phase `waf-custom`. `banSeconds` (60–604800, default 3600), `banScope` (`site`, the default; `platform` for platform rules only, 400 in site rules), `banPrefixV4` (16–32, default 32), `banPrefixV6` (48–64, default 64) |
| `action` (`kind: "respond"`) | Phase `waf-custom`. `statusCode` (200, 204, 400–599, default 403), `contentType` (`text/plain` (default), `text/html`, `application/json`), `body` (≤ 8192 bytes, no control characters but tab and line breaks; empty for 204), `errorPage` (default `false`; 4xx and 5xx only, `body` empty with it) |
| `action` (`kind: "close"`) | Phase `waf-custom`, no fields |
| `action` (`kind: "skip"`) | Phase `waf-custom`. `skip`: distinct values of `rules`, `rate_limits`, `crs`, `challenges`, at least one |
| `action` (`kind: "log"`) | Adds `accessLog` (default `false`): write an access log line whatever the sample rate |
| `action` (`kind: "rate_limit"`) | Adds `banSeconds` (0 or 60–86400, default 0): ban the address over the limit |
| `action` (`kind: "config"`) | Adds `crs` (`off`, `detect`, `block`), phase `config` only |
| `PATCH /sites/{id}/waf` | `exclusions` replaces `excludedRuleIds` as a whole: at most 100 `{ path, exact, ruleIds, targets }`; `path` empty for the whole site, or starting with `/` (≤ 1024 bytes, without `?`, `#`, whitespace or control characters); `exact` (default `false`, a prefix); `ruleIds` 1–200 (900000–999999, unique; 901xxx, 949xxx, 959xxx, 980xxx return 400 `WAF_RULE_NOT_EXCLUDABLE`); `targets` ≤ 16, `ARGS:name`, `REQUEST_COOKIES:name` (1–64 of `[A-Za-z0-9_.-[]]`) or `REQUEST_HEADERS:name` (`[A-Za-z0-9-]`) |
| `PATCH /sites/{id}/protection` | Adds `allowVerifiedBots`; `challengeText` (`{ titleZh, hintZh, titleEn, hintEn }`, ≤ 200 characters each, trimmed, no control characters, empty for the built-in text; replaced as a whole); `failureBan` (`{ enabled, threshold, banSeconds }`, `threshold` 3–100, `banSeconds` 60–86400, defaults 10 and 600) |
| `POST /sites`, `PATCH /sites/{id}` | `contentSettings.rulesBodyLimit` (1024–1048576 bytes, default 65536); `PATCH` keeps it when omitted |
| `GET /bans` | `source` adds `rule` |

Responses:

| Procedure | Content |
| --- | --- |
| `rules.*`, `platformRules.*` | The action fields above, with the defaults of `ban` written out |
| `waf.get`, `waf.update` | `exclusions` in the order saved, `ruleIds` ascending, `targets` sorted, `exact` `false` without a path; `[]` until first saved |
| `protection.get`, `protection.update` | Adds `allowVerifiedBots`, `challengeText`, `failureBan` (its threshold and duration are returned while it is off too) |
| `bans.list` | `source` adds `rule` (reasons `waf_rule`, `rate_limit`), automatic bans add the reason `challenge_failures`; `trigger` adds `ruleId`; new field `rule`: `{ id, name, platform }` for bans made by rules (`name` `null` once the rule is deleted), `null` otherwise |
| `logs.query`, `logs.export` | Entries add `ruleIds`: the log rules that asked for the line (at most 8); the CSV ends with a `ruleIds` column (space separated) |
| `sites.features` | Adds `wafV2`, `rulesBody`, `challengeV2` (capabilities `waf-v2`, `rules-body-v1`, `challenge-v2`) |
| `rules.validate` | `code` adds `request_field` (request body and crawler fields only in the request phases), `form_name`, `json_path` |

- Configurations using the new actions, `accessLog`, a rate limit's `banSeconds`, the config action's `crs` or CRS exclusions with a path or targets need the node capability `waf-v2`; request body fields and `form_value`, `json_value` need `rules-body-v1`; `allowVerifiedBots`, `challengeText`, `failureBan` and `http.request.bot.*` need `challenge-v2`. Configurations without them do not change.
- Whole-site exclusions without targets reach the nodes merged into the former excluded rule ids, which older nodes run as before.
- The former `excludedRuleIds` migrated to one exclusion without a path; the API no longer accepts the field.

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"exclusions":[{"path":"/api/","ruleIds":[942100]},{"path":"/login","exact":true,"ruleIds":[941100],"targets":["ARGS:password"]}]}' \
  https://cdn-admin.example.com/api/v1/sites/<site id>/waf
```

Behaviour: [Rules](../guide/rules.en.md), [OWASP CRS managed rules](../guide/waf.en.md), [Challenges and CC protection](../guide/challenges.en.md) and [Bans](../guide/bans.en.md).

### Access log fields, retention and statistics dimensions

Logs keep `logs.*`; the system setting `settings.logRetention` / `settings.setLogRetention` and the statistics procedure `analytics.dimensions` are new. Service accounts cannot call them (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys only call `GET`.

| Request | Fields |
| --- | --- |
| `PUT /sites/{siteId}/logs/settings` | Every field optional, omitted keeps the current value: `sampleRate` (0–10000), `logBlocked`, `logQuery`, `logPeer` (booleans), `logHeaders` (≤ 8 request header names, `[A-Za-z0-9-]`, 1–64 characters, lowercased and deduplicated; `authorization`, `cookie`, `proxy-authorization` are 400) |
| `GET /sites/{siteId}/logs`, `/logs/export` | New filters (all optional, combined with "and"): `host` (exact, any case), `method`, `statusClass` (`1xx`–`5xx`), `cacheStatus` (`HIT`, `MISS`, `BYPASS`, `EXPIRED`, `STALE`, `UPDATING`, `REVALIDATED`), `blockReason` (a reason below, or `any`), `country` (ISO 3166-1 two letters), `asn` (1–4294967295), `ua`, `referer` (contains, any case, ≤ 256), `minDuration` (milliseconds), `cidr` (IPv4 or IPv6 network or a single address, host bits cleared) |
| `PUT /settings/log-retention` | `postgresDays` (1–30), `clickhouseDays` (1–90), both required; audited as `system.log_retention_update` |
| `GET /analytics/dimensions` | `range` (`1h`, `6h`, `24h`, `7d`, `30d`, default `24h`), `siteId` (optional: every site) |

Responses:

| Procedure | Content |
| --- | --- |
| `logs.settings` | Adds `retentionDays` (days the current storage keeps), `logBlocked`, `logQuery`, `logHeaders`, `logPeer` |
| `logs.query`, `logs.export` | Entries add `userAgent`, `referer` (without query and fragment), `httpVersion` (`1.0`, `1.1`, `2`, `3`), `scheme`, `country` (empty when unknown), `asn` (0 when unknown), `asName`, `upstreamAddr`, `upstreamStatus`, `upstreamMs` (empty, 0 and 0 without the origin), `requestBytes`, `contentType`, `tlsVersion` (`1.2`, `1.3`, empty on plain HTTP), `blockReason`, `blockRuleId`, and, while the site records them, `query`, `headers` (name → value), `peerIp`; the CSV ends with these columns in this order (`headers` as `name: value` joined with `; `) |
| `settings.logRetention` | `postgresDays`, `clickhouseDays`, `storage` (`lite` or `clickhouse`: which one applies) |
| `analytics.dimensions` | `countries` (`{ country, requests, bytesSent }` by requests, empty `country` is unknown), `asns` (`{ asn, name, requests }`, top 50, approximate), `referers` (`{ host, requests }`, top 50, approximate), `browsers`, `oses`, `devices`, `httpVersions`, `tlsVersions`, `blockReasons` (`{ key, requests }`), `challenges` (`{ issued, passed }`), `unsupportedNodes` (active nodes without `stats-dims-v1`; above 0 the data is partial) |
| `sites.features` | Adds `accessLogsV2` (feature `access-logs-v2`) |

`blockReason` values: `ip_banned`, `ip_blocked`, `rule`, `rate_limit`, `crs`, `cc`, `challenge`, `auth`, `referer`, `user_agent`, `region`, `cors`, `websocket_origin`, `client_cert`, `maintenance`, see [Access logs](../guide/access-logs.en.md#block-reasons). Client class keys: browsers `chrome`, `edge`, `firefox`, `safari`, `opera`, `samsung`, `uc`, `qq`, `wechat`, `yandex`, `ie`, `crawler`, `tool`, `other`; operating systems `windows`, `macos`, `ios`, `android`, `linux`, `chromeos`, `harmonyos`, `other`; devices `desktop`, `mobile`, `tablet`, `crawler`, `other`; HTTP versions `1.0`, `1.1`, `2`, `3`, `other`; TLS versions `1.2`, `1.3`, `none`, `other`.

- Configurations using any of `logBlocked`, `logQuery`, `logHeaders`, `logPeer` require node feature `access-logs-v2`; without them the configuration is unchanged.
- Statistics dimensions come from node feature `stats-dims-v1`, used only for statistics; it never holds a publish.

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"logBlocked":true,"logHeaders":["x-request-source"]}' \
  https://cdn-admin.example.com/api/v1/sites/<site id>/logs/settings
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites/<site id>/logs?from=2026-10-10T00:00:00Z&to=2026-10-10T01:00:00Z&blockReason=any&country=US"
```

See [Access logs and access keys](../guide/access-logs.en.md) and [System settings](../guide/system.en.md#access-logs).

### Port pools and L4 apps

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `clusters.portPools` | `GET /clusters/{clusterId}/port-pools` | The cluster's port pools, reserved ports, and nodes without `l4-v1` or `l4-v2` |
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
| `POST /l4-apps` | `clusterId`, `name` (1–100 characters, trimmed), `protocol` (`tcp` / `udp`), `port` (1024–65535), `origins`; optional: `portEnd` (last port of a range, above `port`, at most 1000 ports, default `null`), `originPortMode` (`fixed` / `same`, default `fixed`), `certificateId` (TCP only, the node terminates TLS, default `null`), `tlsMinimumVersion` (`1.2` / `1.3`, default `1.2`), `enabled` (default `true`), `acceptProxyProtocol` (default `false`), `proxyProtocolVersion` (0–2, 0 sends none, default 0), `maxFails` (1–100, default 3), `failTimeoutSeconds` (1–3600, default 30), `connectTimeoutMs` (100–60000, default 5000), `idleTimeoutSeconds` (1–86400; omitted: 600 for TCP, 30 for UDP), `allowListIds`, `blockListIds` (IP list IDs, at most 16 each, deduplicated, default `[]`), `maxConnections` (0–10000000), `newConnectionsPerSecond` (0–1000000); 0 means no limit for the last two, default 0 |
| `origins[]` | 1–32 `{ address, port, weight, backup }`: `address` is a host name or IP under the rules for site origins; `port` 1–65535, omitted with `originPortMode` `same` (stored as 0); `weight` 1–100, default 1; `backup` default `false`. At least one origin has `backup` `false` |
| `PATCH /l4-apps/{id}` | The fields of `POST` except `clusterId` and `enabled`, all optional; `origins` replaces the list, and origins whose address and port stay keep their ID (and with it the nodes' passive health state); changing `protocol` leaves `idleTimeoutSeconds` as it is; optional `expectedUpdatedAt` |
| `PUT /l4-apps/{id}/enabled` | `enabled`; optional `expectedUpdatedAt` |
| `GET /l4-apps/{id}/stats` | Query parameters `from` and `to` (ISO 8601), `from` before `to`, at most 7 days |

| Procedure | Response |
| --- | --- |
| `clusters.portPools`, `clusters.setPortPools` | `clusterId`; `pools` (sorted by first port, then protocol); `reservedPorts` (the ports of the cluster's HTTP / HTTPS listeners, extra ports included, never part of a pool); `nodesWithoutL4` (`[{ id, name }]`, active nodes of the cluster that do not report `l4-v1`); `nodesWithoutL4V2` (active nodes that do not report `l4-v2`) |
| The app returned by `l4Apps.list`, `l4Apps.get`, and the other procedures | `id`, `clusterId`, `clusterName`, `name`, `protocol`, `port`, `enabled`, `acceptProxyProtocol`, `proxyProtocolVersion`, `portEnd`, `originPortMode`, `certificateId`, `certificateName`, `tlsMinimumVersion`, `origins` (`[{ id, address, port, weight, backup }]`, in the saved order), `maxFails`, `failTimeoutSeconds`, `connectTimeoutMs`, `idleTimeoutSeconds`, `allowListIds`, `blockListIds`, `maxConnections`, `newConnectionsPerSecond`, `dnsTarget`, `dnsLines`, `createdAt`, `updatedAt` |
| `cnamePrefix` | The CNAME prefix: 8 random characters for new apps, the ID for apps from before the upgrade |
| `dnsTarget` | The CNAME clients connect to, `<cnamePrefix>.<cluster domain>`, published only while the app is enabled; `null` while the cluster's DNS is **Not managed** |
| `dnsLines` | Per binding line `{ name, target }`: `target` is `<line>.<cnamePrefix>.<cluster domain>` with line aliases, else `<line>.<cluster domain>` |
| `dnsRetired` | Old names still resolving within 24 hours of a prefix change, `{ name, expiresAt }` |
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
| `IP_LIST_IN_USE` | 409 | `DELETE /ip-lists/{id}` on a list a rule, a cache rule condition, or an L4 app still references; `data.users` names the first 5: rule names (site rules with the site, such as `block (shop)`), sites whose cache rules use it, and L4 app names |
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
