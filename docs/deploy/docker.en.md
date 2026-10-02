# Docker Compose

Deploy the console image with Docker Compose, or without Compose using `docker run`.

Runtime requirements and other platforms: [deployment overview](README.en.md). BaoTa / aaPanel and `deploy.sh`: [baota.en.md](baota.en.md).

## Compose services

The `compose.yml` project name is `edgeweir`: the volume is `edgeweir_postgres-data`, the network `edgeweir_default`.

| Service | Image | Enabled | Notes |
| --- | --- | --- | --- |
| `console` | `ghcr.io/marvinli001/edgeweir:${EDGEWEIR_VERSION:-latest}` | Default | `ROLE=all`; publishes `${EDGEWEIR_HTTP_PORT:-3000}:3000` and `${EDGEWEIR_NODE_API_PORT:-8443}:8443`; read-only root file system, `/tmp` on tmpfs, `no-new-privileges` |
| `postgres` | `postgres:18.6-alpine` (pinned by digest) | Default | Volume `postgres-data` mounted at `/var/lib/postgresql`; no published port; `console` starts after the `pg_isready` health check passes |
| `clickhouse` | `clickhouse/clickhouse-server:26.9-alpine` (pinned by digest) | `--profile analytics` | Volume `clickhouse-data` |
| `valkey` | `valkey/valkey:9.2-alpine` (pinned by digest) | `--profile cache` | Not used by the console yet |

The image is public; pulling needs no login. Tag rules: [versions, upgrades, and rollback](upgrade.en.md).

## 1. Prepare

1. Provision a Linux server (amd64 or arm64) with Docker Engine and Docker Compose v2:

   ```bash
   docker compose version
   ```

2. Open 8443/TCP in the firewall and cloud security group. Exposure of 3000/TCP: [ports and reverse proxy](networking.en.md).

## 2. Fetch the files

The server needs only `compose.yml` and `.env`.

```bash
mkdir -p /opt/edgeweir && cd /opt/edgeweir
curl -fsSLO https://raw.githubusercontent.com/marvinli001/edgeweir/master/compose.yml
umask 077
curl -fsSL -o .env https://raw.githubusercontent.com/marvinli001/edgeweir/master/.env.example
```

## 3. Generate secrets

```bash
sed -i "s|^EDGEWEIR_MASTER_KEY=.*|EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)|" .env
sed -i "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=$(openssl rand -hex 24)|" .env
```

| Variable | Command | Constraint |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | `openssl rand -base64 32` | Use the output as is, keeping `/`, `+`, and `=`; the console refuses to start on any other character or when it decodes to fewer than 32 bytes. |
| `POSTGRES_PASSWORD` | `openssl rand -hex 24` | Embedded in `DATABASE_URL`; letters and digits only. |

> [!WARNING]
> The master key encrypts the internal CA key, certificate keys, S3 origin keys, DNS API credentials, and the setup token at rest, and derives the session secret. Back it up offline, apart from database backups; without it that data is unrecoverable.

### Master key file

The master key can stay out of `.env`: put it in a file mounted as a Compose secret and leave `EDGEWEIR_MASTER_KEY` in `.env` empty.

```bash
umask 077
openssl rand -base64 32 > master.key
chown 1000 master.key   # the image runs as the node user (uid 1000)
sed -i "s|^EDGEWEIR_MASTER_KEY=.*|EDGEWEIR_MASTER_KEY=|" .env
```

`compose.override.yml` next to `compose.yml` (Compose merges it automatically):

```yaml
services:
  console:
    environment:
      EDGEWEIR_MASTER_KEY_FILE: /run/secrets/edgeweir_master_key
    secrets:
      - edgeweir_master_key
secrets:
  edgeweir_master_key:
    file: ./master.key
```

The file's trailing newline is ignored; the console refuses to start when `EDGEWEIR_MASTER_KEY` is also set to a non-empty value or the file cannot be read.

## 4. Configure `.env`

Set the console URL:

```bash
sed -i "s|^EDGEWEIR_PUBLIC_URL=.*|EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com|" .env
```

Required variables:

| Variable | Description |
| --- | --- |
| `EDGEWEIR_MASTER_KEY` | Master key, from the previous step. The console refuses to start without it. |
| `POSTGRES_PASSWORD` | Password of the bundled PostgreSQL. `compose.yml` builds `DATABASE_URL` from it and ignores the `DATABASE_URL` line in `.env`. |
| `EDGEWEIR_PUBLIC_URL` | URL browsers use for the console, including scheme and port. Must match the browser address bar; otherwise sign-in fails the origin check. |

Common optional variables (uncomment in `.env`):

| Variable | Default | Description |
| --- | --- | --- |
| `EDGEWEIR_VERSION` | `latest` | Image tag to pull. Pin a dated tag in production; see [pinning a version](upgrade.en.md#pinning-a-version). |
| `EDGEWEIR_NODE_API_URL` | `https://<host of EDGEWEIR_PUBLIC_URL>:8443` | URL nodes use for the node channel; see [node channel URL and certificate](networking.en.md#node-channel-url-and-certificate). |
| `EDGEWEIR_TRUSTED_PROXIES` | Empty | Reverse proxy addresses; see [trusted proxies](networking.en.md#trusted-proxies-and-client-ip). |
| `EDGEWEIR_HTTP_PORT`, `EDGEWEIR_NODE_API_PORT` | `3000`, `8443` | Published host ports, optionally with a bind address such as `127.0.0.1:3000`. |
| `BETTER_AUTH_SECRET` | Empty, derived from the master key | Deployments that set it keep it; the console refuses to start once it is removed. |
| `EDGEWEIR_DOWNLOADS_DIR` | Empty | Directory of the node package mirror; see [downloads mirror](nodes.en.md#downloads-mirror). |

All variables: [environment variables](../reference/environment.en.md).

After setup, SMTP, the node release source, the origin allow list, and GeoIP are configured in **System**; saving applies them without a restart. Values saved there take precedence over `EDGEWEIR_SMTP_CA_FILE` and `EDGEWEIR_NODE_RELEASE_BASE_URL` in `.env`, which take precedence over the defaults. `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` bounds the outbound addresses saved there; the web console cannot widen it.

## 5. Start

```bash
docker compose pull
docker compose up -d
docker compose logs -f console
```

Startup sequence:

| Order | Behavior | Log |
| --- | --- | --- |
| 1 | Waits for the database, up to 60 seconds | `database not reachable yet` |
| 2 | Runs database migrations | `database migrated` |
| 3 | On first start, creates the node channel internal CA; its private key is encrypted with the master key | — |
| 4 | While uninitialized, prints the setup token | `first-run setup` |
| 5 | Node channel listens on 8443 and logs the CA fingerprint | `node channel listening` (`caSha256`) |
| 6 | Web console and API listen on 3000 | `console listening` |

## 6. Run setup

1. Read the setup token:

   ```bash
   docker compose logs console | grep setupToken
   ```

   An uninitialized console prints the same token at every start until it is used. The token is stored encrypted with the master key; a new master key yields a new token.

2. Open `<EDGEWEIR_PUBLIC_URL>/setup` and enter the setup token, name, email, and password to create the console account. The console also creates the default cluster `default`. Setup wizard: [quick start](../guide/first-site.en.md).

Setup requests without a token or with a wrong token are rejected and written to the audit log. The token expires after a successful setup.

## 7. Verify

```bash
curl -s http://127.0.0.1:3000/healthz
docker compose ps
```

Expected: `{"status":"ok","version":"<image tag>"}`; `console` is `healthy`.

## Optional components

| Profile | Component | Enable |
| --- | --- | --- |
| `analytics` | ClickHouse: raw access logs and per-minute statistics | Set `EDGEWEIR_ANALYTICS=clickhouse` and `CLICKHOUSE_PASSWORD` in `.env` |
| `cache` | Valkey | Not used by the console yet |

```bash
docker compose --profile analytics up -d
```

Console charts and alerts use PostgreSQL rollups. Access-log sampling is off by default and is enabled on a site's logs page; raw logs are retained for 7 days. Switching the storage mode does not migrate history. Details: [access logs and AccessKeys](../guide/access-logs.en.md).

## Build from source

```bash
git clone https://github.com/marvinli001/edgeweir.git /opt/edgeweir
cd /opt/edgeweir
docker compose up -d --build
```

The remaining steps are the same. The locally built image takes the same tag and reports version `dev`; run `docker compose pull` before returning to a published image.

## Without Compose: standalone containers

`compose.yml` is equivalent to two containers on a dedicated network. With an existing PostgreSQL 18, omit `edgeweir-postgres` and point `DATABASE_URL` at that database.

```bash
cd /opt/edgeweir
umask 077
POSTGRES_PASSWORD=$(openssl rand -hex 24)
cat > console.env <<ENV
DATABASE_URL=postgres://edgeweir:${POSTGRES_PASSWORD}@edgeweir-postgres:5432/edgeweir
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com
EDGEWEIR_NODE_API_URL=https://cdn-admin.example.com:8443
ENV

docker network create edgeweir
docker run -d --name edgeweir-postgres --network edgeweir --restart unless-stopped \
  -e POSTGRES_USER=edgeweir -e POSTGRES_DB=edgeweir -e POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  -v edgeweir-postgres:/var/lib/postgresql \
  postgres:18.6-alpine@sha256:77f585114c32fbca283dc835b0596f4e52b51b4c6662d7810b2f4084f60a1873
docker run -d --name edgeweir-console --network edgeweir --restart unless-stopped \
  --env-file console.env -e ROLE=all \
  -p 127.0.0.1:3000:3000 -p 8443:8443 \
  --read-only --tmpfs /tmp --security-opt no-new-privileges:true \
  ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d
```

| Item | Constraint |
| --- | --- |
| `console.env` | Same variables as the `environment` of `compose.yml`; add optional variables as needed. Deployments that set `BETTER_AUTH_SECRET` keep its value. |
| `EDGEWEIR_VERSION` | Not in `console.env`: inside the image it carries the running version. The tag in the image reference selects the version. |
| `DATABASE_URL` | `127.0.0.1` inside the container is the container itself, not the host. |
| PostgreSQL volume | Mount at `/var/lib/postgresql`: PostgreSQL 18 images keep data under `/var/lib/postgresql/<major>/docker`. |
| Hardening flags | `--read-only`, `--tmpfs /tmp`, and `--security-opt no-new-privileges:true` match `compose.yml`. |

Upgrading standalone containers: [upgrade](upgrade.en.md#upgrade).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Log `invalid configuration:` followed by variable names | Variable missing or malformed | Fix the listed variables in `.env`, then run `docker compose up -d`. |
| `EDGEWEIR_MASTER_KEY: is not valid base64` or `must be at least 32 bytes` | Master key truncated or edited, for example a panel turned `+` into a space, or the value is quoted | Use the unmodified output of `openssl rand -base64 32`. |
| `EDGEWEIR_MASTER_KEY does not match this database` | The master key is not the one this database uses: the key changed, or the database comes from another installation | Restore the original master key (the original `.env` or its offline copy); setting `BETTER_AUTH_SECRET` does not help. |
| `BETTER_AUTH_SECRET is not set, but this database was used with another secret` | `BETTER_AUTH_SECRET` removed from an existing deployment | Restore the previous value. |
| `database not reachable yet` repeats, exit after 60 seconds | Database unreachable | Check the database container with `docker compose ps postgres`; for an external database, check `DATABASE_URL`. |
| Sign-in fails, or the origin is reported as untrusted | Scheme, host, or port of `EDGEWEIR_PUBLIC_URL` differs from the browser address | Correct `EDGEWEIR_PUBLIC_URL`, then run `docker compose up -d`. |
| `console` is `unhealthy` | `/healthz` does not answer | `docker compose logs console`. |
| Node enrollment or connection fails | — | See [adding nodes: troubleshooting](nodes.en.md#troubleshooting). |
