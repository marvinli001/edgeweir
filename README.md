# Edgeweir

English | [简体中文](README.zh-CN.md)

Edgeweir is a self-hosted CDN, WAF and edge traffic-steering platform. It covers the same ground as GoEdge and FlexCDN (your own edge nodes, caching, WAF, DNS-based scheduling, multi-tenant resale) and aims for Cloudflare-grade site optimisation. Its first priority is verifiable trust. GoEdge has shipped official binaries that did not match its published source and were later found to be poisoned, and in 2025 the RingH23 attack used node SSH root credentials stored in its control plane to spread across edge nodes. Edgeweir is designed so that neither can happen: the control plane does not store node SSH credentials, node private keys never leave the node, every release is signed with Sigstore and ships with an SBOM and SLSA provenance, and there is no phone-home or licence check anywhere in the code.

## The name

Edgeweir is named after a weir. Around 256 BC, Li Bing built the Dujiangyan irrigation system on the Min River. One of its parts, the Feisha ("flying sand") Weir, sits at the edge of the inner channel: in normal times it lets water flow on through the Bottle-Neck Channel to irrigate the Chengdu Plain; in floods, the river bend flings sand and excess water over the weir back into the outer channel. Edgeweir aims to do the same at the network edge: let good traffic through, shed attacks, and steer the flow.

## Status

**Phase 0: skeleton and a minimal end-to-end loop.** A node enrolls over mTLS, receives its configuration, and serves a site through OpenResty with caching (`X-Cache: MISS`, then `HIT`); the console shows the node online with its applied config revision. Edgeweir is not ready for production use. See [ROADMAP.md](ROADMAP.md) for what comes next.

## Components

| Repository | Contents |
| --- | --- |
| [edgeweir/edgeweir](https://github.com/edgeweir/edgeweir) (this repo) | The console: web UI, management API (including the public OpenAPI at `/api/v1`) and the node channel, all in one Node.js process and one image. Also `edgeweir-certd`, a Go helper for ACME certificates and DNS records, shipped inside the same image. |
| [edgeweir/edgeweir-node](https://github.com/edgeweir/edgeweir-node) | The edge node: the `edgeweir-node` Go agent plus OpenResty. |

```
browser, API clients ──:3000──▶ ┌───────────────────────────────────┐
                                │ console (one Node.js process)     │── PostgreSQL 18 (required)
                                │   UI · /rpc · /api/v1             │── ClickHouse (optional)
                                │   node channel :8443 (mTLS)       │── Valkey (optional)
                                │   pg-boss workers · certd         │
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

# Two required secrets. Compose reads them from .env.
cat > .env <<EOF
EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
EOF

docker compose up -d
```

Open <http://localhost:3000>. The first-run setup wizard creates the platform administrator and a default organization.

- `EDGEWEIR_MASTER_KEY` encrypts secrets at rest (internal CA key, certificate keys, DNS API credentials). **Back it up separately from your database.** Without it, that data cannot be recovered.
- `BETTER_AUTH_SECRET` signs login sessions.
- Finish the setup wizard before exposing port 3000 to the internet. Until an administrator exists, anyone who can reach the console can create one.

Optional components:

```sh
docker compose --profile analytics up -d   # adds ClickHouse (raw logs and analytics)
docker compose --profile cache up -d       # adds Valkey (optional cache)
```

Ports:

| Port | Purpose | Reverse proxy |
| --- | --- | --- |
| 3000 | Web console and API | Allowed. A proxy such as BaoTa (宝塔) nginx can terminate TLS in front of it. |
| 8443 | Node channel | Expose it directly, or pass it through at layer 4 with nginx `stream`. **Never terminate TLS on a proxy**: the console terminates TLS itself and enforces mTLS. |

Deployment guides: [docs/deploy/docker.md](docs/deploy/docker.md) and [docs/deploy/baota.md](docs/deploy/baota.md) (BaoTa panel).

## Adding a node

1. In the console, open **Clusters**, pick a cluster and generate a one-time install command. It contains a single-use token and the SHA-256 fingerprint of the console's internal CA.
2. Run the command as root on the node (Linux with systemd, amd64 or arm64). The node must be able to reach the console on port 8443.

   ```sh
   curl -fsSL https://<console>/install.sh | sudo bash -s -- --token <one-time-token> --ca-sha256 <fingerprint> ...
   ```

3. The installer verifies the cosign signature and sha256 of everything it downloads before running it. The agent checks the CA fingerprint before sending the token, generates its private key locally, and from then on talks to the console only over mTLS.
4. The node shows up as online in the console, together with the config revision it has applied.

Details: [ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md) and [ADR-0016](docs/adr/0016-one-line-install.md).

## Development

Requirements: Node.js 24+, pnpm 12, Docker. Go 1.27 is needed only for `helpers/certd`, and buf only for changes under `proto/`.

```sh
pnpm install
docker compose -f compose.dev.yml up -d
cp .env.example .env
pnpm dev
```

`pnpm dev` starts a single process that serves the UI and API on <http://localhost:3000> and the node channel on `:8443`.

| Command | Purpose |
| --- | --- |
| `pnpm lint` | Biome lint and format check |
| `pnpm typecheck` | TypeScript type check across the workspace |
| `pnpm test` | Unit and integration tests (Vitest) |
| `pnpm build` | Production build |
| `pnpm proto:lint` | Lint `proto/` with buf |
| `pnpm proto:gen` | Regenerate TypeScript from `proto/` into `packages/proto` |
| `pnpm e2e` | End-to-end tests (needs Docker) |

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
helpers/certd/             edgeweir-certd (Go): ACME via lego, DNS records via libdns
docs/adr/                  architecture decision records
docs/deploy/               deployment guides
```

## Documentation

- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit together
- [docs/adr/](docs/adr/README.md): architecture decision records (in Chinese)
- [ROADMAP.md](ROADMAP.md): MVP, v1 and v2 feature plan
- [SECURITY.md](SECURITY.md): trust baseline, vulnerability reporting, verifying releases
- [CONTRIBUTING.md](CONTRIBUTING.md): how to contribute
- Documentation site: <https://edgeweir.dev> · Website: <https://edgeweir.com>

## License

[AGPL-3.0-only](LICENSE). The same license applies to [edgeweir-node](https://github.com/edgeweir/edgeweir-node).
