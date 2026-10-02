# Environment variables

Variables the console process reads, with defaults and validation, plus the host variables used by the Compose files.

## Loading and validation

- The process reads and validates every variable once at startup. An invalid value stops the process; the log line starts with `invalid configuration:` and names the variables.
- Recreate the container after a change: `docker compose up -d`. `docker compose restart` does not apply new values.
- An empty `BETTER_AUTH_SECRET`, `EDGEWEIR_NODE_API_URL`, `NODE_API_HOST`, or `EDGEWEIR_NODE_RELEASE_BASE_URL` counts as unset; an empty value of any other variable is validated as is, e.g. `ROLE=` is invalid.
- The Default column is the process default. Values set by the image or a Compose file are given in the Description column.
- **Fallback**: a value saved in **System** wins; clearing the saved value restores the variable.
- Template with comments: [`.env.example`](https://github.com/marvinli001/edgeweir/blob/master/.env.example).

## Required

With `compose.yml` or `compose.baota.yml`, `DATABASE_URL` is built from the [Compose host variable](#compose-host-variables) `POSTGRES_PASSWORD`.

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | None | Master key. Canonical base64 (standard or URL-safe alphabet) of at least 32 bytes; the console refuses to start on any other character, such as a space or a quote, or on fewer than 32 bytes. Generate it with `openssl rand -base64 32` and use the output as is (keep `/`, `+`, and `=`). A key other than the one the database's secrets were encrypted with stops the console with `EDGEWEIR_MASTER_KEY does not match this database`; restore the original key rather than setting `BETTER_AUTH_SECRET`. Envelope-encrypts private keys, DNS API keys, and other secrets at rest, and derives the session secret. Losing it makes encrypted data unrecoverable; back it up separately from the database. |
| `EDGEWEIR_MASTER_KEY_FILE` | Unset | File holding the master key (for example a Docker secret), instead of `EDGEWEIR_MASTER_KEY`; its trailing newline is ignored and the content is checked like `EDGEWEIR_MASTER_KEY`. The console refuses to start when `EDGEWEIR_MASTER_KEY` is also set to a non-empty value or the file cannot be read. The Compose templates do not pass it; see [Master key file](../deploy/docker.en.md#master-key-file). |
| `DATABASE_URL` | None | PostgreSQL 18 connection string. At startup the console waits up to 60 seconds for the database, then runs migrations. `compose.yml` and `compose.baota.yml` build it from `POSTGRES_PASSWORD` and ignore the `.env` value; `compose.baota-host.yml` requires it in `.env`. |
| `EDGEWEIR_PUBLIC_URL` | `http://localhost:3000` | URL browsers use to reach the console; behind a reverse proxy, the proxy URL. Format `http(s)://host[:port]`, without path, query, fragment, user name, or password; a trailing `/` and the default port are dropped. Any other value stops the console at startup. Used for the trusted origin of the authentication endpoints, the `Secure` attribute of session cookies (with `https://`), the passkey RP ID (host name), the `servers` entry of the OpenAPI document, the console URL in `/install.sh`, links in alert notifications, and the default host of `EDGEWEIR_NODE_API_URL`. The default only suits local access: node install commands and alert links would point to localhost. |

## Session secret

| Variable | Default | Description |
| --- | --- | --- |
| `BETTER_AUTH_SECRET` | Derived from the master key | Secret that signs sessions and encrypts two-factor secrets; at least 32 characters. Unset: derived from the master key with HKDF-SHA256 (parameters in [SECURITY.en.md](../../SECURITY.en.md)). A deployment that has set it must keep the value: removing it stops the console from starting; a new value starts the console with a warning, ends every session, and makes enrolled two-factor secrets unreadable. |

## Addresses and network

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_NODE_API_URL` | `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>` | URL nodes use to reach the node channel, in the form `https://host[:port]` (same rules as `EDGEWEIR_PUBLIC_URL`). Used as `--server` in node install commands and shown as "Node channel" in **System**; its host goes into the node channel server certificate. The default uses the process `NODE_API_PORT` (`8443` in the image), not Compose's `EDGEWEIR_NODE_API_PORT`; set this variable when the host port is not `8443` or nodes connect through another address. |
| `EDGEWEIR_NODE_API_HOSTNAMES` | Empty | Extra names (DNS names or IPs) for the node channel server certificate, comma separated. The certificate always includes `localhost`, `127.0.0.1`, `::1`, the machine host name (the container host name in a container), and the host of `EDGEWEIR_NODE_API_URL`. The certificate is issued at every start; enrolled nodes verify these names. |
| `EDGEWEIR_TRUSTED_PROXIES` | Empty | Trusted reverse proxies as IPs or CIDRs, comma separated. `X-Forwarded-For` and `X-Real-IP` are used only from these addresses, for audit log IPs and sign-in rate limiting. Empty: the TCP peer is the client. An entry that is not an IP or CIDR stops the console from starting. `compose.baota-host.yml` defaults to `127.0.0.1,::1`. Configuration: [Ports, reverse proxy, and trusted proxies](../deploy/networking.en.md). |
| `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` | Empty | Private or special-purpose ranges (CIDRs, separated by commas or whitespace) the console may reach for destinations saved in the web console: alert notification channels, SMTP, and the node release source. Empty: public addresses only. Values saved in the web console cannot widen this boundary. A release source set through an environment variable is not bound by it. The console refuses to start on an entry that is not an IP address or CIDR range. |

## Analytics

The ClickHouse variables apply only with `EDGEWEIR_ANALYTICS=clickhouse`. The `analytics` profile of `compose.yml` creates the ClickHouse database and user from `EDGEWEIR_CLICKHOUSE_DATABASE`, `EDGEWEIR_CLICKHOUSE_USER`, and the same password.

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_ANALYTICS` | `lite` | Storage for access logs and per-minute statistics: `lite` (PostgreSQL) or `clickhouse`. Switching does not migrate history. Shown as "Analytics" in **System**. Behavior: [Access logs and AccessKey](../guide/access-logs.en.md). |
| `EDGEWEIR_CLICKHOUSE_URL` | `http://clickhouse:8123` | ClickHouse HTTP interface. `http` or `https` only, without user name, password, query, or fragment. `compose.baota.yml` defaults to `http://host.docker.internal:8123` (the host; ClickHouse must listen on the Docker bridge address), `compose.baota-host.yml` to `http://localhost:8123`. |
| `EDGEWEIR_CLICKHOUSE_DATABASE` | `edgeweir` | Database name; must match `^[A-Za-z_][A-Za-z0-9_]{0,63}$`. |
| `EDGEWEIR_CLICKHOUSE_USER` | `edgeweir` | User name, sent in the `X-ClickHouse-User` header. |
| `EDGEWEIR_CLICKHOUSE_PASSWORD` | Empty | Password, sent in the `X-ClickHouse-Key` header. When unset, the Compose files use `CLICKHOUSE_PASSWORD`, then `edgeweir`. |

## Certificates and DNS

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_ACME_DIRECTORY` | Empty | ACME directory URL for every certificate; overrides the CA chosen per certificate. Private PKI and tests only; ACME accounts do not move between directories. Empty: Let's Encrypt or ZeroSSL, chosen per certificate ([HTTPS and certificates](../guide/https.en.md)). |
| `EDGEWEIR_ACME_CA_FILE` | Empty | Path of a PEM file the certificate helper uses to verify the ACME directory's TLS certificate. Used with `EDGEWEIR_ACME_DIRECTORY`. |
| `EDGEWEIR_SMTP_CA_FILE` | Empty | **Fallback** for **System → SMTP** → "CA certificates (PEM)". CA for SMTP TLS (path of a PEM file), used only when the SMTP settings hold no CA. Empty: the system trust store. |
| `EDGEWEIR_DNS_TEST_ENDPOINT` | Empty | Address of the local DNS simulator for integration tests; enables the `test` DNS provider. Never set it for real providers. |

## Node releases

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_NODE_RELEASE_BASE_URL` | Empty | **Fallback** for **System → Node release source**. Base URL node upgrades read release manifests from, at `<base>/v<version>/checksums.txt`. `http` or `https` only, without user name, password, query, or fragment; at most 2048 characters. Empty: `https://github.com/marvinli001/edgeweir-node/releases/download`. |
| `EDGEWEIR_DOWNLOADS_DIR` | Unset | Directory of release files served at `/downloads/*`, from which `install.sh` downloads node packages and cosign. Unset: `/downloads/*` returns 404 and `install.sh` downloads from GitHub. Directory layout: [Adding nodes](../deploy/nodes.en.md). |

## Runtime

| Variable | Default | Description |
| --- | --- | --- |
| `ROLE` | `all` | Process role: `all`, `app`, or `worker`. Components per role: [Deployment overview](../deploy/README.en.md#process-roles). |
| `HOST` | `0.0.0.0` | Listen address of the web UI and API. `compose.baota-host.yml`: `127.0.0.1`. |
| `PORT` | `3000` | Listen port of the web UI and API, 1–65535. |
| `NODE_API_HOST` | Value of `HOST` | Listen address of the node channel. `compose.baota-host.yml`: `0.0.0.0`. |
| `NODE_API_PORT` | `8443` | Listen port of the node channel. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, or `error`. Logs are one JSON object per line. |
| `NODE_ENV` | `development` (image: `production`) | `development`, `production`, or `test`. `production` enables rate limiting of the authentication endpoints, with counters in PostgreSQL. |
| `EDGEWEIR_WEB_DIST` | `<directory of main.js>/../web` | Directory of the built web UI; resolves to `/app/dist/web` in the image. Not used by `pnpm dev`. |
| `EDGEWEIR_CERTD_BIN` | `edgeweir-certd` (image: `/usr/local/bin/edgeweir-certd`) | Path of the certificate helper; looked up in `PATH` when it contains no `/`. From source, build it with `cd helpers/certd && go build -o bin/edgeweir-certd .` and set its absolute path. |
| `EDGEWEIR_TELEMETRY` | `false` | Anonymous usage telemetry. Accepts `true`, `1`, `yes`, `on` and `false`, `0`, `no`, `off`. The current version sends nothing; the state is shown as "Telemetry" in **System**. |
| `EDGEWEIR_VERSION` | `dev` (image: build version) | Version the process reports in `/healthz`, the OpenAPI document, and "Version" in **System**. The image build sets the rolling version `<YYYYMMDD>-<commit>`; do not override it in the container environment. Compose uses a host variable of the same name to pick the image tag; see [Compose host variables](#compose-host-variables). |

## Compose host variables

Compose reads these variables on the host (`.env` or the shell environment) to interpolate the Compose files; the console process does not read them. For the unattended variables of `deploy.sh`, see [deploy.sh reference](../deploy/deploy-script.en.md).

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_VERSION` | `latest` | Image tag to pull: `ghcr.io/marvinli001/edgeweir:<EDGEWEIR_VERSION>`. Rolling tags are `<YYYYMMDD>-<commit>`; `@sha256:<digest>` may be appended. See [Versions, upgrades, and rollback](../deploy/upgrade.en.md). |
| `EDGEWEIR_HTTP_PORT` | `3000` | Host port of the web console. `compose.yml`: a port publishing spec, may include a bind address, default `127.0.0.1:3000` (ports Docker publishes bypass ufw and firewalld); `3000` publishes it on every interface. `compose.baota.yml`: number only, bound to `127.0.0.1`. `compose.baota-host.yml`: number only, used as `PORT`. |
| `EDGEWEIR_NODE_API_PORT` | `8443` | Host port of the node channel. `compose.yml` and `compose.baota.yml`: a port publishing spec, may include a bind address. `compose.baota-host.yml`: number only, used as `NODE_API_PORT`. |
| `POSTGRES_PASSWORD` | None | Password of the bundled PostgreSQL; `compose.yml` and `compose.baota.yml` build `DATABASE_URL` from it, and refuse to start without it (deployments created without it used `edgeweir`). Must be URL-safe: `openssl rand -hex 24`. The PostgreSQL image applies it only to an empty data directory; changing it later does not change the existing password. |
| `CLICKHOUSE_PASSWORD` | `edgeweir` | ClickHouse password when `EDGEWEIR_CLICKHOUSE_PASSWORD` is unset, shared by the console and the ClickHouse container of the `analytics` profile. |
| `DEV_POSTGRES_PORT` | `5432` | `compose.dev.yml`: port of the development database on `127.0.0.1`. |

### Variables passed to the container

The Compose files pass the remaining console variables as `${VARIABLE:-default}`. The table lists fixed values and variables that are not passed; a variable that is not passed has no effect in `.env`; add it to the service's `environment` when needed.

| Compose file | Fixed values | Not passed |
| --- | --- | --- |
| `compose.yml` | `ROLE=all` | `EDGEWEIR_MASTER_KEY_FILE`, `HOST`, `PORT`, `NODE_API_HOST`, `NODE_API_PORT`, `NODE_ENV`, `EDGEWEIR_WEB_DIST`, `EDGEWEIR_CERTD_BIN`, `EDGEWEIR_DNS_TEST_ENDPOINT`, `EDGEWEIR_VERSION` |
| `compose.baota.yml` | `ROLE=all` | Same as `compose.yml`, plus `EDGEWEIR_TELEMETRY`, `LOG_LEVEL`, and `EDGEWEIR_DOWNLOADS_DIR` |
| `compose.baota-host.yml` | `ROLE=all`, `HOST=127.0.0.1`, `NODE_API_HOST=0.0.0.0`; `PORT` and `NODE_API_PORT` from the host port variables | `EDGEWEIR_MASTER_KEY_FILE`, `NODE_ENV`, `EDGEWEIR_WEB_DIST`, `EDGEWEIR_CERTD_BIN`, `EDGEWEIR_DNS_TEST_ENDPOINT`, `EDGEWEIR_VERSION`, `EDGEWEIR_TELEMETRY`, `LOG_LEVEL`, and `EDGEWEIR_DOWNLOADS_DIR` |
