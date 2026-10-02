# deploy.sh reference

Reference for the repository-root `deploy.sh`: commands, unattended variables, generated files, backup layout, restore, and exit behavior.

## Requirements

| Item | Requirement |
| --- | --- |
| Host | BaoTa Panel / aaPanel, or any Linux host with Docker |
| Shell | bash |
| Docker | Docker Engine and Compose v2 (`docker compose`); `docker info` must succeed (root or `sudo`) |
| Images | Pull access to `ghcr.io/marvinli001/edgeweir` and `postgres:18.6-alpine`; otherwise `docker load` beforehand and set `EDGEWEIR_NO_PULL=1` |
| Optional tools | `ss` or `netstat`: port-in-use checks, skipped when missing; `openssl`: `/dev/urandom` is used when missing; `curl`: script download and the `self-update` fallback source |

```bash
curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
sudo bash deploy.sh install
```

Save the script to a file before running it: through a pipe (`curl … | bash`) or process substitution (`bash <(curl …)`) it exits with 1. After install, a copy lives at `<install directory>/deploy.sh`; run the other commands there as `./deploy.sh <command>`. Full flow on BaoTa / aaPanel: [baota.en.md](baota.en.md).

## Commands

| Command | Arguments | Effect |
| --- | --- | --- |
| `install` | — | Interactive install: choose the database mode, check the database, write `.env`, `compose.yml`, and the script copy, start and wait for health checks, print the setup token |
| `update` (alias `upgrade`) | `[tag]` `[--no-backup]` | Back up, then upgrade to the given tag; without a tag, the dated tag behind `latest`. See [update](#update) |
| `backup` | — | Back up the database, `.env` (without the master key), and compose file to `backups/<time>/`, keeping the newest 5. See [Backups](#backups) |
| `restore` | `<backup>` `[--no-backup]` | Back up the current database, then replace it with the backup's `edgeweir.dump`; `.env` is left alone. See [restore](#restore) |
| `config` | — | Change the console URL and node channel URL, then recreate the containers; interactive only |
| `start` | — | Start the project and wait for health checks |
| `stop` | — | `docker compose stop`; containers are kept |
| `restart` | — | Start as `start` does, recreating the `console` container in any case: `.env` changes take effect |
| `status` | — | `docker compose ps`, plus the deployment directory, mode, and running version |
| `logs` | `[service…]` | Follow logs, starting with the last 200 lines; services are `console` and `postgres` (bundled), all when omitted |
| `setup-token` | — | Read the most recent setup token from the console logs |
| `template` | `host` \| `bundled` | Print a compose template; no Docker needed |
| `self-update` | — | Replace this script; sources in [self-update](#self-update) |
| `help` (`-h`, `--help`) | — | Print usage; same without a command |

## Deployment directory

Commands other than `install`, `template`, and `help` look for the deployment directory in this order and use the first match:

1. `EDGEWEIR_DIR`
2. The script's directory
3. The working directory
4. `/www/dk_project/edgeweir`
5. `/opt/edgeweir`

| Item | Rule |
| --- | --- |
| Deployment directory | Contains `.env` and a compose file containing `container_name: edgeweir-console`: `compose.yml`, `compose.yaml`, `docker-compose.yml`, or `docker-compose.yaml` |
| Mode | host when the compose file contains `network_mode: host`, otherwise bundled |
| Override file | `compose.override.yml` next to the compose file (`docker-compose.override.yml` for `docker-compose.yml`, and so on) is passed to Compose as well when it exists; local changes go there and survive template replacements by `update` |
| Compose project name | Taken from the `com.docker.compose.project` label of the `edgeweir-console` container, so projects a panel created under another name work too |
| Environment | Shell variables named in `.env` or the compose file are removed before Compose runs; `.env` decides |

## install

### Prompts

| Order | Prompt | Default | Variable |
| --- | --- | --- | --- |
| 1 | Install directory | `/www/dk_project/edgeweir` when `/www/server/panel` exists, otherwise `/opt/edgeweir` | `EDGEWEIR_DIR` |
| 2 | Database: `1` local or cloud PostgreSQL (host), `2` bundled PostgreSQL (bundled) | `1` | `EDGEWEIR_DB` |
| 3 | host: `1` enter fields, `2` paste a connection string | `1` | `DATABASE_URL` |
| 3a | Fields: address, port, database name, user name, password | `127.0.0.1`, `5432`, `edgeweir`, the database name, none (required, not echoed) | — |
| 3b | Fields with a non-loopback address: use TLS and verify the certificate | Yes: appends `?sslmode=verify-full` | — |
| 4 | Console URL | — | `EDGEWEIR_PUBLIC_URL` |
| 5 | Node channel URL | `https://<console host name>:<EDGEWEIR_NODE_API_PORT or 8443>` | `EDGEWEIR_NODE_API_URL` |
| 6 | Web console port; only when the port is in use | The busy port plus 1 | `EDGEWEIR_HTTP_PORT` |
| 7 | Start the install (after a summary of directory, database, URLs, and version) | Yes | — |

Variables supply the defaults; in unattended mode they are the answers. A set `EDGEWEIR_DB` or `DATABASE_URL` skips the matching prompt. Loopback means `127.*`, `localhost`, or `::1`. The prompts are in Chinese.

### Validation

| Input | Rule |
| --- | --- |
| Install directory | Absolute path; missing, empty, or holding only `deploy.sh`; no container named `edgeweir-console` on the host |
| Existing data | bundled: aborts when the Docker volume `edgeweir_postgres-data` (the database of an earlier install) exists; host: see [Database check](#database-check) |
| Console URL | `http(s)://host[:port]` with a port of 1–65535, without a path; a trailing `/` is removed; a warning when it is not `https://` |
| Node channel URL | `https://host[:port]` without a path; its port is the public node channel port, 443 when omitted |
| Connection string | `postgres://` or `postgresql://`; with user name and database name; a single host; no whitespace, quotes, backticks, `\`, `$`, or `#` (URL-encode special characters in the password, e.g. `$` as `%24`) |
| Ports | The web and node channel ports are numbers and differ; the install aborts when the node channel port is in use |

### Result

1. Resolve and pull the image version, see [Version resolution](#version-resolution).
2. Create the install directory (700), write `.env` (600), `compose.yml` (600), `.compose.cksum`, and `deploy.sh` (700).
3. Pull the compose images, start, and wait for health checks.
4. Print the running version, next steps, and the setup token.

## Unattended install

When `EDGEWEIR_YES` is non-empty, or `/dev/tty` cannot be opened, the script reads no input: each prompt takes its default or the variable below.

| Variable | Values | Default | Effect |
| --- | --- | --- | --- |
| `EDGEWEIR_YES` | Any non-empty value | Empty | Enables unattended mode; an unattended `restore` requires it |
| `EDGEWEIR_DB` | `host` \| `bundled` | `bundled` | Database mode; any other value aborts |
| `DATABASE_URL` | `postgres://user:password@host:port/dbname[?sslmode=verify-full]` | — | Required in host mode |
| `EDGEWEIR_PUBLIC_URL` | `https://host[:port]` | — | Required |
| `EDGEWEIR_NODE_API_URL` | `https://host[:port]` | `https://<console host name>:<EDGEWEIR_NODE_API_PORT>` | Node channel URL |
| `EDGEWEIR_NODE_API_PORT` | Port | `8443` | Only for the node channel URL default; the port written to `.env` comes from the node channel URL |
| `EDGEWEIR_HTTP_PORT` | Port | `3000` | Web console port; the part after the last `:` is used; aborts when in use |
| `EDGEWEIR_VERSION` | Tag | `latest` | Image version to pin |
| `EDGEWEIR_DIR` | Absolute path | See [Prompts](#prompts) | Install directory; other commands look here first |
| `EDGEWEIR_NO_PULL` | Any non-empty value | Empty | `install` and `update` pull no images and use local ones only |
| `EDGEWEIR_BACKUP_KEEP` | Non-negative integer | `5` | Backups `backup` and `update` keep; `0` keeps all |
| `EDGEWEIR_SCRIPT_URL` | URL | `https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh` | Fallback source of `self-update` |

| Confirmation | Unattended answer |
| --- | --- |
| PostgreSQL major version below 18, continue | No: abort |
| Database check failed or the database is not empty, enter again | Not asked: abort |
| Start the install | Yes |
| `update` rollback confirmation | No: abort |
| `update` replaces an edited compose file | No: the existing file is kept (an unedited one is replaced without asking) |
| `update` replaces this script with the image's copy | Yes |
| `restore` confirmation | Yes when `EDGEWEIR_YES` is set; without a terminal and without it: abort |
| `config` | Not supported: abort |

```bash
EDGEWEIR_YES=1 EDGEWEIR_DB=bundled \
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com \
bash deploy.sh install
```

`EDGEWEIR_NO_PULL=1` needs the target tag (or `latest`) of the console image and `postgres:18.6-alpine` (host mode checks and backups, the bundled database) on the host.

## Database check

In host mode the database is checked before any file is written. The check runs `psql` from `postgres:18.6-alpine` (pinned by digest, as in `compose.baota.yml`) on the host network; the password travels in the environment; the connect timeout is 8 seconds.

| Check | On failure |
| --- | --- |
| Connection | Prints the error and the hint below; interactive mode offers to enter the details again |
| The user has `CREATE` on the database and on schema `public` (migrations and the job queue) | Suggests `ALTER DATABASE <db> OWNER TO <user>;` and `ALTER SCHEMA public OWNER TO <user>;` |
| Server major version 18 or later | Warns and asks whether to continue, default no |
| No `drizzle.__drizzle_migrations` in the database (no console has run on it) | Note: the encrypted data in it opens only with the original master key; to keep using it, put the original `.env` back into the deployment directory and run `./deploy.sh start`, otherwise use an empty database. Interactively asks whether to enter the database again |

| Error contains | Hint |
| --- | --- |
| `refused` | No PostgreSQL listens on that address and port |
| `password` | Wrong user name or password |
| `pg_hba` | `pg_hba.conf` does not admit this host |
| `does not exist` | The database or user does not exist |
| `timeout`, `timed out` | Firewall, security group, or cloud database allow list |
| `certificate`, `SSL` | The certificate is not from a public CA or does not match the host name |

The check and backups connect according to `sslmode` in `DATABASE_URL`:

| `sslmode` | Connection |
| --- | --- |
| None, `disable`, `allow` | Unencrypted |
| `no-verify` | Encrypted, certificate not verified |
| Any other value | Certificate and host name verified; CA from the host's `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, or `/etc/ssl/cert.pem`, the system default when none exists |

## update

`./deploy.sh update [tag] [--no-backup]` runs these steps:

1. Resolve the target version, see [Version resolution](#version-resolution). When the target equals `EDGEWEIR_VERSION` in `.env` and the container already runs it, print `已经是 <version>。` (already at) and exit 0.
2. A target other than `latest` that is older than the current version is a rollback: warn and ask whether to continue, default no. The dates in the tags are compared first; two tags of the same day compare the commit times of the two images (label `org.opencontainers.image.created`). When the order cannot be told (a tag is not `<YYYYMMDD>-<commit>`, or one image of the same day is not local), only a note is printed.
3. Back up to `backups/<time>-before-<target version>/`; `--no-backup` skips this. A failed backup aborts with the deployment unchanged.
4. When the compose file differs from the built-in template:
   - Same as the script last wrote it (per `.compose.cksum`): replaced with the new template.
   - Edited since: the difference is shown and the script asks whether to replace it, default no.
   - No `.compose.cksum` (older installs): the difference is shown and the script asks, default yes interactively, kept in unattended mode.

   The old file is in the step 3 backup; local changes belong in the [override file](#deployment-directory); `./deploy.sh template <mode>` prints the template.
5. Write `EDGEWEIR_VERSION` and recreate the containers with the `start` flow. Database migrations run when the console starts.
6. Print the rollback command `./deploy.sh update <previous version>` (valid only when no migration was added between the two versions).
7. When `/app/deploy.sh` in the new image differs from this script, ask whether to replace this script, default yes.

Version policy and rollback constraints: [upgrade.en.md](upgrade.en.md).

### Version resolution

| Target | Behavior |
| --- | --- |
| `latest` | Pull `ghcr.io/marvinli001/edgeweir:latest`, read the image label `org.opencontainers.image.version`, pull that dated tag, and pin it; when the label is empty or `dev`, warn and pin `latest` |
| `<tag>` | Pull that tag and pin it as given |
| `EDGEWEIR_NO_PULL` set | No pull; the image must be local. When the dated tag behind `latest` is missing locally, it is tagged from the local `latest` |

`install` resolves `EDGEWEIR_VERSION` (default `latest`) with the same rules.

## config

Interactive only; in unattended mode or without a terminal it aborts; edit `.env` directly and run `./deploy.sh start` instead.

1. Ask for the console URL and node channel URL; Enter keeps the current value. Validation as in [install](#validation).
2. When the port in the node channel URL changes: an `EDGEWEIR_NODE_API_PORT` that is unset or equal to the old URL's port follows it, with a warning to open the new port and re-enroll nodes with the new URL; a value set apart (e.g. `127.0.0.1:18443` behind an nginx stream) is kept, with a note to adjust it yourself.
3. When the node channel host name changes, warn: enrolled nodes re-enroll, or add the old host name to `EDGEWEIR_NODE_API_HOSTNAMES`.
4. After confirmation, write `EDGEWEIR_PUBLIC_URL`, `EDGEWEIR_NODE_API_URL`, and `EDGEWEIR_NODE_API_PORT` when step 2 changes it, then recreate the containers with the `start` flow.

`config` does not change `EDGEWEIR_HTTP_PORT` and does not check whether the new port is in use.

## Start, stop, and trusted proxy sync

| Command | Behavior |
| --- | --- |
| `start` | bundled: start `postgres` first and sync `EDGEWEIR_TRUSTED_PROXIES`. Then `docker compose up -d --wait --remove-orphans`; when the services do not become healthy, print the last 40 console log lines and abort |
| `restart` | As `start`, with `docker compose up -d --wait --remove-orphans --force-recreate console` as the last step: the console container is always recreated (`docker compose restart` would not apply `.env` changes), and `postgres`, which it depends on, is recreated when its configuration changed |
| `stop` | `docker compose stop` |

`install`, `update`, and `config` use the `start` flow.

| Item | Rule |
| --- | --- |
| Sync condition | bundled mode, the `postgres` container is running, and `EDGEWEIR_TRUSTED_PROXIES` is empty or a single IPv4 address other than the current gateway |
| Value written | The IPv4 gateway of the network the `postgres` container is on |
| Left unchanged | Lists or CIDR ranges; host mode (template default `127.0.0.1,::1`) |
| After a host mode start | Warns when the node channel port listens on loopback only: the image does not support `NODE_API_HOST` |

Meaning of trusted proxies: [networking.en.md](networking.en.md#trusted-proxies-and-client-ip).

## self-update

| Order | Source | Used when |
| --- | --- | --- |
| 1 | `/app/deploy.sh` in the image `ghcr.io/marvinli001/edgeweir:<EDGEWEIR_VERSION from .env>` | Readable, non-empty, passes `bash -n` |
| 2 | `EDGEWEIR_SCRIPT_URL` | Downloads and passes `bash -n`; otherwise aborts without replacing |

Identical content is left alone. A replacement is written to a new file (700) and renamed over this script; the running process keeps reading the old file.

## Generated files

| Path | Mode | Content | Written by |
| --- | --- | --- | --- |
| `<dir>/` | 700 | Deployment directory | `install` |
| `<dir>/.env` | 600 | See the next table | `install`; `update`, `config`, and the trusted proxy sync change keys in it |
| `<dir>/compose.yml` | 600 | Template of the chosen mode, byte for byte [`compose.baota-host.yml`](../../compose.baota-host.yml) or [`compose.baota.yml`](../../compose.baota.yml) | `install`; replaced by `update`, see [update](#update) |
| `<dir>/.compose.cksum` | Per umask | `cksum` of the compose file the script last wrote, to tell template updates from local changes | `install`, `update` |
| `<dir>/compose.override.yml` | — | Local changes; never written by the script | — |
| `<dir>/deploy.sh` | 700 | Copy of the script | `install`; replaced by `update` and `self-update` |
| `<dir>/backups/` | 700 | Backups | `backup`, `update` |

| `.env` key | Mode | Value |
| --- | --- | --- |
| `EDGEWEIR_MASTER_KEY` | All | `openssl rand -base64 32`; without `openssl`, the base64 of 32 random bytes |
| `DATABASE_URL` | host | The pasted connection string, or one built from the fields: each part URL-encoded, IPv6 addresses in brackets |
| `POSTGRES_PASSWORD` | bundled | `openssl rand -hex 24` |
| `EDGEWEIR_HTTP_PORT` | All | Web console port |
| `EDGEWEIR_NODE_API_PORT` | All | Port in the node channel URL |
| `EDGEWEIR_PUBLIC_URL` | All | Console URL |
| `EDGEWEIR_NODE_API_URL` | All | Node channel URL |
| `EDGEWEIR_VERSION` | All | Pinned image tag |
| `EDGEWEIR_TRUSTED_PROXIES` | bundled | Docker gateway address; written at the first start |

Values are unquoted. Changing a key keeps the other lines and mode 600. Other variables: [Environment variables](../reference/environment.en.md).

## Backups

```text
<dir>/backups/
└── 20260929-153000-before-20260930-b2c3d4e/
    ├── edgeweir.dump
    ├── env
    ├── compose.yml
    └── compose.override.yml   # when present
```

| File | Content |
| --- | --- |
| `edgeweir.dump` | `pg_dump --format=custom`. host: dumped per `DATABASE_URL` with `postgres:18.6-alpine` on the host network; without `DATABASE_URL` in `.env`, the file `DATABASE_URL_FILE` names (set and mounted in the override file) is read in a one-off console container; bundled: dumped inside the `postgres` container |
| `env` | Copy of `.env` with the `EDGEWEIR_MASTER_KEY`, `EDGEWEIR_MASTER_KEY_PREVIOUS`, and `BETTER_AUTH_SECRET` lines turned into comments, without their values |
| `compose.yml` | Copy of the compose file under its original name, and of the override file when present |

| Item | Rule |
| --- | --- |
| Directory name | `YYYYMMDD-HHMMSS`; backups made by `update` get the suffix `-before-<target version>` |
| Modes | Directory 700, files 600 |
| Precondition | In bundled mode the `postgres` container is running |
| Failure | Aborts when `pg_dump` fails |
| Retention | After a successful backup only the newest `EDGEWEIR_BACKUP_KEEP` are kept (default 5, `0` keeps all), older ones removed by directory name; other directories in `backups/` are left alone |
| Master key | Not in the backup: it is only in `.env` (or the file named by `EDGEWEIR_MASTER_KEY_FILE`); keep it offline separately, restoring the database needs it |
| Scope | No ClickHouse data |

Restore with [restore](#restore); manual restores and restore acceptance: [backup.en.md](backup.en.md).

## restore

`./deploy.sh restore <backup> [--no-backup]` replaces the deployment's database with a backup. `<backup>` is a backup directory (its `edgeweir.dump` is used) or a dump file, looked up as given, then relative to the deployment directory, then relative to `backups/`, e.g. `./deploy.sh restore 20261001-080000`.

1. Check the backup: bundled starts `postgres` first; `pg_restore --list` must read it, and it must hold table data and `drizzle.__drizzle_migrations` (a console database), or the command aborts.
2. host: the `DATABASE_URL` user must own the database (or be a superuser) and have `CREATEDB`, or the command aborts; [restore into a new database by hand](backup.en.md#external-postgresql) instead.
3. Confirm, default no; unattended: see [confirmations](#unattended-install).
4. Back up the current database to `backups/<time>-before-restore/` without removing older backups; `--no-backup` skips this. A failed backup aborts with the deployment unchanged.
5. Stop `console`.
6. Drop and recreate the database: `DROP DATABASE … WITH (FORCE)` and `CREATE DATABASE`. bundled runs them in the `postgres` container as `edgeweir`; host runs them with `postgres:18.6-alpine` against the `postgres` maintenance database, and the new database belongs to the `DATABASE_URL` user.
7. Import with `pg_restore --exit-on-error --single-transaction --no-owner --no-privileges`.
8. Start and wait for the health checks as `start` does.

| Item | Rule |
| --- | --- |
| `.env` | Not changed; the backup's `env` is not used. The master key must be the one in use when the backup was made, or the console refuses to start |
| Console version | Not older than at backup time: migrations only move forward |
| Failed import | The database is empty and the console stays stopped; the `restore` command for the pre-restore backup is printed |
| Nodes | Reconnect after the restore; publish one configuration change so they resync, see [Resynchronize nodes](backup.en.md#3-resynchronize-nodes) |

## Exit and abort behavior

| Case | Behavior |
| --- | --- |
| Success | Exit code 0 |
| Abort | Prints `✗ <reason>`, exit code 1 |
| Unknown command | Prints usage, exit code 1 |
| Failing underlying command | Exits at once (`set -Eeuo pipefail`) with that command's exit code |
| End of input (EOF) | Aborts: 「输入已结束，安装取消。」 or 「输入已结束，已取消。」 (input ended) |
| Declined confirmation | Aborts: 「已取消。」 (cancelled) |
| `install` before confirmation | Nothing is written to the install directory |
| `install` fails to start | Files are kept and 「启动失败。修正 .env 后运行 ./deploy.sh start 重试。」 (startup failed; fix .env and run start) is printed; the directory now counts as a deployment and a second `install` is refused |
| `update` fails to start | `.env` already points at the target version; recover with the printed rollback command or the backup |
| `restore` import fails | The database is empty and the console stays stopped; restore the pre-restore backup with the printed command |
| `setup-token` finds no token | Aborts: setup is complete, or the container has not started |

`template` and `setup-token` write their result to standard output; progress, prompts, and errors go to standard error, in color when standard error is a terminal.
