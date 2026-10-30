# Maintenance

Key rotation, database size and retention, background jobs, health checks, logs, monitoring, certificate rotation, disk usage, and account recovery.

## Routine checks

| Check | Command or location | Healthy |
| --- | --- | --- |
| Console | `curl -s http://127.0.0.1:3000/healthz`; `docker compose ps` | `"status":"ok"`; `console` is `healthy` |
| Error log | `docker compose logs --since 24h console \| grep -E '"level":"(warn\|error)"'` | No recurring error |
| Needs attention | "Needs attention" on the **Overview** | Not shown (nothing pending); see [needs attention](../guide/clusters.en.md#needs-attention) |
| Nodes | **Clusters & nodes** | Nodes "Online" and "In sync", none "Data plane unhealthy", "Certificate expired", or "Upgrade required" |
| Certificates | **Certificates** | None "Issuance failed" |
| Alerts | **Alerts** | The latest delivery of each alert channel succeeded; see [Alerts](../guide/alerts.en.md) |
| Backups | The backup directory or the platform's backup page | Time and size of the latest backup look right; see [backup and recovery](backup.en.md) |
| Database and disk | See [database](#database) and [disk and resources](#disk-and-resources) | Growth matches the retention settings |
| Version | [GitHub Releases](https://github.com/marvinli001/edgeweir/releases) | The running version is not behind a `stable` with security fixes |

## Master key rotation

Replaces `EDGEWEIR_MASTER_KEY` (for example when it may have leaked). Encrypted data in the database is re-encrypted with the new key at startup.

1. Back up the database and `.env`; see [backup and recovery](backup.en.md).
2. In `.env`, move the old value to `EDGEWEIR_MASTER_KEY_PREVIOUS` and set `EDGEWEIR_MASTER_KEY` to a new value:

   ```bash
   openssl rand -base64 32
   ```

   With files, use `EDGEWEIR_MASTER_KEY_PREVIOUS_FILE` and `EDGEWEIR_MASTER_KEY_FILE`.
3. Recreate the console: `docker compose up -d` (`./deploy.sh restart` for `deploy.sh` deployments).
4. Check the result:

   ```bash
   docker compose logs console | grep -E 'master key rotation|EDGEWEIR_MASTER_KEY_PREVIOUS'
   ```

   | Log | Meaning | Action |
   | --- | --- | --- |
   | `no envelope uses EDGEWEIR_MASTER_KEY_PREVIOUS any more: remove it and restart the console` | Every ciphertext uses the new key | Go to step 5 |
   | `envelopes still use EDGEWEIR_MASTER_KEY_PREVIOUS: keep it set` | Some ciphertexts still use the old key | Keep the old key; investigate the `cannot re-seal an envelope of the previous master key` lines and restart |
   | `envelopes sealed with neither master key cannot be opened` | Some ciphertexts were sealed by neither the new nor the old key | Check that `EDGEWEIR_MASTER_KEY_PREVIOUS` is the key from before the rotation |

5. Remove `EDGEWEIR_MASTER_KEY_PREVIOUS` and recreate the console again.
6. Store the new key offline; keep the old key until every backup from before the rotation has expired.

| Item | Description |
| --- | --- |
| Validation | Startup is refused when `EDGEWEIR_MASTER_KEY_PREVIOUS` equals `EDGEWEIR_MASTER_KEY`; both must be base64 of 32 or more bytes |
| Sessions and two-factor | Unaffected: without `BETTER_AUTH_SECRET`, the session secret derived from the old key is stored in the database, sealed with the new key, and still used after `EDGEWEIR_MASTER_KEY_PREVIOUS` is removed |
| Nodes | No action; the configuration receipts nodes keep are issued again under the new key with their next configuration fetch |
| Several console instances | Recreate every instance with the same variables |
| Backups from before the rotation | Still sealed with the old key: set it as `EDGEWEIR_MASTER_KEY_PREVIOUS` when restoring |
| `deploy.sh` backups | Do not contain `EDGEWEIR_MASTER_KEY_PREVIOUS` |

## Session secret

`BETTER_AUTH_SECRET` signs session cookies and encrypts TOTP secrets and backup codes.

| Case | Result |
| --- | --- |
| Unset | Derived from the master key; the `session secret` log line has `source` `master_key`, or `stored` after a master key rotation |
| Set to a new value | Startup warns `BETTER_AUTH_SECRET changed`: every session ends and enabled two-factor authentication can no longer be verified; turn it off on the server and enable it again; see [account recovery](#account-recovery) |
| Removed from an existing deployment | Startup is refused: `BETTER_AUTH_SECRET is not set, but this database was used with another secret`; restore the original value |
| Master key leaked | Rotate the master key and set a new `BETTER_AUTH_SECRET` (`openssl rand -base64 32`, at least 32 characters) |

## Database

### Size

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir -c \
  "select pg_size_pretty(pg_database_size('edgeweir'))"
docker compose exec -T postgres psql -U edgeweir -d edgeweir -c \
  "select schemaname, relname, pg_size_pretty(pg_total_relation_size(relid)) from pg_statio_user_tables order by pg_total_relation_size(relid) desc limit 15"
```

| Growth source | Control |
| --- | --- |
| Access logs (`EDGEWEIR_ANALYTICS=lite`) | Retention and the sites' sample rates; for high volume use ClickHouse; see [access logs](../guide/access-logs.en.md) |
| Node logs | Retention days and entries per node; see [node log retention](../guide/node-logs.en.md#retention) |
| Statistics, usage, security events | Retention in the table below |
| Audit log | Never deleted automatically |

PostgreSQL autovacuum reclaims the rows the cleanup jobs delete; partitioned tables are cleaned by dropping partitions.

### Retention

The worker runs the cleanup (`ROLE` `all` or `worker`); without a worker nothing is deleted.

| Data | Kept | Setting |
| --- | --- | --- |
| Access logs | Default 7 days; PostgreSQL 1–30 days, ClickHouse 1–90 days | "Access logs" in **System settings**; see [access logs](../guide/system.en.md#access-logs) |
| Node logs | Default 7 days (1–30), at most 10000 entries per node (1000–100000) | "Node log retention" in **System settings**; see [node log retention](../guide/system.en.md#node-log-retention) |
| Security events | Default 30 days (7–365) | "Security event retention (days)" in **Protection settings**; see [protection](../guide/system.en.md#protection) |
| Usage | Default 100 days (35–400) | "Usage" in **System settings**; see [usage](../guide/system.en.md#usage) |
| Traffic statistics | Minute buckets 7 days, hour buckets 90 days, day buckets 365 days | Fixed |
| Configuration revisions | Latest 200 per cluster; the latest revision and the canary's stable and candidate revisions are always kept | Fixed |
| DNS revisions | Latest 200 per cluster; desired, applied, and held-back revisions are always kept | Fixed |
| Purge and preload tasks | 90 days after creation | Fixed |
| Expired bans | 1 hour after expiry | Fixed |
| Node enrollment tokens | 7 days after expiry or use | Fixed |
| API idempotency keys | 24 hours | Fixed |
| Expired origin client certificates | 7 days after expiry | Fixed |
| Audit log | Never deleted | — |

### Background jobs

The worker uses pg-boss; its tables are in the database's `pgboss` schema. Cron times are UTC.

| Queue | Schedule | Purpose |
| --- | --- | --- |
| `alerts.sweep` | Every minute | Alert evaluation and delivery |
| `mitigation.evaluate` | Every minute | Starting and ending automatic mitigation |
| `rollouts.evaluate` | Every minute | Advancing configuration canaries |
| `dns.reconcile` | Every minute | DNS record sync; drops replaced CNAME prefixes after 24 hours |
| `traffic.rollup` | Every minute | Statistics rollup and cleanup, usage and usage protection, access log partitions and retention, expiry of node upgrade tasks |
| `certificates.sweep` | Every minute | Certificate issuance and renewal |
| `maintenance.recompile` | Every start | Configuration recompile after an upgrade |
| `maintenance.check-certificates` | Every start | Marks uploaded certificates nodes cannot load |
| `maintenance.link-acme-accounts` | Every start | Links ACME certificates and accounts |
| `maintenance.prune-bans` | Every 10 minutes | Deletes expired bans |
| `maintenance.prune-node-logs` | Every start and every 10 minutes | Deletes node logs beyond retention or count, and old debug log pulls |
| `maintenance.expire-enrollment-tokens` | Every 30 minutes | Deletes stale enrollment tokens |
| `maintenance.rotate-challenge-keys` | Minute 11 of every hour | Rotates challenge keys older than 1 day |
| `maintenance.rotate-session-ticket-keys` | Minute 13 of every hour | Rotates TLS session ticket keys older than 12 hours |
| `maintenance.prune-revisions` | Minute 17 of every hour | Prunes configuration and DNS revisions |
| `maintenance.rotate-origin-client-certificates` | Minute 19 of every hour | Replaces origin client certificates 30 days before expiry |
| `maintenance.prune-idempotency-keys` | Minute 29 of every hour | Deletes expired idempotency keys |
| `maintenance.prune-security-events` | Minute 37 of every hour | Deletes security events beyond retention |
| `maintenance.expire-cache-tasks` | Minute 43 of every hour | Expires undelivered purge and preload tasks and deletes old ones |

Scheduling (probe reachability and scheduling rules) is evaluated every 10 seconds by an in-process timer; a lease lets one console process evaluate at a time.

Job states:

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir -c \
  "select name, state, count(*) from pgboss.job group by 1, 2 order by 1, 2"
```

When the `failed` count grows, search the console log for errors of that queue. Do not delete tables in the `pgboss` schema by hand.

## Health checks

| Check | Behavior |
| --- | --- |
| `GET /healthz` | Returns `{"status":"ok","version":"<version>"}`; only shows that the HTTP server runs, checks neither database nor worker; no sign-in needed |
| Container `HEALTHCHECK` | `edgeweir-healthcheck`: interval 10 s, timeout 3 s, start period 30 s, 5 retries; succeeds at once with `ROLE=worker`, other roles request `http://127.0.0.1:${PORT}/healthz` with a 2-second timeout |
| Platform health checks | Path `/healthz` |
| Database | Not covered by `/healthz`; a lost connection logs `database connection lost` |
| Nodes | Heartbeat every 15 seconds; "Online" with a heartbeat within 45 seconds |

## Logs

| Item | Description |
| --- | --- |
| Format | One JSON object per line: `time`, `level`, `msg`, and fields; `info` and `debug` go to stdout, `warn` and `error` to stderr |
| Level | `LOG_LEVEL`: `debug`, `info` (default), `warn`, `error` |
| Viewing | `docker compose logs -f console`; `./deploy.sh logs console` for `deploy.sh` deployments |
| Rotation | Done by the container runtime: Docker's `json-file` driver has no size limit by default; set `log-opts` in `/etc/docker/daemon.json` (for example `"max-size": "50m"`, `"max-file": "5"`) |
| Node logs | Logs reported by nodes are viewed in the console; see [node logs](../guide/node-logs.en.md) |

## Monitoring

| Object | Method |
| --- | --- |
| Offline nodes, certificates, DNS | Alert rules and alert channels; see [Alerts](../guide/alerts.en.md) |
| External reachability | Regional probes check the nodes from each region; see [regional probes](../guide/scheduling.en.md#regional-probes) |
| The console itself | External monitoring of `https://<console>/healthz`; alerts are sent by the console and stop when it stops |
| Audit | Management actions are written to the [audit log](../guide/system.en.md#audit-log) |

## Automatic certificate and key rotation

| Object | Lifetime | Rotation |
| --- | --- | --- |
| Site certificates (ACME) | Set by the CA | `certificates.sweep` renews them per the [renewal](../guide/https.en.md#renewal) rules; failures show "Issuance failed" and are retried |
| Uploaded certificates | Set by the certificate | Not renewed; upload a new certificate before expiry |
| Node channel server certificate | 90 days | Checked hourly; reissued with less than 30 days left or when its names change; log `node channel certificate rotated` |
| Node client certificates | 30 days | Renewed by the node; node details show "Expires soon" with less than 10 days left |
| Origin client certificates | — | Replaced 30 days before expiry |
| Challenge keys | 1 day | Checked hourly |
| TLS session ticket keys | 12 hours | Checked hourly |
| Node channel CA | — | Not rotated |
| Origin CA, origin client CA | — | Not rotated automatically; manual rotation in [rotating the CAs](../guide/https.en.md#rotating-the-cas) |

## Disk and resources

| Object | Check | Action |
| --- | --- | --- |
| Docker usage | `docker system df` | Remove old console images no longer used: `docker image rm ghcr.io/marvinli001/edgeweir:<old tag>`; keep the current and the previous version for a downgrade |
| PostgreSQL volume | `docker system df -v \| grep postgres-data` | See [database](#database) |
| ClickHouse volume | `docker system df -v \| grep clickhouse-data` | Shorten access log retention |
| Backup directory | `du -sh backups` | `deploy.sh` keeps `EDGEWEIR_BACKUP_KEEP` backups; cron backups are cleaned as in [scheduled backups](backup.en.md#scheduled-backups) |
| Memory and CPU | `docker stats --no-stream` | Requirements in the [deployment overview](README.en.md#runtime-requirements); splitting web and worker in [process roles](README.en.md#process-roles) |

> [!WARNING]
> `docker compose down -v` and `docker volume prune` delete volumes such as `postgres-data`: all data.

## Account recovery

When sign-in is impossible (forgotten password, lost two-factor device, login IP allow list without the current address), run on the console's server:

```bash
docker compose exec console node dist/server/recover.js --reset-password --disable-two-factor
```

The options `--reset-password`, `--disable-two-factor`, and `--clear-login-allowlist` can be combined. Steps in [account recovery](../guide/account.en.md#account-recovery); options, output, and exit codes in the [command line reference](../reference/cli.en.md#account-recovery).
