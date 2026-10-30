# Environment variables

Variables the console process reads, with type, default, validation and effect, plus the host variables used by the Compose files.

## Loading and validation

- The process reads and validates every variable once at startup. An invalid value stops the process with exit code 1 and one log line per problem: `invalid configuration: <variable>: <reason>`.
- Recreate the container after a change: `docker compose up -d`. `docker compose restart` does not apply new values.
- An empty value counts as unset for: `EDGEWEIR_MASTER_KEY_PREVIOUS`, `BETTER_AUTH_SECRET`, `EDGEWEIR_NODE_API_URL`, `EDGEWEIR_NODE_API_WEBSOCKET`, `NODE_API_HOST`, `EDGEWEIR_NODE_RELEASE_BASE_URL`, `EDGEWEIR_E2E_TICK_SECONDS`, `EDGEWEIR_E2E_HEARTBEAT_SECONDS` and every `_FILE` variable. An empty value of any other variable is validated as is: `ROLE=` is invalid, `EDGEWEIR_ACME_DIRECTORY=` is the empty string.
- The **Default** column is the process default. Values set by the image or a Compose file are given in the **Description** column.
- **Fallback**: a value saved in **System settings** wins; clearing the saved value restores the variable.
- Template with comments: [`.env.example`](../../.env.example).

| Type | Rule |
| --- | --- |
| String | Used as is |
| Integer | Decimal, checked against the range |
| Boolean | `true`, `1`, `yes`, `on` turn it on, `false`, `0`, `no`, `off` turn it off, case-insensitive; any other value is invalid |
| Enum | Only the listed values, case-sensitive |
| Origin URL | `<scheme>://host[:port]`: no path, query, fragment, user name or password; a trailing `/` and the scheme's default port are dropped; a host that is an unexpanded platform variable (such as `${ZEABUR_WEB_DOMAIN}`) is invalid |
| List | Comma-separated; whitespace around entries is ignored |
| Path | Path of a file or directory; not checked at startup, read when used |

## Required

With `compose.yml` or `compose.baota.yml`, `DATABASE_URL` is built from the [Compose host variable](#compose-host-variables) `POSTGRES_PASSWORD`.

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | Base64 | None | Master key. Canonical base64 (standard or URL-safe alphabet) of at least 32 bytes; any other character, such as a space or a quote, or fewer than 32 bytes stops the console. Generate: `openssl rand -base64 32`, used as is (keep `/`, `+` and `=`). A key other than the one the database's secrets were encrypted with stops the console with `EDGEWEIR_MASTER_KEY does not match this database`; restore the original key, or, when rotating, set the original as [`EDGEWEIR_MASTER_KEY_PREVIOUS`](#master-key-rotation). Envelope-encrypts private keys, DNS API keys and other secrets at rest, and derives the session secret. Losing it makes encrypted data unrecoverable; back it up separately from the database |
| `EDGEWEIR_MASTER_KEY_FILE` | Path | Unset | File holding the master key (for example a Docker secret), instead of `EDGEWEIR_MASTER_KEY`; rules in [Read from files](#read-from-files). The Compose templates do not pass it; see [Master key file](../deploy/docker.en.md#master-key-file) |
| `DATABASE_URL` | String | None | PostgreSQL 18 connection string, non-empty. At startup the console waits up to 60 seconds for the database (logging `database not reachable yet` on each failure), then runs migrations. Unlike libpq, `sslmode=require`, `prefer` and `verify-ca` verify the certificate and host name like `verify-full`: for a certificate not issued by a public CA, name the CA with `sslrootcert=<CA file>`, or skip the check with `uselibpqcompat=true&sslmode=require` (libpq's behaviour) or `sslmode=no-verify`; a failed certificate check adds a `hint` field to the log line. `compose.yml` and `compose.baota.yml` build it from `POSTGRES_PASSWORD` and ignore the `.env` value; `compose.baota-host.yml` takes it from `.env`, or reads it from `DATABASE_URL_FILE` set in `compose.override.yml` |
| `EDGEWEIR_PUBLIC_URL` | Origin URL (`http`, `https`) | `http://localhost:3000` | URL browsers use to reach the console; behind a reverse proxy, the proxy URL. Used for: the trusted origin of the authentication endpoints, the `Secure` attribute of session cookies (with `https://`), the passkey RP ID (host name), the `servers` entry of the OpenAPI document, the console URL in `/install.sh`, links in alert notifications, and the host of the default node channel URL. The default only suits local access: node install commands and alert links point to localhost. A local-only, private or `http://` address logs a warning at startup; see [Adding nodes](../deploy/nodes.en.md#1-generate-the-install-command) |

## Session secret

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `BETTER_AUTH_SECRET` | String, at least 32 characters | Derived from the master key | Secret that signs sessions and encrypts two-factor secrets. Unset: derived from the master key with HKDF-SHA256 (parameters in [Security policy](../../SECURITY.en.md)); it keeps its value when the [master key is rotated](#master-key-rotation). A deployment that has set it must keep the value: removing it stops the console (`BETTER_AUTH_SECRET is not set, but this database was used with another secret`); a new value starts the console with a warning, ends every session and makes enrolled two-factor secrets unreadable |

## Master key rotation

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_MASTER_KEY_PREVIOUS` | Base64 | Unset | The master key before the rotation, used only to decrypt; same rules as `EDGEWEIR_MASTER_KEY`, and the same key as `EDGEWEIR_MASTER_KEY` stops the console. At startup the console accepts data it encrypted and re-encrypts every envelope it sealed with `EDGEWEIR_MASTER_KEY`; the `master key rotation` log line counts them. Once all are done the log says `no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more: remove it and restart the console`; remove it and restart. While envelopes still use it the log says `envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS: keep it set`. Revision receipts stored on nodes stay verifiable while it is set; nodes get receipts of the new key on their next configuration pull. Without `BETTER_AUTH_SECRET`, the session secret stays the value derived from the old key, stored in `system_setting` encrypted with the new key: sessions and two-factor authentication are unaffected. Steps: [Rotating the master key](../deploy/docker.en.md#rotating-the-master-key) |

## Read from files

`<variable>_FILE` names a file whose content is the variable's value (for example a Docker secret).

| Rule | Description |
| --- | --- |
| Content | The trailing line break is dropped; the rest is validated by the variable's own rules |
| Startup refused | The variable is set to a non-empty value as well as its `_FILE`; the file is empty; the file cannot be read |
| Empty value | An empty `_FILE` counts as unset |
| Compose | The templates do not pass `_FILE` variables; mounts and settings in [Other secret files](../deploy/docker.en.md#other-secret-files) |

| Variable | Instead of |
| --- | --- |
| `EDGEWEIR_MASTER_KEY_FILE` | `EDGEWEIR_MASTER_KEY` |
| `EDGEWEIR_MASTER_KEY_PREVIOUS_FILE` | `EDGEWEIR_MASTER_KEY_PREVIOUS` |
| `DATABASE_URL_FILE` | `DATABASE_URL` |
| `BETTER_AUTH_SECRET_FILE` | `BETTER_AUTH_SECRET` |
| `EDGEWEIR_CLICKHOUSE_PASSWORD_FILE` | `EDGEWEIR_CLICKHOUSE_PASSWORD`; the Compose templates give that variable a default, set it to `""` in `compose.override.yml` |

## Addresses and network

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_NODE_API_URL` | Origin URL (`https`, `wss`, `ws`) | `https://<host name of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>`; with `EDGEWEIR_NODE_API_WEBSOCKET` on, `wss://<host[:port] of EDGEWEIR_PUBLIC_URL>` (`ws://` when `EDGEWEIR_PUBLIC_URL` is `http://`) | URL nodes connect to while **System settings** → "Node channel" holds none: `https://` for the node channel port, `wss://` or `ws://` for the WebSocket entry on the web port, see [The node channel's WebSocket entry](../deploy/networking.en.md#the-node-channels-websocket-entry). Used as `--server` in node install commands; its host name goes into the node channel's server certificate. The default takes the process's `NODE_API_PORT` (`8443` in the image), not Compose's `EDGEWEIR_NODE_API_PORT`; when the host port is not `8443` or nodes use another address, save the URL in System settings or set this variable, see [Node channel URL and certificate](../deploy/networking.en.md#node-channel-url-and-certificate) |
| `EDGEWEIR_NODE_API_WEBSOCKET` | Boolean | `false` | On: without `EDGEWEIR_NODE_API_URL` the default node channel URL is the WebSocket entry (see the row above), and the WebSocket entry `/node-channel` on the web port stays open whatever URL is saved. For platforms that only forward HTTP (such as [Render](../deploy/render.en.md)). The Compose templates do not pass it |
| `EDGEWEIR_NODE_API_HOSTNAMES` | List | Empty | Extra names (DNS names or IPs) for the node channel's server certificate. The certificate always holds `localhost`, `127.0.0.1`, `::1`, the machine's host name (the container's in a container), the host of the node channel URL and the hosts of node channel URLs saved in System settings. Takes effect after a restart; enrolled nodes verify these names |
| `EDGEWEIR_TRUSTED_PROXIES` | List (IPs or CIDRs) | Empty | Trusted reverse proxies. `X-Forwarded-For` and `X-Real-IP` are used only from these addresses, for audit log IPs, sign-in rate limiting and the login allow list. Empty: the TCP peer is the client. An entry that is not an IP or CIDR stops the console. `compose.baota-host.yml` defaults to `127.0.0.1,::1`. See [Ports, reverse proxies and trusted proxies](../deploy/networking.en.md) |
| `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` | List (IPs or CIDRs, commas or whitespace) | Empty | Private or special-purpose networks the console may reach for destinations saved in the web console: alert channels, SMTP, the node release source. Empty: public addresses only. Values saved in the web console cannot widen it; a release source set by environment variable is not bound by it. An entry that is not an IP or CIDR stops the console |

## Analytics

The ClickHouse variables apply only with `EDGEWEIR_ANALYTICS=clickhouse`. The `analytics` profile of `compose.yml` creates the ClickHouse database and user from `EDGEWEIR_CLICKHOUSE_DATABASE`, `EDGEWEIR_CLICKHOUSE_USER` and the same password.

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_ANALYTICS` | Enum: `lite`, `clickhouse` | `lite` | Storage of access logs and per-minute statistics: `lite` is PostgreSQL. Switching does not migrate history. Shown as "Analytics" in **System settings**. See [Access logs](../guide/access-logs.en.md) |
| `EDGEWEIR_CLICKHOUSE_URL` | URL (`http`, `https`) | `http://clickhouse:8123` | ClickHouse HTTP interface; no user name, password, query or fragment. `compose.baota.yml` defaults to `http://host.docker.internal:8123` (the host; ClickHouse must listen on the Docker bridge address), `compose.baota-host.yml` to `http://localhost:8123` |
| `EDGEWEIR_CLICKHOUSE_DATABASE` | String, `^[A-Za-z_][A-Za-z0-9_]{0,63}$` | `edgeweir` | Database name |
| `EDGEWEIR_CLICKHOUSE_USER` | String | `edgeweir` | User name, sent in the `X-ClickHouse-User` header |
| `EDGEWEIR_CLICKHOUSE_PASSWORD` | String | Empty | Password, sent in the `X-ClickHouse-Key` header. Unset in the Compose templates: `CLICKHOUSE_PASSWORD`, then `edgeweir` |

## Certificates and DNS

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_ACME_DIRECTORY` | String (URL) | Empty | **Fallback** for the custom ACME directory of **System settings** → "Certificate authorities". While only this variable supplies the URL, requests without a CA use the custom directory. Each certificate records the directory it was issued from and asks that directory for ARI renewal windows; ACME accounts do not move between directories. See [System settings](../guide/system.en.md#certificate-authorities) and [HTTPS and certificates](../guide/https.en.md#certificate-authorities) |
| `EDGEWEIR_ACME_CA_FILE` | Path (PEM) | Empty | **Fallback** for "CA certificates (PEM)" under "Certificate authorities": issuers of the custom ACME directory's TLS certificate, used together with the system trust store |
| `EDGEWEIR_SMTP_CA_FILE` | Path (PEM) | Empty | **Fallback** for **Alerts → SMTP** → "CA certificates (PEM)": the CA for SMTP TLS, read only when the SMTP settings hold no CA. Empty: the system trust store |
| `EDGEWEIR_DNS_TEST_ENDPOINT` | String | Empty | Local DNS simulator for integration tests; enables the hidden `test` DNS provider and is passed to the certificate helper. Never set for real providers |
| `EDGEWEIR_PROBE_SOURCE_TEST_ENDPOINT` | String | Empty | Local monitoring-API simulator for integration tests; external probe source API requests go there instead. Never set it in a deployment |

## Node releases

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_NODE_RELEASE_BASE_URL` | URL (`http`, `https`), at most 2048 characters | Empty | **Fallback** for **System settings** → "Node release source". Base URL node upgrades read release manifests from: `<base>/v<version>/checksums.txt`. No user name, password, query or fragment. Empty: `https://github.com/marvinli001/edgeweir-node/releases/download` |
| `EDGEWEIR_DOWNLOADS_DIR` | Path (directory) | Unset | Directory of release files served at `/downloads/*`; `install.sh` downloads the node packages and cosign from it. Unset: `/downloads/*` answers 404 and `install.sh` downloads from GitHub. Layout: [Adding nodes](../deploy/nodes.en.md) |

## Runtime

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `ROLE` | Enum: `all`, `app`, `worker` | `all` | Process role; see [Container](cli.en.md#container) and [Deployment overview](../deploy/README.en.md#process-roles) |
| `HOST` | String | `0.0.0.0` | Listen address of the web UI and API. `compose.baota-host.yml`: `127.0.0.1` |
| `PORT` | Integer, 1–65535 | `3000` | Listen port of the web UI and API |
| `NODE_API_HOST` | String | Value of `HOST` | Listen address of the node channel. `compose.baota-host.yml`: from `EDGEWEIR_NODE_API_HOST`, default `0.0.0.0` |
| `NODE_API_PORT` | Integer, 0–65535 | `8443` | Listen port of the node channel |
| `LOG_LEVEL` | Enum: `debug`, `info`, `warn`, `error` | `info` | Log level. One JSON object per log line |
| `NODE_ENV` | Enum: `development`, `production`, `test` | `development` (image: `production`) | `production` enables rate limiting of `/api/auth`, counted in PostgreSQL |
| `EDGEWEIR_WEB_DIST` | Path (directory) | `<directory of main.js>/../web` | Directory of the built web UI; `/app/dist/web` in the image. Not used by `pnpm dev` |
| `EDGEWEIR_CERTD_BIN` | Path | `edgeweir-certd` (image: `/usr/local/bin/edgeweir-certd`) | Certificate helper; without a `/` it is looked up in `PATH`. When running from source build it with `cd helpers/certd && go build -o bin/edgeweir-certd .` and give its absolute path |
| `EDGEWEIR_VERSION` | String | `dev` (image: the build version) | Version the process reports, in `/healthz`, the OpenAPI document and "Version" in **System settings**. The image build writes the rolling version `<YYYYMMDD>-<commit>`; do not override it in the container environment. Not validated. Compose uses a host variable of the same name to pick the image tag; see [Compose host variables](#compose-host-variables) |

## Test only

For end-to-end tests (`compose.e2e.yml`) only; never set in a deployment.

| Variable | Type | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_E2E_TICK_SECONDS` | Integer, 1–59 | Unset | The worker's every-minute jobs also run every this many seconds |
| `EDGEWEIR_E2E_HEARTBEAT_SECONDS` | Integer, 1–15 | Unset (15-second node heartbeats) | Heartbeat interval sent to nodes; a node counts as online for three intervals |

## Compose host variables

Compose reads these on the host (`.env` or the shell) to interpolate the Compose files; the console process does not read them. `deploy.sh` variables: [deploy.sh reference](../deploy/deploy-script.en.md).

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_VERSION` | `stable` | Image tag to pull: `ghcr.io/marvinli001/edgeweir:<EDGEWEIR_VERSION>`. Channels `stable` and `latest`, or a dated tag `<YYYYMMDD>-<commit>`, optionally followed by `@sha256:<digest>`. See [Versions, upgrades and rollback](../deploy/upgrade.en.md) |
| `EDGEWEIR_POSTGRES_IMAGE` | `postgres:18.6-alpine` (pinned by digest) | `compose.baota.yml` only: image of the bundled PostgreSQL. `deploy.sh` writes it for offline installs (`EDGEWEIR_NO_PULL`) that cannot use the pinned version |
| `EDGEWEIR_HTTP_PORT` | `compose.yml`: `127.0.0.1:3000`; others: `3000` | Host port of the web console. `compose.yml`: a port publishing spec, optionally with a bind address (ports Docker publishes bypass ufw and firewalld); `3000` publishes on every interface. `compose.baota.yml`: a number, bound to `127.0.0.1`. `compose.baota-host.yml`: a number, used as `PORT` |
| `EDGEWEIR_NODE_API_PORT` | `8443` | Host port of the node channel. `compose.yml`, `compose.baota.yml`: a port publishing spec, optionally with a bind address. `compose.baota-host.yml`: a number, used as `NODE_API_PORT` |
| `EDGEWEIR_NODE_API_HOST` | `0.0.0.0` | `compose.baota-host.yml` only: listen address of the node channel, used as `NODE_API_HOST`; `127.0.0.1` behind an nginx `stream` on the same host. Set it in `.env`: panels run Compose with `-f`, which skips `compose.override.yml` |
| `POSTGRES_PASSWORD` | None | Password of the bundled PostgreSQL; `compose.yml` and `compose.baota.yml` build `DATABASE_URL` from it and refuse to start without it (deployments created without it used `edgeweir`). Must be URL-safe: `openssl rand -hex 24`. The PostgreSQL image applies it only to an empty data directory; changing it later does not change the existing password |
| `COMPOSE_PROFILES` | Empty | Compose profiles, comma-separated. `analytics`: the ClickHouse service of `compose.yml`; in `.env` every `docker compose` and `deploy.sh` command includes it without `--profile` |
| `CLICKHOUSE_PASSWORD` | `edgeweir` | ClickHouse password while `EDGEWEIR_CLICKHOUSE_PASSWORD` is unset, shared by the console and the ClickHouse container of the `analytics` profile |
| `DEV_POSTGRES_PORT` | `5432` | `compose.dev.yml`: port of the development database on `127.0.0.1` |

### Variables passed to the container

The Compose files pass the other console variables into the container as `${variable:-default}`. The table lists fixed values and the variables not passed; a variable not passed has no effect in `.env`; add it to the service's `environment` (`compose.override.yml`) when needed.

| Compose file | Fixed values | Not passed |
| --- | --- | --- |
| `compose.yml` | `ROLE=all`; `DATABASE_URL` built from `POSTGRES_PASSWORD` | `_FILE` variables, `EDGEWEIR_NODE_API_WEBSOCKET`, `HOST`, `PORT`, `NODE_API_HOST`, `NODE_API_PORT`, `NODE_ENV`, `EDGEWEIR_WEB_DIST`, `EDGEWEIR_CERTD_BIN`, `EDGEWEIR_DNS_TEST_ENDPOINT`, `EDGEWEIR_VERSION`, `EDGEWEIR_E2E_*` |
| `compose.baota.yml` | `ROLE=all`; `DATABASE_URL` built from `POSTGRES_PASSWORD` | As `compose.yml`, plus `LOG_LEVEL`, `EDGEWEIR_DOWNLOADS_DIR` |
| `compose.baota-host.yml` | `ROLE=all`, `HOST=127.0.0.1`; `PORT`, `NODE_API_HOST`, `NODE_API_PORT` from `EDGEWEIR_HTTP_PORT`, `EDGEWEIR_NODE_API_HOST`, `EDGEWEIR_NODE_API_PORT` | `_FILE` variables, `EDGEWEIR_NODE_API_WEBSOCKET`, `NODE_ENV`, `EDGEWEIR_WEB_DIST`, `EDGEWEIR_CERTD_BIN`, `EDGEWEIR_DNS_TEST_ENDPOINT`, `EDGEWEIR_VERSION`, `EDGEWEIR_E2E_*`, `LOG_LEVEL`, `EDGEWEIR_DOWNLOADS_DIR` |
