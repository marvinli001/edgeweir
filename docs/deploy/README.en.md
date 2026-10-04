# Deployment overview

Console components, runtime requirements, supported platforms, and process roles.

## Components

| Component | Description | Required |
| --- | --- | --- |
| Console image `ghcr.io/marvinli001/edgeweir` | linux/amd64, linux/arm64. One Node.js process: web UI and API (`:3000`), node channel (`:8443`), pg-boss worker; ships `edgeweir-certd` (ACME and DNS records). | Yes |
| PostgreSQL 18 | Only external dependency. Holds all state, the pg-boss queues, and the sign-in rate-limit counters; LISTEN/NOTIFY broadcasts configuration changes between instances. | Yes |
| ClickHouse | Raw access logs and per-minute statistics, enabled with `EDGEWEIR_ANALYTICS=clickhouse`; see [access logs and AccessKeys](../guide/access-logs.en.md). | No |
| Edge nodes | [edgeweir-node](https://github.com/marvinli001/edgeweir-node) on separate hosts; see [adding nodes](nodes.en.md). | — |

## Runtime requirements

| Item | Requirement | Constraint |
| --- | --- | --- |
| Process | Always on | Scale-to-zero or per-request freezing stops the worker and the node streams; see [process roles](#process-roles). |
| PostgreSQL | 18; the console's database user has `CREATE` on the target database (schemas `drizzle`, `pgboss`) and `CREATE` on schema `public` | Earlier versions are untested. Migrations run at startup. |
| 3000/TCP | HTTP: web UI, `/rpc`, `/api/v1`, `/healthz`, `/install.sh`, `/downloads/*`; the node channel's WebSocket entry `/node-channel` (closed by default) | A reverse proxy may terminate TLS; see [ports and reverse proxy](networking.en.md). |
| 8443/TCP | Node channel (nodes and regional probes): the console terminates TLS and enforces mTLS after enrollment | Publicly reachable, direct or layer-4 passthrough only; or nodes use the [WebSocket entry](networking.en.md#the-node-channels-websocket-entry) on 3000 and 8443 stays internal. |
| Master key | `EDGEWEIR_MASTER_KEY`: base64, at least 32 bytes decoded; generate with `openssl rand -base64 32` | Keep apart from database backups; a lost key leaves encrypted data unreadable; replace it by [rotating](docker.en.md#rotating-the-master-key) it. |
| Session secret | `BETTER_AUTH_SECRET`: derived from the master key when unset | Deployments that set it keep it; the console refuses to start once it is removed. |
| Architecture | linux/amd64, linux/arm64 | — |
| Resources | No minimum specification | `compose.yml` sets `nofile` 262144 for ClickHouse. |

## Supported platforms

| Platform | Method | Documentation | Status |
| --- | --- | --- | --- |
| Docker Compose | `compose.yml`: console and bundled PostgreSQL 18 | [docker.en.md](docker.en.md) | Supported |
| docker run | Console and PostgreSQL containers on a dedicated Docker network | [docker.en.md](docker.en.md#without-compose-standalone-containers) | Supported |
| BaoTa / aaPanel, or any Docker host | `deploy.sh` with `compose.baota.yml` (bundled PostgreSQL) or `compose.baota-host.yml` (local or cloud PostgreSQL, host network) | [baota.en.md](baota.en.md), [deploy-script.en.md](deploy-script.en.md) | Supported |
| Railway | Console image with Railway PostgreSQL 18; web console, optional Railway CLI | [railway.en.md](railway.en.md) | Supported |
| Fly.io | Console image with an external PostgreSQL 18; flyctl deployment, Dashboard for secrets, IPs, certificates, and logs | [fly.en.md](fly.en.md) | Supported |
| bunny.net Magic Containers | Console image with an external PostgreSQL 18; a CDN endpoint for the web console, an Anycast IP for the node channel; Dashboard, optional bunny CLI | [bunny.en.md](bunny.en.md) | Supported |
| Render | `render.yaml` creates the console and Render Postgres 18 in one click, or manual creation in the Dashboard; nodes connect through the WebSocket entry (edgeweir-node 0.2.0 or later) | [render.en.md](render.en.md) | Supported |
| Zeabur | The `zeabur.yaml` template creates the console and PostgreSQL 18 in one click, or manual creation in the Dashboard; runs on a Zeabur Server, the node channel goes through TCP port forwarding | [zeabur.en.md](zeabur.en.md) | Supported |

### Platform conditions

A platform not listed above must meet every condition in this table.

| Condition | Description | When not met |
| --- | --- | --- |
| Always-on process | The process keeps running and never scales to zero for lack of traffic | Worker certificate renewal and scheduled jobs, the LISTEN/NOTIFY event bus, and node `WatchConfig` streams stop. |
| Public TCP port or WebSocket | The node channel port is exposed as raw TCP, and the platform does not terminate TLS; or the platform's HTTP entry forwards WebSocket and nodes use the [WebSocket entry](networking.en.md#the-node-channels-websocket-entry) | Enrollment fails (`CA pin mismatch`); mTLS cannot be established. |
| PostgreSQL 18 | Reachable from the console, with the privileges above | The console waits 60 seconds, then exits. |
| Persistent secrets | `EDGEWEIR_MASTER_KEY` (and `BETTER_AUTH_SECRET` when set) stay the same across restarts and redeploys | Encrypted data becomes unreadable; the console refuses to start. |
| Trusted proxy address | Port 3000 receives client connections directly, or the platform proxy connects from fixed addresses that can go into `EDGEWEIR_TRUSTED_PROXIES` | Audit entries and sign-in rate limits see only the proxy address. |

## Process roles

`ROLE` selects what the image runs.

| `ROLE` | Runs | Listens on | Container health check |
| --- | --- | --- | --- |
| `all` (default) | Everything in `app` and `worker` | 3000, 8443 | `GET /healthz` |
| `app` | Web UI, `/rpc`, `/api/v1`, node channel, setup token output, LISTEN/NOTIFY subscription | 3000, 8443 | `GET /healthz` |
| `worker` | pg-boss queues and schedules | Nothing | Process liveness only |

Every role runs database migrations at startup.

Worker schedules:

| Interval | Jobs |
| --- | --- |
| Every 10 seconds | Probe-driven address reachability and scheduling rule evaluation (one process at a time) |
| Every minute | Alert checks; DNS sync; traffic and access-log rollups, node upgrade timeouts; certificate issuance and renewal |
| Hourly | Pruning old revisions; expiring undelivered purge and prefetch tasks |
| Every 30 minutes | Deleting enrollment tokens expired or used more than 7 days ago |
| At startup | When an upgrade changes what the stored configuration compiles to, republishing every cluster once (reason "Configuration recompiled after an upgrade") |

### Scaling

- Several `app` instances and one or more `worker` instances share one PostgreSQL database.
- Migrations are serialized by a PostgreSQL advisory lock; instances may start at the same time.
- Sign-in rate-limit counters live in PostgreSQL, are shared by all instances, and survive restarts.
- The node channel CA is stored in the database; every `app` instance issues its server certificate from the same CA, so a layer-4 load balancer may spread 8443 across `app` instances.
- All instances run the same image tag and are upgraded together; see [upgrades](upgrade.en.md).

## Deployment documents

| Document | Contents |
| --- | --- |
| [Docker Compose](docker.en.md) | Compose and `docker run` deployment |
| [BaoTa / aaPanel](baota.en.md) | Panel deployment, nginx site, stream passthrough |
| [deploy.sh reference](deploy-script.en.md) | Install and upgrade script |
| [Railway](railway.en.md) | Web console deployment with CLI equivalents |
| [Fly.io](fly.en.md) | flyctl deployment and Dashboard steps |
| [bunny.net Magic Containers](bunny.en.md) | Dashboard deployment with bunny CLI equivalents |
| [Render](render.en.md) | One-click Deploy to Render, manual creation in the Dashboard, Render CLI |
| [Zeabur](zeabur.en.md) | One-click template, manual creation in the Dashboard, Zeabur CLI |
| [Ports, reverse proxy, and trusted proxies](networking.en.md) | 3000 and 8443, nginx examples, the node channel's WebSocket entry, `EDGEWEIR_TRUSTED_PROXIES` |
| [Adding nodes](nodes.en.md) | Install command, `install.sh` checks, regional probes, downloads mirror |
| [Versions, upgrades, and rollback](upgrade.en.md) | Image tags, pinning, upgrade, rollback, signature verification |
| [Backup and recovery](backup.en.md) | Database and master key backup, restore acceptance |
| [Environment variables](../reference/environment.en.md) | Every variable and its default |
