# Edgeweir

[简体中文](README.md) | English

[![CI](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml/badge.svg?branch=master)](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml)
[![Docs](https://github.com/marvinli001/edgeweir/actions/workflows/docs.yml/badge.svg?branch=master)](https://marvinli001.github.io/edgeweir/en/)
[![License: AGPL-3.0-only](https://img.shields.io/badge/license-AGPL--3.0--only-blue.svg)](LICENSE)

Self-hosted CDN / WAF / edge scheduling control plane. Manages edge nodes, origin pools, caching, HTTPS, access policy, DNS steering and organization access control from one console. Edge nodes: [edgeweir-node](https://github.com/marvinli001/edgeweir-node).

Documentation: <https://marvinli001.github.io/edgeweir/en/>

## Features

| Area | Capabilities |
| --- | --- |
| Clusters and access | Node groups, regions, organizations, member invitations, 2FA / passkeys, management audit log |
| Origins and cache | Origin pools, origin TLS verification, S3-signed origins, WebSocket, cache keys, slicing, purge and prefetch |
| Certificates and protocols | Certificate upload, ACME HTTP-01 / DNS-01 issuance and renewal, HTTPS, HSTS, HTTP/2, HTTP/3; Zstandard, Brotli and Gzip compression |
| Access policy | Organization / platform IP lists, local GeoIP, phased rules, WAF, rate limits, redirects, rewrites, request and response header transforms; IP bans delivered within seconds, platform bans optionally dropped in the kernel by nftables |
| Managed rules | OWASP CRS: detect or block, paranoia level, anomaly threshold, exclusions by rule ID, request body limit; matched-rule statistics and access logs; the platform can forbid it for tenants |
| Challenges and CC mitigation | Four challenge levels (cookie redirect, JavaScript, proof of work, image captcha); site or platform Under Attack; tiered CC escalation decided locally on each node (site, per-URL, per-IP automatic bans, origin error rate); signed passes valid across the cluster; JA4 fingerprints in rules, rate limits and access logs |
| DNS and observability | Domain ownership verification, independent DNS revisions, healthy-node steering, deduplicated traffic statistics and rollups, Top URL / IP, alerts and subscriptions |
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
- No vendor phone-home and no license checks. Telemetry is off by default; third-party telemetry is hard-disabled.

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
EOF

docker compose pull        # build from source: docker compose up -d --build
docker compose up -d
docker compose logs console | grep setupToken
```

Open <http://localhost:3000> and complete the setup wizard with the one-time setup token from the log. The wizard creates the platform administrator and a default organization. The token expires after the first successful setup; setup requests without it are rejected.

### Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | Yes | Master key. Envelope-encrypts secrets at rest (internal CA key, certificate keys, S3 origin keys, DNS API credentials, setup token) and derives the session secret. **Back it up separately from the database; without it that data is unrecoverable.** |
| `POSTGRES_PASSWORD` | Yes | Password of the bundled PostgreSQL. |
| `BETTER_AUTH_SECRET` | No | Derived from the master key when unset. Deployments that set it must keep it; the console refuses to start once it is removed. |

All other variables have defaults; see [.env.example](.env.example). SMTP, the node release source, DNS servers for ownership checks, the origin allow list and GeoIP are configured after setup in **Admin → System**.

### Optional components

| Compose profile | Component | Description |
| --- | --- | --- |
| `analytics` | ClickHouse | With `EDGEWEIR_ANALYTICS=clickhouse`, stores raw access logs and per-minute statistics. Access-log sampling is off by default; logs are retained for 7 days. Console charts and alerts use PostgreSQL rollups. |
| `cache` | Valkey | Not used by the console yet. |

See [access logs and AccessKeys](docs/guide/access-logs.en.md) and [backup and recovery](docs/deploy/backup.en.md).

### Ports

| Port | Purpose | Reverse proxy |
| --- | --- | --- |
| 3000 | Web console and API | TLS may be terminated in front (e.g. BaoTa nginx). Add the proxy address to `EDGEWEIR_TRUSTED_PROXIES` so audit entries and sign-in rate limits see the client IP; forwarding headers from other sources are ignored. |
| 8443 | Node channel | Expose directly or pass through at layer 4 with nginx `stream`. **Never terminate TLS on a proxy**: the console terminates TLS itself and enforces mTLS. |

### Deployment options

| Platform | Guide |
| --- | --- |
| Docker Compose / `docker run` | [Docker Compose](docs/deploy/docker.en.md) |
| BT Panel / aaPanel | [BT Panel / aaPanel](docs/deploy/baota.en.md), [deploy.sh reference](docs/deploy/deploy-script.en.md) |
| Railway | [Railway](docs/deploy/railway.en.md) |
| Fly.io | [Fly.io](docs/deploy/fly.en.md) |

The interactive install and upgrade script `deploy.sh` runs on any Linux host with Docker and Compose v2, with a local, cloud or bundled PostgreSQL:

```sh
curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
sudo bash deploy.sh install
```

## Adding a node

Node requirements: Linux with systemd, amd64 / arm64, glibc 2.34 or later (RHEL / Rocky / AlmaLinux 9+, Debian 12+, Ubuntu 22.04+), access to port 8443 of the console.

1. Sign in as a platform administrator, switch to **Admin → Clusters & nodes**, pick a cluster and generate an install command. The command carries a single-use token and the SHA-256 fingerprint of the console's internal CA.
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
- for the install step: goreleaser v2, syft, cosign, Go 1.27.1 and network access to deb.debian.org and openresty.org

Coverage: enrollment, config rollout, caching, purge and prefetch, origins and S3, failover, the auth route allow list (better-auth organization and admin endpoints closed; API keys never become sessions), the origin address policy and CDN-Loop, HTTPS origin name verification, Range requests over 1 MiB slices, `install.sh` in a clean container installing from the console's mirror, dynamic bans (delivery p95 ≤ 5 s, site bans, platform bans dropped by nftables), challenges and passes (a headless browser passes the js and pow challenges; the pass works on another node and fails from another prefix, with another User-Agent or when forged), tiered CC (only the attacked path escalates, per-IP automatic bans), JA4 in rule matching, and Playwright UI flows.

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
| Deployment | [Overview](docs/deploy/README.en.md) · [Docker Compose](docs/deploy/docker.en.md) · [BT Panel / aaPanel](docs/deploy/baota.en.md) · [deploy.sh](docs/deploy/deploy-script.en.md) · [Railway](docs/deploy/railway.en.md) · [Fly.io](docs/deploy/fly.en.md) · [Ports and reverse proxy](docs/deploy/networking.en.md) · [Adding nodes](docs/deploy/nodes.en.md) · [Versions and upgrades](docs/deploy/upgrade.en.md) · [Backup and recovery](docs/deploy/backup.en.md) |
| Usage | [Quick start](docs/guide/first-site.en.md) · [Organizations and members](docs/guide/organizations.en.md) · [Platform administration](docs/guide/admin.en.md) · [Origins and cache](docs/guide/origins-and-cache.en.md) · [HTTPS and certificates](docs/guide/https.en.md) · [Rules](docs/guide/rules.en.md) · [Bans](docs/guide/bans.en.md) · [Challenges and CC mitigation](docs/guide/challenges.en.md) · [OWASP CRS managed rules](docs/guide/waf.en.md) · [DNS and alerts](docs/guide/dns-and-alerts.en.md) · [Access logs and AccessKeys](docs/guide/access-logs.en.md) · [Node upgrades](docs/guide/node-upgrades.en.md) |
| Reference | [Environment variables](docs/reference/environment.en.md) · [Command line](docs/reference/cli.en.md) · [API and endpoints](docs/reference/api.en.md) |
| Project | [Architecture](ARCHITECTURE.en.md) · [Security](SECURITY.en.md) · [Contributing](CONTRIBUTING.en.md) · [Licensing](LICENSING.en.md) |

## License

[AGPL-3.0-only](LICENSE); [edgeweir-node](https://github.com/marvinli001/edgeweir-node) uses the same license. Commercial use is permitted subject to the license.

Organizations, members, access control, organization isolation and the console and admin area are part of the open-source core. Customer portals, plans and billing, finance and reselling belong to a separate commercial product and add no restrictions to the core. See [LICENSING.en.md](LICENSING.en.md).
