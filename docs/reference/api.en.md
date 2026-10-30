# API overview

Console HTTP endpoints and the public API's authentication, access levels, request format, idempotency, concurrency control and pagination.

## Endpoints

These paths are on the web port (`PORT`, default `3000`), served by `ROLE=app` and `all` only.

| Path | Authentication | Purpose |
| --- | --- | --- |
| `/api/v1/*` | `x-api-key` | Public API (OpenAPI); cookies in the request are stripped |
| `/api/v1/openapi.json` | None | OpenAPI document |
| `/rpc/*` | Session cookie + `x-csrf-token: orpc` | Web UI only (oRPC RPC protocol); `x-api-key` in the request is stripped |
| `/api/auth/*` | Per endpoint | Endpoints on the better-auth allow list; see [Authentication endpoints](#authentication-endpoints) |
| `/healthz` | None | Health check |
| `/install.sh` | None | Node installer |
| `/downloads/*` | None | Release file mirror; 404 without `EDGEWEIR_DOWNLOADS_DIR` |
| `/node-channel` | Node channel mTLS | WebSocket entry of the node channel; a plain request answers 426 while it is open, 404 while it is closed |
| Any other path | None | Web UI |

Unmatched requests under `/api/*`, `/rpc/*`, `/downloads/*`, `/install.sh`, `/healthz` and `/node-channel` return 404 with `{"error":"not found"}` and never fall back to the web UI. Every response without its own `cache-control` carries `cache-control: no-store`.

## Resources

`/api/v1` and `/rpc` come from the same oRPC contract in `packages/contract`: 275 procedures.

| Page | Resources | Procedures |
| --- | --- | --- |
| [Sites](api/sites.en.md) | Sites, enabling and disabling sites, tags and batch operations, copying and cloning, cache tasks, error pages and maintenance, access authentication, access control, image format conversion, usage protection, automatic mitigation | 51 |
| [Access control](api/security.en.md) | Site rules, platform rules, bulk redirects, IP lists, IP check, bans, greylist, challenges and CC mitigation, OWASP CRS | 32 |
| [Certificates](api/certificates.en.md) | Certificates, ACME accounts, DNS credentials, origin client CA, Origin CA, origin certificates | 28 |
| [Clusters and nodes](api/clusters.en.md) | Clusters, revisions and canary, cluster network settings, enrollment tokens, node groups, nodes, node logs, regions, node upgrades, port pools and L4 apps | 60 |
| [DNS and scheduling](api/dns.en.md) | DNS providers, DNS bindings and records, DNS revisions and reconciliation, regional probes, scheduling rules | 28 |
| [Overview, analytics and alerts](api/monitoring.en.md) | Overview, analytics, access logs, usage, audit log, alerts | 29 |
| [System and account](api/system.en.md) | Setup and status, account, AccessKeys, service accounts, system settings | 47 |

## OpenAPI document

`GET /api/v1/openapi.json` returns the OpenAPI document: `info.version` is the console version, `servers` is `<EDGEWEIR_PUBLIC_URL>/api/v1`, security scheme `apiKey` (header `x-api-key`). "OpenAPI" in **System settings** links to it.

```bash
curl -fsS https://cdn-admin.example.com/api/v1/openapi.json
```

## Authentication

| Credential | Prefix | Where | Identity |
| --- | --- | --- | --- |
| AccessKey | `ewk_` | `/api/v1`, header `x-api-key` | The operator (the only account, created by the setup wizard); audit actor type `api_key` |
| Service account key | `ews_` | `/api/v1`, header `x-api-key` | The service account; audit actor type `service_account` |
| Session cookie | — | `/rpc`, plus header `x-csrf-token: orpc` | The signed-in account; audit actor type `user` |

- No credential, or an invalid, revoked or expired key, or a disabled service account: 401 `UNAUTHORIZED`.
- Procedures without credentials (`security: []` in OpenAPI): `system.status` (`GET /system/status`), `system.setup` (`POST /system/setup`).
- `GET /me` (`account.me`) returns the caller; see [System and account](api/system.en.md#accountme).
- AccessKeys are created and changed only in a signed-in session (`accessKeys.create`, `accessKeys.update`); through `/api/v1` they answer 403 `ACCESS_KEY_SESSION_REQUIRED`.
- The login IP allow list limits sessions (`/rpc`, `/api/auth`) only, not keys on `/api/v1`.

### AccessKey

AccessKeys are managed in the "Access keys" card of **Personal settings** (user menu), or with `accessKeys.*` over `/rpc` in a signed-in session.

| Property | Value |
| --- | --- |
| Scope | "Read only" or "Read and write" (default read and write); see [Access](#access) |
| Requests per minute | Default 600, 1–100000, or unlimited; see [Rate limits](#rate-limits) |
| Key | Starts with `ewk_`, shown once at creation |
| Revoking | Requests with a revoked key answer 401; the key stays listed |
| Audit | `api_key.create`, `api_key.update`, `api_key.revoke` |

Procedures and fields: [System and account](api/system.en.md#accesskey). better-auth's `/api/auth/api-key/*` endpoints are closed and answer 404.

## Access

| Level | Procedures | Callers |
| --- | --- | --- |
| Read | Every `GET` procedure and `rules.validate` | Sessions, every AccessKey, the demo account |
| Write | Every other procedure | Sessions and "Read and write" AccessKeys; a "Read only" AccessKey gets 403 `ACCESS_KEY_READ_ONLY`, the demo account 403 `DEMO_READ_ONLY` |

An AccessKey's scope is "Read only" or "Read and write" (a key without one counts as read and write). The resource pages mark each procedure **read** or **write**.

### Service accounts

Service accounts can call only the procedures below, each with its scope; any other procedure answers 403 `SERVICE_ACCOUNT_FORBIDDEN`, a missing scope 403 `SCOPE_REQUIRED` (`data.scope` names it). Scopes apply to service accounts only.

| Procedure | Endpoint | Scope |
| --- | --- | --- |
| `system.status` | `GET /system/status` | — |
| `account.me` | `GET /me` | — |
| `dns.catalog` | `GET /dns/catalog` | — |
| `settings.get` | `GET /settings` | `system:read` |
| `clusters.list`, `clusters.get` | `GET /clusters`, `GET /clusters/{id}` | `clusters:read` |
| `sites.list`, `sites.get`, `sites.launch` | `GET /sites`, `GET /sites/{id}`, `GET /sites/{id}/launch` | `sites:read` |
| `dns.siteTarget` | `GET /sites/{siteId}/cname` | `sites:read` |
| `sites.setEnabled` | `PUT /sites/{id}/enabled` | `sites:write` |
| `usage.list`, `usage.changes` | `GET /usage`, `GET /usage/changes` | `usage:read` |

Procedures managing service accounts and their keys: [System and account](api/system.en.md#service-accounts).

### Node capabilities

When the changed configuration needs a feature an active node of the cluster lacks (nodes report them in `supportedFeatures`, such as `challenge-v1` or `modsecurity-v1`):

| Caller | Result |
| --- | --- |
| The operator (session or AccessKey) | Saved and published; nodes lacking the feature keep their configuration and show "Upgrade required" in **Clusters & nodes** |
| A service account, the console's automatic jobs | 409 `NODE_CAPABILITY_REQUIRED`; `data.features` lists the missing features (comma-separated), `data.nodes` the nodes lacking them (first 5, then `+N`); nothing is saved |

Upgrading nodes: [Node upgrades](../guide/node-upgrades.en.md).

## Request format

| Item | Rule |
| --- | --- |
| Base URL | `<EDGEWEIR_PUBLIC_URL>/api/v1` |
| Path parameters | `{name}` in the path |
| Other input | `GET`: query parameters; `POST`, `PUT`, `PATCH`, `DELETE`: JSON body (`content-type: application/json`) |
| Arrays in the query | `name[]=a&name[]=b` |
| Body limit | 1 MiB without valid credentials, 16 MiB with them; over it 413 `PAYLOAD_TOO_LARGE`, before the procedure runs |
| Times | ISO 8601 strings with an offset (such as `2026-10-30T08:00:00Z`) |
| IDs | UUIDs |
| Response | The procedure's output JSON; status 200, or 201 where a resource page says so |
| Validation failure | 400 `BAD_REQUEST`, `data.issues` holds the issues |

Error format and all error codes: [Error codes](errors.en.md).

```bash
curl -fsS -H "x-api-key: $EDGEWEIR_API_KEY" \
  "https://cdn-admin.example.com/api/v1/sites?page=1&pageSize=20"
```

```bash
curl -fsS -X PUT -H "x-api-key: $EDGEWEIR_API_KEY" -H 'content-type: application/json' \
  -d '{"enabled":false}' \
  https://cdn-admin.example.com/api/v1/sites/<site ID>/enabled
```

## Rate limits

Each AccessKey has its own "Requests per minute": default 600, 1–100000, or unlimited (`requestsPerMinute: null`).

| Rule | Description |
| --- | --- |
| Window | Fixed 60-second windows, each starting with the key's first request after the previous one ended; at most "Requests per minute" requests per window |
| Over the limit | 429 `API_KEY_RATE_LIMITED`; `data.retryAfterSeconds` is the time to the window's end (at least 1) |
| Counting | In the console process: each instance counts on its own, a restart starts over; a changed limit starts a new count |
| Not counted | Unlimited AccessKeys, service account keys |

The sign-in endpoints of `/api/auth` have better-auth's own rate limiting (`NODE_ENV=production`, counted in PostgreSQL).

## Idempotency keys

`POST`, `PUT` and `PATCH` on `/api/v1` accept an `Idempotency-Key` header: 1–255 printable ASCII characters, as an RFC 8941 string (`"key"`) or bare. `GET` and `DELETE` ignore it.

| Case | Response |
| --- | --- |
| First request | Runs; method, path (with query), body SHA-256 and the final response are stored |
| Same caller, key and request | The stored response (status and body) with `Idempotent-Replayed: true` |
| Same key, another method, path or body | 422 `IDEMPOTENCY_KEY_MISMATCH` |
| The first request still runs | 409 `IDEMPOTENCY_IN_PROGRESS` |
| Malformed key | 400 `IDEMPOTENCY_KEY_INVALID` |
| A body with SSH credentials: `sshInstalls.start`, `sshInstalls.retry` | 400 `IDEMPOTENCY_KEY_UNSUPPORTED`, not run, and no hash of the body is kept; send it again without the header |
| A response with a credential shown once: `accessKeys.create`, `serviceAccounts.createKey`, `clusters.createEnrollmentToken`, `probes.createToken`, `authRules.signUrl` | 400 `IDEMPOTENCY_KEY_UNSUPPORTED`, not run; send it again without the header |

- Keys are per caller: all AccessKeys share one namespace (one account), each service account has its own.
- Kept 24 hours; expired records are removed hourly.
- 5xx responses are not stored, so the same key can be retried; neither are 401 and 429 (the procedure never ran). 4xx responses are stored and replay the same error.
- A record still running after 10 minutes counts as abandoned; the next request takes it over and runs again.

## Optimistic concurrency

These writes accept an optional `expectedUpdatedAt` (ISO 8601, the `updatedAt` the caller read). When it differs from the current value they answer 409 `UPDATED_AT_MISMATCH` with the current value in `data.updatedAt` (empty while there is none). Left out, nothing is compared.

| Procedure | `updatedAt` compared |
| --- | --- |
| `sites.setEnabled` | The site's; already in the requested state, it returns at once without comparing |
| `accessControl.update` | The site's access control |
| `authRules.update`, `authRules.forgetIdentityHeaders` | The site's access authentication |
| `errorPages.update` | The site's error pages |
| `maintenance.update` | The site's maintenance mode |
| `usageGuard.update` | The site's usage protection |
| `autoMitigation.update` | The site's automatic mitigation |
| `clusters.setRolloutPolicy` | `policyUpdatedAt` of the cluster's canary policy (rollouts and canary progress do not change it; the `updatedAt` read at the time passes too) |
| `l4Apps.update`, `l4Apps.setEnabled` | The L4 app's; `setEnabled` in the requested state returns at once without comparing |

## Pagination

| Style | Request | Response | Procedures |
| --- | --- | --- | --- |
| Pages | `page` (≥1, default 1), `pageSize` | `{ items, total }` | `sites.list`, `cacheTasks.list` (`pageSize` 1–100, default 20); `bans.list`, `greylist.list`, `security.events` (1–100, default 50) |
| Offset | `offset` (≥0, default 0), `limit` (1–200, default 50) | `{ items, total }` | `auditLogs.list` |
| Cursor | `cursor` (the previous page's `nextCursor`), `limit` | `nextCursor`; `null` on the last page | `usage.list`, `nodes.logs` |
| Sequence | `afterSeq` (the highest `seq` received, default `"0"`), `limit` | Records in `seq` order | `usage.changes` (incremental sync) |
| Count | `limit` | A list | Analytics and access log queries; limits on each procedure |

An invalid cursor answers 400 (`USAGE_CURSOR_INVALID`, `NODE_LOG_CURSOR_INVALID`). Parameter ranges are on the resource pages.

## Web UI RPC

`/rpc/*` speaks the oRPC RPC protocol for the web UI; the path is the procedure's, such as `POST /rpc/sites/list`.

| Requirement | Description |
| --- | --- |
| Session cookie | Issued by the sign-in endpoints of `/api/auth` |
| `x-csrf-token: orpc` | Without it: 403 `CSRF_TOKEN_MISMATCH` |
| `x-api-key` | Stripped; never replaces the session cookie |
| Login IP allow list | A client IP outside it gets 403 `LOGIN_IP_NOT_ALLOWED` (except the demo account) |

Third-party integrations use `/api/v1`.

## Authentication endpoints

better-auth handles `/api/auth/*`; only the paths and methods below are allowed (`AUTH_HTTP_ROUTES`). Matching is exact (no prefixes, encoded variants or trailing slashes); anything else returns 404. `x-api-key` in the request is stripped; the client IP is resolved per `EDGEWEIR_TRUSTED_PROXIES` and passed on. Body limit 64 KiB. The console has no sign-up; the only account is created by the setup wizard.

| Path | Method | Login IP allow list | Demo account |
| --- | --- | --- | --- |
| `/api/auth/get-session` | `GET` | Limited | Allowed |
| `/api/auth/sign-in/email` | `POST` | Limited | Allowed |
| `/api/auth/sign-out` | `POST` | Not limited | Allowed |
| `/api/auth/change-password` | `POST` | Limited | 403 `DEMO_READ_ONLY` |
| `/api/auth/two-factor/enable` | `POST` | Limited | 403 `DEMO_READ_ONLY` |
| `/api/auth/two-factor/disable` | `POST` | Limited | 403 `DEMO_READ_ONLY` |
| `/api/auth/two-factor/verify-totp` | `POST` | Limited | Allowed |
| `/api/auth/two-factor/verify-backup-code` | `POST` | Limited | Allowed |
| `/api/auth/passkey/generate-register-options` | `GET` | Limited | 403 `DEMO_READ_ONLY` |
| `/api/auth/passkey/verify-registration` | `POST` | Limited | 403 `DEMO_READ_ONLY` |
| `/api/auth/passkey/generate-authenticate-options` | `GET` | Limited | Allowed |
| `/api/auth/passkey/verify-authentication` | `POST` | Limited | Allowed |
| `/api/auth/passkey/list-user-passkeys` | `GET` | Limited | Allowed |
| `/api/auth/passkey/delete-passkey` | `POST` | Limited | 403 `DEMO_READ_ONLY` |

A client IP outside the login IP allow list gets 403 `LOGIN_IP_NOT_ALLOWED` from the limited endpoints before better-auth sees the request (the demo account's sign-in and session excepted). With `NODE_ENV=production` better-auth's rate limiting is on, counted in PostgreSQL.

## Health check

`GET /healthz` returns 200:

```json
{ "status": "ok", "version": "20261029-0c26898" }
```

| Field | Description |
| --- | --- |
| `status` | Always `ok` |
| `version` | Running version (`EDGEWEIR_VERSION`); `dev` from source |

It answers as soon as the HTTP server listens and does not check the database. Container health check: [Command line](cli.en.md#container).

## Installer and release mirror

`GET /install.sh` returns the node installer (`text/x-shellscript; charset=utf-8`, `cache-control: no-store`) with the console URL replaced by `EDGEWEIR_PUBLIC_URL`. Options: [Command line](cli.en.md#node-install-script).

`GET` and `HEAD` `/downloads/*` serve files from `EDGEWEIR_DOWNLOADS_DIR`; the URL path equals the relative path in the directory:

| Path | Content | `cache-control` |
| --- | --- | --- |
| `/downloads/<project>/latest` | Latest version, text | `no-cache` |
| `/downloads/<project>/v<semver>/<file>` | Release file | `public, max-age=86400, immutable` |

`<project>` is `edgeweir-node` or `cosign`; the `edgeweir-openresty` and `edgeweir-openresty-modsecurity` packages sit in the same version directory as `edgeweir-node`. Other paths, missing files and symbolic links leading outside the directory return 404. Preparing the directory: [Adding nodes](../deploy/nodes.en.md).

## Node channel

| Item | Value |
| --- | --- |
| Protocol | Connect-RPC over HTTPS (HTTP/2, HTTP/1.1 compatible), TLS 1.2 or later |
| Listener | `NODE_API_HOST:NODE_API_PORT`, default `8443` |
| WebSocket entry | `/node-channel` on the web port: the node channel's TLS runs inside the WebSocket and ends at the console. Open while the node channel URL is `wss://` or `ws://`, or with `EDGEWEIR_NODE_API_WEBSOCKET` |
| Services | `edgeweir.node.v1.NodeService` (nodes) and `edgeweir.node.v1.ProbeService` (regional probes and nodes that probe), defined in [`proto/edgeweir/node/v1/node.proto`](../../proto/edgeweir/node/v1/node.proto) and [`probe.proto`](../../proto/edgeweir/node/v1/probe.proto) |
| Server certificate | Issued by the console's internal CA; names in [Environment variables](environment.en.md#addresses-and-network) |
| Authentication | `Enroll`, `EnrollProbe`: a one-time enrollment token (nodes `ewt_`, probes `ewp_`); the node or probe pins the internal CA's SHA-256 fingerprint. Every other RPC: a client certificate from the internal CA (mTLS) with the node ID (`O=Edgeweir Node`) or probe ID (`O=Edgeweir Probe`) as CN; probe certificates can call `ProbeService` only, node certificates call `GetProbeTargets` and `ReportProbeResults` only while the node probes |
| Other paths | 404 |

> [!WARNING]
> The node channel must be reached directly or through layer-4 passthrough; a proxy that terminates TLS breaks node mTLS. See [Ports, reverse proxies and trusted proxies](../deploy/networking.en.md).
