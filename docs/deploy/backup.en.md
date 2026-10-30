# Backup and recovery

Backup and restore of the database, master key, ClickHouse, and node state; node resynchronization, restore acceptance, and restore drills.

## What to back up

| Object | Location | Method | Constraint |
| --- | --- | --- | --- |
| PostgreSQL | Database `edgeweir` | `pg_dump --format=custom` | Use PostgreSQL tools of the server's major version (PostgreSQL 18 in `compose.yml`) |
| `EDGEWEIR_MASTER_KEY` | `.env`, or the file `EDGEWEIR_MASTER_KEY_FILE` names | Offline copy, stored apart from database backups | Without it the encrypted data in the database cannot be decrypted; see [data sealed with the master key](#data-sealed-with-the-master-key) |
| `EDGEWEIR_MASTER_KEY_PREVIOUS` | `.env` during a rotation | Stored with the master key | Needed by backups taken before the rotation finished |
| `BETTER_AUTH_SECRET` | `.env` (if set) | Stored with the master key | When unset, the session secret is derived from the master key |
| Deployment configuration | `.env`, `compose.yml`, `compose.override.yml` | File copies | Store a `.env` that holds keys like the keys |
| ClickHouse | Volume `clickhouse-data` (with `EDGEWEIR_ANALYTICS=clickhouse`) | Volume copy | Same restore point as PostgreSQL; see [ClickHouse](#clickhouse) |
| Node state | `/var/lib/edgeweir-node` on each node | Local backup on the node | Holds the node's private key and `config/receipts.json`; the private key is never uploaded to the console |
| Node cache | `/var/cache/edgeweir-node` on each node | Not backed up | Rebuilt |

With `EDGEWEIR_ANALYTICS=lite` (default) access logs and statistics are in PostgreSQL and part of the database backup.

> [!WARNING]
> Backups contain account data, audit logs, and access logs; restrict who can read them. Pass database credentials through a restricted `.pgpass` or environment variables, never on the command line or in Git.

### Data sealed with the master key

The master key encrypts this data before it is written to the database; each ciphertext is bound to its table, column, and record:

| Data | Used for |
| --- | --- |
| Private keys of the node channel CA and the Origin CA | Issuing node certificates, node channel server certificates, origin certificates, and origin client certificates |
| Certificate private keys, ACME accounts | Site HTTPS and certificate renewal |
| DNS credentials, DNS provider credentials | ACME DNS-01 and DNS scheduling |
| S3 origin keys, site secrets, access authentication secrets, origin client certificate keys | Origin requests and access control |
| Alert channel configuration, SMTP settings | Alert notifications |
| Challenge keys, TLS session ticket keys | Challenges and TLS session resumption on nodes |
| Custom ACME directory settings, setup token, session secret kept after a rotation | System settings and sign-in |

## 1. Create a backup

Docker Compose built-in database:

```bash
umask 077
docker compose exec -T postgres pg_dump -U edgeweir -d edgeweir --format=custom > edgeweir.dump
docker compose exec -T postgres pg_restore --list < edgeweir.dump > edgeweir.dump.list
```

External PostgreSQL:

```bash
umask 077
pg_dump --format=custom --file=edgeweir.dump --dbname=edgeweir
pg_restore --list edgeweir.dump > edgeweir.dump.list
```

Verify:

```bash
grep -c 'TABLE DATA' edgeweir.dump.list
grep -c '__drizzle_migrations' edgeweir.dump.list
```

Expected: both counts are greater than 0.

| Deployment | Backup method |
| --- | --- |
| `deploy.sh` | `./deploy.sh backup` (runs automatically before `update`): writes the same `edgeweir.dump`, a copy of `.env` (master key, `EDGEWEIR_MASTER_KEY_PREVIOUS`, and `BETTER_AUTH_SECRET` commented out), and the compose files; keeps the latest `EDGEWEIR_BACKUP_KEEP` backups (default 5); see the [deploy.sh reference](deploy-script.en.md#backups) |
| Render | Database page **Recovery → Create export**; see [Render](render.en.md#upgrade) |
| Zeabur | `pg_dump` in the `postgresql` service, or that service's **Backup** page; see [Zeabur](zeabur.en.md#upgrade) |
| Other platforms | The platform database's snapshot or export, or `pg_dump` on a host that can reach the database |

### Scheduled backups

crontab example for a Docker Compose deployment, daily at 03:00, kept for 14 days:

```bash title="crontab"
0 3 * * * cd /opt/edgeweir && umask 077 && docker compose exec -T postgres pg_dump -U edgeweir -d edgeweir --format=custom > backups/edgeweir-$(date +\%Y\%m\%d).dump && find backups -name 'edgeweir-*.dump' -mtime +14 -delete
```

`deploy.sh` deployment:

```bash title="crontab"
0 3 * * * cd /www/dk_project/edgeweir && ./deploy.sh backup
```

| Item | Requirement |
| --- | --- |
| Storage | Copy to another host or object storage, apart from the master key |
| Check | `pg_restore --list` on every backup |
| Drill | Restore into an isolated environment regularly, as in [restore drills](#restore-drills) |

## 2. Restore

Verify in an isolated environment first. Requirements for the restore environment:

| Item | Requirement |
| --- | --- |
| Master key | `EDGEWEIR_MASTER_KEY` at backup time. If the key was [rotated](maintenance.en.md#master-key-rotation) after the backup, use the new key and set the old one as `EDGEWEIR_MASTER_KEY_PREVIOUS`. With a wrong key the console refuses to start: `EDGEWEIR_MASTER_KEY does not match this database` |
| `BETTER_AUTH_SECRET` | The original value if it was set; derived from the master key otherwise |
| Node channel URL | The original `EDGEWEIR_NODE_API_URL` and `EDGEWEIR_NODE_API_HOSTNAMES`: enrolled nodes check the certificate against the names at enrollment. A URL saved in **System settings** is in the database and comes back with it |
| Console version | Same as or newer than the backup: migrations only go forward; see [downgrade](downgrade.en.md) |
| Background jobs | Only one restore environment at a time may run background jobs against real DNS providers and alert channels; drills use `ROLE=app` or local mock services |

### deploy.sh

In the deployment directory of a `deploy.sh` deployment:

```bash
./deploy.sh restore backups/20261001-080000
```

Backs up the current database, stops the console, drops and recreates the database, imports `edgeweir.dump` from the backup, then starts and waits for the health check. `.env` is unchanged and must hold the master key from the table above. Prerequisites and failure behavior: [deploy.sh reference](deploy-script.en.md#restore).

### Docker Compose

On a new host or in a new Compose project:

1. Place `compose.yml`, the original `.env`, and `edgeweir.dump`.
2. Start an empty database:

   ```bash
   docker compose up -d --wait postgres
   ```

3. Import:

   ```bash
   docker compose exec -T postgres pg_restore -U edgeweir -d edgeweir --exit-on-error < edgeweir.dump
   ```

4. Start the console:

   ```bash
   docker compose up -d
   ```

5. Verify: `curl -s http://127.0.0.1:3000/healthz` returns `"status":"ok"`.

To replace the database of an existing deployment, stop `console`, recreate the database with `dropdb --force` and `createdb`, then import; steps in [downgrade from a backup](downgrade.en.md#docker-compose).

### External PostgreSQL

1. Restore into a new database:

   ```bash
   createdb edgeweir_restored
   pg_restore --exit-on-error --dbname=edgeweir_restored edgeweir.dump
   ```

2. Point the console's `DATABASE_URL` at `edgeweir_restored`, configure it as in the table above, and start it.
3. Verify: `curl -s http://127.0.0.1:3000/healthz` returns `"status":"ok"`.

## 3. Resynchronize nodes

1. With the CA restored from the database, enrolled nodes reconnect over mTLS. Wait until every node reports a heartbeat after the restore; heartbeats from before it do not count.
2. Publish a configuration once (any site or cluster change).

Revision number rules:

| Rule | Description |
| --- | --- |
| New number | max(latest revision in the database, highest applied revision verified by receipts from this cluster's nodes) + 1 |
| Unchanged content | A higher number is still created when nodes are ahead; nodes do not stay on their last good configuration |
| Receipts | Bound to node, cluster, revision, and content hash, authenticated with the master key; unverified numbers are ignored |
| Example | Revision 112 at backup → nodes applied 113 → first publish after the restore is 114 |

Upgrade old nodes and let them sync a configuration before the backup; node state backups keep `config/receipts.json`.

## 4. Restore acceptance

| Check | Pass condition |
| --- | --- |
| Console | `/healthz` returns `"status":"ok"`; no `"level":"error"` lines in the log |
| Sign-in | The original account signs in with its password and two-factor authentication |
| Encrypted data | No `cannot re-seal` or `cannot upgrade a legacy envelope` in the log; certificate states on the **Certificates** page match the backup |
| Nodes | "Online" under **Clusters & nodes** |
| Configuration | Nodes are "In sync": applied revision equals the latest revision, same content hash |
| Data plane | Node data planes are healthy; HTTP and HTTPS requests through the nodes succeed |

After acceptance keep the old database and handle it per the backup retention policy.

## ClickHouse

Volume backup for Docker Compose (`COMPOSE_PROFILES=analytics`):

```bash
docker compose stop clickhouse
docker run --rm -v edgeweir_clickhouse-data:/data:ro -v "$PWD":/backup alpine \
  tar czf /backup/clickhouse-data.tar.gz -C /data .
docker compose start clickhouse
```

The volume is named `<Compose project name>_clickhouse-data`; the project name in `compose.yml` is `edgeweir`.

| Rule | Description |
| --- | --- |
| Restore point | ClickHouse and PostgreSQL come from the same restore point, or writing starts in a new ClickHouse database (`EDGEWEIR_CLICKHOUSE_DATABASE`) |
| Batch sequence | Restoring older PostgreSQL cursors while keeping newer ClickHouse tables can collide with existing batch sequence numbers |
| Across stores | Not restored automatically; a successful PostgreSQL restore does not mean ClickHouse is restored |
| Without a backup | Access logs are deleted after their [retention](../guide/access-logs.en.md#retention) anyway; old logs can be dropped and writing started in a new database |

## Restore drills

Manual drill on a host isolated from production:

1. Restore the latest backup as in [Docker Compose](#docker-compose) with the production master key in `.env`, and set `ROLE=app` (`services.console.environment.ROLE` in `compose.override.yml`): no worker runs, so nothing is sent to real DNS providers or alert channels.
2. Keep production nodes away from the drill: do not change DNS, do not open the node channel port.
3. Check the console, sign-in, and encrypted data as in [restore acceptance](#4-restore-acceptance).
4. Record the restore time and the backup's point in time, then remove the drill: `docker compose down -v`.

Automated drill script:

```bash
node scripts/e2e-restore.mjs
```

| Item | Description |
| --- | --- |
| Scope | Only the test database of `compose.e2e.yml`. `pnpm e2e` includes this drill; running it alone needs a running e2e environment and `.e2e/m5-state.json` from the earlier steps |
| Steps | Runs a real `pg_dump`; a node applies a revision higher than the backup; creates a new database and runs `pg_restore`; switches the console's connection; after a new heartbeat, publishes the same content; confirms that the node accepts a higher revision. Then switches back to the original test database and resynchronizes, keeping the restored database for inspection |
| Result | `.e2e/restore-result.json` |
| Constraint | Never use the test data and credentials in a real deployment |
