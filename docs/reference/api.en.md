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

`/api/v1` and `/rpc` are generated from the same oRPC contract in `packages/contract`. The OpenAPI document is at `/api/v1/openapi.json`, with `servers` set to `<EDGEWEIR_PUBLIC_URL>/api/v1`; "OpenAPI" in **Admin → System** links to it.

```bash
curl -fsS https://cdn-admin.example.com/api/v1/openapi.json
```

### Authentication

- Header `x-api-key: <AccessKey>`; AccessKeys start with `ewk_`.
- An AccessKey acts as its creator, with the creator's role and organization scope. A platform administrator's key can call Admin procedures.
- When the creator's organization requires two-factor authentication and the creator has not enabled it, tenant procedures return 403 `TWO_FACTOR_REQUIRED`.
- Invalid, revoked, or missing key: 401. Once the creator's account is disabled, requests with the creator's AccessKeys are refused.
- Each AccessKey allows up to 600 requests in a row; the count restarts when more than 60 seconds pass since the previous request. Beyond that the answer is 429 `API_KEY_RATE_LIMITED` with `data.retryAfterSeconds`. Use a service account key for continuous polling; service account keys are not counted.
- Procedures that need no key (`security: []` in OpenAPI): `GET /system/status`, `POST /system/setup`, `GET /invitations/{id}`, and `POST /invitations/{id}/accept`.

### AccessKey

Managed in **Settings → Access keys**. Each user sees and revokes only their own keys.

| Action | Where | Notes |
| --- | --- | --- |
| Create | Enter "Name" (up to 64 characters), choose "Scope", click "Create" | Default "Read and write". The key is shown once. Keys are created only from a signed-in console session; creating one through `/api/v1` returns 403 `ACCESS_KEY_SESSION_REQUIRED`. |
| View | Key list; `GET /api/v1/access-keys` | Prefix, scope, state, last use |
| Revoke | "Revoke key"; `DELETE /api/v1/access-keys/{id}` | Requests with the key return 401 afterwards; the key stays in the list marked "Revoked" |

| Scope | Callable procedures |
| --- | --- |
| Read only | `GET` procedures and `POST /rules/validate`; other methods return 403 `ACCESS_KEY_READ_ONLY` |
| Read and write | Every procedure the creator may call |

Keys from before scopes existed count as read and write. Creation and revocation are written to the audit log (`api_key.create`, `api_key.revoke`); actions performed with an AccessKey appear in the audit log with actor type `api_key`.

### Service accounts

A service account is a platform-level machine identity for integrations calling `/api/v1`. It cannot sign in: it has no password, passkey or session, only keys. Platform administrators manage service accounts in **Admin → Service accounts**.

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
| `settings.get` | `GET /settings` | `system:read` |
| `clusters.list`, `clusters.get` | `GET /clusters`, `GET /clusters/{id}` | `clusters:read` |
| `organizations.list` | `GET /organizations` | `organizations:read` |
| `organizations.create`, `organizations.update` | `POST /organizations`, `PATCH /organizations/{id}` | `organizations:write` |
| `organizations.members` | `GET /organizations/{id}/members` | `members:read` |
| `organizations.invite` | `POST /organizations/{organizationId}/invitations` | `invitations:write` |
| `sites.list`, `sites.get` | `GET /sites`, `GET /sites/{id}` | `sites:read` |
| `sites.setEnabled` | `PUT /sites/{id}/enabled` | `sites:write` |
| `admin.sites.suspend`, `admin.sites.resume` | `POST /admin/sites/{id}/suspend`, `POST /admin/sites/{id}/resume` | `sites:suspend` |
| `admin.organizations.getLimits` | `GET /admin/organizations/{id}/limits` | `limits:read` |
| `admin.organizations.setLimits` | `PUT /admin/organizations/{id}/limits` | `limits:write` |
| `usage.list`, `usage.changes` | `GET /usage`, `GET /usage/changes` | `usage:read` |

| Case | Response |
| --- | --- |
| Missing scope | 403 `SCOPE_REQUIRED`; `data.scope` names the scope |
| Procedure not in the table | 403 `SERVICE_ACCOUNT_FORBIDDEN` |
| Invalid or revoked key, disabled account | 401 |

For a service account, `GET /me` returns `serviceAccount: { id, name, scopes }`; `user` carries the service account's id and name (empty `email`, `isAdmin` `false`) and `organizations` is empty. User AccessKeys keep their read-only / read-and-write scopes.

### Idempotency keys

`POST`, `PUT` and `PATCH` on `/api/v1` accept the `Idempotency-Key` header: 1–255 printable ASCII characters, as an RFC 8941 string (`"key"`) or bare.

| Case | Response |
| --- | --- |
| First request | Runs normally; method, path (with query), request body SHA-256 and the final response are kept |
| Same caller, same key, same request | The stored response (status and body) with `Idempotent-Replayed: true` |
| Same key, other method, path or body | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| The first request is still running | 409 `IDEMPOTENCY_IN_PROGRESS` |
| Invalid key | 400 `IDEMPOTENCY_KEY_INVALID` |

- Keys are per caller: all AccessKeys of a user share them, each service account has its own.
- Records are kept 24 hours; expired ones are deleted hourly.
- 5xx responses are not kept, so the caller can retry with the same key; neither are 401 and 429 (the procedure did not run). 4xx responses are kept and replayed.
- A record still running after 10 minutes counts as interrupted (a crashed console instance); the next request takes it over and runs again.
- `GET` and `DELETE` ignore the header.

### Optimistic concurrency

These writes accept an optional `expectedUpdatedAt` (ISO 8601, the `updatedAt` the caller read). A different value returns 409 `UPDATED_AT_MISMATCH` with the current value in `data.updatedAt`.

| Procedure | `updatedAt` of |
| --- | --- |
| `sites.setEnabled`, `admin.sites.suspend`, `admin.sites.resume` | The site |
| `organizations.update` | The organization |
| `admin.organizations.setLimits` | The organization's limits (`null` until first saved; then any value differs) |
| `clusters.setRolloutPolicy` | The cluster's canary policy |

When a site already has the requested state, enabling and suspension return the current state without comparing `expectedUpdatedAt`.

### Site enabling and suspension

| State | Changed by | Endpoint |
| --- | --- | --- |
| `enabled` | Organization owners / admins, platform administrators, `sites:write` service accounts | `PUT /sites/{id}/enabled`, `{"enabled":false}` |
| `suspended` | Platform administrators, `sites:suspend` service accounts | `POST /admin/sites/{id}/suspend`, `{"reason":"billing","note":"…"}`; `POST /admin/sites/{id}/resume` |

- `reason`: `billing`, `abuse`, `security`, `other`; `note` up to 256 characters, readable by platform administrators and service accounts only.
- A site is shipped to nodes only when both states allow it. A disabled or suspended site is not shipped and nodes answer 404 for its domains; its DNS records stay; certificate renewal continues and HTTP-01 challenges are answered.
- A change publishes a configuration revision (reason codes `site_enabled`, `site_disabled`, `site_suspended`, `site_resumed`) and writes an audit entry (`site.enable`, `site.disable`, `site.suspend`, `site.resume`); an unchanged state returns the current state without a revision or audit entry.
- Purging or prefetching a disabled or suspended site: 409 `SITE_DISABLED` / `SITE_SUSPENDED`.
- The response is `{ site, revision }`; `site` carries `enabled`, `suspended`, `suspendReason`, `suspendNote`, `suspendedAt`.

### Organization limits

| Procedure | Endpoint | Caller |
| --- | --- | --- |
| `admin.organizations.getLimits` | `GET /admin/organizations/{id}/limits` | Platform administrators, `limits:read` service accounts |
| `admin.organizations.setLimits` | `PUT /admin/organizations/{id}/limits` | Platform administrators, `limits:write` service accounts |
| `organization.limits` | `GET /organization/limits` | Members of the active organization |

The response is `{ organizationId, limits, usage, updatedAt }`. Fields of `limits` and `usage`: `sites`, `domains`, `certificates`, `ipListEntries`, `purgeTasksPerMinute`, `purgeUrlsPerHour`, `members`, `bans` (active manual site bans); `null` in `limits` means no limit. `setLimits` replaces every limit (omitted fields become `null`) and writes the audit entry `organization.limits_update` with the values before and after. Exceeding a limit returns 409 `ORG_LIMIT_EXCEEDED` with `data` `{ resource, limit, current }`. Behavior: [Organizations and members](../guide/organizations.en.md#technical-limits).

### Bans

| Procedure | Endpoint | Caller |
| --- | --- | --- |
| `bans.list` | `GET /bans` | Organization members (the organization's site bans); platform administrators (every site ban) |
| `bans.create` | `POST /bans` | Organization owners and admins, platform administrators |
| `bans.delete` | `DELETE /bans/{id}` | Organization owners and admins, platform administrators; site bans only, automatic ones included |
| `admin.bans.list` | `GET /admin/bans` | Platform administrators |
| `admin.bans.create` | `POST /admin/bans` | Platform administrators |
| `admin.bans.delete` | `DELETE /admin/bans/{id}` | Platform administrators |
| `settings.bans`, `settings.setBans` | `GET`, `PUT /settings/bans` | Platform administrators |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only.

| Request | Fields |
| --- | --- |
| `POST /bans` | `siteId`, `cidr` (IP address or CIDR), `reason` (`abuse`, `attack`, `scanner`, `spam`, `other`), `durationSeconds` (60–604800) |
| `POST /admin/bans` | Also `scope` (`platform` / `site`): `site` requires `siteId`, `platform` does not allow it |
| `GET /bans` | Query parameters `siteId`, `source` (`manual` / `auto`), `page`, `pageSize` (1–100, default 50) |
| `GET /admin/bans` | Also `scope`, `organizationId` |
| `PUT /settings/bans` | `maxTotal` (100–100000, default 10000), `shareAutoBans` (default `true`) |

Lists answer `{ items, total }` with active bans only (neither expired nor lifted), newest first. Ban fields:

| Field | Description |
| --- | --- |
| `id`, `scope`, `cidr` | `cidr` is canonical, e.g. `203.0.113.7/32` |
| `reason`, `source` | `source` is `manual` or `auto`; automatic bans have the `reason` `cc_ip_rate` |
| `siteId`, `siteName`, `organizationId`, `organizationName` | `null` for platform bans |
| `node`, `trigger` | The node `{ id, name }` and trigger `{ metric, observed, threshold, windowSeconds }` of an automatic ban; `null` for manual bans |
| `createdBy` | Who created a manual ban `{ type, id, name }` |
| `createdAt`, `expiresAt` | ISO 8601 |
| `seq` | Ban change sequence (decimal string) |
| `distributed` | Whether nodes receive it; `false` for automatic bans that are not shared |
| `unappliedNodes` | Online nodes that report they could not hold the ban |

- When an active manual ban of the same scope, site and address exists, `create` sets the new `reason` and expiry and returns the same `id` (audit `ban.update`); otherwise the audit entry is `ban.create`. `delete` writes `ban.delete`.
- A node's ban state: `banStatus` of `GET /nodes/{id}` (`appliedSequence`, `entries`, `capacity`, `unappliedIds`, `unapplied`, `kernelEntries`, `autoEvicted`, `reportedAt`), `null` when the node reports none; capabilities are in `supportedFeatures` (`bans-v1`, `kernel-ban-v1`).

| Error code | Status | When |
| --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | Not an IP address or CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | Prefix shorter than `/16` (IPv4) or `/48` (IPv6); `data.min` is the minimum |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | `durationSeconds` outside 60–604800 |
| `BAN_PROTECTED_ADDRESS` | 400 | Covers a node address, loopback or an unspecified address, or overlaps a platform allow list; `data.address` is the conflicting address |
| `BAN_PLATFORM_LIMIT` | 409 | Platform limit of manual bans reached; `data.limit` |
| `BAN_NOT_FOUND` | 404 | The ban does not exist, expired, was lifted, or is outside the caller's scope |
| `ORG_LIMIT_EXCEEDED` | 409 | Organization limit reached, `data.resource` is `bans` |
| `ORG_ADMIN_REQUIRED` | 403 | A member called `create` or `delete` |

```bash
curl -fsS -X POST -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"scope":"platform","cidr":"203.0.113.0/24","reason":"attack","durationSeconds":86400}' \
  https://cdn-admin.example.com/api/v1/admin/bans
```

Behavior: [Bans](../guide/bans.en.md).

### Challenges and CC mitigation

| Procedure | Endpoint | Caller |
| --- | --- | --- |
| `protection.get` | `GET /sites/{id}/protection` | Organization members, platform administrators |
| `protection.update` | `PATCH /sites/{id}/protection` | Organization owners and admins, platform administrators |
| `security.state` | `GET /sites/{id}/security` | Organization members, platform administrators |
| `security.events` | `GET /sites/{id}/security/events` | Organization members, platform administrators |
| `settings.protection`, `settings.setProtection` | `GET`, `PUT /settings/protection` | Platform administrators |
| `settings.ccTemplate`, `settings.setCcTemplate` | `GET`, `PUT /settings/cc-template` | Platform administrators |

Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`); read-only AccessKeys call `GET` only. Challenge types and CC levels: `cookie302`, `js`, `pow`, `captcha` (levels also `normal`).

| Request | Fields |
| --- | --- |
| `PATCH /sites/{id}/protection` | Changes only the fields given: `underAttack`, `underAttackChallenge`, `passTtlSeconds` (300–86400), `powDifficulty` (8–24), `powHighDifficulty` (8–26, at least `powDifficulty`), `logJa4`, `cc` (any of its fields, merged into the saved policy) |
| `cc` | `enabled`, `followTemplate`, `maxLevel`, `highPowInsteadOfCaptcha`, `windowSeconds` (5–60), `siteQps`, `urlQps`, `ipQps` (0–1000000, 0 turns the trigger off), `ipBanSeconds` (60–86400), `originErrorPercent` (0–100), `originErrorMinRequests`, `escalateAfterSeconds` (1–3600), `cooldownSeconds` (1–86400) |
| `GET /sites/{id}/security` | Query parameter `hours` (1–168, default 24) |
| `GET /sites/{id}/security/events` | Query parameters `kind` (`site_level` / `path_level` / `ip_banned`), `page`, `pageSize` (1–100, default 50) |
| `PUT /settings/protection` | `underAttack`, `underAttackChallenge`, `eventRetentionDays` (7–365, default 30) |
| `PUT /settings/cc-template` | Every field of `cc` except `enabled` and `followTemplate` |

Responses:

| Procedure | Content |
| --- | --- |
| `protection.get`, `protection.update` | The fields above plus `siteId`, `cc` (template thresholds while it follows the template), `ccTemplate` (the platform's current template), `effectiveCc` (thresholds the nodes use, `null` while the policy is off), `platformUnderAttack`, `updatedAt` |
| `security.state` | `nodes`: `{ id, name, online, level, escalatedPaths, reportedAt }` for every active node of the cluster; `topIps`, `topPaths`: `{ value, count }` from the events of the last `hours` hours (up to 10 each, approximate); `hours` |
| `security.events` | `{ items, total }`, newest first; event fields `id`, `node` (`{ id, name }`, `null` once the node is deleted), `occurredAt`, `kind`, `level`, `previousLevel`, `path`, `address`, `metric`, `observed`, `threshold`, `topIps`, `topPaths` |

- A change publishes the site's cluster (reason `site_protection_updated`) and is audited as `site.protection_update`; a change of platform Under Attack publishes every cluster (`platform_protection_updated`), audited as `system.protection_update`; a template change publishes clusters with sites that follow it (`cc_template_updated`), audited as `system.cc_template_update`. The daily key rotation publishes `challenge_keys_rotated`.

| Error code | Status | When |
| --- | --- | --- |
| `PROTECTION_POW_DIFFICULTY` | 400 | `powHighDifficulty` is below `powDifficulty`; `data.min` is the lowest allowed value |
| `NODE_CAPABILITY_REQUIRED` | 409 | An active node of the cluster lacks `challenge-v1` or `ja4-v1` (tenant calls); `data.features` |
| `ORG_ADMIN_REQUIRED` | 403 | An organization member calls `protection.update` |
| `SITE_NOT_FOUND` | 404 | The site does not exist or is outside the caller's scope |

```bash
curl -fsS -X PATCH -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"underAttack":true,"underAttackChallenge":"pow","cc":{"enabled":true,"followTemplate":true}}' \
  https://cdn-admin.example.com/api/v1/sites/<site ID>/protection
```

Behavior: [Challenges and CC mitigation](../guide/challenges.en.md).

### Usage

One record per site and UTC 5-minute window `[windowStart, windowEnd)`, summing the minute statistics every node reported for the window.

| Procedure | Endpoint | Query parameters |
| --- | --- | --- |
| `usage.list` | `GET /usage` | `from`, `to` (5-minute aligned, UTC, half-open), `siteId`, `organizationId`, `cursor`, `limit` (1–5000, default 1000) |
| `usage.changes` | `GET /usage/changes` | `afterSeq` (default `"0"`), `limit` (1–5000, default 1000), `organizationId` |

Record fields:

| Field | Notes |
| --- | --- |
| `id` | `<siteId>.<Unix seconds of windowStart>`; always the same for a site and window |
| `siteId`, `organizationId` | Records remain after the site is deleted |
| `windowStart`, `windowEnd` | ISO 8601 |
| `requests`, `bytesSent`, `bytesReceived` | Decimal integer strings (bytes out and in), exact beyond 2^53 |
| `revision` | Starts at 1; +1 when a recomputation changes a value |
| `seq` | Globally increasing (decimal string, gaps allowed); assigned on creation and revision |
| `updatedAt` | Last write |

- `usage.list` is ordered by (window, site) and returns `{ items, nextCursor, completeUntil }`; `nextCursor` `null` means the last page. Unaligned `from` / `to`, or `to` not after `from`: 400 `USAGE_RANGE_INVALID`; an invalid cursor: 400 `USAGE_CURSOR_INVALID`.
- `usage.changes` returns records created or revised after `afterSeq`, in `seq` order, as `{ items, lastSeq, completeUntil }`; pass `lastSeq` as the next `afterSeq`. Revised records appear again.
- Windows without traffic have no record.
- Closed windows are recomputed every minute; late data that changes a value increments `revision` and assigns a new `seq`; otherwise neither changes. A statistics batch reported twice does not change the result.
- Members read their own organization's records only (`organizationId` is ignored); platform administrators and `usage:read` service accounts may filter by organization.
- Kept 100 days by default, adjustable in **Admin → System settings → Usage** (35–400 days).

`completeUntil` (ISO 8601 or `null`): windows that end at or before it contain the data of every node that was active then.

| Rule | Notes |
| --- | --- |
| Node watermark | Once every statistics batch is acknowledged, a node reports `complete_until`: the start of the minute of its last successful statistics drain; every earlier minute has been uploaded |
| Nodes taken into account | Enabled nodes with a heartbeat within the offline threshold: 60 minutes by default, adjustable in **Admin → System settings → Usage** (5–1440 minutes) |
| Computation | The lowest watermark of those nodes; a node that never reported one (older node versions) counts from its enrollment; windows still waiting to be recomputed hold it back; rounded down to 5 minutes |
| Monotonic | It only moves forward. Data a node sends after being offline longer than the threshold is a revision (`revision` + 1) |
| Disabled or deleted nodes | Not taken into account |

### Example

List sites (procedure `sites.list`, `GET /api/v1/sites`):

```bash
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites?page=1&pageSize=20"
```

| Query parameter | Description |
| --- | --- |
| `search` | Matches the site name or any of its domains; up to 100 characters |
| `clusterId` | Cluster UUID; platform administrators only |
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

Authentication and input validation failures use the generic oRPC codes `UNAUTHORIZED` (401), `FORBIDDEN` (403), and `BAD_REQUEST` (400).

## Web UI RPC

`/rpc/*` uses the oRPC RPC protocol for the web UI; the path is the procedure path, e.g. `POST /rpc/sites/list`.

| Requirement | Description |
| --- | --- |
| Session cookie | Issued by the sign-in endpoints under `/api/auth` |
| `x-csrf-token: orpc` | 403 when missing |
| `x-api-key` | Stripped; cannot replace the session cookie |

Third-party integrations use `/api/v1`.

## Authentication endpoints

better-auth handles `/api/auth/*`, limited to the paths and methods below. Matching is exact (no prefixes, encoded variants, or trailing slashes); every other request returns 404. `x-api-key` is stripped from requests; the client IP is resolved according to `EDGEWEIR_TRUSTED_PROXIES` before it reaches better-auth. There is no public sign-up; accounts are created by the setup wizard, by platform administrators, or when an invitation is accepted. With `NODE_ENV=production`, rate limiting is on, with counters in PostgreSQL.

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
| `/api/auth/api-key/create` | `POST` |
| `/api/auth/api-key/list` | `GET` |
| `/api/auth/api-key/delete` | `POST` |

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

`<project>` is `edgeweir-node` or `cosign`. Other paths, missing files, and symbolic links leading out of the directory return 404. Preparing the directory: [Adding nodes](../deploy/nodes.en.md).

## Node channel

| Item | Value |
| --- | --- |
| Protocol | Connect-RPC over HTTPS (HTTP/2, HTTP/1.1 accepted), TLS 1.2 or later |
| Listener | `NODE_API_HOST:NODE_API_PORT`, default `8443` |
| Service | `edgeweir.node.v1.NodeService`, defined in [`proto/edgeweir/node/v1/node.proto`](https://github.com/marvinli001/edgeweir/blob/master/proto/edgeweir/node/v1/node.proto) |
| Server certificate | Issued by the console's internal CA at every start; names: [Environment variables](environment.en.md#addresses-and-network) |
| Authentication | `Enroll`: a one-time enrollment token; the node pins the internal CA's SHA-256 fingerprint beforehand. Every other RPC: a client certificate issued by the internal CA (mTLS), with the node ID as CN |
| Other paths | 404 |

> [!WARNING]
> The node channel must be reached directly or through TCP passthrough; a proxy that terminates TLS breaks node mTLS. See [Ports, reverse proxy, and trusted proxies](../deploy/networking.en.md).

