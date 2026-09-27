# Edgeweir

English | [简体中文](README.zh-CN.md)

Edgeweir is an open-source, self-hosted CDN control plane and edge runtime. It brings your nodes, origin pools, caching, HTTPS and organization access control into one console. The project aims to make CDN operation verifiable: inspect the source, trace configuration changes, check node acknowledgements and verify release artifacts.

The console never stores SSH credentials. Node identity keys stay on their nodes; certificate and origin secrets are encrypted in the database. The core has no vendor phone-home or licence checks. These controls reduce specific risks; they are not a claim that compromise is impossible.

The core includes organizations, members, access control, organization isolation and the existing console and admin area. A customer commerce portal, plans and billing, finance and reselling are planned as a separate commercial operations product. The open-source core remains usable for commercial purposes under AGPL; see [licensing and product boundaries](LICENSING.md).

## The name

Edgeweir (pronounced *EDGE-weer*) is named after a weir. Around 256 BC, Li Bing built the Dujiangyan irrigation system on the Min River. One of its parts, the Feisha ("flying sand") Weir, sits at the edge of the inner channel: in normal times it lets water flow on through the Bottle-Neck Channel to irrigate the Chengdu Plain; in floods, the river bend flings sand and excess water over the weir back into the outer channel. Edgeweir aims to do the same at the network edge: let good traffic through, shed attacks, and steer the flow.

## Status

**MVP functionality is implemented and locally validated. Pre-release; there is no official binary release yet.**

| Area | Available |
| --- | --- |
| Clusters and access | Groups, regions, organizations, invitations, 2FA/passkeys and audit logs |
| Origins and cache | Pools, origin TLS verification, S3 signing, WebSocket, cache keys, slicing, purge and prefetch |
| Certificates and protocols | Upload, ACME HTTP-01/DNS-01, renewal, HTTPS, HSTS, HTTP/2 and HTTP/3 |
| Policy | Scoped IP lists, local GeoIP, phased rules, WAF, rate limits, redirects, rewrites and header transforms |
| DNS and visibility | Domain proof, independent DNS revisions, healthy-node reconciliation, deduplicated traffic, rollups, Top URL/IP, alerts and subscriptions |
| Operations | Sampled logs and CSV, optional ClickHouse, read-only/revocable AccessKeys, signed canary upgrades with rollback, benchmark and backup recovery |

Verification uses real OpenResty nodes, PostgreSQL, Pebble, ClickHouse, local DNS and notification fixtures, plus browser flows. Upgrade tests sign real Linux archives with a local fixture key, check wrong-key rejection, and recover from a signed executable that fails to start. Recovery tests restore a real database backup and prove that newer node revisions remain updateable. See [console CI](https://github.com/marvinli001/edgeweir/actions/workflows/ci.yml) / [node CI](https://github.com/marvinli001/edgeweir-node/actions/workflows/ci.yml).

Live DNS-provider accounts, ZeroSSL EAB and external notification accounts still require operator-specific acceptance. The stock engine does not include Brotli or Zstd. No official GitHub OIDC-signed binary release has been published or accepted yet; evaluate with a source build. These checks are reproducible evidence, not a production reliability or security guarantee.

Guides: [HTTPS](docs/guide/https.md) · [rules](docs/guide/rules.md) · [DNS and alerts](docs/guide/dns-and-alerts.md) · [logs and AccessKeys](docs/guide/access-logs.md) · [node upgrades](docs/guide/node-upgrades.md) · [backup recovery](docs/deploy/backup.md).

## Components

| Repository | Contents |
| --- | --- |
| [edgeweir](https://github.com/marvinli001/edgeweir) (this repo) | The console: web UI, management API (including the public OpenAPI at `/api/v1`) and the node channel, all in one Node.js process and one image. The image also contains `edgeweir-certd`, a Go helper for ACME certificates and DNS records, invoked by pg-boss over a bounded stdin/stdout protocol; private credentials never appear in process arguments. |
| [edgeweir-node](https://github.com/marvinli001/edgeweir-node) | The edge node: the `edgeweir-node` Go agent plus OpenResty. |

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

Release image namespace: `ghcr.io/marvinli001/edgeweir` and `ghcr.io/marvinli001/edgeweir-node`. No Docker Hub mirror is currently published by these workflows.

## Quick start (Docker)

Requirements: Docker with Compose v2.

```sh
git clone https://github.com/marvinli001/edgeweir.git
cd edgeweir

# Required secrets. Compose reads them from .env; use the openssl output as is.
umask 077
cat > .env <<EOF
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF

docker compose up -d --build
```

Open <http://localhost:3000> (every variable is described in [.env.example](.env.example)). The first-run setup wizard creates the platform administrator and a default organization. It asks for the one-time setup token that the console prints to its log (`docker compose logs console | grep setupToken`).

- `EDGEWEIR_MASTER_KEY` encrypts secrets at rest (the internal CA key, S3 origin keys, the setup token, certificate keys and DNS API credentials). **Back it up separately from your database.** Without it, that data cannot be recovered.
- `BETTER_AUTH_SECRET` signs login sessions.
- Setup is refused without the setup token, so nobody else can claim the console before you finish the wizard. The token is spent by the first successful setup.

`EDGEWEIR_ANALYTICS=clickhouse` with the `analytics` Compose profile enables optional ClickHouse raw logs and minute statistics. Sampling is off by default; access logs are retained for 7 days. Console charts and alerts use the shared PostgreSQL rollups. The `cache` profile starts Valkey, which the console does not use yet. See [logs and AccessKeys](docs/guide/access-logs.md) and [backup and restore](docs/deploy/backup.md).

Ports:

| Port | Purpose | Reverse proxy |
| --- | --- | --- |
| 3000 | Web console and API | Allowed. A proxy such as BaoTa (宝塔) nginx can terminate TLS in front of it. Set `EDGEWEIR_TRUSTED_PROXIES` to the proxy's address so that audit entries and sign-in rate limits see the client IP; forwarding headers from anyone else are ignored. |
| 8443 | Node channel | Expose it directly, or pass it through at layer 4 with nginx `stream`. **Never terminate TLS on a proxy**: the console terminates TLS itself and enforces mTLS. |

Deployment guides: [docs/deploy/docker.md](docs/deploy/docker.md) and [docs/deploy/baota.md](docs/deploy/baota.md) (BaoTa panel).

## Adding a node

The signed installer flow below applies after an official release is published. For the current pre-release, build the [node from source](https://github.com/marvinli001/edgeweir-node#build-and-test).

1. Sign in as a platform admin, switch to **Admin** in the top bar, open **Clusters & nodes**, pick a cluster and generate a one-time install command. It contains a single-use token and the SHA-256 fingerprint of the console's internal CA.
2. Run the command on the node with an account that may use sudo (Linux with systemd, amd64 or arm64). The node must be able to reach the console on port 8443.

   ```sh
   export EDGEWEIR_TOKEN='<one-time-token>'
   curl -fsSL https://<console>/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
     --server https://<console>:8443 --ca-sha256 <fingerprint>
   ```

   The token travels in the `EDGEWEIR_TOKEN` environment variable (or a file given with `--token-file`), never as a command-line argument that the process list would show.
3. The installer verifies the cosign signature of the release checksums (the certificate must be the edgeweir-node release workflow at exactly the tag being installed) and the SHA-256 of every package before it installs or runs anything. It installs the .deb or .rpm package when it can, and the tar.gz otherwise. Files come from the console's `/downloads` mirror when one is configured, and from GitHub Releases otherwise. The agent checks the CA fingerprint before sending the token, generates its private key locally, and from then on talks to the console only over mTLS.
4. The node shows up as online in the console, together with the config revision it has applied.

Details: [ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md) and [ADR-0016](docs/adr/0016-one-line-install.md).

## Development

Requirements: Node.js 24+, pnpm 12, Docker. Go 1.27.1 is needed only for `helpers/certd` and `pnpm e2e`. buf comes with the dev dependencies (`pnpm lint` runs it).

```sh
pnpm install
docker compose -f compose.dev.yml up -d   # local PostgreSQL
cp .env.example .env                      # fill in EDGEWEIR_MASTER_KEY and BETTER_AUTH_SECRET
pnpm dev
```

`pnpm dev` starts a single process that serves the UI and API on <http://localhost:3000> and the node channel on `:8443`.

| Command | Purpose |
| --- | --- |
| `pnpm lint` | Biome lint and format check, plus `buf lint` |
| `pnpm typecheck` | TypeScript type check across the workspace |
| `pnpm test` | Unit and integration tests (Vitest; PostgreSQL runs in-process with PGlite, no Docker needed) |
| `pnpm build` | Production build |
| `pnpm proto:lint` | Lint `proto/` with buf |
| `pnpm proto:gen` | Regenerate TypeScript from `proto/` into `packages/proto` |
| `pnpm db:generate` | Generate a SQL migration from schema changes in `packages/db/src/schema` |
| `pnpm e2e` | End-to-end tests against `compose.e2e.yml` (see [End-to-end tests](#end-to-end-tests)) |

### End-to-end tests

`pnpm e2e` runs `scripts/e2e.sh` against a fresh `compose.e2e.yml` stack (PostgreSQL, the console, one edge node built from edgeweir-node, test origins):

```sh
docker compose -f compose.e2e.yml up -d --build
pnpm e2e     # --up starts the stack, --down removes it and its volumes afterwards, --skip-ui skips Playwright
```

Besides curl, jq, Docker and Node.js it needs a checkout of edgeweir-node next to this repository (or `EDGEWEIR_NODE_CONTEXT`), and for the install step goreleaser v2, syft, cosign and Go 1.27.1 on the host, plus network access to deb.debian.org and openresty.org. On top of enrollment, config rollout, cache, purge and prefetch, origins, S3, failover and the Playwright suites it checks the auth route allow list (better-auth's organization and admin endpoints are closed, API keys never become sessions), the origin address policy and CDN-Loop, HTTPS origin name verification, Range requests from 1 MiB slices, and `install.sh` in a clean container installing goreleaser snapshot packages from the console's mirror.

`compose.e2e.yml` and `scripts/e2e.sh` read these variables; give both the same values. With another project name, ports, tag and subnets a second environment runs next to the first one.

| Variable | Default | Purpose |
| --- | --- | --- |
| `COMPOSE_PROJECT_NAME` | `edgeweir-e2e` | Compose project; also names the install container |
| `E2E_CONSOLE_PORT` | `13000` | Host port of the console |
| `E2E_NODE_PORT` | `18080` | Host port of the node's HTTP listener |
| `E2E_TAG` | `e2e` | Tag of the console and node images |
| `E2E_SUBNET` | `172.28.213.0/24` | Default network, put on the origin allow list |
| `E2E_ISOLATED_SUBNET` | `172.28.214.0/24` | Network outside the allow list (its origin must be refused) |
| `E2E_INSTALL_IMAGE` | `debian:bookworm-slim` (pinned by digest in `scripts/e2e.sh`) | Clean machine for `install.sh` |
| `EDGEWEIR_NODE_CONTEXT` | `../edgeweir-node` | edgeweir-node checkout |

See [CONTRIBUTING.md](CONTRIBUTING.md) for commit conventions, the proto change flow and the i18n rules.

## Repository layout

```
apps/console/              the console: one package, one process
  src/server/              Hono server: API, auth, node channel, workers
  src/web/                 React SPA
packages/db/               Drizzle schema and SQL migrations
packages/contract/         oRPC contract and zod schemas
packages/config-compiler/  database model → NodeConfig IR
packages/proto/            TypeScript generated from proto/
proto/                     protobuf managed by buf; the single source of truth shared with edgeweir-node
helpers/certd/             edgeweir-certd (Go): ACME via lego and DNS records via libdns
scripts/e2e.sh             end-to-end test driver
docs/adr/                  architecture decision records
docs/guide/                behaviour guides (origins and cache)
docs/deploy/               deployment guides
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit together
- [docs/adr/](docs/adr/README.md): architecture decision records (in Chinese)
- [ROADMAP.md](ROADMAP.md): MVP, v1 and v2 feature plan
- [docs/guide/origins-and-cache.md](docs/guide/origins-and-cache.md): origin pools, cache rules, purge and prefetch (in Chinese)
- [SECURITY.md](SECURITY.md): trust baseline, vulnerability reporting, verifying releases
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute
- [HTTPS and certificates](docs/guide/https.md): issuance, renewal and protocol limits

## License

[AGPL-3.0-only](LICENSE). The same license applies to [edgeweir-node](https://github.com/marvinli001/edgeweir-node). Commercial use is permitted subject to the license. Separate commercial products do not add restrictions to the core; see [LICENSING.md](LICENSING.md).
