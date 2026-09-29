# Architecture

Components, processes, ports, data flows, data model, and trust boundaries of the console repository.

## Components

| Component | Location | Responsibility |
| --- | --- | --- |
| Console | `apps/console` | Web UI, UI endpoint `/rpc`, public API `/api/v1`, node channel, pg-boss worker; one image, one Node.js process |
| `edgeweir-certd` | `helpers/certd` | ACME and DNS helper written in Go, shipped in the console image; the worker runs it as a child process and exchanges JSON over stdin/stdout, so credentials never appear in process arguments |
| PostgreSQL 18 | External service | The only required dependency: application data, migration history (schema `drizzle`), pg-boss queues (schema `pgboss`), LISTEN/NOTIFY |
| ClickHouse | Compose profile `analytics` | Optional; with `EDGEWEIR_ANALYTICS=clickhouse` it stores access logs and a copy of per-minute statistics |
| Valkey | Compose profile `cache` | Not used by the console yet |
| Node | [edgeweir-node](https://github.com/marvinli001/edgeweir-node) | Go agent and OpenResty data plane; pulls configuration and tasks over the node channel and reports status, statistics, and logs |

```text
Console (ROLE=app|worker|all)
├── :3000  HTTP ◀── browsers, API clients
├── :8443  Connect-RPC (TLS + mTLS) ◀── edgeweir-node agent ── OpenResty ──▶ origins
├── SQL, LISTEN/NOTIFY ──▶ PostgreSQL 18
├── HTTP (optional) ──▶ ClickHouse
└── child process stdin/stdout ──▶ edgeweir-certd ──▶ ACME CA, DNS provider APIs
```

The only contract between the console and the nodes is `edgeweir.node.v1` in `proto/` (current tag `proto/v0.7.0`). The boundary between the open core and commercial products is defined in [ADR-0019](docs/adr/0019-open-core-and-commercial-products.md).

## Repository layout

| Path | Contents |
| --- | --- |
| `apps/console/src/server` | Server: `app.ts` (HTTP routes), `bootstrap.ts` (startup sequence), `main.ts` (production entry), `dev.ts` (development entry with Vite middleware in the same process), `rpc/` (oRPC router and guards), `node-channel/` (node channel), `pki/` (internal CA), `services/` (domain services), `jobs/worker.ts` (pg-boss queues), `lib/` (environment, authentication, envelope encryption, client IP, logging), `install/install.sh` (node installer), `downloads.ts` (release mirror) |
| `apps/console/src/web` | React 19 SPA: TanStack Router file routes (`routes/`), TanStack Query, shadcn components (`components/ui`), appica wrappers (`components/appica/`); Paraglide messages in `apps/console/messages/{zh-CN,en}.json`, compiled to `src/web/paraglide` |
| `apps/console/test` | Vitest: `server/` (in-process PGlite database), `web/` (i18n, UI rules, preset, theme) |
| `apps/console/e2e` | Playwright specs, run by `scripts/e2e.sh` |
| `packages/contract` | oRPC contract and zod schemas, error codes (`errors.ts`), node error codes (`node-errors.ts`), origin address rules (`addresses.ts`); shared by the UI, the server, and OpenAPI |
| `packages/db` | Drizzle schema (`src/schema/`) and plain SQL migrations (`migrations/`) |
| `packages/config-compiler` | Compiles sites, rules, IP lists, certificate references, and platform policy into the NodeConfig IR; canonical ordering, content hash, diff |
| `packages/rule-engine` | Rule expression fields, phases, parser, and list reference binding |
| `packages/proto` | TypeScript generated from `proto/` (protoc-gen-es); not edited by hand |
| `proto/` | buf module `edgeweir/node/v1/{node,config}.proto`; edgeweir-node generates its Go code from a `proto/vX.Y.Z` tag |
| `helpers/certd` | `edgeweir-certd` source |
| `helpers/http3probe` | HTTP/3 probe used in CI |
| `Dockerfile`, `docker/` | Image build, container health check script, end-to-end fixtures |
| `compose*.yml`, `deploy.sh` | `compose.yml` (production), `compose.baota.yml` and `compose.baota-host.yml` (宝塔 / aaPanel), `compose.dev.yml` (development database), `compose.e2e.yml` (end-to-end); `deploy.sh` installs and upgrades 宝塔 / aaPanel deployments |
| `scripts/` | `e2e.sh` (end-to-end tests), `image-version.sh` (rolling version), `bench.sh` (cache-hit performance baseline) |
| `docs/` | `adr/` (architecture decision records), `deploy/` (deployment), `guide/` (feature guides) |

## Processes and roles

`ROLE` selects what a process runs. All roles use the same image and the same database; deployment shapes and scaling: [Deployment overview](docs/deploy/README.en.md); all variables: [Environment variables](docs/reference/environment.en.md).

| `ROLE` | Runs |
| --- | --- |
| `app` | HTTP server, node channel, setup token, LISTEN/NOTIFY subscription |
| `worker` | pg-boss queues and schedules |
| `all` (default) | Everything in `app` and `worker` |

### Startup sequence

1. Parse and validate the environment (`lib/env.ts`); on failure, list the invalid variables and exit.
2. Wait up to 60 seconds for PostgreSQL.
3. Apply pending migrations on a dedicated connection under an advisory lock; instances that start together run them one at a time.
4. Resolve the session secret (`BETTER_AUTH_SECRET`, or derived from the master key) and compare it with the HMAC check value in the database: a derived secret that differs from the one the database was used with stops startup; a new explicit value is accepted with a warning ([SECURITY.en.md](SECURITY.en.md#session-secret)).
5. Re-encrypt v1 envelopes written by older versions as v2.
6. Load the internal CA; generate it when the database has none.
7. `app`, `all`: before setup, create or read the setup token and write it to the log; start LISTEN; issue the node channel server certificate from the internal CA and start listening.
8. `worker`, `all`: start pg-boss, create the queues, register the schedules.
9. `app`, `all`: the HTTP server starts listening.

On `SIGTERM` or `SIGINT` the process closes HTTP connections and the node channel, gives pg-boss up to 5 seconds to finish running jobs, then closes the database pool.

## Ports and routes

| Port | Variables | Protocol | Constraint |
| --- | --- | --- | --- |
| 3000 | `HOST`, `PORT` | HTTP | May sit behind a reverse proxy; list the proxy addresses in `EDGEWEIR_TRUSTED_PROXIES` |
| 8443 | `NODE_API_HOST` (defaults to `HOST`), `NODE_API_PORT` | HTTPS, TLS 1.2 or later, HTTP/2 and HTTP/1.1 | Expose directly or pass through at layer 4; a proxy that terminates TLS breaks node mTLS |

Reverse proxy and layer-4 passthrough configuration: [Ports, reverse proxy, and trusted proxies](docs/deploy/networking.en.md).

### HTTP routes

| Path | Handler | Credentials |
| --- | --- | --- |
| `/healthz` | Returns `{"status":"ok","version":…}` | None |
| `/api/auth/*` | better-auth, allow-listed endpoints only | See [Authentication and authorization](#authentication-and-authorization) |
| `/rpc/*` | oRPC, UI only | Session cookie + `x-csrf-token` |
| `/api/v1/openapi.json` | OpenAPI document | None |
| `/api/v1/*` | OpenAPI handler for the same router as `/rpc` | `x-api-key` |
| `/install.sh` | Node installer with the console address replaced by `EDGEWEIR_PUBLIC_URL`; `cache-control: no-store` | None |
| `/downloads/*` | Node release mirror (`EDGEWEIR_DOWNLOADS_DIR`), GET and HEAD | None |
| `/assets/*` | SPA assets, `max-age=31536000, immutable` | None |
| Any other path | SPA static files; `index.html` when no file matches | None |

Unmatched requests under `/api`, `/rpc`, and `/downloads`, and other methods on `/install.sh` and `/healthz`, return a 404 JSON body and never fall back to the SPA. Every response carries security headers; the CSP is `default-src 'self'`, `frame-ancestors 'none'`.

### UI areas

| Area | Paths | Access |
| --- | --- | --- |
| Entry | `/` (redirects to `/setup`, `/overview`, or `/login` by state), `/setup`, `/login`, `/invite/$id` | Everyone |
| Console | `/overview`, `/sites`, `/certificates`, `/alerts`, `/ip-lists`, `/purge`, `/members`, `/security`, `/settings` | Signed-in users; `/members` only for organization owners and admins and platform administrators |
| Admin | `/admin`, `/admin/clusters`, `/admin/alerts`, `/admin/dns`, `/admin/rules`, `/admin/ip-lists`, `/admin/regions`, `/admin/organizations`, `/admin/audit`, `/admin/settings` | Platform administrators, through the **Console** / **Admin** switch in the header |

## Authentication and authorization

| Entry | Credentials | Rules |
| --- | --- | --- |
| `/api/auth/*` | Email and password, TOTP, backup codes, passkeys | Only the methods and paths in `AUTH_HTTP_ROUTES` (`lib/auth.ts`) are served (session, sign-in, sign-out, password change, two-factor, passkeys, API key create / list / delete); everything else returns 404; `x-api-key` is dropped; public sign-up is disabled, accounts are created by the setup wizard and by administrators; passwords have at least 12 characters |
| `/rpc/*` | Session cookie + `x-csrf-token` | `x-api-key` is dropped |
| `/api/v1/*` | `x-api-key` (AccessKey) | Cookies are dropped; an AccessKey acts as its owner with the same permissions as a session; a read-only AccessKey can call GET procedures and `rules.validate` only |
| `:8443` | Client certificate | See [Node channel](#node-channel) |

Endpoints, the OpenAPI document, and AccessKey details: [API and endpoints](docs/reference/api.en.md). oRPC procedures are layered by guard (`rpc/base.ts`):

| Guard | Allowed callers |
| --- | --- |
| `authed` | A valid session or an enabled AccessKey |
| `tenant` | `authed`, with two-factor enabled when the organization requires it |
| `orgManager` | `tenant`, and an organization owner or admin, or a platform administrator |
| `admin` | Platform administrators (`user.role` contains `admin`) |
| `maybeAuthed` | Anyone; the result differs for a signed-in caller (invitations) |

The client IP (audit log, sign-in rate limiting) is the TCP peer; `X-Forwarded-For` and `X-Real-IP` are used only when the peer is in `EDGEWEIR_TRUSTED_PROXIES` (`resolveClientIp`). Rate-limit counters for the authentication endpoints live in the `rate_limit` table and are shared by all instances. Sign-ins and account changes completed by better-auth are audited by the hooks in `lib/auth-audit.ts` ([ADR-0007](docs/adr/0007-auth-better-auth-multitenancy.md)).

## Configuration publishing

A change to node configuration runs in one transaction:

1. Write the application tables (sites, domains, origins, cache rules, rules, IP lists, certificates, ACME HTTP-01 responses, the origin allow list, the full-site purge generation).
2. `publishRevision()` takes an advisory lock on the cluster, reads the cluster's enabled sites, platform rules, referenced IP lists, the origin allow list, certificate references, and unexpired HTTP-01 responses, and `compileNodeConfig()` produces the canonical NodeConfig IR.
3. Compute `content_hash`: SHA-256 of the binary encoding with `revision` and `content_hash` cleared. Identical content produces no new revision.
4. The new revision number is one more than the larger of the latest stored revision and the highest verified applied revision reported by the cluster's nodes; restoring the database from a backup never moves revisions backwards.
5. Insert into `config_revision`, run `pg_notify('edgeweir_config', …)` in the same transaction, and write the audit entry.
6. After commit, every `app` instance receives the notification through LISTEN and pushes it to the `WatchConfig` streams of the cluster's nodes.
7. The node calls `GetConfig(base_revision=applied revision)`, receives a diff or a snapshot plus a revision receipt, verifies the hash, stores it as last-known-good, applies it to OpenResty, and reports with `ReportStatus`.
8. The console records each node's applied revision and heartbeat in `node_config_status`; a node with a heartbeat in the last 45 seconds is online.

| Constraint | Value |
| --- | --- |
| Enabled sites per cluster | At most 512 (`MAX_SITES_PER_CLUSTER`); more returns `CLUSTER_SITE_LIMIT` |
| New node capabilities | A change that needs a capability some active node lacks returns `NODE_CAPABILITY_REQUIRED` unless a platform administrator makes it; `GetConfig` returns `FailedPrecondition` to a node missing a required capability |
| Revision retention | Newest 200 per cluster, pruned hourly |
| Rollback | Publishes the IR of an older revision as a new revision with the current origin allow list; audit action `cluster.rollback` |

Revision reasons are codes (`revision_reason_<code>`) defined in `packages/contract/src/errors.ts`. IR semantics: [ADR-0011](docs/adr/0011-config-model-nodeconfig-ir.md). Rule language: [ADR-0012](docs/adr/0012-rule-engine-expression-language.md).

## Node tasks

URL, prefix, and full-site purges and URL prefetches produce no revision; they are delivered as typed tasks:

1. `cacheTasks.create` inserts a `cache_task` and a `cache_task_node` for every enabled node (disabled nodes are marked skipped), then runs `pg_notify('edgeweir_tasks', …)`.
2. The `WatchConfig` stream emits `WATCH_EVENT_TASKS`.
3. The node pulls tasks with `PullTasks` and reports results with `ReportTaskResult`.
4. A task without a result 5 minutes after hand-out is handed out again; a task not finished within 7 days fails. When a node reconnects, the console issues a full-site purge for each site whose purges the node missed.

| Limit | Value |
| --- | --- |
| Tasks per organization per minute | 10 (platform administrators exempt) |
| Targets per organization per hour | 2000 (platform administrators exempt) |

Node upgrades are delivered through `PullTasks` as well: an upgrade first runs on one node group, and a platform administrator promotes it to the remaining nodes after the health observation passes. Behavior: [Node upgrades](docs/guide/node-upgrades.en.md).

## Node channel

Connect-RPC over HTTPS; the console process terminates TLS itself ([ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md)).

| Item | Value |
| --- | --- |
| Internal CA | ECDSA P-256, valid for 10 years, generated on first start; private key envelope-encrypted in `pki_authority` |
| Server certificate | Issued by the internal CA at every start, valid for 90 days; checked hourly and reissued in-process when less than a third of the lifetime remains, so new handshakes get the new certificate and established connections keep theirs; SANs are the host name of `EDGEWEIR_NODE_API_URL` (the host name of `EDGEWEIR_PUBLIC_URL` when unset), `EDGEWEIR_NODE_API_HOSTNAMES`, `localhost`, `127.0.0.1`, `::1`, and the container host name |
| Node certificate | CN is the node ID, client authentication only, valid for 30 days; with less than a third of the lifetime left, `ReportStatus` asks the node to call `RenewCertificate` |
| Heartbeat | Every 15 seconds; `WatchConfig` sends a keepalive every 15 seconds |

Enrollment:

1. A platform administrator generates an install command: a single-use token (valid for 5 minutes to 7 days, default 60 minutes, stored as SHA-256 only) and the SHA-256 fingerprint of the internal CA (`--ca-sha256`). The token travels in the `EDGEWEIR_TOKEN` environment variable.
2. The node checks the CA fingerprint in the server certificate chain, then sends the token and a locally generated CSR (`Enroll`).
3. The console verifies the CSR signature, issues the node certificate, and marks the token used and writes the audit entry in the same transaction.

Install command and `install.sh` checks: [Adding nodes](docs/deploy/nodes.en.md).

The console never stores SSH credentials; nodes join only through the one-time install command generated by the console and enroll themselves ([ADR-0016](docs/adr/0016-one-line-install.md)).

Every RPC other than `Enroll` requires a client certificate verified by the internal CA whose serial number equals the current serial stored for the node: a rotated certificate stops working at once, and deleting a node writes its serial to `node_certificate_revocation`. Disabled or deleted nodes are refused on every RPC, and their open `WatchConfig` streams close.

| RPC | Purpose |
| --- | --- |
| `Enroll` | Exchange a single-use token and a CSR for a node certificate |
| `RenewCertificate` | Rotate the node certificate |
| `WatchConfig` | Server stream: revision notifications, task notifications, keepalives |
| `GetConfig` | Snapshot, or diff against `base_revision`, with a revision receipt |
| `ReportStatus` | Heartbeat, apply receipt, passive origin health and error codes |
| `ReportStats`, `ReportStatsV2` | Per-minute pre-aggregated traffic statistics; deduplicated by batch sequence |
| `ReportLogs` | Sampled access logs; deduplicated by batch sequence |
| `GetOriginCredentials` | S3 origin keys referenced by the cluster's sites |
| `GetCertificates` | Certificate chains and private keys referenced by the cluster's sites |
| `PullTasks`, `ReportTaskResult` | Purge, prefetch, and upgrade tasks |

A revision receipt is sealed with the master key (purpose `node.revision_receipt`, bound to the node ID) and carries the cluster, the revision, and the content hash. The node stores the receipt locally and returns it in `ReportStatus`; a report of an applied revision above the console's latest revision without a valid receipt is refused ([ADR-0008](docs/adr/0008-node-channel-connect-rpc-mtls.md)).

## Certificates and DNS

`edgeweir-certd` performs ACME issuance, renewal, and revocation and DNS record operations ([ADR-0010](docs/adr/0010-certd-lego-libdns.md)).

1. The pg-boss queue `certificates.sweep` selects, every minute, certificates waiting for issuance and certificates past `renew_at`.
2. The worker starts `EDGEWEIR_CERTD_BIN` (`/usr/local/bin/edgeweir-certd` in the image) with only `PATH` and `EDGEWEIR_DNS_TEST_ENDPOINT` in its environment.
3. It writes one JSON request line to stdin (command and parameters, including the ACME account and DNS credentials). certd writes JSON event lines to stdout (`account`, `http01.present`, `http01.cleanup`, `dns01.prepare`, `dns01.cleanup`); the console handles each one and acknowledges it on stdin. The last line is the result.
4. `http01.present` responses are written to `acme_challenge` and published in a new revision, and nodes answer them. `dns01.prepare` records the cleanup obligation in `dns_challenge_lease` before certd writes the TXT record; after completion, failure, or a restart, only the values written by that operation are removed. The ACME account from an `account` event is envelope-encrypted into `certificate`.
5. The result is written back to `certificate`: chain, fingerprint, expiry, next renewal time, and the envelope-encrypted private key; clusters that reference the certificate publish a new revision.

| Limit | Value |
| --- | --- |
| Duration per call | 5 minutes, then `SIGKILL` |
| stdout size | 16 MiB for `dns.*` commands, 2 MiB otherwise |
| stderr | Discarded (dependency diagnostics may quote credentials) |
| Commands | `version`, `providers`, `obtain`, `renew`, `revoke`, `dns.list`, `dns.set`, `dns.present`, `dns.cleanup` |
| DNS providers | `cloudflare`, `alidns`, `huaweicloud`, `dnspod` |

Platform DNS (`dns.reconcile`, every minute) computes records from healthy nodes and domain routing rights, creates a `dns_revision`, and writes it to the zone of a `platform_dns_provider`; names are recorded in `dns_managed_name` before external records are written, so partial writes can be repaired. Domain routing rights require a TXT check (`_edgeweir-verification.<domain>`), tracked in `domain_ownership`. Behavior: [HTTPS and certificates](docs/guide/https.en.md), [DNS and alerts](docs/guide/dns-and-alerts.en.md).

## Statistics, logs, and alerts

| Mode | `EDGEWEIR_ANALYTICS` | Access logs | Per-minute statistics | Charts and alerts |
| --- | --- | --- | --- | --- |
| lite (default) | `lite` | PostgreSQL `access_log`, one partition per UTC day | PostgreSQL | PostgreSQL |
| ClickHouse | `clickhouse` | ClickHouse `access_log` | PostgreSQL, with a copy in ClickHouse `minute_stats` | PostgreSQL |

Access logs are sampled per site; the sample rate defaults to 0 (off). Per-minute statistics pre-aggregated by nodes go to `node_minute_stats`; the worker rolls them up into `node_hour_stats` and `node_day_stats`, and the view `traffic_hour_stats` combines rolled-up and pending data. Overview, site statistics, and the platform overview query 1-hour, 6-hour, 24-hour, 7-day, and 30-day ranges in buckets (`date_bin`); the 7-day and 30-day ranges read hourly data.

| Data | Retention |
| --- | --- |
| Access logs (PostgreSQL and ClickHouse) | 7 days |
| Per-minute statistics (PostgreSQL and ClickHouse) | 7 days |
| Hourly statistics | 90 days |
| Daily statistics | 365 days |

The Compose profile `cache` starts Valkey; the console does not use Valkey yet ([ADR-0009](docs/adr/0009-analytics-clickhouse-and-lite.md)).

Alerts (`alerts.sweep`, every minute) detect offline nodes, expiring certificates, unavailable origins, and high 5xx rates, create `alert_event` rows, fan them out to `alert_delivery` by `alert_subscription`, and send them through an `alert_channel` (webhook or email); membership, bans, two-factor, and channel visibility are checked again at delivery. Access logs and AccessKeys: [Access logs and AccessKeys](docs/guide/access-logs.en.md).

## Background jobs

| Queue | Schedule | Work |
| --- | --- | --- |
| `alerts.sweep` | Every minute | Alert detection and delivery |
| `dns.reconcile` | Every minute | Platform DNS publishing and external record maintenance |
| `traffic.rollup` | Every minute | Traffic rollup and cleanup, access log partition maintenance, upgrade expiry |
| `certificates.sweep` | Every minute | Certificate issuance and renewal |
| `domains.enforce-ownership` | At start; skipped once `domain_ownership_v1` is recorded in `system_setting` | Republishes every cluster so unverified domains stop routing |
| `maintenance.prune-revisions` | Minute 17 of every hour | Deletes revisions beyond the retention count |
| `maintenance.expire-cache-tasks` | Minute 43 of every hour | Fails purge and prefetch deliveries past their deadline |
| `maintenance.expire-enrollment-tokens` | Every 30 minutes | Deletes enrollment tokens expired or used more than 7 days ago |

## Data model

Tables are defined in `packages/db/src/schema`; migrations are plain SQL generated by drizzle-kit in `packages/db/migrations` and run at console startup (see [Startup sequence](#startup-sequence)).

### Identity and organizations

| Table | Contents |
| --- | --- |
| `user` | Users; `role` containing `admin` marks a platform administrator |
| `session` | Sign-in sessions |
| `account` | Sign-in credentials (password hash) |
| `verification` | better-auth verification records |
| `organization` | Organizations, the resource and permission boundary |
| `member` | Organization members and roles |
| `invitation` | Member invitations |
| `two_factor` | TOTP secrets and backup codes |
| `passkey` | Passkey public keys |
| `apikey` | AccessKeys: hash, permissions, enabled state |
| `rate_limit` | Rate-limit counters of the authentication endpoints |
| `organization_settings` | Organization default cluster, required two-factor |

### Infrastructure

| Table | Contents |
| --- | --- |
| `region` | Region dictionary |
| `cluster` | Clusters: sets of nodes that share one revision stream |
| `node_group` | Node groups, optionally tied to a region |
| `node` | Nodes: status, capabilities, certificate serial and fingerprint, last heartbeat |
| `node_ip` | IP addresses reported by nodes |
| `enrollment_token` | SHA-256 and usage of enrollment tokens |
| `node_certificate_revocation` | Certificate serials revoked when a node is deleted |
| `pki_authority` | Internal CA, private key envelope-encrypted |
| `system_setting` | Platform key/value settings: setup token, session secret HMAC check value, origin allow list, SMTP, node release source, DNS resolvers, alert policy, one-time migration markers |
| `audit_log` | Audit of management actions |

### Sites and configuration

| Table | Contents |
| --- | --- |
| `site` | Sites: organization and cluster, cache key, slicing, WebSocket, certificate, TLS settings, cache generation, log sample rate |
| `site_domain` | Site domains and their routing verification state |
| `site_star` | Per-user stars |
| `origin_pool` | Origin pools: timeouts, keepalive, failure thresholds, origin TLS verification |
| `origin` | Origins |
| `origin_credential` | S3 origin keys, envelope-encrypted |
| `cache_rule` | Cache rules |
| `edge_rule` | Site or platform rules: phase, expression, action, list references |
| `ip_list` | Organization or platform IP lists (normalized CIDRs) |
| `config_revision` | Revisions per cluster: number, content hash, binary IR, reason code |
| `node_config_status` | Node apply receipts and heartbeats, with the receipt verification flag |

### Certificates, DNS, and domains

| Table | Contents |
| --- | --- |
| `certificate` | Chain, fingerprint, expiry, and renewal state; private key and ACME account envelope-encrypted |
| `acme_challenge` | Short-lived public HTTP-01 responses |
| `dns_credential` | Organization DNS provider credentials, envelope-encrypted |
| `dns_challenge_lease` | Cleanup obligations of DNS-01 TXT records |
| `domain_ownership` | Domain ownership verification |
| `platform_dns_provider` | Platform DNS provider and zone, credentials envelope-encrypted |
| `dns_state` | Platform DNS policy and desired / applied DNS revision |
| `dns_revision` | DNS revisions: record set, managed names, status |
| `dns_managed_name` | Registered managed DNS names |

### Statistics, logs, tasks, and alerts

| Table | Contents |
| --- | --- |
| `node_minute_stats` | Traffic per node, site, and minute |
| `node_hour_stats` | Hourly rollups |
| `node_day_stats` | Daily rollups |
| `stats_rollup_dirty` | Time buckets waiting for a rollup |
| `node_stats_cursor` | Per-node high-water mark of statistics batches |
| `access_log` | Sampled access logs, one partition per UTC day |
| `node_log_cursor` | Per-node high-water mark of log batches |
| `origin_health` | Passive origin health and error codes reported by nodes |
| `cache_task` | Purge and prefetch tasks |
| `cache_task_node` | Delivery and result of a task on each node |
| `node_upgrade` | Node upgrade jobs |
| `node_upgrade_delivery` | Phase, state, and health observation of an upgrade on each node |
| `alert_channel` | Alert channels, configuration envelope-encrypted |
| `alert_subscription` | User subscriptions per site and channel |
| `alert_state` | Current alert state |
| `alert_event` | Alert events with an ordinal |
| `alert_delivery` | Delivery and retries of an event on a channel |

The view `traffic_hour_stats` combines hourly rollups with minute data not rolled up yet, without double counting.

### Migrations

| Migration | Change |
| --- | --- |
| `0000_init` | Initial schema: better-auth tables, clusters, node groups, nodes, enrollment tokens, sites, domains, origin pools, origins, cache rules, revisions, node status, per-minute statistics, internal CA, audit log |
| `0001_m1` | `region`, `organization_settings`, `system_setting`, `node_certificate_revocation`; revision reason codes; actor and target names in the audit log; node group region |
| `0002_site_star` | `site_star` |
| `0003_m2` | `origin_credential`, `origin_health`, `cache_task`, `cache_task_node`; origin pool timeouts, keepalive, and TLS verification; cache rule extensions; site cache key, slicing, and WebSocket |
| `0004_wrapup_auth` | `rate_limit` |
| `0005_wrapup_console` | Cache rule `cache_authorized`; task source; error codes of tasks and origin health |
| `0006_m3_certificates` | `certificate`, `dns_credential`, `acme_challenge`; node capabilities; site certificate and TLS settings |
| `0007_m3_challenge_attempts` | `acme_challenge.operation_started_at` |
| `0008_m3_dns_cleanup` | `dns_challenge_lease` |
| `0009_m4_rules` | `edge_rule`, `ip_list` |
| `0010_m5_stats` | `node_stats_cursor`, `node_hour_stats`, `node_day_stats`, `stats_rollup_dirty`, view `traffic_hour_stats`; top URLs and top IPs in per-minute statistics |
| `0011_m5_domain_ownership` | `domain_ownership`; `site_domain.verified` |
| `0012_m5_dns` | `platform_dns_provider`, `dns_state`, `dns_revision`, `dns_managed_name` |
| `0013_m5_dns_managed_names` | `dns_revision.managed_names` |
| `0014_m5_alerts` | `alert_channel`, `alert_subscription`, `alert_state`, `alert_event`, `alert_delivery` |
| `0015_m5_alert_order` | `alert_event.ordinal` |
| `0016_m5_alert_privacy_default` | `alert_channel.platform` defaults to `false` (platform-wide notifications off by default) |
| `0017_m6_logs` | `access_log`, `node_log_cursor`; `site.log_sample_rate` |
| `0018_retain_node_traffic` | Traffic statistics tables drop their foreign key to `node`; deleting a node keeps site statistics |
| `0019_m6_upgrades` | `node_upgrade`, `node_upgrade_delivery` |
| `0020_m6_upgrade_health` | `node_upgrade_delivery.healthy_since` |
| `0021_authenticated_revision_floor` | `node_config_status.revision_receipt_verified` |
| `0022_bound_traffic_counters` | Existing traffic counters clamped to 0 through 2^53−1 |

## Build output

| Step | Output |
| --- | --- |
| `vite build` | `apps/console/dist/web` (SPA) |
| `node scripts/build-server.mjs` (esbuild) | `apps/console/dist/server/main.js`: the server and all dependencies in one ESM file; `install/` copied to `dist/server/install`, migrations to `dist/migrations` |
| Dockerfile stage `certd` | `golang:1.27.1-alpine` builds `edgeweir-certd` |
| Dockerfile stage `build` | `node:24.21.0-alpine` with pnpm 12.6.0 builds the console |
| Dockerfile stage `runtime` | `node:24.21.0-alpine` + tini; no `node_modules`; runs as user `node`; `EXPOSE 3000 8443`; health check `edgeweir-healthcheck` |

Base images are pinned by tag and multi-arch index digest ([ADR-0017](docs/adr/0017-release-supply-chain.md)). The image version is `<YYYYMMDD>-<commit>` (`scripts/image-version.sh`), written to `EDGEWEIR_VERSION` and the image label `org.opencontainers.image.version`; the full commit ID goes to `org.opencontainers.image.revision`. Development commands and tests: [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

## Observability

| Item | Behavior |
| --- | --- |
| Logs | One JSON line per event; `warn` and `error` to stderr, the rest to stdout; level set by `LOG_LEVEL` |
| `/healthz` | Returns status and version |
| Container health check | `ROLE=worker` checks only that the process is alive; other roles request `http://127.0.0.1:${PORT}/healthz` |
| Node state | Online state, applied revision, data plane health, and origin health come from `node_config_status` and `origin_health` |
