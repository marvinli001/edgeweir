# Edgeweir

[简体中文](README.md) | English

[![CI](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml)
[![Docs](https://github.com/marvinli001/edgeweir/actions/workflows/docs.yml/badge.svg?branch=master)](https://marvinli001.github.io/edgeweir/en/)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Self-hosted CDN / WAF / edge scheduling control plane for personal use: one operator account manages edge nodes, origin pools, caching, HTTPS, layer-4 forwarding, access policy and DNS steering from one console. Edge nodes: [edgeweir-node](https://github.com/marvinli001/edgeweir-node).

Documentation: <https://marvinli001.github.io/edgeweir/en/>

## Features

| Area | Capabilities |
| --- | --- |
| Clusters and account | Node groups, regions, configuration canary, 2FA / passkeys, service accounts, audit log |
| Origins and cache | Origin pools and origin groups, active and passive health checks, session affinity, origin TLS verification, S3-signed origins, HTTP/2 and gRPC to origins, WebSocket, expression cache rules with browser TTLs, cache keys, slicing, purge by URL / directory / host / Cache-Tag, prefetch per device and from sitemaps, a keyed PURGE method, cache zones sized per cluster and node, caching responses with Set-Cookie (the cookies go only to the request that fetched them), origin tries and status retries, request body limits, charsets, object storage presets, error pages per status and for 4xx / 5xx (HTML or redirect), maintenance mode |
| Layer-4 forwarding | TCP / UDP port pools per cluster; L4 apps with weighted and backup origins, passive health checks, connect and idle timeouts, PROXY protocol v1 / v2 to origins and on the listener, port ranges and same-port origins, TLS termination for TCP, allow / block lists, per-node concurrency and new-connection limits; the same DNS steering as sites (CNAME, resolution lines, backup node groups); per-minute connections, refusals, peak concurrency and traffic; open connections survive port changes |
| Certificates and protocols | Certificate upload, ACME HTTP-01 / DNS-01 issuance and renewal, HTTPS, HSTS, HTTP/2, HTTP/3; listener ports besides 80 / 443 and the ports a site is bound to, redirect status and port; client addresses from the PROXY protocol or a trusted proxy header; Zstandard, Brotli and Gzip compression (Gzip level, largest compressed length) |
| Access policy | IP lists (global allow / block), local GeoIP, phased rules with built-in functions, WAF, rate limits, dynamic redirects and rewrites, bulk redirects, request and response header transforms, origin override and compression rules, per-request site setting overrides; IP bans delivered within seconds, global bans optionally dropped in the kernel by nftables |
| Managed rules | OWASP CRS: detect or block, paranoia level, anomaly threshold, exclusions by rule ID, request body limit; matched-rule statistics and access logs |
| Challenges and CC mitigation | Four challenge levels (cookie redirect, JavaScript, proof of work, image captcha); site or global Under Attack; tiered CC escalation decided locally on each node (site, per-URL, per-IP automatic bans, origin error rate); signed passes valid across the cluster; JA4 fingerprints in rules, rate limits and access logs |
| DNS and observability | Independent DNS revisions, healthy-node steering, deduplicated traffic statistics and rollups, Top URL / IP, alerts and subscriptions |
| Scheduling | Regional probes (TCP / HTTP / HTTPS health endpoint), node host metrics, scheduling rules that remove nodes or switch to backup node groups or backup IPs by metrics and probe results (with a preview); carrier resolution lines (DNSPod, Tencent Cloud, Alibaba Cloud, Huawei Cloud), backup node groups, multi-level backup IPs |
| Operations | Sampled access logs with CSV export, optional ClickHouse, read-only and revocable AccessKeys, signed canary upgrades with rollback, performance baseline, backup and recovery |

## Architecture

| Repository | Contents |
| --- | --- |
| [edgeweir](https://github.com/marvinli001/edgeweir) (this repo) | Console: web UI, management API (including OpenAPI at `/api/v1`), node channel and pg-boss workers in one process and one image. The image includes `edgeweir-certd` (Go) for ACME issuance and DNS record management, invoked by pg-boss over a bounded stdin/stdout protocol; credentials never appear in process arguments. |
| [edgeweir-node](https://github.com/marvinli001/edgeweir-node) | Edge node: the `edgeweir-node` Go agent and the OpenResty data plane. |

```
browser, API clients ──:3000──▶ ┌───────────────────────────────────┐
                                │ console (one Node.js process)     │── PostgreSQL 18 (the only dependency)
                                │   UI · /rpc · /api/v1             │
                                │   node channel :8443 (mTLS)       │
                                │   pg-boss workers                 │
                                └────────────────▲──────────────────┘
                                                 │ Connect-RPC over mTLS
                                ┌────────────────┴──────────────────┐
                 end users ───▶ │ edge node: edgeweir-node agent    │──▶ origins
                                │            + OpenResty            │
                                └───────────────────────────────────┘
```

The only contract between console and node is the protobuf in `proto/`, managed with buf. Design details: [ARCHITECTURE.en.md](ARCHITECTURE.en.md) (Chinese).

## Security baseline

- The console never stores SSH credentials.
- Node private keys are generated and kept on the node and never leave it.
- Internal CA keys, certificate keys, S3 origin keys and DNS API credentials are envelope-encrypted with `EDGEWEIR_MASTER_KEY` before they reach the database; each ciphertext is bound to its row.
- Enrollment tokens are single-use and stored as SHA-256 only; after enrollment every node RPC requires mTLS.
- `/api/v1` accepts only `x-api-key`; `/rpc` accepts only the session cookie plus the CSRF header.
- No vendor phone-home, no license checks and no telemetry; third-party telemetry is hard-disabled.

Trust baseline, vulnerability reporting and release verification: [SECURITY.en.md](SECURITY.en.md).

## Releases

| Artifact | Location | Versioning |
| --- | --- | --- |
| Console image | `ghcr.io/marvinli001/edgeweir` (amd64 / arm64) | Rolling: every `master` commit that passes CI is published as `<YYYYMMDD>-<commit>` (e.g. `20260929-a1b2c3d`); `latest` tracks the newest. No semantic version numbers. Signed with cosign keyless. |
| Edge node | [edgeweir-node Releases](https://github.com/marvinli001/edgeweir-node/releases) | Signed releases, versioned `vX.Y.Z`. |

Pin a dated tag in production with `EDGEWEIR_VERSION`.

## Quick start

Requirements: Docker with Compose v2.

```sh
git clone https://github.com/marvinli001/edgeweir.git
cd edgeweir

umask 077
cat > .env <<EOF
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EDGEWEIR_PUBLIC_URL=http://localhost:3000
EOF

docker compose pull        # build from source: docker compose up -d --build
docker compose up -d
docker compose logs console | grep setupToken
```

Open <http://localhost:3000> (port 3000 listens on localhost only by default; other machines go through a [reverse proxy](docs/deploy/networking.en.md)) and complete the setup wizard with the one-time setup token from the log. The wizard creates the only operator account and a default cluster. The token expires after the first successful setup; setup requests without it are rejected.

### Environment variables

Required variables:

| Variable | Description |
| --- | --- |
| `EDGEWEIR_MASTER_KEY` or `EDGEWEIR_MASTER_KEY_FILE` | Master key, or a file holding it ([master key file](docs/deploy/docker.en.md#master-key-file)). Envelope-encrypts secrets at rest (internal CA key, certificate keys, S3 origin keys, DNS API credentials, setup token) and derives the session secret. **Back it up separately from the database; without it that data is unrecoverable.** |
| `POSTGRES_PASSWORD` or `DATABASE_URL` | With Compose: password of the bundled PostgreSQL, from which `DATABASE_URL` is built. Without Compose: the PostgreSQL 18 connection string `DATABASE_URL`. |
| `EDGEWEIR_PUBLIC_URL` | URL browsers use for the console; behind a reverse proxy, the proxy URL, e.g. `https://cdn-admin.example.com`. It must match the browser address bar or sign-in fails; with `http://localhost:3000` the generated node install commands point to localhost as well. |

All other variables have defaults; see [.env.example](.env.example). `BETTER_AUTH_SECRET` is derived from the master key when unset; deployments that set it must keep it, or the console refuses to start. The node release source and the origin allow list are configured after setup in **System**; bans, platform protection and GeoIP in **Protection settings**; SMTP on the **Alerts** page.

### Optional components

| Compose profile | Component | Description |
| --- | --- | --- |
| `analytics` | ClickHouse | With `EDGEWEIR_ANALYTICS=clickhouse`, stores raw access logs and per-minute statistics. Access-log sampling is off by default; logs are retained for 7 days. Console charts and alerts use PostgreSQL rollups. |

See [access logs and AccessKeys](docs/guide/access-logs.en.md) and [backup and recovery](docs/deploy/backup.en.md).

### Ports

| Port | Purpose | Reverse proxy |
| --- | --- | --- |
| 3000 | Web console and API | TLS may be terminated in front (e.g. BaoTa nginx). Add the proxy address to `EDGEWEIR_TRUSTED_PROXIES` so audit entries and sign-in rate limits see the client IP; forwarding headers from other sources are ignored. |
| 8443 | Node channel | Expose directly or pass through at layer 4 with nginx `stream`. **Never terminate TLS on a proxy**: the console terminates TLS itself and enforces mTLS. Where the platform forwards HTTP only, nodes use the WebSocket entry `/node-channel` on 3000, with the node channel's TLS inside the WebSocket; see [The node channel's WebSocket entry](docs/deploy/networking.en.md#the-node-channels-websocket-entry). |

### Deployment options

| Platform | Guide |
| --- | --- |
| Docker Compose / `docker run` | [Docker Compose](docs/deploy/docker.en.md) |
| BT Panel / aaPanel | [BT Panel / aaPanel](docs/deploy/baota.en.md), [deploy.sh reference](docs/deploy/deploy-script.en.md) |
| Railway | [Railway](docs/deploy/railway.en.md) |
| Fly.io | [Fly.io](docs/deploy/fly.en.md) |
| bunny.net Magic Containers | [bunny.net Magic Containers](docs/deploy/bunny.en.md) |
| Render | [Render](docs/deploy/render.en.md); [![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/marvinli001/edgeweir) |
| Zeabur | [Zeabur](docs/deploy/zeabur.en.md); [![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/5MQJR2) |

The interactive install and upgrade script `deploy.sh` runs on any Linux host with Docker and Compose v2, with a local, cloud or bundled PostgreSQL:

```sh
curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
sudo bash deploy.sh install
```

## Adding a node

Node requirements: Linux with systemd, amd64 / arm64, glibc 2.34 or later (RHEL / Rocky / AlmaLinux 9+, Debian 12+, Ubuntu 22.04+), access to port 8443 of the console.

1. Sign in, open **Clusters & nodes**, pick a cluster and generate an install command. The command carries a single-use token and the SHA-256 fingerprint of the console's internal CA.
2. Run it on the node with an account that may use sudo:

   ```sh
   export EDGEWEIR_TOKEN='<one-time-token>'
   curl -fsSL https://<console>/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
     --server https://<console>:8443 --ca-sha256 <fingerprint>
   ```

3. The node appears online in the console with the config revision it has applied.

Installer behavior:

- The token is passed only through `EDGEWEIR_TOKEN` or `--token-file`, never as a process argument.
- Before installing, it verifies the cosign signature of the checksums (issued to the edgeweir-node release workflow at the exact tag being installed) and the SHA-256 of every package.
- Installs the .deb / .rpm package where possible, otherwise the tar.gz; downloads from the console's `/downloads` mirror when configured, otherwise from GitHub Releases.
- Installs OpenResty built for Edgeweir (`edgeweir-openresty`) and its ModSecurity module (`edgeweir-openresty-modsecurity`, skipped with `--no-modsecurity`) from the same release before edgeweir-node.
- The agent checks the CA fingerprint before sending the token, generates its private key locally, and talks to the console only over mTLS from then on.

Installer options and the release mirror: [Adding nodes](docs/deploy/nodes.en.md).

## API

| Endpoint | Authentication | Purpose |
| --- | --- | --- |
| `/api/v1` | AccessKey (`x-api-key` header) | Public OpenAPI; specification at `/api/v1/openapi.json` |
| `/rpc` | Session cookie + CSRF header | Web UI only |

Both are served from the same oRPC contract in `packages/contract`.

## Development

Requirements: Node.js 24+, pnpm 12, Docker. Go 1.27.1 for `helpers/certd` and `pnpm e2e`. buf ships with the dev dependencies.

```sh
pnpm install
docker compose -f compose.dev.yml up -d   # local PostgreSQL
cp .env.example .env                      # fill in EDGEWEIR_MASTER_KEY
pnpm dev                                  # UI and API on :3000, node channel on :8443
```

| Command | Purpose |
| --- | --- |
| `pnpm lint` | Biome lint and format check, `buf lint` |
| `pnpm typecheck` | TypeScript type check across the workspace |
| `pnpm test` | Unit and integration tests (Vitest; PostgreSQL via in-process PGlite, no Docker) |
| `pnpm build` | Production build |
| `pnpm proto:lint` | Lint `proto/` |
| `pnpm proto:gen` | Generate TypeScript from `proto/` into `packages/proto` |
| `pnpm db:generate` | Generate a SQL migration from changes in `packages/db/src/schema` |
| `pnpm e2e` | End-to-end tests; see [End-to-end tests](#end-to-end-tests) |

Commit conventions, the proto change flow and i18n rules: [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

### End-to-end tests

```sh
docker compose -f compose.e2e.yml up -d --build
pnpm e2e     # --up starts the stack; --down removes it and its volumes afterwards; --skip-ui skips Playwright
```

Dependencies:

- curl, jq, Docker (the node containers need `NET_ADMIN`), Node.js
- an edgeweir-node checkout next to this repository (or `EDGEWEIR_NODE_CONTEXT`)
- for the install step: goreleaser v2, syft, cosign, Go 1.27.1, and the edgeweir-openresty packages for the Docker architecture in edgeweir-node's `out/openresty` (`make openresty-packages`; `scripts/e2e.sh` builds them when missing, which needs Docker Buildx)
- for the G3 step: a node image from before G3, `edgeweir-node:pre-g3` (`E2E_OLD_NODE_IMAGE`; `scripts/e2e-g3.mjs` builds it from edgeweir-node commit `6da3403` when missing)
- network access to deb.debian.org and openresty.org; building the node image or the edgeweir-openresty packages for the first time also needs github.com, download.gnome.org and vault.almalinux.org

Coverage: enrollment, config rollout, caching, purge and prefetch, origins and S3, failover, the auth route allow list (better-auth admin and api-key endpoints closed; API keys never become sessions), the origin address policy and CDN-Loop, HTTPS origin name verification, Range requests over 1 MiB slices, `install.sh` in a clean container installing from the console's mirror, dynamic bans (delivery p95 ≤ 5 s, site bans, global bans dropped by nftables), challenges and passes (a headless browser passes the js and pow challenges; the pass works on another node and fails from another prefix, with another User-Agent or when forged), tiered CC (only the attacked path escalates, per-IP automatic bans), JA4 in rule matching, Brotli and Zstandard negotiated by q-value (one cached identity object, decoded by `curl --compressed`), OWASP CRS detection and blocking (cache hits included), clusters with old nodes unable to turn these on, the contents of the edgeweir-openresty packages, purges by Cache-Tag and host (stale content and slices included), prefetch per device and from sitemaps, active health checks taking origins out and back, session affinity and its failover, site and platform error pages (escaping, no-store, request IDs), dynamic redirects and rewrites with query parameter edits (an invalid target failing closed), bulk redirects updated without a reload, origin override rules and origin timeouts, expression cache rules with browser TTLs, compression rules and `gzip=false` without a cache bypass, Under Attack, WebSocket and log sampling per rule, regional probes (two probe containers enrolling with one-time tokens, a node probing with its own certificate), the move to a backup address when most probes lose the primary, a region-scoped scheduling rule removing a node and a line switching to its backup node group, records written per resolution line, layer-4 forwarding (overlapping pools, ports outside the pools and PROXY protocol on UDP refused; TCP and UDP through both nodes; a long connection across the reload a new port causes; PROXY protocol v1 / v2 to the origin and an accepting listener; an origin change without a reload; an IP block list and a connection limit; statistics and the CNAME), HTTP/2 to origins and gRPC (an h2c-only origin; gRPC unary calls, bidirectional streaming and error trailers through both nodes; HTTP/1.1 again once switched back), cache, origins and content (cluster and node cache zones and their usage, cached Set-Cookie responses sending cookies only with the fetched response, a cache key without `utm_*`, the PURGE method, error page classes and redirects, maintenance mode, charsets, body limits, the Gzip level, origin retries, an S3 origin with the MinIO preset), and Playwright UI flows.

`compose.e2e.yml` and `scripts/e2e.sh` both read the variables below; give both the same values. A different project name, ports, tag and subnets run a second stack side by side.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `edgeweir-e2e` | Compose project; also names the install container |
| `E2E_CONSOLE_PORT` | `13000` | Host port of the console |
| `E2E_NODE_PORT` | `18080` | Host port of the node's HTTP listener |
| `E2E_TAG` | `e2e` | Tag of the console and node images |
| `E2E_SUBNET` | `172.28.213.0/24` | Default network, on the origin allow list |
| `E2E_ISOLATED_SUBNET` | `172.28.214.0/24` | Network outside the allow list; its origin must be refused |
| `E2E_INSTALL_IMAGE` | `debian:bookworm-slim` (pinned by digest in `scripts/e2e.sh`) | Clean machine for `install.sh` |
| `EDGEWEIR_NODE_CONTEXT` | `../edgeweir-node` | edgeweir-node checkout |

## Repository layout

```
apps/console/              console: one package, one process
  src/server/              Hono server: API, auth, node channel, workers
  src/web/                 React SPA
packages/db/               Drizzle schema and SQL migrations
packages/contract/         oRPC contract and zod schemas
packages/config-compiler/  database model → NodeConfig IR
packages/proto/            TypeScript generated from proto/
proto/                     protobuf managed by buf; the single contract shared with edgeweir-node
helpers/certd/             edgeweir-certd (Go): ACME via lego, DNS records via libdns
scripts/e2e.sh             end-to-end test driver
docs/deploy/               deployment guides
docs/guide/                usage guides
docs/reference/            reference: environment variables, command line, API
doc/                       documentation site (Fumadocs), published to GitHub Pages
```

## Documentation

The documentation site <https://marvinli001.github.io/edgeweir/en/> is generated from the Markdown below. Every document has an English version `*.en.md`; the architecture decision records are Chinese only.

| Area | Documents |
| --- | --- |
| Deployment | [Overview](docs/deploy/README.en.md) · [Docker Compose](docs/deploy/docker.en.md) · [BT Panel / aaPanel](docs/deploy/baota.en.md) · [deploy.sh](docs/deploy/deploy-script.en.md) · [Railway](docs/deploy/railway.en.md) · [Fly.io](docs/deploy/fly.en.md) · [bunny.net](docs/deploy/bunny.en.md) · [Render](docs/deploy/render.en.md) · [Zeabur](docs/deploy/zeabur.en.md) · [Ports and reverse proxy](docs/deploy/networking.en.md) · [Adding nodes](docs/deploy/nodes.en.md) · [Versions and upgrades](docs/deploy/upgrade.en.md) · [Backup and recovery](docs/deploy/backup.en.md) |
| Usage | [Quick start](docs/guide/first-site.en.md) · [Account and sign-in](docs/guide/account.en.md) · [Clusters and system](docs/guide/system.en.md) · [Origins and cache](docs/guide/origins-and-cache.en.md) · [HTTPS and certificates](docs/guide/https.en.md) · [Rules](docs/guide/rules.en.md) · [Bans](docs/guide/bans.en.md) · [Challenges and CC mitigation](docs/guide/challenges.en.md) · [OWASP CRS managed rules](docs/guide/waf.en.md) · [DNS steering and alerts](docs/guide/dns-and-alerts.en.md) · [Regional probes and scheduling](docs/guide/scheduling.en.md) · [Layer-4 forwarding](docs/guide/l4.en.md) · [Access logs and AccessKeys](docs/guide/access-logs.en.md) · [Node upgrades](docs/guide/node-upgrades.en.md) |
| Reference | [Environment variables](docs/reference/environment.en.md) · [Command line](docs/reference/cli.en.md) · [API and endpoints](docs/reference/api.en.md) |
| Project | [Architecture](ARCHITECTURE.en.md) · [Security](SECURITY.en.md) · [Contributing](CONTRIBUTING.en.md) · [Licensing](LICENSING.en.md) |

## License

[AGPL-3.0-only](LICENSE); [edgeweir-node](https://github.com/marvinli001/edgeweir-node) uses the same license. Commercial use is permitted subject to the license.

The open-source edition is a single-operator CDN without multi-tenancy. Multi-tenancy (organizations, members and the like), customer portals, plans and billing, finance and reselling belong to separate commercial products and add no restrictions to the core. See [LICENSING.en.md](LICENSING.en.md).
