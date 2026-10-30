# Downgrade

Conditions, steps, and risks of returning the console and nodes to an earlier version; crossing a migration needs the pre-upgrade backup.

## When a downgrade is possible

| Between the two versions | Method | Data |
| --- | --- | --- |
| No new migrations | Set the image tag back to the old version and recreate the container; see [direct downgrade](#direct-downgrade) | Kept |
| New migrations | Restore the pre-upgrade backup, then start the old version; see [downgrade from a backup](#downgrade-from-a-backup) | Every change after the backup is lost |

> [!WARNING]
> The console does not check whether the database schema is newer than the image: an old image on a migrated database finds no pending migration, starts normally, and fails when it reads or writes new or changed tables. Do not only switch back to the old tag when there are new migrations.

## Migration rules

| Item | Rule |
| --- | --- |
| Location | `packages/db/migrations/<number>_<name>.sql`, ordered in `packages/db/migrations/meta/_journal.json` |
| Record | Table `drizzle.__drizzle_migrations`: one row per applied migration (`hash`, `created_at`) |
| At startup | Applies the migrations whose `created_at` is later than the last record, all in one transaction that rolls back on failure |
| Direction | Forward only; no down scripts |
| Release notes | The "Compatibility" section of a `stable` GitHub Release lists the migrations it adds |

## Checking for new migrations

Method 1, compare the two commits in a repository checkout (the commit ID is the part of the tag after `-`):

```bash
git diff --name-only <old commit> <new commit> -- packages/db/migrations/
```

No output means no new migrations.

Method 2, compare the migrations applied to the database with the old version's count:

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir -Atc \
  'select count(*) from drizzle.__drizzle_migrations'
git show <old commit>:packages/db/migrations/meta/_journal.json | jq '.entries | length'
```

Equal numbers mean no new migrations; a larger database count means new migrations.

## Direct downgrade

For two versions without new migrations between them.

| Deployment | Action |
| --- | --- |
| Docker Compose | Set `EDGEWEIR_VERSION` in `.env` back to the old tag and run `docker compose up -d` |
| `deploy.sh` | `./deploy.sh update <old tag>`; when the target is older than the current version the script warns and asks whether to continue (default no); see the [deploy.sh reference](deploy-script.en.md#update) |
| `docker run` | Recreate `edgeweir-console` with the same options and the old tag |
| Railway, Fly.io, bunny.net, Render, Zeabur | Set the image tag to the old dated tag and redeploy; see the "Upgrade" section of each platform page |

Verify: `version` in `curl -s http://127.0.0.1:3000/healthz` is the old tag.

## Downgrade from a backup

For two versions with new migrations between them. Needs the pre-upgrade database backup (`deploy.sh update` writes it to `backups/<time>-before-<new tag>/`) and the master key at backup time.

### deploy.sh

1. Set `EDGEWEIR_VERSION` in `.env` back to the old tag.
2. Restore the pre-upgrade backup:

   ```bash
   ./deploy.sh restore backups/<time>-before-<new tag>
   ```

   The script backs up the current database, stops the console, drops and recreates the database, imports the backup, and starts the version in `.env`; see the [deploy.sh reference](deploy-script.en.md#restore).

### Docker Compose

1. Stop the console:

   ```bash
   docker compose stop console
   ```

2. Back up the current database (to return to the new version if the downgrade fails):

   ```bash
   umask 077
   docker compose exec -T postgres pg_dump -U edgeweir -d edgeweir --format=custom > edgeweir-after-upgrade.dump
   ```

3. Drop and recreate the database:

   ```bash
   docker compose exec -T postgres dropdb -U edgeweir --force edgeweir
   docker compose exec -T postgres createdb -U edgeweir edgeweir
   ```

4. Import the pre-upgrade backup:

   ```bash
   docker compose exec -T postgres pg_restore -U edgeweir -d edgeweir --exit-on-error < edgeweir.dump
   ```

5. Set `EDGEWEIR_VERSION` in `.env` back to the old tag and start:

   ```bash
   docker compose up -d
   ```

6. Check as in [verification after a downgrade](#verification-after-a-downgrade).

For external PostgreSQL and platform databases, restore into a new database as in [backup and recovery](backup.en.md#2-restore), point `DATABASE_URL` at it, and deploy the old tag.

### Lost data

These changes made after the backup are not in the restored database:

| Data | After the restore | Action |
| --- | --- | --- |
| Changes to sites, rules, certificates, DNS, and other configuration | Back to their state at backup time | Repeat them |
| Nodes enrolled after the backup | The database does not know them; they cannot connect | Enroll again on the node with a new install command plus `--force` |
| Certificates issued or renewed after the backup | The database holds the certificate at backup time; nodes switch to it with the next published configuration | Request certificates added after the backup again; click "Renew now" for certificates close to expiry |
| Audit logs, access logs, statistics, alert records | Missing after the backup | — |
| Configuration revision numbers | Nodes may have applied a revision higher than the latest in the database | Publish a configuration once; see [resynchronize nodes](backup.en.md#3-resynchronize-nodes) |

## Verification after a downgrade

| Check | Pass condition |
| --- | --- |
| Version | `/healthz` returns `"status":"ok"` and the old tag as `version` |
| Migrations | Rows in `drizzle.__drizzle_migrations` equal the entries of the old version's `_journal.json` |
| Log | `docker compose logs console` has no `"level":"error"` lines |
| Nodes | Nodes under **Clusters & nodes** are "Online"; "In sync" after one published configuration |

## Node downgrade

Node versions are independent of the console; a console downgrade does not require a node downgrade.

| Method | Conditions and steps |
| --- | --- |
| Automatic rollback | When a signed upgrade's candidate does not pass its health check within 90 seconds, the supervisor restores the previous program, Lua, and configuration snapshot; no action needed; see [supervisor and rollback](../guide/node-upgrades.en.md#supervisor-and-rollback) |
| Upgrade task to an older version | Nodes refuse versions older than the running one ("Version … was rejected; the previous version is kept"). Set `EDGEWEIR_UPGRADE_ALLOW_DOWNGRADE=true` in the node's `/etc/default/edgeweir-node` and run `systemctl restart edgeweir-node`; when no node is below the target version, the console's "New upgrade" dialog cannot be submitted, so start it through the API `POST /api/v1/node-upgrades` (`version`, `nodeGroupId`). Remove the setting afterwards |
| Reinstalling an older package or image | The supervisor sees that the base installation changed and uses the newly installed program and Lua; an unconfirmed upgrade task is recorded as "The task for version … was superseded by a local package update" |

A node's identity key, certificate, credentials, and statistics cursors do not go back with the program. A node downgraded to a version without a capability the cluster's current configuration needs shows "Upgrade required" and serves its last good configuration.

## Risks

| Risk | Description |
| --- | --- |
| Only switching back the tag | With new migrations, old code runs on the new schema; requests and background jobs fail and data may be written inconsistently |
| Data loss | A downgrade from a backup loses every change after the backup; see [lost data](#lost-data) |
| Master key | A restore needs the master key at backup time; if the key was rotated after the backup, set the old key as `EDGEWEIR_MASTER_KEY_PREVIOUS`; see [master key rotation](maintenance.en.md#master-key-rotation) |
| Session secret | `BETTER_AUTH_SECRET` must match the backup; otherwise every session ends and two-factor codes cannot be verified |
| Several instances | Downgrade all console instances together; instances of different versions cannot share a database |
| Security fixes | The old version lacks security fixes released since |
| Node capabilities | The old console does not know capabilities newer nodes report; connections are not affected |
