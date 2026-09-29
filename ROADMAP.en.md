# Roadmap

Feature scope and delivery status of the open core (the edgeweir console and the edgeweir-node node).

## Status

| Status | Meaning |
| --- | --- |
| Done | Implemented and merged into `master` |
| To do | Part of the current stage, not finished |
| Blocked | Depends on an upstream or external condition; not implemented for now |
| Planned | Later stage, not started |
| Out of core | Belongs to the separate commercial operations product ([ADR-0019](docs/adr/0019-open-core-and-commercial-products.md)) |

"Wrap-up" in the notes column marks items added by the 2026-09-25 wrap-up audit; "D1" to "D6" are that audit's deferred-item numbers. Design records: [ADR index](docs/adr/README.md).

## Stages

| Stage | Requirement source | Status |
| --- | --- | --- |
| Phase 0 | BOOTSTRAP §3 | Done |
| MVP (M1–M6) | BOOTSTRAP §4, MVP specification | Done; Brotli / Zstd blocked |
| Before the first official release | Wrap-up audit deferred items, [ADR-0017](docs/adr/0017-release-supply-chain.md) | 2 items to do |
| v1 | BOOTSTRAP §4, benchmark research | Planned; 2 items done early with MVP M6 |
| v2 | BOOTSTRAP §4, benchmark research | Planned |

## Phase 0

### Repositories and CI

| Item | Status | Notes |
| --- | --- | --- |
| Repository documents: LICENSE (AGPL-3.0), Chinese and English READMEs, ARCHITECTURE, ADRs, ROADMAP, SECURITY, CONTRIBUTING, `.editorconfig` | Done | Both repositories |
| edgeweir CI: lint, typecheck, test, image build | Done | — |
| edgeweir-node CI: go test, goreleaser snapshot | Done | — |

### Console skeleton

| Item | Status | Notes |
| --- | --- | --- |
| Monorepo: `apps/console` (Hono server in `src/server`, React in `src/web`), `packages/db`, `packages/contract`, `packages/config-compiler`, `proto/` | Done | One app package, one process |
| Data model v0 | Done | organization, user (better-auth), cluster, node_group, node, node_ip, enrollment_token, site, site_domain, origin_pool, origin, cache_rule, config_revision, node_config_status, audit_log |
| Pages (zh-CN / en): sign-in, setup wizard, overview, clusters and nodes, sites, settings | Done | Every page has empty, loading, and error states |
| proto v0 `NodeService` | Done | `Enroll`, `WatchConfig`, `GetConfig`, `ReportStatus`, `ReportStats`, `RenewCertificate` |
| `NodeConfig` IR | Done | Listeners, sites, domains, origins, cache rules, TLS certificate references |

### Node skeleton

| Item | Status | Notes |
| --- | --- | --- |
| Agent path: enrollment, mTLS, watch, snapshot on disk, nginx.conf rendering, site table pushed to Lua over a unix socket | Done | — |
| Lua routes by Host to the upstream with proxy_cache; responses carry an `X-Cache` header | Done | — |
| Agent reports the applied revision | Done | — |

### End-to-end verification

| Item | Status | Notes |
| --- | --- | --- |
| `compose.e2e.yml`: postgres, console, node (OpenResty), whoami origin | Done | — |
| After a site is created through the API, `curl -H "Host: demo.test" http://<node>` returns `MISS`, then `HIT` | Done | — |
| The console shows the node online with its applied revision | Done | — |
| The flow runs in CI | Done | — |

### Deployment

| Item | Status | Notes |
| --- | --- | --- |
| Multi-stage Dockerfile | Done | Non-root; `ROLE` is `app`, `worker`, or `all` (default `all`) |
| `compose.yml` | Done | Console and PostgreSQL 18; profile `analytics` adds ClickHouse, profile `cache` adds Valkey (the console does not use Valkey yet) |
| `compose.baota.yml` and the [宝塔 deployment page](docs/deploy/baota.en.md) | Done | Reverse proxy to `:3000`; `:8443` exposed directly or passed through with stream; TLS must not be terminated by the 宝塔 nginx |
| [Docker Compose deployment page](docs/deploy/docker.en.md) | Done | — |

## MVP

### Clusters and sites

| Item | Status | Notes |
| --- | --- | --- |
| Multiple clusters | Done | — |
| Node groups | Done | — |
| Regions | Done | — |
| Sites over HTTP and HTTPS | Done | — |
| Multiple domains per site (including wildcards) | Done | — |

### Tenancy and accounts

| Item | Status | Notes |
| --- | --- | --- |
| Organizations (tenants), default cluster, members and roles, invitations | Done | — |
| Platform user management: create, platform administrator, disable | Done | — |
| Account security: change password, TOTP, passkeys; organizations can require two-factor authentication | Done | — |
| One-time setup token protects first-run setup | Done | — |
| Authentication hardening | Done | Wrap-up: `/api/auth/*` allows only the endpoints the UI uses; API keys work only on `/api/v1`; client IPs trust forwarding headers only from `EDGEWEIR_TRUSTED_PROXIES`; sign-in rate-limit counters live in the database; sign-in, password, two-factor, passkey, and API key changes are audited |

### Origins

| Item | Status | Notes |
| --- | --- | --- |
| Origin pools: weights, backup origins | Done | — |
| Load balancing: weighted random, smooth weighted round robin, consistent hashing | Done | — |
| Passive health checks | Done | — |
| Origin Host and SNI | Done | — |
| Origin HTTPS certificate verification | Done | On by default; can be turned off per site |
| Object storage origin authentication | Done | — |
| Origin connection pooling and timeouts, WebSocket pass-through | Done | — |
| Origin address restrictions: loopback, private, link-local, and other special-purpose addresses refused unless on the platform allow list; loop detection (`CDN-Loop`) | Done | Wrap-up |

### Cache

| Item | Status | Notes |
| --- | --- | --- |
| Cache rules: match by extension, path, prefix, status code, size | Done | — |
| Custom cache keys | Done | — |
| Respect or override origin cache headers | Done | — |
| Stale content fallback | Done | — |
| Range and slice | Done | — |
| Purge: URL, prefix, whole site | Done | — |
| Prefetch | Done | URL prefetch; prefix, whole-site, and variant prefetch are in [v1](#cache-and-scheduling) |
| Requests with `Authorization` are not cached by default; rules can allow it explicitly | Done | Wrap-up |
| Purge and prefetch rate-limited per organization; node purge markers capped and merged into a site-level marker on overflow; purges missed while offline for more than 7 days or while disabled are replaced by a whole-site purge | Done | Wrap-up |

### Protocols and certificates

| Item | Status | Notes |
| --- | --- | --- |
| ACME certificates | Done | HTTP-01, DNS-01 |
| Certificate upload | Done | — |
| HSTS | Done | — |
| HTTP/2 | Done | — |
| HTTP/3 | Done | — |
| Gzip (types and minimum length) | Done | — |
| Brotli, Zstd | Blocked | The official OpenResty engine has no modules for them; the UI keeps them unavailable |
| Minimum TLS version, OCSP stapling, ZeroSSL | Done | ZeroSSL EAB not accepted against a real account |
| Minimum agent capability gate: nodes that lack a capability do not receive configs that need it; nodes reject unknown enum values | Done | proto v0.3.0 (M3); wrap-up deferred item D1 |

### Access control and rules

| Item | Status | Notes |
| --- | --- | --- |
| IP and CIDR allow/deny lists | Done | — |
| Country, subdivision, and ASN allow/deny lists | Done | Local MMDB |
| Rate limiting | Done | Fixed window per node |
| Redirect rules | Done | — |
| Rewrite rules | Done | — |
| Request and response header rules | Done | — |
| Platform IP lists, custom WAF rules, configuration rules | Done | — |

### DNS

| Item | Status | Notes |
| --- | --- | --- |
| Third-party DNS: DNSPod, Alibaba Cloud, Huawei Cloud, Cloudflare | Done | Not accepted against real provider accounts |
| Automatic CNAME records | Done | — |
| Records removed automatically when health checks fail | Done | — |
| DNS record repair job | Done | — |
| Nodes taken offline automatically when health checks fail | Done | — |
| Domain ownership verification (TXT) | Done | — |
| DNS and node configuration released separately | Done | — |

### Operations

| Item | Status | Notes |
| --- | --- | --- |
| Per-minute statistics: requests, traffic, bandwidth, hit ratio, status codes | Done | Lite mode |
| Idempotent statistics reports (batch sequence numbers), hourly / daily rollups, detail retention | Done | Minute / hour / day data kept 7 / 90 / 365 days; M5, wrap-up deferred item D2 |
| Top URLs, top IPs | Done | Node-side estimates |
| Alert channels: email, webhook, DingTalk, WeCom, Telegram | Done | DingTalk, WeCom, and Telegram not accepted against real accounts |
| Audit log | Done | — |
| Public API | Done | — |
| Node self-upgrade: signature verification, canary by node group, rollback on failure | Done | The supervisor and the engine are updated through system packages or images |
| Sampled access log reporting and search | Done | Off by default; PostgreSQL daily partitions or optional ClickHouse; 7-day retention; CSV export |
| AccessKey revocation and read-only scope | Done | — |
| Performance baseline (bench) | Done | — |
| Backup and restore drill | Done | After a restore, nodes keep accepting new revisions (config receipts signed by the console); wrap-up deferred item D3 |
| System settings: SMTP, node release source, ownership-check DNS servers, origin allow list, GeoIP | Done | Values saved in Admin take precedence over environment variables |

### Deployment

| Item | Status | Notes |
| --- | --- | --- |
| Rolling console image releases: `<YYYYMMDD>-<commit>` tags, cosign keyless signatures | Done | [ADR-0017](docs/adr/0017-release-supply-chain.md) update of 2026-09-29 |
| `deploy.sh`: install and upgrade 宝塔 / aaPanel Compose deployments | Done | — |
| Node channel on its own listener (`NODE_API_HOST`, `NODE_API_PORT`) | Done | — |
| `BETTER_AUTH_SECRET` optional; derived from the master key when unset | Done | — |

## Before the first official release

| Item | Status | Notes |
| --- | --- | --- |
| Container base images pinned by digest and GitHub Actions by full commit SHA in both repositories | Done | Wrap-up deferred item D5; ADR-0017 update of 2026-09-27; guarded by a console test and the node's `make pin-check` |
| Release workflows of both repositories (signatures, provenance, image push) exercised once against the verification commands in [SECURITY.en.md](SECURITY.en.md) | To do | The console image moved to rolling releases from `master` (ADR-0017 update of 2026-09-29); the drill follows the first push |
| Official binary release signed through GitHub OIDC | To do | Not released yet |
| Node CI in the public repository fetches `proto/v0.7.0` from GitHub and checks the generated code | Done | Wrap-up deferred item D6 |

## v1

### Security

| Item | Status | Notes |
| --- | --- | --- |
| OWASP CRS managed rules | Planned | Log first, then block |
| Tiered CC protection | Planned | — |
| 5-second shield / PoW challenge | Planned | — |
| JA4 fingerprints | Planned | — |
| nftables / ipset blocking | Planned | — |
| URL signing (four schemes: A, B, C, D) | Planned | — |
| Hotlink protection | Planned | — |
| User-Agent lists | Planned | — |
| IP gray lists, nftables connection count and new-connection rate limits | Planned | — |
| Admin sign-in IP allow list | Planned | — |
| Domain deny list and content keyword monitoring | Planned | — |

### Cache and scheduling

| Item | Status | Notes |
| --- | --- | --- |
| Tiered Cache / L2 origin fetch | Planned | — |
| Topologies (reusable cache tier topologies) | Planned | — |
| Consistent hashing within a group | Planned | — |
| Purge by Cache-Tag | Planned | — |
| Smart scheduling rules | Planned | — |
| Regional probes | Planned | — |
| Node leases | Planned | — |
| Cache index node within a group | Planned | — |
| Active origin health checks, session affinity | Planned | — |
| Prefetch: prefix and whole-site prefetch, prefetch per cache-key variant (e.g., mobile) | Planned | Only the desktop variant is prefetched today; wrap-up deferred item D4 |

### Logs

| Item | Status | Notes |
| --- | --- | --- |
| Raw logs written to ClickHouse | Done | Done early with MVP M6 |
| Access log search and CSV export | Done | Done early with MVP M6 |
| Logpush: S3, HTTP, Kafka | Planned | — |
| Attack dashboard, origin fetch quality | Planned | — |
| SMS alert channel | Planned | — |

### Protocols and optimization

| Item | Status | Notes |
| --- | --- | --- |
| TCP/UDP layer 4 forwarding (PROXY protocol) | Planned | — |
| Image WebP / AVIF conversion and resizing (imgproxy) | Planned | — |
| 103 Early Hints | Planned | — |
| Speculation-Rules injection | Planned | — |
| Custom error pages | Planned | — |
| CORS, HLS encryption, visitor IP source, per-site request and traffic limits | Planned | — |
| Domain regex and IDN matching, site groups, bulk redirects | Planned | — |
| 0-RTT, mutual TLS to origins and from visitors, Origin CA | Planned | — |

### Releases

| Item | Status | Notes |
| --- | --- | --- |
| Canary configuration releases | Planned | — |
| Automatic rollback | Planned | — |
| Rule versions and rollback | Planned | — |
| Node CLI diagnostics, clock skew alerts, node log page | Planned | — |

## v2

### DNS and layer 3/4 protection

| Item | Status | Notes |
| --- | --- | --- |
| Self-hosted authoritative DNS / GTM | Planned | PowerDNS and CoreDNS under evaluation |
| XDP / eBPF layer 3/4 protection | Planned | — |
| Automatic layer 7 DDoS mitigation, bot scoring | Planned | — |
| Certificate Transparency monitoring, ECH | Planned | — |

### Cache

| Item | Status | Notes |
| --- | --- | --- |
| Shared compression dictionaries | Planned | — |
| Cache Reserve (S3 / MinIO persistent tier) | Planned | — |

### Edge compute and engine

| Item | Status | Notes |
| --- | --- | --- |
| Edge compute: expression DSL or Wasm sandbox | Planned | Tenant scripts need approval |
| Pingora engine | Planned | Waits for Pingora's HTTP/3 to mature |
| Smart routing that picks parents by probed latency, edge HTML rewriting | Planned | — |
| RUM, security event explorer | Planned | — |

### Product modules

| Item | Status | Notes |
| --- | --- | --- |
| Tunnels | Planned | — |

## Outside the open core

Organizations, members, invitations, roles, tenant isolation, and the existing console and Admin are part of the open core. Usage statistics, resource protection, and the management API stay in the core; commercial plans, subscription state, and ledgers do not enter the core data model. ADR-0019 supersedes the original BOOTSTRAP placement of the items below; the commercial product has its own schedule. License and boundary: [LICENSING.en.md](LICENSING.en.md).

| Item | Status | Notes |
| --- | --- | --- |
| Customer portal, self-service sign-up and purchase | Out of core | Formerly listed in v1 |
| Plans and commercial quotas, traffic packages, balances, 95th-percentile billing, payments | Out of core | Formerly listed in v1 |
| Identity verification, support tickets, coupons, white-labeling, overdue-account flows, SMS / WeChat Pay | Out of core | Formerly listed in v1 |
| Sale, orders, and settlement of high-defense IPs | Out of core | Node protection and scheduling stay on this roadmap |
| Public marketing landing page | Out of core | ADR-0019 update of 2026-09-29; the sign-in page and invitation acceptance stay in the open core |
