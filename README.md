# Edgeweir

English | [简体中文](README.zh-CN.md)

Edgeweir is a self-hosted CDN, WAF and edge traffic-steering platform. It covers the same ground as GoEdge and FlexCDN (your own edge nodes, caching, WAF, DNS-based scheduling, multi-tenant resale) and aims for Cloudflare-grade site optimisation. Its first priority is verifiable trust. GoEdge has shipped official binaries that did not match its published source and were later found to be poisoned, and in 2025 the RingH23 attack used node SSH root credentials stored in its control plane to spread across edge nodes. Edgeweir is designed so that neither can happen: the control plane does not store node SSH credentials, node private keys never leave the node, every release is signed with Sigstore and ships with an SBOM and SLSA provenance, and there is no phone-home or licence check anywhere in the code.

## The name

Edgeweir (pronounced *EDGE-weer*) is named after a weir. Around 256 BC, Li Bing built the Dujiangyan irrigation system on the Min River. One of its parts, the Feisha ("flying sand") Weir, sits at the edge of the inner channel: in normal times it lets water flow on through the Bottle-Neck Channel to irrigate the Chengdu Plain; in floods, the river bend flings sand and excess water over the weir back into the outer channel. Edgeweir aims to do the same at the network edge: let good traffic through, shed attacks, and steer the flow.

## Status

**MVP in progress (milestones 1 and 2 of 6 done).** Phase 0 delivered the end-to-end loop: a node enrolls over mTLS, receives its configuration and serves a site through OpenResty with caching. MVP M1 added clusters, node groups and regions, organizations with members, invitations and 2FA/passkeys, site editing with a revision per save, a filterable audit log and a one-time setup token. MVP M2 added origin pools (weights, backup origins, weighted random, round robin and consistent hashing, passive health checks, origin Host and SNI, origin certificate verification, S3-signed origins, timeouts, keep-alive and WebSocket), cache rules and cache keys, stale content, Range slicing, and URL, prefix and whole-site purge plus URL prefetch as typed node tasks. The console also shows per-minute traffic statistics stored in PostgreSQL (lite mode) and can serve an optional public landing page at `/`. HTTPS on the edge, certificates and the rule engine are still to come. Edgeweir is not ready for production use. See [docs/specs/mvp.md](docs/specs/mvp.md) and [ROADMAP.md](ROADMAP.md) for what comes next.

## Components

| Repository | Contents |
| --- | --- |
| [edgeweir/edgeweir](https://github.com/edgeweir/edgeweir) (this repo) | The console: web UI, management API (including the public OpenAPI at `/api/v1`) and the node channel, all in one Node.js process and one image. The image also contains `edgeweir-certd`, a Go helper that will obtain ACME certificates and manage DNS records; so far it is only a skeleton (its request protocol and tests), and certificates arrive with MVP M3. |
| [edgeweir/edgeweir-node](https://github.com/edgeweir/edgeweir-node) | The edge node: the `edgeweir-node` Go agent plus OpenResty. |

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

Images: `ghcr.io/edgeweir/edgeweir` and `ghcr.io/edgeweir/edgeweir-node` (mirrored on Docker Hub as `edgeweir/edgeweir` and `edgeweir/edgeweir-node`).

## Quick start (Docker)

Requirements: Docker with Compose v2.

```sh
git clone https://github.com/edgeweir/edgeweir.git
cd edgeweir

# Required secrets. Compose reads them from .env; use the openssl output as is.
cat > .env <<EOF
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
POSTGRES_PASSWORD=$(openssl rand -hex 24)
EOF

docker compose up -d
```

Open <http://localhost:3000> (every variable is described in [.env.example](.env.example)). The first-run setup wizard creates the platform administrator and a default organization. It asks for the one-time setup token that the console prints to its log (`docker compose logs console | grep setupToken`).

- `EDGEWEIR_MASTER_KEY` encrypts secrets at rest (the internal CA key, S3 origin keys, the setup token, and later certificate keys and DNS API credentials). **Back it up separately from your database.** Without it, that data cannot be recovered.
- `BETTER_AUTH_SECRET` signs login sessions.
- Setup is refused without the setup token, so nobody else can claim the console before you finish the wizard. The token is spent by the first successful setup.

`compose.yml` also has an `analytics` profile (ClickHouse) and a `cache` profile (Valkey). They only start the containers for later milestones: the console does not use either yet, and traffic statistics are stored in PostgreSQL.

Ports:

| Port | Purpose | Reverse proxy |
| --- | --- | --- |
| 3000 | Web console and API | Allowed. A proxy such as BaoTa (宝塔) nginx can terminate TLS in front of it. Set `EDGEWEIR_TRUSTED_PROXIES` to the proxy's address so that audit entries and sign-in rate limits see the client IP; forwarding headers from anyone else are ignored. |
| 8443 | Node channel | Expose it directly, or pass it through at layer 4 with nginx `stream`. **Never terminate TLS on a proxy**: the console terminates TLS itself and enforces mTLS. |

Deployment guides: [docs/deploy/docker.md](docs/deploy/docker.md) and [docs/deploy/baota.md](docs/deploy/baota.md) (BaoTa panel).

## Adding a node

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

Requirements: Node.js 24+, pnpm 12, Docker. Go 1.27.1 is needed only for `helpers/certd`. buf comes with the dev dependencies (`pnpm lint` runs it).

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
| `pnpm e2e` | End-to-end tests against `compose.e2e.yml`: start it first with `docker compose -f compose.e2e.yml up -d --build` (needs Docker and a checkout of edgeweir-node next to this repository) |

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
helpers/certd/             edgeweir-certd (Go) skeleton: ACME via lego and DNS records via libdns, from MVP M3
scripts/e2e.sh             end-to-end test driver
docs/adr/                  architecture decision records
docs/specs/                MVP specification
docs/guide/                behaviour guides (origins and cache)
docs/deploy/               deployment guides
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit together
- [docs/adr/](docs/adr/README.md): architecture decision records (in Chinese)
- [ROADMAP.md](ROADMAP.md): MVP, v1 and v2 feature plan; [docs/specs/mvp.md](docs/specs/mvp.md): the MVP milestones
- [docs/guide/origins-and-cache.md](docs/guide/origins-and-cache.md): origin pools, cache rules, purge and prefetch (in Chinese)
- [SECURITY.md](SECURITY.md): trust baseline, vulnerability reporting, verifying releases
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute
- Documentation site: <https://edgeweir.dev> · Website: <https://edgeweir.com>

## License

[AGPL-3.0-only](LICENSE). The same license applies to [edgeweir-node](https://github.com/edgeweir/edgeweir-node).
