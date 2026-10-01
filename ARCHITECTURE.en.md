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

The only contract between the console and the nodes is `edgeweir.node.v1` in `proto/` (current tag `proto/v0.7.0`). The boundary between the open core and commercial products is defined in [LICENSING.en.md](LICENSING.en.md).

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
| `packages/rule-engine` | Rule expression fields, phases, functions, parser (conditions, value expressions, cache rule conditions), list reference binding, and reference evaluation |
| `packages/proto` | TypeScript generated from `proto/` (protoc-gen-es); not edited by hand |
| `proto/` | buf module `edgeweir/node/v1/{node,config}.proto`; edgeweir-node generates its Go code from a `proto/vX.Y.Z` tag |
| `helpers/certd` | `edgeweir-certd` source |
| `helpers/http3probe` | HTTP/3 probe used in CI |
| `Dockerfile`, `docker/` | Image build, container health check script, end-to-end fixtures |
| `compose*.yml`, `deploy.sh` | `compose.yml` (production), `compose.baota.yml` and `compose.baota-host.yml` (宝塔 / aaPanel), `compose.dev.yml` (development database), `compose.e2e.yml` (end-to-end); `deploy.sh` installs and upgrades 宝塔 / aaPanel deployments |
| `scripts/` | `e2e.sh` (end-to-end tests), `image-version.sh` (rolling version), `bench.sh` (performance baseline of cache hits, requests with a pass and challenge pages) |
| `docs/` | `deploy/` (deployment), `guide/` (feature guides), `reference/` (reference) |

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

On `SIGTERM` or `SIGINT` the process stops the HTTP and node channel listeners, ends the nodes' config watch streams and stops pg-boss at the same time: requests in flight get up to 3 more seconds, pg-boss up to 5 seconds to finish running jobs; then the database pool is closed. If all of this takes more than 8 seconds the process exits with 1.

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
| Entry | `/` (redirects to `/setup`, `/overview`, or `/login` by state), `/setup`, `/login` | Everyone |
| Console | Sites: `/overview`, `/sites`, `/certificates`, `/purge`; access control: `/ip-lists`, `/bans`, `/rules`; infrastructure: `/clusters`, `/regions`, `/dns`; system: `/alerts`, `/service-accounts`, `/audit`, `/system`; account (user menu): `/security`, `/settings` | The signed-in operator |

## Authentication and authorization

| Entry | Credentials | Rules |
| --- | --- | --- |
| `/api/auth/*` | Email and password, TOTP, backup codes, passkeys | Only the methods and paths in `AUTH_HTTP_ROUTES` (`lib/auth.ts`) are served (session, sign-in, sign-out, password change, two-factor, passkeys); everything else returns 404; `x-api-key` is dropped; public sign-up is disabled, the only account is created by the setup wizard; passwords have at least 12 characters |
| `/rpc/*` | Session cookie + `x-csrf-token` | `x-api-key` is dropped |
| `/api/v1/*` | `x-api-key` (AccessKey or service account key) | Cookies are dropped; an AccessKey acts as the account with the same permissions as a session; a read-only AccessKey can call GET procedures and `rules.validate` only; a service account can call only the procedures listed in `serviceAccountProcedures` that its scopes allow |
| `:8443` | Client certificate | See [Node channel](#node-channel) |

Endpoints, the OpenAPI document, and AccessKey details: [API and endpoints](docs/reference/api.en.md). The console has one operator account, with no organizations or roles: every procedure except `system.status` and `system.setup` goes through `authed` in `rpc/base.ts` (a valid session, an enabled AccessKey or a service account key).

The client IP (audit log, sign-in rate limiting) is the TCP peer; `X-Forwarded-For` and `X-Real-IP` are used only when the peer is in `EDGEWEIR_TRUSTED_PROXIES` (`resolveClientIp`). Rate-limit counters for the authentication endpoints live in the `rate_limit` table and are shared by all instances. Sign-ins and account changes completed by better-auth are audited by the hooks in `lib/auth-audit.ts`.

Account recovery has no HTTP entry and happens on the server only: `dist/server/recover.js` (`services/recovery.ts`) reads the console's environment and, in one transaction, resets the password (better-auth's `password.hash`), turns two-factor authentication off, deletes the account's sessions and pending two-factor sign-ins, and writes the audit entry `account.recover` ([Command line](docs/reference/cli.en.md#account-recovery)).

## Configuration publishing

A change to node configuration runs in one transaction:

1. Write the application tables (sites, domains, origins, cache rules, rules, IP lists, certificates, ACME HTTP-01 responses, the origin allow list, the full-site purge generation).
2. `publishRevision()` takes an advisory lock on the cluster, reads the cluster's enabled sites, global rules, every IP list, the origin allow list, certificate references, and unexpired HTTP-01 responses, and `compileNodeConfig()` produces the canonical NodeConfig IR.
3. Compute `content_hash`: SHA-256 of the binary encoding with `revision` and `content_hash` cleared. Identical content produces no new revision.
4. The new revision number is one more than the larger of the latest stored revision and the highest verified applied revision reported by the cluster's nodes; restoring the database from a backup never moves revisions backwards.
5. Insert into `config_revision`, run `pg_notify('edgeweir_config', …)` in the same transaction, and write the audit entry.
6. After commit, every `app` instance receives the notification through LISTEN and pushes it to the `WatchConfig` streams of the cluster's nodes.
7. The node calls `GetConfig(base_revision=applied revision)`, receives a diff or a snapshot plus a revision receipt, verifies the hash, stores it as last-known-good, applies it to OpenResty, and reports with `ReportStatus`.
8. The console records each node's applied revision and heartbeat in `node_config_status`; a node with a heartbeat in the last 45 seconds is online.

| Constraint | Value |
| --- | --- |
| Enabled sites per cluster | At most 512 (`MAX_SITES_PER_CLUSTER`); more returns `CLUSTER_SITE_LIMIT` |
| New node capabilities | A change that needs a capability some active node lacks returns `NODE_CAPABILITY_REQUIRED` when a service account or a background job publishes it; the operator (session or AccessKey) may publish it; `GetConfig` returns `FailedPrecondition` to a node missing a required capability |
| Revision retention | Newest 200 per cluster, pruned hourly |
| Rollback | Publishes the IR of an older revision as a new revision with the current origin allow list; audit action `cluster.rollback` |

Revision reasons are codes (`revision_reason_<code>`) defined in `packages/contract/src/errors.ts`. Rule language: [Rules](docs/guide/rules.en.md).

## Node tasks

URL, prefix, host, Cache-Tag, and full-site purges and URL and sitemap prefetches produce no revision; they are delivered as typed tasks:

1. `cacheTasks.create` inserts a `cache_task` and a `cache_task_node` for every enabled node (disabled nodes are marked skipped), then runs `pg_notify('edgeweir_tasks', …)`.
2. The `WatchConfig` stream emits `WATCH_EVENT_TASKS`.
3. The node pulls tasks with `PullTasks` and reports results with `ReportTaskResult`.
4. A task without a result 5 minutes after hand-out is handed out again; a task not finished within 7 days fails. When a node reconnects, the console issues a full-site purge for each site whose purges the node missed.

Host and Cache-Tag purges need the node feature `purge-tag-v1`, mobile and sitemap prefetches `prefetch-v2`; while an active node of an affected cluster lacks it, the console refuses the task (`NODE_CAPABILITY_REQUIRED`). Nodes derive cache keys from the purge markers' points in time and an index of the cached objects' `Cache-Tag`, so purged objects (stale ones included) are never looked up again; nodes fetch sitemaps through their own edge layer. Behavior: [Origins and cache](docs/guide/origins-and-cache.en.md#purge-and-prefetch).

Node upgrades are delivered through `PullTasks` as well: an upgrade first runs on one node group and is promoted after the health observation passes; the remaining nodes follow at most a quarter at a time, and each task must finish within 30 minutes after it is sent. A node pulling tasks first checks without a lock whether it has an upgrade task, and takes the cluster's upgrade lock only if it does. Behavior: [Node upgrades](docs/guide/node-upgrades.en.md).

## Dynamic bans

IP bans (`ip_ban`) create no revision and skip the configuration canary; they have their own path over the node channel:

1. Every write (create, ban again, unban, automatic ban writes and overflow removal) takes `nextval('ip_ban_seq')` as the row's `seq` under one transaction-level advisory lock, so commits follow sequence order; the same transaction runs `pg_notify('edgeweir_bans', …)` with the affected clusters (all of them for platform bans). Manual actions are audited as `ban.create`, `ban.update`, `ban.delete`.
2. Nodes with `bans-v1` receive `WATCH_EVENT_BANS` (`ban_sequence` is the sequence's current value) when their `WatchConfig` stream opens and after every notification.
3. The node calls `GetBans(after_sequence)`: from 0, or from a sequence above the current value (after a database restore), it returns a snapshot (`reset`); otherwise the active bans and lifted ids changed afterwards. Expired bans are left out; nodes drop them at expiry. Reads take the same lock in shared mode first, so the current value never passes an uncommitted write. Pages hold 2000 entries by default and at most 5000; `sequence` is the page's highest sequence, or the current value on the last page.
4. Nodes upload their own automatic bans with `ReportBans` (at most 1000 per call), merged per node, site and address, and report the applied sequence, capacity and unapplied bans in `ReportStatus.bans`, kept in `node.ban_status`.

| Limit | Value |
| --- | --- |
| Shortest prefix | IPv4 `/16`, IPv6 `/48` |
| Lifetime | 1 minute to 7 days; deleted by `maintenance.prune-bans` an hour after expiry |
| Count | Platform limit of manual bans (system settings, 10000 by default); at most 10000 automatic bans per cluster |

Behavior: [Bans](docs/guide/bans.en.md).

## Challenges and CC mitigation

Nodes enforce challenges, Under Attack and tiered CC mitigation locally; the console holds the settings, keys and events:

1. A site's protection (`site_protection`), global Under Attack (system setting `protection_settings`) and the CC template (`cc_template`) are compiled into NodeConfig. Only clusters that use challenges (global Under Attack, a site's Under Attack, an enabled CC policy or a `challenge` rule) carry `challenge_keys`, `platform_protection` and every site's `protection`, with `challenge-v1` in `required_features`; a site that only records JA4 carries its `protection` alone. Rules that read `tls.ja4` (or rate limit by it) and sites that record JA4 add `ja4-v1`. Other clusters keep their content hash.
2. Pass HMAC keys are per cluster, three of them (`next`, `current`, `previous`), created the first time a cluster uses challenges. The IR holds only key ids and roles (sorted by id); nodes fetch the 32-byte secrets with `GetChallengeKeys`, only those of their own cluster. A secret is generated the first time it is fetched and stored envelope-encrypted (purpose `challenge_key.secret`, bound to the row id).
3. `maintenance.rotate-challenge-keys` checks every hour and rotates keys once the newest one is a day old: `previous` is deleted, `current` becomes `previous`, `next` becomes `current` and a new `next` is created; clusters whose latest revision carries keys get a new revision (reason `challenge_keys_rotated`), audited as `cluster.challenge_keys_rotate`.
4. Nodes report level changes, escalated paths and automatic bans with `ReportSecurityEvents` (at most 500 per call); the console stores them in `security_event`, idempotent by (node, event id). A site leaving the normal level raises the `cc_mitigation` alert, at most once per site in 15 minutes. `ReportStatus.security` of the heartbeat is kept in `node.security_state`. `maintenance.prune-security-events` deletes events after the retention (default 30 days).

| Management action | Audit |
| --- | --- |
| Site protection | `site.protection_update` (publishes the site's cluster) |
| Global Under Attack, event retention | `system.protection_update` (publishes every cluster when Under Attack changes) |
| CC template | `system.cc_template_update` (publishes clusters with sites that follow it) |

Behavior: [Challenges and CC mitigation](docs/guide/challenges.en.md).

## Compression and OWASP CRS

Nodes compress and run CRS with OpenResty built for Edgeweir (`edgeweir-openresty`, optional module package `edgeweir-openresty-modsecurity`) and report `brotli-v1`, `zstd-v1` and `modsecurity-v1` according to their build. The console holds the settings, the capability gate and the match statistics:

1. A site's Brotli and Zstandard settings live with Gzip in `site.tls_settings` and are compiled into `TlsOptions`; only algorithms that are on carry their level, minimum length and types (types sorted and unique), so the content hash stays the same while they are off. Enabled sites with them on add `brotli-v1` / `zstd-v1` to `required_features`.
2. A site's CRS settings live in `site_waf`; unless the mode is off they compile into `Site.waf` (excluded rule ids ascending and unique) and add `modsecurity-v1`.
3. As with other capabilities, a service account or background publish that introduces a capability an active node of the cluster lacks gets `NODE_CAPABILITY_REQUIRED`; the operator may publish it. `sites.features` tells per site whether each feature can be turned on (reason `nodes` when not), and the UI disables the switches accordingly. Rollback recomputes the three capabilities from the sites it ships.
4. `waf_rules` of `ReportStats` (rule id → requests) keeps at most 50 rules per node, site and minute, rolls up into hours and days with the other per-minute statistics and is copied to ClickHouse `minute_stats`; `waf.topRules` sums a range. Access logs keep the matched rule ids (at most 16, ascending) and `waf_blocked` (PostgreSQL, ClickHouse, CSV).

| Management action | Audit |
| --- | --- |
| A site's HTTPS and compression | `site.https_update` (publishes the site's cluster) |
| A site's CRS | `site.waf_update` (publishes the site's cluster, reason `site_waf_updated`) |

Behavior: [HTTPS and certificates](docs/guide/https.en.md#compression) and [OWASP CRS managed rules](docs/guide/waf.en.md).

## Rule engine extensions

The console is the only authority on expression syntax: `packages/rule-engine` parses conditions and value expressions and `packages/config-compiler` emits typed IR; nodes validate the IR field by field and run it, and never receive expression text. Functions, value expressions, bulk redirects, origin groups, cache rule conditions and the new rule actions are marked by the node capability `rules-v2`:

1. Function calls are encoded as `call`, `field` and `const` nodes of `RuleExpression`. Value expressions of redirect targets and rewrite paths go into `RuleAction.target`; `set_query` is sorted by name and `remove_query` sorted and unique; `preserve_query` is written only when it differs from the action's default.
2. Cache rules are stored as expressions (`cache_rule.expression`, with the lists they reference in `list_ids`). Expressions in the builder's shape compile into the former `path_prefixes`, `paths` and `extensions`, so older nodes run them as before and the content hash stays the same; other expressions compile into `CacheRuleMatch.condition`. `browser_ttl_seconds` goes into `CacheRule`.
3. Bulk redirects compile into `Site.bulk_redirects` (sorted by source) and origin groups into `Origin.group`.
4. A configuration that uses any of these (the `compression` phase and the new fields of `config` actions included) adds `rules-v2` to `required_features`; others encode exactly as before. As with other capabilities, a change by a service account or background job that introduces `rules-v2` while an active node of the cluster lacks it gets `NODE_CAPABILITY_REQUIRED`, while the operator may publish it; `rulesV2` of `sites.features` lets the UI lock the controls.

| Management action | Audit |
| --- | --- |
| A site's rules | `site.rules_update` (publishes the site's cluster, reason `rules_updated`) |
| Global rules | `platform.rules_update` (publishes every cluster) |
| A site's bulk redirects | `site.bulk_redirects_update` (publishes the site's cluster, reason `rules_updated`) |

Behavior: [Rules, IP lists, and GeoIP](docs/guide/rules.en.md) and [Origins and cache](docs/guide/origins-and-cache.en.md).

## Node channel

Connect-RPC over HTTPS; the console process terminates TLS itself.

| Item | Value |
| --- | --- |
| Internal CA | ECDSA P-256, valid for 10 years, generated on first start; private key envelope-encrypted in `pki_authority` |
| Server certificate | Issued by the internal CA at every start, valid for 90 days; checked hourly and reissued in-process when less than a third of the lifetime remains, so new handshakes get the new certificate and established connections keep theirs; SANs are the host name of `EDGEWEIR_NODE_API_URL` (the host name of `EDGEWEIR_PUBLIC_URL` when unset), `EDGEWEIR_NODE_API_HOSTNAMES`, `localhost`, `127.0.0.1`, `::1`, and the container host name |
| Node certificate | CN is the node ID, client authentication only, valid for 30 days (server and node certificates are valid from 1 hour before issue, for nodes whose clocks run behind); with less than a third of the lifetime left, `ReportStatus` asks the node to call `RenewCertificate`. After a renewal the old certificate (`node.previous_cert_serial`) stays valid until the node first authenticates with the new one; a node that could not install the new one renews again with the old one. A disabled node may still renew; its other calls are refused |
| Heartbeat | Every 15 seconds; `WatchConfig` sends a keepalive every 15 seconds |

Enrollment:

1. The operator generates an install command: a single-use token (valid for 5 minutes to 7 days, default 60 minutes, stored as SHA-256 only) and the SHA-256 fingerprint of the internal CA (`--ca-sha256`). The token travels in the `EDGEWEIR_TOKEN` environment variable.
2. The node checks the CA fingerprint in the server certificate chain, then sends the token and a locally generated CSR (`Enroll`).
3. The console verifies the CSR signature, issues the node certificate, and marks the token used and writes the audit entry in the same transaction.

Install command and `install.sh` checks: [Adding nodes](docs/deploy/nodes.en.md).

The console never stores SSH credentials; nodes join only through the one-time install command generated by the console and enroll themselves.

Every RPC other than `Enroll` requires a client certificate verified by the internal CA whose serial number equals the current serial stored for the node: a rotated certificate stops working at once, and deleting a node writes its serial to `node_certificate_revocation`. Disabled or deleted nodes are refused on every RPC, and their open `WatchConfig` streams close.

| RPC | Purpose |
| --- | --- |
| `Enroll` | Exchange a single-use token and a CSR for a node certificate |
| `RenewCertificate` | Rotate the node certificate |
| `WatchConfig` | Server stream: revision notifications, task notifications, ban notifications (`bans-v1`), keepalives |
| `GetConfig` | Snapshot, or diff against `base_revision`, with a revision receipt |
| `ReportStatus` | Heartbeat, apply receipt, origin health and error codes (passive and active checks reported apart), ban state |
| `ReportStats`, `ReportStatsV2` | Per-minute pre-aggregated traffic statistics; deduplicated by batch sequence |
| `ReportLogs` | Sampled access logs; deduplicated by batch sequence |
| `GetOriginCredentials` | S3 origin keys referenced by the cluster's sites |
| `GetCertificates` | Certificate chains and private keys referenced by the cluster's sites |
| `PullTasks`, `ReportTaskResult` | Purge, prefetch, and upgrade tasks |
| `GetBans`, `ReportBans` | Incremental ban changes of the node's cluster by sequence; upload of the node's automatic bans |

A revision receipt is sealed with the master key (purpose `node.revision_receipt`, bound to the node ID) and carries the cluster, the revision, and the content hash. The node stores the receipt locally and returns it in `ReportStatus`; a report of an applied revision above the console's latest revision without a valid receipt is refused.

## Certificates and DNS

`edgeweir-certd` performs ACME issuance, renewal, and revocation and DNS record operations.

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
| Commands | `version`, `providers`, `obtain`, `renew`, `revoke`, `dns.list`, `dns.set`, `dns.present`, `dns.cleanup`, `dns.zones`, `dns.test` |
| DNS providers | The provider catalog `helpers/certd/catalog.json`, see [Providers and credentials](docs/guide/dns-and-alerts.en.md#providers-and-credentials) |

DNS steering is bound per cluster (`dns_binding`, mode Not managed, Manual, or Automatic): `dns.reconcile` computes, every minute, the records of each cluster in Automatic mode from healthy nodes and site domains (one set of address records per cluster, one CNAME per site), creates a `dns_revision` for that cluster, and writes it to the zone of the binding's provider account (`platform_dns_provider`); clusters publish and reconcile on their own, so an unavailable provider does not affect other clusters, and one process at a time writes a cluster (`dns_lease`). Names are recorded in `dns_managed_name` before external records are written, so partial writes can be repaired. Manual mode only produces the records to create and a zone file and writes no DNS. DNS steering provider accounts and DNS-01 credentials use the same provider catalog. A site's domains route as soon as they are saved; a domain belongs to one site. Behavior: [HTTPS and certificates](docs/guide/https.en.md), [DNS steering and alerts](docs/guide/dns-and-alerts.en.md).

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

The Compose profile `cache` starts Valkey; the console does not use Valkey yet.

Alerts (`alerts.sweep`, every minute) detect offline nodes, expiring certificates, unavailable origins, and high 5xx rates (the `cc_mitigation` alert fires on a node's event and resolves once no node reports the site above normal), create `alert_event` rows, fan them out to `alert_delivery` by `alert_subscription`, and send them through an `alert_channel` (webhook, email, DingTalk, WeCom, or Telegram); at delivery the channel must still be enabled and the subscription still valid, and "receive every alert" channels get every alert. Access logs and AccessKeys: [Access logs and AccessKeys](docs/guide/access-logs.en.md).

## Background jobs

| Queue | Schedule | Work |
| --- | --- | --- |
| `alerts.sweep` | Every minute | Alert detection and delivery |
| `dns.reconcile` | Every minute | DNS steering publishing and external record maintenance |
| `traffic.rollup` | Every minute | Traffic rollup and cleanup, access log partition maintenance, upgrade expiry |
| `certificates.sweep` | Every minute | Certificate issuance and renewal |
| `maintenance.recompile` | At start; skipped while `config_recompiled` in `system_setting` matches the current marker | Republishes every cluster once when an upgrade changes what stored data compiles to |
| `maintenance.prune-revisions` | Minute 17 of every hour | Deletes revisions beyond the retention count |
| `maintenance.expire-cache-tasks` | Minute 43 of every hour | Fails purge and prefetch deliveries past their deadline |
| `maintenance.expire-enrollment-tokens` | Every 30 minutes | Deletes enrollment tokens expired or used more than 7 days ago |
| `maintenance.prune-bans` | Every 10 minutes | Deletes bans that expired more than an hour ago |
| `maintenance.rotate-challenge-keys` | Hourly at minute 11 | Rotates challenge keys that are a day old |
| `maintenance.prune-security-events` | Hourly at minute 37 | Deletes security events past the retention |

## Data model

Tables are defined in `packages/db/src/schema`; migrations are plain SQL generated by drizzle-kit in `packages/db/migrations` and run at console startup (see [Startup sequence](#startup-sequence)).

### Account and identities

| Table | Contents |
| --- | --- |
| `user` | The operator's account, the only one, created by the setup wizard |
| `session` | Sign-in sessions |
| `account` | Sign-in credentials (password hash) |
| `verification` | better-auth verification records |
| `two_factor` | TOTP secrets and backup codes |
| `passkey` | Passkey public keys |
| `apikey` | AccessKeys: hash, permissions, enabled state |
| `service_account` | Service accounts: name, scopes, enabled (cannot sign in) |
| `service_account_key` | Service account keys: SHA-256, prefix, last use, revocation |
| `idempotency_key` | Idempotency keys of `/api/v1` writes: caller, method, path, body hash and final response, kept 24 hours |
| `rate_limit` | Rate-limit counters of the authentication endpoints |

### Infrastructure

| Table | Contents |
| --- | --- |
| `region` | Region dictionary |
| `cluster` | Clusters: sets of nodes that share one revision stream |
| `node_group` | Node groups, optionally tied to a region |
| `node` | Nodes: status, capabilities, certificate serial and fingerprint (after a renewal also the replaced certificate's serial), last heartbeat, last reported ban state and CC level per site |
| `node_ip` | IP addresses reported by nodes |
| `enrollment_token` | SHA-256 and usage of enrollment tokens |
| `node_certificate_revocation` | Certificate serials revoked when a node is deleted |
| `pki_authority` | Internal CA, private key envelope-encrypted |
| `system_setting` | Platform key/value settings: setup token, session secret HMAC check value, origin allow list, SMTP, node release source, alert policy, bans, platform protection and the CC template, platform error pages, one-time migration markers |
| `audit_log` | Audit of management actions |

### Sites and configuration

| Table | Contents |
| --- | --- |
| `site` | Sites: cluster, enabled state, cache key, slicing, Cache-Tag forwarding, WebSocket, certificate, TLS settings, cache generation, log sample rate, whether error pages replace origin errors and when they were saved |
| `site_domain` | Site domains (host names or wildcards), unique across the console |
| `site_star` | Per-user stars |
| `origin_pool` | Origin pools: timeouts, keepalive, failure thresholds, origin TLS verification, active health check and session affinity (kept while off) |
| `origin` | Origins and their origin group (empty for the default group) |
| `origin_credential` | S3 origin keys, envelope-encrypted |
| `cache_rule` | Cache rules: condition expression and list references, status and size conditions, action, edge and browser TTLs |
| `edge_rule` | Site or global rules: phase, expression, action, list references |
| `bulk_redirect` | A site's bulk redirects: source (path or domain plus path, unique per site), target, status code, whether the query string is kept, order |
| `ip_list` | IP lists (normalized CIDRs, unique names); `allow` / `block` lists apply to every site |
| `ip_ban` | Dynamic bans: scope (platform / site), normalized CIDR, reason code, source (manual / auto; auto bans keep the node and trigger), expiry and removal time, `seq` (sequence `ip_ban_seq`), whether it is delivered |
| `site_protection` | Site protection: Under Attack and its challenge type, pass lifetime, proof-of-work difficulty, CC policy (template or custom), JA4 logging; no row means the defaults |
| `site_waf` | A site's OWASP CRS: mode (off, detect, block), paranoia level, anomaly threshold, excluded rule ids, request body limit; no row means off |
| `site_error_page` | A site's error pages: one template per status (403, 429, 502, 503, 504) |
| `challenge_key` | Challenge keys of a cluster (`next`, `current`, `previous`), secrets envelope-encrypted |
| `config_revision` | Revisions per cluster: number, content hash, binary IR, reason code |
| `node_config_status` | Node apply receipts and heartbeats, with the receipt verification flag |
| `cluster_rollout` | Configuration canary of a cluster: policy (switch, observation window, auto promotion, 5xx thresholds) and the current rollout (stable and candidate revisions, window, outcome) |

### Certificates, DNS, and domains

| Table | Contents |
| --- | --- |
| `certificate` | Chain, fingerprint, expiry, and renewal state; private key and ACME account envelope-encrypted |
| `acme_challenge` | Short-lived public HTTP-01 responses |
| `dns_credential` | DNS provider credentials and zone for ACME DNS-01, envelope-encrypted |
| `dns_challenge_lease` | Cleanup obligations of DNS-01 TXT records |
| `platform_dns_provider` | DNS steering provider accounts and their zones, credentials envelope-encrypted |
| `dns_binding` | A cluster's DNS binding: mode, provider account, cluster domain, TTL, lines, desired / applied DNS revision |
| `dns_revision` | A cluster's DNS revisions: binding settings, record set, managed names, status |
| `dns_managed_name` | Registered managed DNS names and the cluster they belong to |
| `dns_lease` | Leases for DNS work (cluster bindings, DNS-01 credentials): one process at a time handles a binding or credential |

### Statistics, logs, tasks, and alerts

| Table | Contents |
| --- | --- |
| `node_minute_stats` | Traffic per node, site, and minute, with top URLs, top IPs and matched CRS rules |
| `node_hour_stats` | Hourly rollups |
| `node_day_stats` | Daily rollups |
| `stats_rollup_dirty` | Time buckets waiting for a rollup (hours, days, usage windows) |
| `node_stats_cursor` | Per-node high-water mark of statistics batch sequences and the statistics watermark (`complete_until`) |
| `site_usage` | Recomputable usage per site and UTC 5-minute window (requests, bytes out and in, exact decimals), revision and global `seq` (sequence `site_usage_seq`) |
| `access_log` | Sampled access logs (request id; JA4 when the site records it; matched CRS rules and whether CRS blocked the request), one partition per UTC day |
| `security_event` | CC mitigation events reported by nodes: level changes, escalated paths, automatic bans, with the top addresses and paths of the moment |
| `node_log_cursor` | Per-node high-water mark of log batches |
| `origin_health` | Origin health and error codes reported by nodes, one row each for the passive and the active check |
| `cache_task` | Purge and prefetch tasks |
| `cache_task_node` | Delivery and result of a task on each node |
| `node_upgrade` | Node upgrade jobs |
| `node_upgrade_delivery` | Phase, state, deadline, and health observation of an upgrade on each node |
| `alert_channel` | Alert channels, configuration envelope-encrypted |
| `alert_subscription` | User subscriptions per site and channel |
| `alert_state` | Current alert state (site and platform alerts) |
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
| `0023_p0_site_state` | `site.suspended`, `suspend_reason`, `suspend_note`, `suspended_at` (platform suspension) |
| `0024_p0_organization_limits` | `organization_limit` |
| `0025_p0_service_accounts` | `service_account`, `service_account_key`, `idempotency_key`; `invitation.inviter_id` nullable, new `inviter_service_account_id` |
| `0026_p0_usage` | `site_usage`, sequence `site_usage_seq`, `node_stats_cursor.complete_until`; marks usage windows for existing minute statistics |
| `0027_p0_config_canary` | `cluster_rollout`; `alert_event.site_id` and `alert_state.site_id` nullable (platform alerts) |
| `0028_g1_dynamic_bans` | `ip_ban`, sequence `ip_ban_seq`; `node.ban_status`; `organization_limit.max_bans` |
| `0029_g2_challenges` | `site_protection`, `challenge_key`, `security_event`; `node.security_state`; `access_log.ja4` |
| `0030_g3_waf` | `site_waf`; `waf_rules` in minute, hour and day statistics and the view `traffic_hour_stats`; `access_log.waf_rule_ids`, `waf_blocked` |
| `0031_g4_cache_origins_error_pages` | `site_error_page`; `origin_pool.active_health_check`, `session_affinity`; `site.keep_cache_tag`, `intercept_origin_errors`, `error_pages_updated_at`; `origin_health.source` (joins the primary key, existing rows are passive); `access_log.request_id` |
| `0032_g5_rules` | `bulk_redirect`; `origin.group_name`; `cache_rule.browser_ttl_seconds`, `list_ids`; the structured conditions of existing cache rules are rewritten as equivalent expressions and the structured columns cleared |
| `0033_domains_without_ownership` | Drops `domain_ownership` and `site_domain.verified`; of duplicate pending domains one row stays; `site_domain (name, wildcard)` is unique |
| `0034_sites_without_suspension` | Drops `site.suspended`, `suspend_reason`, `suspend_note`, `suspended_at`; suspended sites become disabled; service accounts lose `sites:suspend` |
| `0035_without_organization_limits` | Drops `organization_limit`; service accounts lose `limits:read`, `limits:write` |
| `0036_single_operator` | Keeps only the earliest platform administrator who is not disabled (the other accounts' alert subscriptions move to it); IP list names become unique (organization lists with a taken name get a suffix and their rules follow), former organization lists become collections; drops `organization`, `member`, `invitation`, `organization_settings`, every `organization_id`, `session.active_organization_id` and `alert_channel.available_to_tenants`; service accounts lose the organization scopes |
| `0037_dns_cluster_bindings` | `dns_binding`, `dns_lease`; `dns_revision.cluster_id`, `dns_managed_name.cluster_id`; the DNS steering policy becomes one binding per cluster; drops `dns_state` |
| `0038_node_lifecycle` | `node.previous_cert_serial`; `node_upgrade_delivery.deadline_at` (deliveries already released keep the deadline of 30 minutes after creation) |

## Build output

| Step | Output |
| --- | --- |
| `vite build` | `apps/console/dist/web` (SPA) |
| `node scripts/build-server.mjs` (esbuild) | `apps/console/dist/server/main.js`: the server and all dependencies in one ESM file; `dist/server/recover.js`: the account recovery command, also with all dependencies, without a source map; `install/` copied to `dist/server/install`, migrations to `dist/migrations` |
| Dockerfile stage `certd` | `golang:1.27.1-alpine` builds `edgeweir-certd` |
| Dockerfile stage `build` | `node:24.21.0-alpine` with pnpm 12.6.0 builds the console |
| Dockerfile stage `runtime` | `node:24.21.0-alpine` + tini; no `node_modules`; runs as user `node`; `EXPOSE 3000 8443`; health check `edgeweir-healthcheck` |

Base images are pinned by tag and multi-arch index digest. The image version is `<YYYYMMDD>-<commit>` (`scripts/image-version.sh`), written to `EDGEWEIR_VERSION` and the image label `org.opencontainers.image.version`; the full commit ID goes to `org.opencontainers.image.revision`. Development commands and tests: [CONTRIBUTING.en.md](CONTRIBUTING.en.md).

## Observability

| Item | Behavior |
| --- | --- |
| Logs | One JSON line per event; `warn` and `error` to stderr, the rest to stdout; level set by `LOG_LEVEL` |
| `/healthz` | Returns status and version |
| Container health check | `ROLE=worker` checks only that the process is alive; other roles request `http://127.0.0.1:${PORT}/healthz` |
| Node state | Online state, applied revision, data plane health, and origin health come from `node_config_status` and `origin_health` |
