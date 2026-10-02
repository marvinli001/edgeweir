# Backup and recovery

Back up and restore the database, master key, and node state, and accept the restore.

## What to back up

| Item | Location | Method | Constraint |
| --- | --- | --- | --- |
| PostgreSQL | Database `edgeweir` | `pg_dump --format=custom` | Use PostgreSQL tools of the server's major version. |
| `EDGEWEIR_MASTER_KEY` | `.env` | Offline copy, stored apart from database backups | Without it, the CA key, certificate keys, S3 origin keys, and DNS and notification credentials in the database cannot be decrypted. |
| `BETTER_AUTH_SECRET` | `.env` (when set) | Stored with the master key | When unset, the session secret is derived from the master key. |
| Deployment configuration | `.env`, `compose.yml` | File copies | — |
| ClickHouse | Volume `clickhouse-data` (when enabled) | Separate backup | Same restore point as PostgreSQL; see [ClickHouse](#clickhouse). |
| Node state | `/var/lib/edgeweir-node` on each node | Local backup on the node | Holds the node private key and `config/receipts.json`; the private key is never uploaded to the console. |
| Node cache | `/var/cache/edgeweir-node` on each node | Not backed up | Rebuilt on demand. |

> [!WARNING]
> Backups contain account data and logs; restrict read access. Supply database credentials through a restricted `.pgpass` or environment variables, never on a command line or in Git.

## 1. Create a backup

Bundled Docker Compose database:

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
```

Expected: greater than 0.

With `deploy.sh`, `./deploy.sh backup` (also run before `update`) writes an `edgeweir.dump` of the same format together with `.env` (without the master key and `BETTER_AUTH_SECRET`) and the Compose file, keeping the newest 5; see [deploy.sh reference](deploy-script.en.md#backups). Keep the master key offline separately.

## 2. Restore

Verify in an isolated environment first. The restore environment requires:

| Item | Requirement |
| --- | --- |
| Master key | The original `EDGEWEIR_MASTER_KEY`. |
| `BETTER_AUTH_SECRET` | The original value when it was set; otherwise derived from the master key. |
| Node channel address | The original `EDGEWEIR_NODE_API_URL` and `EDGEWEIR_NODE_API_HOSTNAMES`: enrolled nodes verify the certificate against the names used at enrollment. |
| Console version | The backup's version or newer: migrations only move forward. |
| Background jobs | Only one restore environment at a time may run background jobs against real DNS providers and notification channels; drills use local simulators. |

### deploy.sh

In the deployment directory of a `deploy.sh` deployment:

```bash
./deploy.sh restore backups/20261001-080000
```

The command backs up the current database, stops the console, drops and recreates the database, imports the backup's `edgeweir.dump`, then starts and waits for the health checks. `.env` is left alone and must hold the master key from the table above. Preconditions and failure behavior: [deploy.sh reference](deploy-script.en.md#restore).

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

### External PostgreSQL

1. Restore into a new database:

   ```bash
   createdb edgeweir_restored
   pg_restore --exit-on-error --dbname=edgeweir_restored edgeweir.dump
   ```

2. Point the console's `DATABASE_URL` at `edgeweir_restored`, configure it as in the table above, and start it.
3. Verify: `curl -s http://127.0.0.1:3000/healthz` returns `"status":"ok"`.

## 3. Resynchronize nodes

1. With the CA restored from the database, enrolled nodes reconnect over mTLS. Wait until every node reports a new heartbeat after the restore; heartbeats from before the restore do not count.
2. Publish a configuration (any site or cluster configuration change).

Revision numbering:

| Rule | Description |
| --- | --- |
| Next revision | max(latest revision in the database, highest applied revision verified by receipt among the cluster's nodes) + 1. |
| Unchanged content | When a node is ahead, a higher revision is still created; nodes do not stay on the last-known-good configuration. |
| Receipts | Bind node, cluster, revision, and content hash, and are authenticated with the original master key; unverified revision numbers are ignored. |
| Example | Revision 112 at backup → node applied 113 → first publish after restore is 114. |

Upgrade older nodes and let them complete one configuration sync before the backup; keep `config/receipts.json` in the node state backup.

## 4. Restore acceptance

| Check | Passes when |
| --- | --- |
| Console | `/healthz` returns `"status":"ok"`. |
| Nodes | "Online" in **Clusters & nodes**. |
| Configuration | Nodes are "In sync": the applied revision equals the latest revision and the content hashes match. |
| Data plane | The node data plane is healthy; HTTP and HTTPS requests through the nodes succeed. |

After acceptance, keep the old database and handle it under the backup retention policy.

## ClickHouse

- Restore ClickHouse from the same point as PostgreSQL, or start writing to a new ClickHouse database (`EDGEWEIR_CLICKHOUSE_DATABASE`).
- Restoring older PostgreSQL cursors while reusing newer ClickHouse tables can collide with existing batch sequence numbers.
- Cross-store restore is not automatic; a successful PostgreSQL restore does not restore ClickHouse.

## Drill

```bash
node scripts/e2e-restore.mjs
```

| Item | Description |
| --- | --- |
| Scope | Only the test database of `compose.e2e.yml`. `pnpm e2e` includes this drill; a standalone run needs a running e2e environment and the `.e2e/m5-state.json` written by earlier steps. |
| Steps | Runs a real `pg_dump`; lets a node apply a revision above the backup; creates a new database and runs `pg_restore`; switches the console connection; after a new heartbeat, publishes the same content; confirms the node accepts a higher revision. Then switches back to the original test database, resynchronizes, and keeps the restored database for inspection. |
| Result | `.e2e/restore-result.json`. |
| Constraint | Test data and credentials must not be used in production. |
