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
- Each AccessKey is limited to 600 requests per 60 seconds.
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

Design record: [ADR-0008](../adr/0008-node-channel-connect-rpc-mtls.md).
