# BaoTa Panel and aaPanel

Deploy the console with Docker Compose on BaoTa Panel (宝塔) or aaPanel: compose modes, panel setup, and manual installs.

## Compose modes

`deploy.sh install` writes the compose file for the selected database mode.

| Item | host | bundled |
| --- | --- | --- |
| Database | Local PostgreSQL (BaoTa **数据库 → PgSQL**) or a cloud database | Bundled `postgres:18.6-alpine`, data in the Docker volume `edgeweir_postgres-data` |
| Compose file | [`compose.baota-host.yml`](../../compose.baota-host.yml) | [`compose.baota.yml`](../../compose.baota.yml) |
| Container network | `network_mode: host`; `127.0.0.1` in the container is the host, so a local PostgreSQL listening on loopback only needs no change to `listen_addresses` or `pg_hba.conf` | Docker bridge; the database is not exposed |
| Web console | Process listens on `127.0.0.1:3000` (`EDGEWEIR_HTTP_PORT`) | Port mapping `127.0.0.1:3000` (`EDGEWEIR_HTTP_PORT`) → `3000` |
| Node channel | Process listens on `0.0.0.0:8443` (`EDGEWEIR_NODE_API_PORT`) | Port mapping `8443` (`EDGEWEIR_NODE_API_PORT`) → `8443` |
| Port variable format | Numbers only | `EDGEWEIR_HTTP_PORT` numbers only; `EDGEWEIR_NODE_API_PORT` may include a bind address, e.g. `127.0.0.1:18443` |
| `EDGEWEIR_TRUSTED_PROXIES` | Default `127.0.0.1,::1` | Docker gateway address, written by `deploy.sh` and synced at startup |
| Port column in the panel's container list | Empty (host networking has no port mappings) | Shows the mappings |

The image `ghcr.io/marvinli001/edgeweir` is public; the panel needs no registry entry or login. Tag format and version pinning: [upgrade.en.md](upgrade.en.md).

## 1. Prepare

| Item | Requirement | BaoTa Panel | aaPanel |
| --- | --- | --- | --- |
| Docker | Docker Engine and Compose v2 (`docker compose`) | Install on the **Docker** page | Install on the **Docker** page |
| Firewall | Open the node channel port (default 8443/TCP); do not open web port 3000 | **安全 → 系统防火墙 → 添加端口规则**: protocol TCP, source all IPs, policy allow | **Security → Firewall → Add Port Rule**: Protocol TCP, Source IP All, Strategy Allow |
| Cloud security group | Open the same port | — | — |
| Domain | Console domain (e.g. `cdn-admin.example.com`) resolves to this host | — | — |
| Database (host) | PostgreSQL 18; an empty database and its owner user; a cloud database allow list that includes this host's IP | **数据库 → PgSQL → 添加数据库** | **Databases → PgSQL → Add DB** |
| Images | Access to `ghcr.io`; otherwise `docker load` beforehand, see `EDGEWEIR_NO_PULL` in [deploy-script.en.md](deploy-script.en.md#unattended-install) | — | — |
| Shell | root | **终端** or SSH | **Terminal** or SSH |

Other requirements: [Deployment overview](README.en.md#runtime-requirements).

## 2. Install with deploy.sh

1. Download the script:

   ```bash
   curl -fsSL -o deploy.sh https://raw.githubusercontent.com/marvinli001/edgeweir/master/deploy.sh
   ```

2. Run the installer and answer the prompts for install directory, database mode, database connection, console URL, and node channel URL. Prompts and defaults: [deploy-script.en.md](deploy-script.en.md#install).

   ```bash
   sudo bash deploy.sh install
   ```

   The default install directory is `/www/dk_project/edgeweir` when `/www/server/panel` exists, otherwise `/opt/edgeweir`. The console URL is the address browsers use, e.g. `https://cdn-admin.example.com`; the node channel URL defaults to `https://<console domain>:8443`.

3. Record the setup token printed at the end.

> [!IMPORTANT]
> `.env` in the install directory holds `EDGEWEIR_MASTER_KEY`. Back it up offline; losing it makes encrypted data unrecoverable. See [backup.en.md](backup.en.md).

Unattended install (run as root; variables: [deploy-script.en.md](deploy-script.en.md#unattended-install)):

```bash
EDGEWEIR_YES=1 EDGEWEIR_DB=host \
EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com \
DATABASE_URL='postgres://edgeweir:<URL-encoded password>@127.0.0.1:5432/edgeweir' \
bash deploy.sh install
```

With `EDGEWEIR_DB=bundled`, leave `DATABASE_URL` unset.

## 3. Reverse proxy and HTTPS

The panel's nginx terminates HTTPS and proxies to `http://127.0.0.1:3000` (replace the port if `EDGEWEIR_HTTP_PORT` was changed).

| Step | BaoTa Panel | aaPanel |
| --- | --- | --- |
| 1. Site | **网站 → PHP项目 → 添加站点**: domain = console domain, PHP version 「纯静态」 (static) | **Website → Proxy Project**, add a site: domain = console domain, proxy target `http://127.0.0.1:3000` |
| 2. Certificate | Site settings **SSL → Let's Encrypt → 申请证书**, enable forced HTTPS | Site settings **SSL → Let's Encrypt** |
| 3. Reverse proxy | Site settings **反向代理 → 添加反向代理**: target URL `http://127.0.0.1:3000` | Set in step 1 |

- If file validation of the certificate fails, use DNS validation.
- Keep the default sent domain (`Host`): the console checks request origins against `EDGEWEIR_PUBLIC_URL` only.
- If the console URL given at install time is not `https://`, run `./deploy.sh config` after the certificate is active and change it to `https://`.

Generic nginx configuration and headers: [networking.en.md](networking.en.md#reverse-proxy-for-the-web-console).

## 4. Set up and verify

1. Read the setup token (also printed by the installer):

   ```bash
   cd /www/dk_project/edgeweir   # install directory
   ./deploy.sh setup-token
   ```

2. Open `https://cdn-admin.example.com/setup`, enter the setup token, and create the platform administrator. Setup wizard: [Quick start](../guide/first-site.en.md).

3. Verify the web console:

   ```bash
   curl -s http://127.0.0.1:3000/healthz
   ```

   Expected: `{"status":"ok","version":"<EDGEWEIR_VERSION from .env>"}`.

4. Verify the node channel (from another host):

   ```bash
   openssl s_client -connect cdn-admin.example.com:8443 -servername cdn-admin.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -issuer
   ```

   Expected: the issuer contains `Edgeweir Node Channel CA`.

SMTP, node release source, ownership check DNS, origin allow list, and GeoIP databases are configured in **Admin → System**, see [Platform administration](../guide/admin.en.md#system-settings). Adding nodes: [Adding nodes](nodes.en.md); `--server` in the install command is `EDGEWEIR_NODE_API_URL`.

## Node channel port

| Method | Configuration | Constraint |
| --- | --- | --- |
| Direct exposure (default) | Open `EDGEWEIR_NODE_API_PORT` in the firewall and security group | — |
| nginx `stream` passthrough | The console listens on local `18443`; the panel's nginx passes TCP through on `8443` | The panel's nginx must include the stream module |
| Panel HTTP reverse proxy, CDN | Not supported | Terminating TLS makes node enrollment fail with `CA pin mismatch`; mTLS cannot be established |

`stream` block, mechanism, and verification: [networking.en.md](networking.en.md#node-channel-passthrough). Steps on BaoTa / aaPanel:

1. Check that the panel's nginx includes the stream module:

   ```bash
   /www/server/nginx/sbin/nginx -V 2>&1 | grep -o -- '--with-stream[^ ]*'
   ```

   Expected: one line is exactly `--with-stream`. Without that line, use direct exposure.

2. Move the node channel to local `18443`; keep `EDGEWEIR_NODE_API_URL` at `:8443`:

   | Mode | Change |
   | --- | --- |
   | bundled | `.env`: `EDGEWEIR_NODE_API_PORT=127.0.0.1:18443` |
   | host | `.env`: `EDGEWEIR_NODE_API_PORT=18443`; `compose.yml`: `NODE_API_HOST: 127.0.0.1` |

   ```bash
   ./deploy.sh start
   ```

3. Add the `stream` block (`listen 8443;`, `proxy_pass 127.0.0.1:18443;`) to `/www/server/nginx/conf/nginx.conf` outside the `http { }` block, then test and reload:

   ```bash
   /www/server/nginx/sbin/nginx -t && /www/server/nginx/sbin/nginx -s reload
   ```

4. Verify as in section 4, step 4.

| Case | Constraint |
| --- | --- |
| `./deploy.sh config` | Resets `EDGEWEIR_NODE_API_PORT` to the port in the node channel URL (8443), which conflicts with nginx. Restore the step 2 value afterwards, then run `./deploy.sh start`. |
| host mode `./deploy.sh update` | Answer `n` when asked to replace `compose.yml` with the built-in template; replacing restores `NODE_API_HOST: 0.0.0.0`. |
| host mode startup | The script warns that the node channel listens on loopback only; the warning does not apply to this setup. |

## Install without the script

### Compose project in the panel

1. Get a template: the output of `bash deploy.sh template bundled` (or `host`), or [`compose.baota.yml`](../../compose.baota.yml) / [`compose.baota-host.yml`](../../compose.baota-host.yml) from the repository.

2. Generate the `.env` content in the panel terminal (bundled):

   ```bash
   cat <<ENV
   EDGEWEIR_MASTER_KEY=$(openssl rand -base64 32)
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   EDGEWEIR_PUBLIC_URL=https://cdn-admin.example.com
   EDGEWEIR_NODE_API_URL=https://cdn-admin.example.com:8443
   EDGEWEIR_VERSION=20260929-a1b2c3d
   ENV
   ```

   For host mode, replace the `POSTGRES_PASSWORD` line with `DATABASE_URL=postgres://edgeweir:<URL-encoded password>@127.0.0.1:5432/edgeweir` (append `?sslmode=verify-full` for a cloud database).

3. Add the compose project: BaoTa **Docker → 容器编排 → 添加容器编排**; aaPanel **Docker → Compose → Add Compose**. Name it `edgeweir`, paste the template as the compose content, paste the previous output into the `.env` field (aaPanel **.env Content**), and create it.

4. Check the containers: `edgeweir-console` is healthy; bundled also runs `edgeweir-postgres`.

5. Set the trusted proxy in bundled mode: put `deploy.sh` in the compose directory and run `./deploy.sh restart`; the script writes the Docker gateway address to `EDGEWEIR_TRUSTED_PROXIES` and recreates the containers. To set it by hand, use the address printed below; environment changes take effect after the containers are recreated.

   ```bash
   docker inspect -f '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}' edgeweir-postgres
   ```

6. Read the setup token and continue with [section 4](#4-set-up-and-verify):

   ```bash
   docker logs edgeweir-console 2>&1 | grep -o '"setupToken":"[^"]*"' | tail -n 1
   ```

| Variable | Constraint |
| --- | --- |
| `.env` field | The panel does not run commands in it; paste the values generated in the terminal. |
| `EDGEWEIR_VERSION` | A dated tag from [GitHub Packages](https://github.com/marvinli001/edgeweir/pkgs/container/edgeweir); `latest` only for evaluation. |
| `BETTER_AUTH_SECRET` | Leave unset on new deployments. Deployments that set it keep the value; the console refuses to start once it is removed. |
| Other variables | See [Environment variables](../reference/environment.en.md). |

### Standalone containers without Compose

The panel's **Create Container** form cannot set the read-only root filesystem, `tmpfs`, and `no-new-privileges` hardening of the compose files. For that hardening, run the `docker run` commands in [docker.en.md](docker.en.md#without-compose-standalone-containers) from the terminal.

1. Create the network `edgeweir`: BaoTa **Docker → 网络**; aaPanel **Docker → Network → Add Network**; or in the terminal:

   ```bash
   docker network create edgeweir
   ```

2. Create two containers: BaoTa **Docker → 容器 → 创建容器**; aaPanel **Docker → Container → Create Container**.

   | Field | `edgeweir-postgres` | `edgeweir-console` |
   | --- | --- | --- |
   | Image | `postgres:18.6-alpine` | `ghcr.io/marvinli001/edgeweir:<dated tag>` |
   | Network | `edgeweir` | `edgeweir` |
   | Ports | None | `127.0.0.1:3000` → `3000`; `8443` → `8443` |
   | Volume | `edgeweir-postgres` → `/var/lib/postgresql` | — |
   | Environment | `POSTGRES_USER=edgeweir`, `POSTGRES_DB=edgeweir`, `POSTGRES_PASSWORD=<output of openssl rand -hex 24>` | `ROLE=all`, `DATABASE_URL=postgres://edgeweir:<same password>@edgeweir-postgres:5432/edgeweir`, `EDGEWEIR_MASTER_KEY`, `EDGEWEIR_PUBLIC_URL`, `EDGEWEIR_NODE_API_URL`, `EDGEWEIR_TRUSTED_PROXIES=<gateway of the edgeweir network>` |
   | Restart policy | `unless-stopped` or `always` | `unless-stopped` or `always` |

   - Do not set `EDGEWEIR_VERSION` on the console container: inside the image it carries the running version.
   - Deployments that set `BETTER_AUTH_SECRET` keep the value.
   - Gateway address:

     ```bash
     docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' edgeweir
     ```

   - If the form cannot bind the port to `127.0.0.1`, use `docker run` in the terminal.

3. Upgrade: pull the new tag, remove `edgeweir-console`, and recreate it with the same settings and the new tag. Data stays in the `edgeweir-postgres` volume. Back up first, see [backup.en.md](backup.en.md).

## Upgrades and backups

Run in the deployment directory:

```bash
cd /www/dk_project/edgeweir
./deploy.sh update                     # back up, then upgrade to the dated tag behind latest
./deploy.sh update 20260929-a1b2c3d    # upgrade or roll back to a given tag
./deploy.sh backup                     # back up to backups/<time>/
```

Commands, backup layout, and abort behavior: [deploy-script.en.md](deploy-script.en.md). Version policy and rollback constraints: [upgrade.en.md](upgrade.en.md). Restore: [backup.en.md](backup.en.md).

| Case | Behavior |
| --- | --- |
| Compose project created in the panel | All commands work after `deploy.sh` is placed in the compose directory; the script recognizes the deployment by `.env` and a compose file containing `container_name: edgeweir-console`, and keeps the panel's Compose project name. |
| Image update in the panel after editing `EDGEWEIR_VERSION` (aaPanel **Update Image**) | No database backup is taken. |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Database check fails during install | Address, password, `pg_hba.conf`, allow list, or TLS certificate | Follow the hint printed by the script; see [Database check](deploy-script.en.md#database-check). |
| The user cannot create tables or schemas | The user does not own the database | Select this user when creating the database in BaoTa, or run `ALTER DATABASE edgeweir OWNER TO edgeweir;` and `ALTER SCHEMA public OWNER TO edgeweir;`. |
| `无法访问 Docker` (cannot access Docker) | Not running as root, or Docker is stopped | Run with `sudo`; start Docker on the panel's **Docker** page. |
| Image pull fails | `ghcr.io` unreachable | Import the images with `docker load`, then set `EDGEWEIR_NO_PULL=1`. |
| Sign-in fails, or the session ends right after sign-in | `EDGEWEIR_PUBLIC_URL` differs from the browser address in scheme, domain, or port | `./deploy.sh config`. |
| Node enrollment fails with `CA pin mismatch` | The panel's nginx or a CDN terminates TLS on the node channel port | Use direct exposure or `stream` passthrough; verify as in section 4, step 4. |
| Node enrollment times out | The firewall or security group blocks the node channel port, or the node channel domain resolves incorrectly | Open the port; check DNS for the `EDGEWEIR_NODE_API_URL` host. |
| host mode warns that the node channel listens on loopback only | The image does not support `NODE_API_HOST`, or the channel was moved to loopback for `stream` passthrough | First case: `./deploy.sh update`; second case: no action. |
| All IPs in the audit log are the Docker gateway (`172.x.x.1`) | In bundled mode, `EDGEWEIR_TRUSTED_PROXIES` differs from the current gateway | `./deploy.sh restart`. |
| `./deploy.sh start` reports 「启动失败」 (startup failed) | `.env` lacks a variable, or the database is unreachable | `./deploy.sh logs console`; fix `.env`, then `./deploy.sh start`. |
