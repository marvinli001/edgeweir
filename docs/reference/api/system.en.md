# API: System and account

Procedures for setup, the caller's account, AccessKeys, service accounts and system settings; 47 in total.

Access levels, authentication, idempotency keys and the error format: [API overview](../api.en.md).

## Setup and status

- Neither procedure needs a key. The setup wizard: [Account](../../guide/account.en.md#account).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`system.status`](#systemstatus) | `GET /system/status` | public; service account (no scope) |
| [`system.setup`](#systemsetup) | `POST /system/setup` | public |

### `system.status`

`GET /system/status` · public · service account (no scope)

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `initialized` | boolean | The operator's account exists (the demo account does not count) |
| `version` | string | Console version |
| `demo` | boolean | The demo account is on; the sign-in page offers it |

### `system.setup`

`POST /system/setup` · public

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `setupToken` | body | string | yes | 1–200 characters after trimming | One-time setup token the console writes to its log at startup |
| `name` | body | string | yes | 1–100 characters after trimming | Name |
| `email` | body | string | yes | E-mail address; lowercased | Sign-in e-mail |
| `password` | body | string | yes | 12–128 characters | Password |

Only while no operator account exists. Creates the only operator account, creates the cluster `default` when there is no cluster, and spends the token. Creates no session. Audited as `system.setup`; a wrong token is audited as `system.setup_rejected` (metadata `email`). When a step fails, the new account is deleted again and the token stays usable.

Response: `{ userId }`: ID of the new account (string).

| Error | Status | Condition |
| --- | --- | --- |
| `SETUP_IN_PROGRESS` | 409 | Another setup request is running |
| `SETUP_DONE` | 403 | The operator account exists already |
| `SETUP_TOKEN_INVALID` | 403 | Wrong or spent token |

## Account

- `hiddenCards.*` read and write a personal preference of the caller's account and are not audited; with an AccessKey they act on the operator's preference. Behaviour: [Customize cards](../../guide/overview.en.md#customize-cards).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`account.me`](#accountme) | `GET /me` | read; service account (no scope) |
| [`hiddenCards.get`](#hiddencardsget) | `GET /hidden-cards` | read |
| [`hiddenCards.update`](#hiddencardsupdate) | `PATCH /hidden-cards` | write |

### `account.me`

`GET /me` · read · service account (no scope)

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `user.id` | string | Account ID; for a service account its ID |
| `user.name` | string | Name; for a service account its name |
| `user.email` | string | Sign-in e-mail; empty for a service account |
| `user.twoFactorEnabled` | boolean | Two-factor authentication is on; `false` for a service account |
| `serviceAccount` | object | `{ id, name, scopes }` when the caller is a service account, else `null` |
| `demo` | boolean | The caller is the demo account |

### `hiddenCards.get`

`GET /hidden-cards` · read

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `overview` | `array<enum>` | Card IDs hidden on the overview, in page order |
| `site` | `array<enum>` | Card IDs hidden on a site's Analytics tab (shared by all sites), in page order |

Every card not listed shows. Both are `[]` until first saved. Saved IDs the current version does not know are left out.

### `hiddenCards.update`

`PATCH /hidden-cards` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `overview` | body | `array<enum>` | no | At most 21, values below; duplicates removed; unchanged when omitted | Replaces the overview's hidden cards |
| `site` | body | `array<enum>` | no | At most 14, values below; duplicates removed; unchanged when omitted | Replaces the site analytics' hidden cards |

Omitting both answers 400 `BAD_REQUEST`. An empty array shows every card of that page.

| Page | Card IDs |
| --- | --- |
| `overview` | `live-requests`, `live-egress`, `live-hit-ratio`, `live-nodes`, `requests`, `data-transfer`, `edge-network`, `hit-ratio`, `peak-bandwidth`, `4xx-rate`, `5xx-rate`, `status-codes`, `top-sites`, `top-nodes`, `top-countries`, `top-urls`, `top-ips`, `revisions`, `recents`, `sites`, `nodes` |
| `site` | `requests`, `data-transfer`, `hit-ratio`, `peak-bandwidth`, `4xx-rate`, `5xx-rate`, `status-codes`, `top-urls`, `top-ips`, `countries`, `asns`, `referers`, `clients`, `protocols` |

Response: as [`hiddenCards.get`](#hiddencardsget).

## AccessKey

- Manages the caller's account's AccessKeys; with an AccessKey, the operator's keys. Usage: [Access keys](../../guide/access-logs.en.md#access-keys).
- A key is `ewk_` followed by 64 letters and is returned once, in the response of `accessKeys.create`; `prefix` is its first 6 characters. `scope` is `read` (read-level procedures) or `write` (every procedure); older keys without recorded permissions count as `write`.
- `requestsPerMinute`: 1–100000, or `null` (unlimited). Each key is counted in 60-second windows; a window starts with the key's first request after the previous window ended. Over the limit within a window: 429 `API_KEY_RATE_LIMITED`, `data.retryAfterSeconds` until the window ends. Counts live in the console process and start over on restart; changing the limit starts the count over.
- Audited as `api_key.create`, `api_key.update` (metadata: `name` and `requestsPerMinute` before and after), `api_key.revoke`; the metadata never holds the key.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`accessKeys.list`](#accesskeyslist) | `GET /access-keys` | read |
| [`accessKeys.create`](#accesskeyscreate) | `POST /access-keys` | write; session only |
| [`accessKeys.update`](#accesskeysupdate) | `PATCH /access-keys/{id}` | write; session only |
| [`accessKeys.revoke`](#accesskeysrevoke) | `DELETE /access-keys/{id}` | write |

### `accessKeys.list`

`GET /access-keys` · read

No parameters.

Response: [AccessKey](#accesskey-object)`[]`, oldest first, including revoked keys (`enabled` is `false`).

### `accessKeys.create`

`POST /access-keys` · write · session only · refuses `Idempotency-Key`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–64 characters after trimming | Name |
| `scope` | body | enum | no | `read` / `write`, default `write` | Scope |
| `requestsPerMinute` | body | integer | no | 1–100000 or `null`, default `600` | Requests per minute; `null` is unlimited |

Only with a signed-in console session.

Response: [AccessKey](#accesskey-object) plus `key` (string): the full key, returned this once.

| Error | Status | Condition |
| --- | --- | --- |
| `ACCESS_KEY_SESSION_REQUIRED` | 403 | Called with an AccessKey |

### `accessKeys.update`

`PATCH /access-keys/{id}` · write · session only

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | string | yes | 1–128 characters | Key ID |
| `name` | body | string | no | 1–64 characters after trimming; unchanged when omitted | Name |
| `requestsPerMinute` | body | integer | no | 1–100000 or `null`; unchanged when omitted | Requests per minute; `null` is unlimited |

Only with a signed-in console session. A changed limit starts the key's count over.

Response: [AccessKey](#accesskey-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ACCESS_KEY_SESSION_REQUIRED` | 403 | Called with an AccessKey |
| `ACCESS_KEY_NOT_FOUND` | 404 | The caller's account has no such key |
| `ACCESS_KEY_REVOKED` | 409 | The key is revoked |

### `accessKeys.revoke`

`DELETE /access-keys/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | string | yes | 1–128 characters | Key ID |

Sets `enabled` to `false`; the key stays in the list. Requests with it answer 401 from then on. Revoking a revoked key succeeds again and writes another audit entry.

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `ACCESS_KEY_NOT_FOUND` | 404 | The caller's account has no such key |

## Service accounts

- Behaviour: [Service accounts](../../guide/system.en.md#service-accounts). Service accounts cannot call the procedures of this section.
- A key is `ews_` followed by 43 base64url characters and is returned once, in the response of `serviceAccounts.createKey`; the console keeps only its SHA-256. `prefix` is its first 12 characters. Keys of a disabled account and revoked keys answer 401. Service account keys have no request limit.
- Audited as `service_account.create`, `service_account.update`, `service_account.delete`, `service_account.key_create`, `service_account.key_revoke`.
- Procedures that need no scope: `system.status`, `account.me`, `dns.catalog`. The procedures each scope allows:

| Scope | Procedures |
| --- | --- |
| `system:read` | `settings.get` |
| `clusters:read` | `clusters.list`, `clusters.get` |
| `sites:read` | `sites.list`, `sites.get`, `sites.launch`, `dns.siteTarget` |
| `sites:write` | `sites.setEnabled` |
| `usage:read` | `usage.list`, `usage.changes` |

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`serviceAccounts.list`](#serviceaccountslist) | `GET /service-accounts` | read |
| [`serviceAccounts.create`](#serviceaccountscreate) | `POST /service-accounts` | write |
| [`serviceAccounts.update`](#serviceaccountsupdate) | `PATCH /service-accounts/{id}` | write |
| [`serviceAccounts.delete`](#serviceaccountsdelete) | `DELETE /service-accounts/{id}` | write |
| [`serviceAccounts.createKey`](#serviceaccountscreatekey) | `POST /service-accounts/{id}/keys` | write |
| [`serviceAccounts.revokeKey`](#serviceaccountsrevokekey) | `POST /service-accounts/{id}/keys/{keyId}/revoke` | write |

### `serviceAccounts.list`

`GET /service-accounts` · read

No parameters.

Response: [Service account](#service-account-object)`[]`, by name.

### `serviceAccounts.create`

`POST /service-accounts` · write · `201`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–64 characters after trimming; unique (case-sensitive) | Name |
| `scopes` | body | `array<enum>` | yes | 0–5 of `clusters:read` / `system:read` / `sites:read` / `sites:write` / `usage:read`; duplicates removed, sorted | Scopes |
| `enabled` | body | boolean | no | Default `true` | Enabled |

Response: [Service account](#service-account-object) with `keys` `[]`.

| Error | Status | Condition |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NAME_TAKEN` | 409 | The name is in use; `data.name` |

### `serviceAccounts.update`

`PATCH /service-accounts/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Service account ID |
| `name` | body | string | no | As in `create`; unchanged when omitted | Name |
| `scopes` | body | `array<enum>` | no | As in `create`; replaces the list; unchanged when omitted | Scopes |
| `enabled` | body | boolean | no | Unchanged when omitted | Enabled |

Response: [Service account](#service-account-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | No such service account |
| `SERVICE_ACCOUNT_NAME_TAKEN` | 409 | Another service account uses the name; `data.name` |

### `serviceAccounts.delete`

`DELETE /service-accounts/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Service account ID |

Deletes all of its keys with it.

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | No such service account |

### `serviceAccounts.createKey`

`POST /service-accounts/{id}/keys` · write · `201` · refuses `Idempotency-Key`

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Service account ID |
| `name` | body | string | no | At most 64 characters after trimming, default `""` | Key name |

Disabled service accounts can get keys too.

Response: `{ key, secret }`: `key` is a [Service account key](#service-account-key-object), `secret` (string) the full key, returned this once.

| Error | Status | Condition |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | No such service account |

### `serviceAccounts.revokeKey`

`POST /service-accounts/{id}/keys/{keyId}/revoke` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Service account ID |
| `keyId` | path | uuid | yes | — | Key ID |

A revoked key is returned as it is, without another audit entry.

Response: [Service account key](#service-account-key-object).

| Error | Status | Condition |
| --- | --- | --- |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | No such service account |
| `SERVICE_ACCOUNT_KEY_NOT_FOUND` | 404 | No such key, or it belongs to another service account |

## System information

- The page: [System information](../../guide/system.en.md#system-information).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.get`](#settingsget) | `GET /settings` | read; service account `system:read` |

### `settings.get`

`GET /settings` · read · service account `system:read`

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `version` | string | Console version |
| `consoleUrl` | string | `EDGEWEIR_PUBLIC_URL` |
| `nodeApiUrl` | string | Node channel URL in effect, as `effectiveUrl` of [`settings.nodeChannel`](#settingsnodechannel) |
| `nodeCaSha256` | string | SHA-256 of the node channel CA certificate (DER), lowercase hex |
| `analyticsMode` | enum | `lite` / `clickhouse`: `EDGEWEIR_ANALYTICS` |
| `setupCompletedAt` | datetime | When the setup token was spent, or `null` |

## Node channel

- Behaviour: [Node channel](../../guide/system.en.md#node-channel) and [Changing the node channel URL](../../deploy/networking.en.md#changing-the-node-channel-url).
- The three changing procedures are audited as `system.node_channel_update` (metadata of `removeNodeChannelName` includes `removedName`, of `closeNodeChannelWebSocket` `webSocket: closed`) and tell every console instance to update its node channel certificate and WebSocket entry.
- Node and probe counts include only those whose certificate is still valid.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.nodeChannelCheck`](#settingsnodechannelcheck) | `GET /settings/node-channel-check` | read |
| [`settings.nodeChannel`](#settingsnodechannel) | `GET /settings/node-channel` | read |
| [`settings.setNodeChannel`](#settingssetnodechannel) | `PUT /settings/node-channel` | write |
| [`settings.removeNodeChannelName`](#settingsremovenodechannelname) | `DELETE /settings/node-channel/names/{name}` | write |
| [`settings.closeNodeChannelWebSocket`](#settingsclosenodechannelwebsocket) | `DELETE /settings/node-channel/websocket` | write |

### `settings.nodeChannelCheck`

`GET /settings/node-channel-check` · read

No parameters.

Connects to the node channel URL in effect the way a node does: a TLS handshake without client certificate and without a request, 3-second timeout. For `wss://` and `ws://` URLs, a WebSocket handshake at `/node-channel` first, then the TLS handshake inside it. A URL saved in system settings is first resolved under the outbound policy (`EDGEWEIR_OUTBOUND_ALLOW_CIDRS`); the environment's and the default URL are connected to as they are. Each console process caches the result for 30 seconds and checks again when the URL or its source changes. Advisory only. See [Node channel connection check](../../deploy/nodes.en.md#node-channel-connection-check).

Response:

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | The URL checked |
| `result` | enum | `ok`: the presented chain contains the node channel CA; `unreachable`: no handshake within the timeout; `mismatch`: another chain answered, or a WebSocket URL did not upgrade; `refused`: the saved URL resolves to a special-purpose address the outbound policy does not allow, not connected |
| `candidate` | object | After `unreachable` or `mismatch`, the WebSocket entry candidate `{ url, result }` (checked also while the entry is closed; with `ok`, saving its `url` as the node channel URL switches to it), otherwise `null` |
| `checkedAt` | datetime | Time of the check |

### `settings.nodeChannel`

`GET /settings/node-channel` · read

No parameters.

Response: [Node channel](#node-channel-object).

### `settings.setNodeChannel`

`PUT /settings/node-channel` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `url` | body | string | yes | Empty, or `https://`, `wss://` or `ws://` with a host and optional port; no credentials, path, query or fragment; at most 2048 characters | Node channel URL |

Saved as its origin (host lowercased, trailing `/` and default port dropped). An empty string clears the saved URL: `EDGEWEIR_NODE_API_URL` or the default applies. The name of the URL in effect before stays in the certificate (at most 32 such names); when the earlier or the new URL is `wss://` or `ws://`, the WebSocket entry stays open.

Response: [Node channel](#node-channel-object).

### `settings.removeNodeChannelName`

`DELETE /settings/node-channel/names/{name}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | path | string | yes | 1–253 characters; case-insensitive | A name from `previousNames` |

Takes the name out of the node channel certificate.

Response: [Node channel](#node-channel-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_CHANNEL_NAME_NOT_FOUND` | 404 | Not a name an earlier URL left: not in `previousNames`, the current URL's name, or a name from the environment or the default |
| `NODE_CHANNEL_NAME_IN_USE` | 409 | Nodes or probes still connect with the name; `data.nodes`, `data.probes` |

### `settings.closeNodeChannelWebSocket`

`DELETE /settings/node-channel/websocket` · write

No parameters.

Closes the WebSocket entry an earlier `wss://` or `ws://` URL opened.

Response: [Node channel](#node-channel-object).

| Error | Status | Condition |
| --- | --- | --- |
| `NODE_CHANNEL_WEBSOCKET_REQUIRED` | 409 | `webSocket.closable` is `false`: `EDGEWEIR_NODE_API_WEBSOCKET=true`, the URL in effect is `wss://` or `ws://`, or no earlier URL of that kind opened the entry |
| `NODE_CHANNEL_WEBSOCKET_IN_USE` | 409 | Nodes or probes may still connect through the entry; `data.nodes`, `data.probes` |

## Origin allow list

- Behaviour: [Origin allow list](../../guide/system.en.md#origin-allow-list) and [Origin address restrictions](../../guide/origins-and-cache.en.md#origin-address-restrictions).
- `settings.setOriginAllowList` publishes a configuration revision for every cluster (reason `origin_allow_list_updated`) and is audited as `system.origin_allow_list_update` (metadata `cidrs`, `added`, `removed`, and each cluster's new revision in `revisions`).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.originAllowList`](#settingsoriginallowlist) | `GET /settings/origin-allow-list` | read |
| [`settings.setOriginAllowList`](#settingssetoriginallowlist) | `PUT /settings/origin-allow-list` | write |

### `settings.originAllowList`

`GET /settings/origin-allow-list` · read

No parameters.

Response: `{ cidrs }`: special-purpose ranges origins may use (string[]), normalized, sorted, without duplicates; `[]` until first saved.

### `settings.setOriginAllowList`

`PUT /settings/origin-allow-list` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `cidrs` | body | `array<string>` | yes | At most 256; each an IPv4 or IPv6 CIDR of at most 64 characters, a bare address being a single host; normalized (`10.1.2.3/8` → `10.0.0.0/8`) | The whole list |

Replaces the list; an empty array clears it.

Response: as [`settings.originAllowList`](#settingsoriginallowlist).

## ACME directory

- Behaviour: [Certificate authorities](../../guide/system.en.md#certificate-authorities). Certificate requests with `ca` `custom` use this directory.
- Each value is the one saved in system settings, else the environment's (`EDGEWEIR_ACME_DIRECTORY`, `EDGEWEIR_ACME_CA_FILE`), else none. The EAB HMAC key is sealed with the master key and never returned.
- Audited as `system.acme_directory_update` (metadata: `url` before and after, `eabKid`, `caCertificates`; never the key).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.acmeDirectory`](#settingsacmedirectory) | `GET /settings/acme-directory` | read |
| [`settings.setAcmeDirectory`](#settingssetacmedirectory) | `PUT /settings/acme-directory` | write |

### `settings.acmeDirectory`

`GET /settings/acme-directory` · read

No parameters.

Response: [ACME directory setting](#acme-directory-setting-object).

### `settings.setAcmeDirectory`

`PUT /settings/acme-directory` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `url` | body | string | yes | Empty, or an `https://` URL without credentials or fragment, at most 2048 characters | ACME directory URL |
| `eabKid` | body | string | no | At most 256 characters after trimming, default `""` | EAB key ID; empty: no EAB |
| `eabHmacKey` | body | string | no | At most 1024 characters after trimming, default `""` | EAB HMAC key; empty keeps the saved key of the same `eabKid` |
| `caPem` | body | string | no | At most 65536 characters, default `""` | CA certificates to trust: 1–10 PEM certificates and no other PEM block; whitespace only means none |

- An empty `url` clears the whole setting; the other fields have no effect.
- With an empty `eabKid`, no EAB is saved and `eabHmacKey` is ignored.
- Before saving, the console reads the directory trusting the system roots plus `caPem` (when empty, the certificates of `EDGEWEIR_ACME_CA_FILE`): 10 seconds, at most 1 MiB, no redirects; it must answer 200 with JSON holding `newNonce`, `newAccount` and `newOrder`. The directory may be on a private network. Up to 10 names of `meta.caaIdentities` are saved as `caaIdentities`.

Response: [ACME directory setting](#acme-directory-setting-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ACME_DIRECTORY_CA_INVALID` | 400 | `caPem` is not 1–10 readable PEM certificates, holds another PEM block, or exceeds 65536 bytes |
| `ACME_DIRECTORY_EAB_INCOMPLETE` | 400 | `eabKid` given with an empty `eabHmacKey`, and no key saved for the same `eabKid` |
| `ACME_DIRECTORY_INVALID` | 400 | The read failed or did not return an ACME directory |

## Node release source

- Behaviour: [Node release source](../../guide/system.en.md#node-release-source). The mirror layout is `<url>/v<version>/checksums.txt`.
- Audited as `system.release_source_update` (metadata `before`, `after`).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.releaseSource`](#settingsreleasesource) | `GET /settings/release-source` | read |
| [`settings.setReleaseSource`](#settingssetreleasesource) | `PUT /settings/release-source` | write |

### `settings.releaseSource`

`GET /settings/release-source` · read

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | URL saved in system settings; empty when none is saved |
| `effectiveUrl` | string | URL node upgrades use: the saved one, else `EDGEWEIR_NODE_RELEASE_BASE_URL`, else `https://github.com/marvinli001/edgeweir-node/releases/download` |
| `source` | enum | `setting` / `environment` / `default`: where `effectiveUrl` comes from |

### `settings.setReleaseSource`

`PUT /settings/release-source` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `url` | body | string | yes | Empty, or an `https://` or `http://` URL without credentials, query or fragment, at most 2048 characters | Mirror URL |

Before saving, the host is resolved (10 seconds): every answer must be a public address or one `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` allows; `http://` is allowed for non-public addresses only. The mirror's content is not read. An empty string clears the saved URL.

Response: as [`settings.releaseSource`](#settingsreleasesource).

| Error | Status | Condition |
| --- | --- | --- |
| `RELEASE_SOURCE_REFUSED` | 400 | The host does not resolve, resolves to an address not allowed, or a public address uses `http://` |

## Usage and log retention

- Behaviour: [Usage](../../guide/system.en.md#usage), [access log retention](../../guide/access-logs.en.md#retention) and [Node log retention](../../guide/system.en.md#node-log-retention).
- All three `PUT`s replace the whole setting; audited as `system.usage_update`, `system.log_retention_update`, `system.node_log_retention_update` (metadata: the values before and after).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.usage`](#settingsusage) | `GET /settings/usage` | read |
| [`settings.setUsage`](#settingssetusage) | `PUT /settings/usage` | write |
| [`settings.logRetention`](#settingslogretention) | `GET /settings/log-retention` | read |
| [`settings.setLogRetention`](#settingssetlogretention) | `PUT /settings/log-retention` | write |
| [`settings.nodeLogRetention`](#settingsnodelogretention) | `GET /settings/node-log-retention` | read |
| [`settings.setNodeLogRetention`](#settingssetnodelogretention) | `PUT /settings/node-log-retention` | write |

### `settings.usage`

`GET /settings/usage` · read

No parameters.

Response: `{ retentionDays, offlineThresholdMinutes }`, fields as in [`settings.setUsage`](#settingssetusage); `100` and `60` until first saved.

### `settings.setUsage`

`PUT /settings/usage` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `retentionDays` | body | integer | yes | 35–400 | Days usage records are kept |
| `offlineThresholdMinutes` | body | integer | yes | 5–1440 | Nodes without a heartbeat for longer no longer hold back `completeUntil` |

Response: as [`settings.usage`](#settingsusage).

### `settings.logRetention`

`GET /settings/log-retention` · read

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `postgresDays` | integer | Days PostgreSQL storage keeps access logs; `7` until first saved |
| `clickhouseDays` | integer | Days ClickHouse storage keeps access logs; `7` until first saved |
| `storage` | enum | `lite` / `clickhouse`: the storage in use (`EDGEWEIR_ANALYTICS`), which decides which of the two applies |

### `settings.setLogRetention`

`PUT /settings/log-retention` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `postgresDays` | body | integer | yes | 1–30 | Days for PostgreSQL storage |
| `clickhouseDays` | body | integer | yes | 1–90 | Days for ClickHouse storage |

With `clickhouse` storage in use, the TTL of the ClickHouse `access_log` table changes right after saving.

Response: as [`settings.logRetention`](#settingslogretention).

### `settings.nodeLogRetention`

`GET /settings/node-log-retention` · read

No parameters.

Response: `{ days, perNode }`, fields as in [`settings.setNodeLogRetention`](#settingssetnodelogretention); `7` and `10000` until first saved.

### `settings.setNodeLogRetention`

`PUT /settings/node-log-retention` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `days` | body | integer | yes | 1–30 | Days node logs are kept |
| `perNode` | body | integer | yes | 1000–100000 | Entries kept per node at most |

Response: as [`settings.nodeLogRetention`](#settingsnodelogretention).

## Ban and protection settings

- Behaviour: [Protection](../../guide/system.en.md#protection), [Bans](../../guide/system.en.md#bans), [CC template](../../guide/system.en.md#cc-template), [Bans](../../guide/bans.en.md) and [Challenges and CC mitigation](../../guide/challenges.en.md).
- All three `PUT`s replace the whole setting; audited as `system.bans_update`, `system.protection_update`, `system.cc_template_update` (metadata: the values before and after).
- Revision reasons: `platform_protection_updated` (`settings.setProtection`), `cc_template_updated` (`settings.setCcTemplate`).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.bans`](#settingsbans) | `GET /settings/bans` | read |
| [`settings.setBans`](#settingssetbans) | `PUT /settings/bans` | write |
| [`settings.protection`](#settingsprotection) | `GET /settings/protection` | read |
| [`settings.setProtection`](#settingssetprotection) | `PUT /settings/protection` | write |
| [`settings.ccTemplate`](#settingscctemplate) | `GET /settings/cc-template` | read |
| [`settings.setCcTemplate`](#settingssetcctemplate) | `PUT /settings/cc-template` | write |

### `settings.bans`

`GET /settings/bans` · read

No parameters.

Response: `{ maxTotal, shareAutoBans }`, fields as in [`settings.setBans`](#settingssetbans); `10000` and `true` until first saved.

### `settings.setBans`

`PUT /settings/bans` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `maxTotal` | body | integer | yes | 100–100000 | Active manual bans across the platform, site and platform bans together |
| `shareAutoBans` | body | boolean | yes | — | Automatic bans are sent to the other nodes of the cluster |

Response: as [`settings.bans`](#settingsbans).

### `settings.protection`

`GET /settings/protection` · read

No parameters.

Response: `{ underAttack, underAttackChallenge, eventRetentionDays }`, fields as in [`settings.setProtection`](#settingssetprotection); `false`, `js` and `30` until first saved.

### `settings.setProtection`

`PUT /settings/protection` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `underAttack` | body | boolean | yes | — | Under Attack for every site of every cluster |
| `underAttackChallenge` | body | enum | yes | `cookie302` / `js` / `pow` / `captcha` | Challenge type of platform Under Attack |
| `eventRetentionDays` | body | integer | yes | 7–365 | Days security events are kept |

When `underAttack` changes, or `underAttackChallenge` changes while `underAttack` is `true`, every cluster gets a configuration revision.

Response: as [`settings.protection`](#settingsprotection).

### `settings.ccTemplate`

`GET /settings/cc-template` · read

No parameters.

Response: the CC template, fields as in [`settings.setCcTemplate`](#settingssetcctemplate).

### `settings.setCcTemplate`

`PUT /settings/cc-template` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `maxLevel` | body | enum | yes | `cookie302` / `js` / `pow` / `captcha`; `captcha` until saved | Highest level the policy may reach |
| `highPowInsteadOfCaptcha` | body | boolean | yes | `false` until saved | At the `captcha` level, challenge with the high-difficulty proof of work instead |
| `windowSeconds` | body | integer | yes | 5–60; `10` until saved | Sliding window in seconds |
| `siteQps` | body | integer | yes | 0–1000000; `1000` until saved | Requests per second of the site |
| `urlQps` | body | integer | yes | 0–1000000; `200` until saved | Requests per second of one path; only attacked paths are escalated |
| `ipQps` | body | integer | yes | 0–1000000; `50` until saved | Requests per second of one address; addresses over it are banned for `ipBanSeconds` |
| `ipBanSeconds` | body | integer | yes | 60–86400; `600` until saved | Duration of the automatic ban |
| `originErrorPercent` | body | integer | yes | 0–100; `50` until saved | Origin errors (5xx and failed attempts) in percent of origin requests |
| `originErrorMinRequests` | body | integer | yes | 0–1000000; `100` until saved | Origin requests in the window before the error rate counts |
| `escalateAfterSeconds` | body | integer | yes | 1–3600; `10` until saved | A trigger that holds this long raises the level by one step |
| `cooldownSeconds` | body | integer | yes | 1–86400; `60` until saved | Without triggers for this long, the level falls by one step |

A threshold of `0` turns its trigger off. Each node decides locally, so thresholds apply per node. Saving publishes the clusters with sites whose enabled CC policy follows the template.

Response: as [`settings.ccTemplate`](#settingscctemplate).

## Probe settings

- Behaviour: [Probe settings](../../guide/scheduling.en.md#probe-settings).
- Audited as `system.probes_update` (metadata: the values before and after).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.probes`](#settingsprobes) | `GET /settings/probes` | read |
| [`settings.setProbes`](#settingssetprobes) | `PUT /settings/probes` | write |

### `settings.probes`

`GET /settings/probes` · read

No parameters.

Response: the probe settings, fields as in [`settings.setProbes`](#settingssetprobes).

### `settings.setProbes`

`PUT /settings/probes` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `intervalSeconds` | body | integer | yes | 5–60; `10` until saved | Seconds between probe rounds |
| `timeoutMs` | body | integer | yes | 500–10000, at most `intervalSeconds × 1000`; `3000` until saved | Milliseconds one attempt may take |
| `attempts` | body | integer | yes | 1–10; `3` until saved | Attempts per target and round |
| `lossPercent` | body | integer | yes | 1–100; `50` until saved | Share of lost attempts (percent) that makes an address fail |
| `ipDownSeconds` | body | integer | yes | 5–3600; `30` until saved | How long an address fails before the node switches to its next level |
| `ipUpSeconds` | body | integer | yes | 5–3600; `60` until saved | How long a failed address answers again before the node switches back |

Replaces the whole setting. `timeoutMs` over `intervalSeconds × 1000` answers 400 `BAD_REQUEST`.

Response: as [`settings.probes`](#settingsprobes).

## Platform error pages

- Behaviour and placeholders: [Platform error pages](../../guide/error-pages.en.md#platform-error-pages) and [Templates](../../guide/error-pages.en.md#templates).
- `settings.setErrorPages` publishes a configuration revision for every cluster (reason `error_pages_updated`) and is audited as `system.error_pages_update` (metadata `changed`, `bytes`, and each cluster's new revision in `revisions`).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.errorPages`](#settingserrorpages) | `GET /settings/error-pages` | read |
| [`settings.setErrorPages`](#settingsseterrorpages) | `PUT /settings/error-pages` | write |

### `settings.errorPages`

`GET /settings/error-pages` · read

No parameters.

Response: `{ unknownHost, siteDisabled }`, fields as in [`settings.setErrorPages`](#settingsseterrorpages); both empty until first saved.

### `settings.setErrorPages`

`PUT /settings/error-pages` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `unknownHost` | body | string | no | At most 65536 bytes of UTF-8, default `""` | Page for hosts no site serves (404) |
| `siteDisabled` | body | string | no | At most 65536 bytes of UTF-8, default `""` | Page for hosts of disabled sites (503) |

Replaces both pages: an omitted field is saved as an empty string. An empty string uses the nodes' built-in page. A template with `{{time}}` or `{{path}}` makes the clusters' configuration require the node capability `rules-v3`.

Response: as [`settings.errorPages`](#settingserrorpages).

| Error | Status | Condition |
| --- | --- | --- |
| `ERROR_PAGE_TOO_LARGE` | 400 | A template exceeds 65536 bytes; `data.status` is `404` or `503`, `data.limit` is `65536` |

## Demo account

- Behaviour: [Demo account](../../guide/system.en.md#demo-account).
- A change of state is audited as `system.demo_update` (metadata `from`, `to`); no entry when the state stays.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.demo`](#settingsdemo) | `GET /settings/demo` | read |
| [`settings.setDemo`](#settingssetdemo) | `PUT /settings/demo` | write |

### `settings.demo`

`GET /settings/demo` · read

No parameters.

Response: `{ enabled }`: the demo account is on (boolean).

### `settings.setDemo`

`PUT /settings/demo` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `enabled` | body | boolean | yes | — | Turns the demo account on or off |

Turning it on creates the account `demo@edgeweir.com` (password `demo`); turning it off deletes the account with all of its sessions. The operator's account is left as it is.

Response: as [`settings.demo`](#settingsdemo).

| Error | Status | Condition |
| --- | --- | --- |
| `DEMO_EMAIL_TAKEN` | 409 | Turning it on while the operator's e-mail is `demo@edgeweir.com` |

## Login IP allow list

- Behaviour and what the list limits: [Login IP allow list](../../guide/system.en.md#login-ip-allow-list).
- Audited as `system.login_allow_list_update` (metadata `cidrs`, `added`, `removed`).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`settings.loginAllowList`](#settingsloginallowlist) | `GET /settings/login-allow-list` | read |
| [`settings.setLoginAllowList`](#settingssetloginallowlist) | `PUT /settings/login-allow-list` | write |

### `settings.loginAllowList`

`GET /settings/login-allow-list` · read

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `cidrs` | `array<string>` | Ranges allowed to sign in, normalized, sorted, without duplicates; `[]` while the list is off. The demo account sees each range cut to at most IPv4 /24 or IPv6 /48 |
| `currentIp` | string | The client address the console resolved for this request |
| `proxyHint` | boolean | `currentIp` may be a proxy's: it is a special-purpose address, or the request carried forwarding headers from a peer outside `EDGEWEIR_TRUSTED_PROXIES` |

### `settings.setLoginAllowList`

`PUT /settings/login-allow-list` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `cidrs` | body | `array<string>` | yes | At most 64; each an IPv4 or IPv6 CIDR of at most 64 characters, a bare address being a single host; normalized | The whole list |

Replaces the list; an empty array turns it off. IPv4-mapped IPv6 addresses and ranges compare as the IPv4 ones they map.

Response: as [`settings.loginAllowList`](#settingsloginallowlist).

| Error | Status | Condition |
| --- | --- | --- |
| `LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP` | 400 | The list is not empty and leaves out this request's client address (checked with an AccessKey too); `data.ip` |

## Node extensions

| Procedure | Endpoint |
| --- | --- |
| `extensionKeys.list`, `extensionKeys.add`, `extensionKeys.remove` | `GET`, `POST /extension-keys`, `DELETE /extension-keys/{kid}` |
| `extensions.verify` | `POST /extensions/verify` |
| `extensions.install` | `POST /extensions` |
| `extensions.list`, `extensions.get`, `extensions.update`, `extensions.uninstall` | `GET /extensions`, `GET`, `PATCH`, `DELETE /extensions/{id}` |
| `extensions.activate`, `extensions.deleteVersion` | `POST /extensions/{id}/activate`, `DELETE /extensions/{id}/versions/{version}` |
| `extensions.settings`, `extensions.updateSettings` | `GET`, `PUT /extensions/settings` (kill switch) |
| `extensions.forSite`, `extensions.updateSite` | `GET /sites/{siteId}/extensions`, `PUT /sites/{siteId}/extensions/{id}` |
| `extensions.rotateSecret` | `POST /extensions/{id}/rotate-secret` (manifest `secret: true`): a new current secret, the old one kept as previous, `secretVersion` + 1; publishes the clusters that get the extension; audit `extension.rotate_secret` |
| `extensions.listSiteData`, `extensions.putSiteData`, `extensions.deleteSiteData` | `GET /sites/{siteId}/extensions/{id}/data` → `[{ name, sha256, size, updatedAt }]`, `PUT`, `DELETE /sites/{siteId}/extensions/{id}/data/{name}` (manifest `data`); publish the site's cluster; audit `site.extension_data_put`, `site.extension_data_delete` |

| Request | Fields |
| --- | --- |
| `POST /extension-keys` | `publisher`, `key` (public JWK JSON or its base64url `x`), `label` |
| `POST /extensions/verify`, `POST /extensions` | `package` (the `.ewx` bytes, base64), `signature` (the `.ewx.sig` compact JWS); requests up to 96 MiB (packages with a sidecar) |
| `PATCH /extensions/{id}` | `enabled`, `failureMode` (`open`, `closed`), `config` (the manifest's global schema) |
| `PUT /sites/{siteId}/extensions/{id}` | `enabled`, `config` (the manifest's site schema) |
| `PUT /sites/{siteId}/extensions/{id}/data/{name}` | `content` (base64; requests up to 34 MiB). `name` `^[a-z0-9][a-z0-9._-]{0,63}$`; limits from the active manifest's `data` (`max_bytes` per item, `max_items` and `max_total_bytes` per site and extension) |

Errors: `EXTENSION_PACKAGE_INVALID`, `EXTENSION_SIGNATURE_INVALID`, `EXTENSION_KEY_UNTRUSTED`, `EXTENSION_PUBLISHER_MISMATCH`, `EXTENSION_CONFIG_INVALID`, `EXTENSION_IN_USE` (rules read its fields), `EXTENSION_KEY_IN_USE`, `EXTENSION_VERSION_ACTIVE`, `EXTENSION_SECRET_NOT_SUPPORTED`, `EXTENSION_DATA_NOT_SUPPORTED` (the manifest has no `data`), `EXTENSION_DATA_TOO_LARGE` (`limit`: `max_bytes`, `max_items` or `max_total_bytes`; `max`), `EXTENSION_DATA_NOT_FOUND`, `NODE_CAPABILITY_REQUIRED` (`extensions-v1`, `extensions-v2`). `extensions.get` carries `secretVersion` (never the secret) and node states with `details` (what the node reports, such as `sidecar.state`); `extensions.forSite` carries `dataLimits`. Configuration values marked `x-secret` come back masked; sending the mask keeps the stored value. Access logs carry block reason `extension` with rule id `ext:<id>` and the field `ext` (the extensions' log fields and verdicts). Format and runtime: [Node extensions](extensions.en.md); usage: [Extensions](../../guide/extensions.en.md).

## Objects

### AccessKey object

| Field | Type | Description |
| --- | --- | --- |
| `id` | string | Key ID |
| `name` | string | Name |
| `prefix` | string | First 6 characters of the key |
| `scope` | enum | `read` / `write` |
| `enabled` | boolean | `false`: revoked |
| `requestsPerMinute` | integer | Requests per minute, or `null` (unlimited) |
| `createdAt` | datetime | Creation time |
| `lastUsedAt` | datetime | Last use (updated at most once a minute), or `null` |

### Service account object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Service account ID |
| `name` | string | Name |
| `scopes` | `array<enum>` | Scopes, sorted |
| `enabled` | boolean | Enabled |
| `keys` | array<[Service account key](#service-account-key-object)> | All keys, revoked ones included, oldest first |
| `createdAt` | datetime | Creation time |
| `updatedAt` | datetime | Last change |

### Service account key object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Key ID |
| `name` | string | Key name, may be empty |
| `prefix` | string | First 12 characters of the key |
| `createdAt` | datetime | Creation time |
| `lastUsedAt` | datetime | Last use (updated at most once a minute), or `null` |
| `revokedAt` | datetime | Revocation time, or `null` |

### Node channel object

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | URL saved in system settings; empty when none is saved |
| `effectiveUrl` | string | URL in effect: the saved one, else `EDGEWEIR_NODE_API_URL`, else the default. New install commands carry it; enrolled nodes and probes switch to it |
| `source` | enum | `setting` / `environment` / `default`: where `effectiveUrl` comes from |
| `serverName` | string | Certificate name nodes verify at `effectiveUrl` (host name or IP) |
| `previousNames` | `array<object>` | Names earlier URLs left in the certificate, without the current name and the names from the environment or the default |
| `previousNames[].name` | string | Name |
| `previousNames[].nodes` | integer | Nodes still connecting with the name: they verified it on their latest connection, or report it as the address they use; a fallback a node keeps does not count |
| `previousNames[].probes` | integer | The same for probes. Removable once `nodes` and `probes` are both `0` |
| `webSocket.open` | boolean | The WebSocket entry is open: `EDGEWEIR_NODE_API_WEBSOCKET=true`, the URL in effect is `wss://` or `ws://`, or such a URL was in effect before |
| `webSocket.closable` | boolean | The entry is open only because of an earlier URL and can be closed with [`settings.closeNodeChannelWebSocket`](#settingsclosenodechannelwebsocket) |
| `webSocket.nodes` | integer | Nodes that may still connect through the entry |
| `webSocket.probes` | integer | Probes that may still connect through the entry |
| `adoption.nodes` | integer | Nodes whose certificate is still valid |
| `adoption.nodesCurrent` | integer | Of those, nodes on `effectiveUrl` |
| `adoption.probes` | integer | Probes whose certificate is still valid |
| `adoption.probesCurrent` | integer | Of those, probes on `effectiveUrl` |

The default URL is `https://<host name of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>`; with `EDGEWEIR_NODE_API_WEBSOCKET=true`, `wss://<host and port of EDGEWEIR_PUBLIC_URL>` (`ws://` when the console URL is `http://`).

### ACME directory setting object

| Field | Type | Description |
| --- | --- | --- |
| `url` | string | Saved directory URL; empty when none is saved |
| `effectiveUrl` | string | Directory URL in effect: the saved one, else `EDGEWEIR_ACME_DIRECTORY`; empty when neither |
| `source` | enum | `setting` / `environment` / `default`: where `effectiveUrl` comes from; `default` means no custom directory |
| `eabKid` | string | Saved EAB key ID; empty without EAB or without a saved directory |
| `eabHmacKeySet` | boolean | An EAB HMAC key is saved |
| `caPem` | string | Saved CA certificates (PEM); empty when none is saved |
| `caSource` | enum | `setting` / `environment` / `default`: where the CA certificates in effect come from; `default` is the system roots |
| `caaIdentities` | `array<string>` | CAA issuer domains from the saved directory's `meta.caaIdentities` (lowercase, at most 10); empty: CAA is not checked. `[]` when the directory comes from the environment |
