# Railway

Deploy the console on Railway from the console image, with Railway PostgreSQL 18.

## Requirements

| Item | Requirement |
| --- | --- |
| Railway | An account that can create projects; the CLI steps use the `railway` CLI after `railway login` |
| Console image | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`, public; tag rules in [Versions, upgrades, and rollback](upgrade.en.md) |
| PostgreSQL | Railway PostgreSQL service, image `ghcr.io/railwayapp-templates/postgres-ssl:18` |
| Master key | Generated with `openssl rand -base64 32`; stored outside Railway and apart from database backups |
| Always on | Serverless disabled on the console service |
| Local commands | `openssl`, `curl` |

## Topology

| Railway resource | Target | Carries |
| --- | --- | --- |
| Service `edgeweir`, source: the console image | — | `ROLE=all` (image default): web UI, API, node channel, pg-boss worker |
| Public Networking domain: `<name>.up.railway.app` or a custom domain | Container port 3000 | HTTPS, TLS terminated by Railway: browsers, `/api/v1`, `/install.sh`, `/healthz` |
| TCP Proxy: `<name>.proxy.rlwy.net:<port>` | Container port 8443 | Node channel; Railway forwards TCP, the console terminates TLS and mTLS |
| Service `Postgres` | Private network, `${{Postgres.DATABASE_URL}}` | PostgreSQL 18; no public access by default |

General rules for ports and the node channel certificate: [Ports, reverse proxy, and trusted proxies](networking.en.md).

## 1. Create the project and PostgreSQL

Create an **Empty project** on Railway and add PostgreSQL with **+ New** on the project canvas. CLI:

```bash
railway init --name edgeweir
railway add --database postgres
```

In the `Postgres` service, check under **Settings → Source** that the image is `ghcr.io/railwayapp-templates/postgres-ssl:18`. For an earlier major version, upgrade to 18 with **Database → Config → Major Version Upgrade**.

## 2. Create the console service

Add a service on the project canvas with the source **Docker Image**, image `ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d` (replace with the target tag), and name it `edgeweir`. CLI:

```bash
railway add --service edgeweir --image ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d
```

## 3. Expose 3000 and 8443

In **Settings → Networking** of the `edgeweir` service, in this order:

| Order | Action | Result |
| --- | --- | --- |
| 1 | **Public Networking → Generate Domain**, port `3000` | `<name>.up.railway.app` |
| 2 | **TCP Proxy**, port `8443` | `<name>.proxy.rlwy.net:<port>`, port assigned by Railway |

Generate the domain before creating the TCP proxy: a service with a TCP proxy must remove it before a domain can be added. CLI:

```bash
railway domain --service edgeweir --port 3000
railway tcp-proxy create --service edgeweir --port 8443
```

## 4. Generate the master key

```bash
umask 077
openssl rand -base64 32 > edgeweir-master-key
```

Use the output as is. Store `edgeweir-master-key` offline, apart from database backups; see [Backup and recovery](backup.en.md).

## 5. Set variables

In **Variables → Raw Editor** of the `edgeweir` service, enter:

```ini
PORT=3000
DATABASE_URL=${{Postgres.DATABASE_URL}}
EDGEWEIR_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}
EDGEWEIR_NODE_API_URL=https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}
EDGEWEIR_MASTER_KEY=<contents of edgeweir-master-key>
```

CLI (each command triggers a deployment):

```bash
railway variable set --service edgeweir PORT=3000 \
  'DATABASE_URL=${{Postgres.DATABASE_URL}}' \
  'EDGEWEIR_PUBLIC_URL=https://${{RAILWAY_PUBLIC_DOMAIN}}' \
  'EDGEWEIR_NODE_API_URL=https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}'
railway variable set --service edgeweir EDGEWEIR_MASTER_KEY --stdin < edgeweir-master-key
```

**Seal** `EDGEWEIR_MASTER_KEY` from the variable menu: a sealed value no longer appears in the Railway UI, API, or CLI. Each variable is described under [Variables](#variables).

## 6. Deployment settings

In the `edgeweir` service, set:

| Setting | Location | Value |
| --- | --- | --- |
| Healthcheck Path | **Settings → Deploy** | `/healthz` |
| Serverless | **Settings → Deploy** | Off |
| Region | **Settings** | Same as the `Postgres` service |
| Restart Policy | **Settings** | `Always`; not offered on the Free plan, keep the default `On Failure` there |

Changes made in the Railway UI are staged; click **Deploy** in the canvas banner to apply them.

## 7. Run setup

An uninitialized console logs the same setup token on every start:

```bash
railway logs --service edgeweir --lines 500 --json | grep setupToken
```

In the Railway log view, filter by `"first-run setup"` and expand the line to read `setupToken`. Open the address in the line's `url` field (`<EDGEWEIR_PUBLIC_URL>/setup`) and enter the setup token in the setup wizard; see [Quick start](../guide/first-site.en.md#1-complete-the-setup-wizard).

## Variables

| Variable | Value | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Railway injects `PORT` into the container and health-checks on it; set to 3000 to match the domain's target port. |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Private network connection string; `Postgres` is the PostgreSQL service name. |
| `EDGEWEIR_MASTER_KEY` | Output of `openssl rand -base64 32` | Required. |
| `EDGEWEIR_PUBLIC_URL` | `https://${{RAILWAY_PUBLIC_DOMAIN}}` | Scheme `https`: Railway accepts only TLS inbound. With a custom domain, use a literal value. |
| `EDGEWEIR_NODE_API_URL` | `https://${{RAILWAY_TCP_PROXY_DOMAIN}}:${{RAILWAY_TCP_PROXY_PORT}}` | Required: the default `https://<public domain>:8443` is unreachable on Railway. The host name is added to the node channel certificate automatically. |
| `EDGEWEIR_NODE_API_HOSTNAMES` | Empty | Extra names for the node channel certificate, comma separated. |
| `EDGEWEIR_TRUSTED_PROXIES` | Empty | See [Limits](#limits). |
| `EDGEWEIR_VERSION` | Not set | The running version built into the image; the image tag sets the version. |
| `BETTER_AUTH_SECRET` | Not set | Keep the existing value when migrating a deployment that set it. |

`ROLE`, `HOST`, and `NODE_API_PORT` keep the image defaults `all`, `0.0.0.0`, and `8443`. All variables: [Environment variables](../reference/environment.en.md).

## Verification

| Check | Command or location | Expected |
| --- | --- | --- |
| Web and API | `curl -fsS https://<name>.up.railway.app/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| Node channel TLS | `openssl` command below | Issuer `Edgeweir Node Channel CA`; SAN includes the TCP proxy domain |
| Node channel URL | **Admin → System**, "Node channel" | `https://<name>.proxy.rlwy.net:<port>` |
| Node enrollment | **Admin → Clusters & nodes** → **Add node** → **Generate command** | `--server` is the TCP proxy address; running it on a node: [Adding nodes](nodes.en.md) |

```bash
openssl s_client -connect <name>.proxy.rlwy.net:<port> -servername <name>.proxy.rlwy.net </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
```

Expected:

```text
        Issuer: CN=Edgeweir Node Channel CA, O=Edgeweir
        Subject: CN=edgeweir-node-api, O=Edgeweir
                DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, DNS:<container host name>, DNS:<name>.proxy.rlwy.net
```

Any other issuer means a device in the path terminates TLS.

## Custom domains

Complete this before enrolling nodes.

| Entry point | Action | Variable |
| --- | --- | --- |
| Web console | **Settings → Networking → + Custom Domain**, port `3000`, then add the `CNAME` and `TXT` records shown; or `railway domain console.example.com --service edgeweir --port 3000` | `EDGEWEIR_PUBLIC_URL=https://console.example.com` |
| Node channel | DNS `CNAME` from `nodes.example.com` to `<name>.proxy.rlwy.net` (no port); the port stays the one Railway assigned | `EDGEWEIR_NODE_API_URL=https://nodes.example.com:<port>` |

Without the `TXT` record the custom domain returns 404. Changing the node channel address for enrolled nodes: [Node channel URL and certificate](networking.en.md#node-channel-url-and-certificate).

## Upgrade

1. Back up the database; see [Backup and recovery](backup.en.md).
2. In **Settings → Source** of the `edgeweir` service, change the image to the new tag and click **Deploy**.
3. Verify:

   ```bash
   curl -fsS https://<name>.up.railway.app/healthz
   ```

   Expected: `version` is the new tag.

Migrations, signature verification, and rollback: [Versions, upgrades, and rollback](upgrade.en.md).

## Limits

| Item | Behavior | Effect |
| --- | --- | --- |
| Client IP | The Railway HTTP proxy passes the client address in `X-Real-IP`; the source range the proxy connects from is not published | Leave `EDGEWEIR_TRUSTED_PROXIES` empty; audit log IPs and sign-in rate limiting use the Railway proxy address; see [Trusted proxies and client IP](networking.en.md#trusted-proxies-and-client-ip) |
| TCP proxy address | Railway assigns the domain and port; a custom domain replaces only the host name | Enrolled nodes connect to the address recorded at enrollment; after the TCP proxy address changes, those nodes cannot connect |
| Serverless | The service sleeps after 5–10 minutes without outbound traffic | Must be off: sleeping stops the worker's scheduled jobs and the node channel |
| Health check | `/healthz` is requested only during a deployment, not while running | Process exits are handled by the Restart Policy |
| Deployment switch | The old deployment stops after the new one passes its health check | Old and new versions run side by side briefly; node channel connections on the old deployment drop with it |
| Restart Policy | Default `On Failure`, at most 10 restarts | The console exits when PostgreSQL is unreachable for 60 seconds, which counts as a restart |
| `/downloads/*` | No downloads mirror directory in the container; `EDGEWEIR_DOWNLOADS_DIR` unset | Returns 404; `install.sh` downloads from GitHub; see [Adding nodes](nodes.en.md#downloads-mirror) |
