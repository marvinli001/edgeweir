# Zeabur

Deploy the console on a Zeabur Server with the console image and PostgreSQL 18: one-click template deployment, manual creation in the Dashboard, and the Zeabur CLI equivalents.

[![Deploy on Zeabur](https://zeabur.com/button.svg)](https://zeabur.com/templates/5MQJR2)

## Requirements

| Item | Requirement |
| --- | --- |
| Zeabur | Dev plan or higher: services on the Free plan sleep when idle, which stops the worker and the node channel |
| Zeabur Server | Bought from Zeabur (**Servers → Create → Buy a Server from Zeabur**), or your own server (at least 1 CPU and 2 GB RAM, with 22, 80, 443, 4222, 6443, and 30000–32767 open). Zeabur's shared clusters no longer accept new services |
| Console image | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`, public; linux/amd64, linux/arm64. Tag rules: [Versions, upgrades and rollback](upgrade.en.md) |
| PostgreSQL | PostgreSQL 18, in the same project as the console |
| Master key | Generated with `openssl rand -base64 32`; keep it outside Zeabur, apart from database backups |
| Local commands | `openssl`, `curl`; Node.js for template deployment (`npx zeabur@latest`) |

## Topology

| Zeabur resource | Target | Carries |
| --- | --- | --- |
| Service `edgeweir` (Docker Image) | — | `ROLE=all` (image default): web UI, API, node channel, pg-boss worker |
| HTTP port `web`: `<prefix>.zeabur.app` or a custom domain, certificate issued and TLS terminated by Zeabur | Container port 3000 | Browsers, `/api/v1`, `/install.sh`, `/healthz` |
| TCP port `node`: port forwarding `<host>:<port>`, the port assigned by Zeabur (NodePort 30000–32767) | Container port 8443 | Node channel; forwarded as TCP, TLS and mTLS terminated by the console |
| Service `postgresql`, volume at `/var/lib/postgresql`, no port forwarding | Private network `postgresql.zeabur.internal:5432` | PostgreSQL 18 |

General rules for ports and the node channel certificate: [Ports, reverse proxy and trusted proxies](networking.en.md).

## One-click template

[`zeabur.yaml`](https://github.com/marvinli001/edgeweir/blob/master/zeabur.yaml) at the repository root is a Zeabur template, published as [`5MQJR2`](https://zeabur.com/templates/5MQJR2):

| Service | Settings |
| --- | --- |
| `postgresql` | `postgres:18.6-alpine` (pinned by digest); volume `data` at `/var/lib/postgresql`; database and user `edgeweir`, password the `${PASSWORD}` Zeabur generates; `portForwarding.enabled: false`; TCP health check |
| `edgeweir` | `ghcr.io/marvinli001/edgeweir:latest`; ports `web` 3000/HTTP and `node` 8443/TCP; HTTP health check `/healthz`; `PORT=3000`, `DATABASE_URL=${POSTGRES_CONNECTION_STRING}`, `EDGEWEIR_PUBLIC_URL=https://${ZEABUR_WEB_DOMAIN}`, `EDGEWEIR_NODE_API_URL=https://${PORT_FORWARDED_HOSTNAME}:${NODE_PORT_FORWARDED_PORT}` |
| Template variables | `PUBLIC_DOMAIN`: the `zeabur.app` domain prefix, bound to the `web` port; `EDGEWEIR_MASTER_KEY`: the master key |

1. Generate the master key:

   ```bash
   umask 077
   openssl rand -base64 32 > edgeweir-master-key
   ```

2. Click **Deploy on Zeabur** at the top of this page and **Deploy** on the template page; when prompted, pick a project or create one on a Server, enter the domain prefix (giving `<prefix>.zeabur.app`) and the master key (the contents of `edgeweir-master-key`).

   CLI equivalent (run `npx zeabur@latest auth login` first); `-f zeabur.yaml` deploys a local copy of the template file:

   ```bash
   npx zeabur@latest template deploy -c 5MQJR2
   ```
3. [Pin the version](#pin-the-version), then [initialize](#initialization).

Template variables are written to every service of the project, so `EDGEWEIR_MASTER_KEY` also appears among the `postgresql` service's variables; PostgreSQL does not read it.

## Manual creation

Equivalent to the [one-click template](#one-click-template).

1. Generate the master key (as above).
2. **Create Project**, pick an existing **Server**, **Buy New Server**, or **Bind External Server**, and click **Create Project**.
3. Database: **Deploy New Service → Databases → PostgreSQL**. Zeabur's PostgreSQL template runs `postgres:18` with port forwarding on (5432 reachable from the internet); turn it off:

   ```bash
   npx zeabur@latest context set project
   npx zeabur@latest context set service --name postgresql
   npx zeabur@latest service port-forward --disable
   ```

4. Console: **Deploy New Service → Docker Image**, image `ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d` (replace with the target tag).
   - **Ports**: `web`, 3000, `HTTP`; `node`, 8443, `TCP`.
   - **Environment Variable**:

     ```ini
     PORT=3000
     DATABASE_URL=${POSTGRES_CONNECTION_STRING}
     EDGEWEIR_MASTER_KEY=<contents of edgeweir-master-key>
     EDGEWEIR_PUBLIC_URL=https://${ZEABUR_WEB_DOMAIN}
     EDGEWEIR_NODE_API_URL=https://${PORT_FORWARDED_HOSTNAME}:${NODE_PORT_FORWARDED_PORT}
     ```

   Click **Deploy**.
5. `edgeweir` service **Domains → Generate Domain**, giving `<prefix>.zeabur.app`.
6. `edgeweir` service **Settings → Health Check**, path `/healthz`.

## Pin the version

The template deploys the `latest` image. Once the first deploy succeeds, pin the tag it runs:

1. Read the running version:

   ```bash
   curl -fsS https://<prefix>.zeabur.app/healthz
   ```

   The `version` field is the tag, e.g. `20260929-a1b2c3d`.
2. `edgeweir` service **Settings → Service Image**: change the second field (the tag) to that tag and click **Save**; the service restarts with the new image. CLI:

   ```bash
   npx zeabur@latest context set service --name edgeweir
   npx zeabur@latest service update tag -t <that tag>
   ```

## Initialization

An uninitialized console logs the same setup token on every start.

1. `edgeweir` service **Logs**, filter for `first-run setup`. After a restart or redeploy the previous instance's logs are gone; the latest instance logs the token again.
2. The line's `setupToken` field is the setup token and its `url` field the setup wizard (`<EDGEWEIR_PUBLIC_URL>/setup`).
3. Open the wizard and enter the setup token; see [Quick start](../guide/first-site.en.md#1-complete-the-setup-wizard).

CLI: `npx zeabur@latest deployment log -t=runtime --service-name edgeweir | grep setupToken`.

## Variables

| Variable | Value | Notes |
| --- | --- | --- |
| `PORT` | `3000` | Zeabur injects `PORT`; set 3000 to match the `web` port. |
| `DATABASE_URL` | `${POSTGRES_CONNECTION_STRING}` | Required. The private network connection string the `postgresql` service exposes. |
| `EDGEWEIR_MASTER_KEY` | The output of `openssl rand -base64 32` | Required. |
| `EDGEWEIR_PUBLIC_URL` | `https://${ZEABUR_WEB_DOMAIN}` | Required. The domain bound to the `web` port; with a custom domain, set the literal value. |
| `EDGEWEIR_NODE_API_URL` | `https://${PORT_FORWARDED_HOSTNAME}:${NODE_PORT_FORWARDED_PORT}` | Required while no URL is saved under "Node channel" in **System settings**: the default `https://<public domain>:8443` is unreachable. Its host name or IP goes into the node channel certificate. |
| `EDGEWEIR_NODE_API_HOSTNAMES` | Empty | Extra names for the node channel certificate, comma separated. |
| `EDGEWEIR_TRUSTED_PROXIES` | Empty | See [Limitations](#limitations). |
| `EDGEWEIR_VERSION` | Unset | The running version built into the image; the image tag decides it. |
| `BETTER_AUTH_SECRET` | Unset | Keep the original value when migrating from a deployment that set it. |

`${KEY}` expands when the service starts: the service's own variables first, then variables other services expose, then Zeabur's special variables. `ROLE`, `HOST`, and `NODE_API_PORT` keep the image defaults `all`, `0.0.0.0`, and `8443`. All variables: [Environment variables](../reference/environment.en.md).

## Verification

| Check | Where or command | Expected |
| --- | --- | --- |
| Services | **Overview** of the `edgeweir` and `postgresql` services | Both running |
| Web and API | `curl -fsS https://<prefix>.zeabur.app/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| Port forwarding | `edgeweir` service **Networking**; `npx zeabur@latest service network` | The `node` port has a `<host>:<port>`; `postgresql` has none |
| Node channel TLS | The `openssl` command below | Issuer `Edgeweir Node Channel CA` |
| Node channel URL | "Node channel" in **System settings** | `https://<host>:<port>`, connection check "Reachable" |
| Node enrollment | **Clusters and nodes** → **Add node** | `--server` is the port forwarding address; run it on the node as in [Adding nodes](nodes.en.md) |

```bash
openssl s_client -connect <host>:<port> </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
```

Expected: issuer `CN=Edgeweir Node Channel CA, O=Edgeweir`. Any other issuer means a device in between terminates TLS.

## Custom domain

Do this before enrolling nodes.

1. Web console: `edgeweir` service **Domains → Custom Domain**, enter `console.example.com`, click **Create Domain**, and add the DNS record the page shows.
2. Node channel: add `nodes.example.com` to DNS as an `A` record for the port forwarding host (the public IP of the Zeabur Server); the port stays the same. With DNS on Cloudflare, turn the proxy off (DNS only). When the forwarding host or port changes, only this record or the node channel URL needs changing.
3. Change the variables (the service restarts):

   ```ini
   EDGEWEIR_PUBLIC_URL=https://console.example.com
   EDGEWEIR_NODE_API_URL=https://nodes.example.com:<port>
   ```

   The node channel URL can instead be changed only under "Node channel" in **System settings** to `https://nodes.example.com:<port>`, without a restart.
4. Verify: run the `curl` command of [Verification](#verification) with the new domain, and the `openssl` command with `nodes.example.com:<port>` and `-servername nodes.example.com`.

Moving enrolled nodes to another node channel URL: [Node channel URL and certificate](networking.en.md#node-channel-url-and-certificate).

## Upgrade

1. Back up the database; see [Backup and recovery](backup.en.md):
   - In the `postgresql` service, **Overview → Command**, run `pg_dump -U edgeweir -d edgeweir -Fc -f /var/lib/postgresql/edgeweir.dump`, download the file from **Overview → Files**, then run `rm /var/lib/postgresql/edgeweir.dump`;
   - or use the service's **Backup** page (Dev plan or higher; backups are kept 7 days).
2. `edgeweir` service **Settings → Service Image**, change the tag to the new version and click **Save**; or `npx zeabur@latest service update tag -t <new tag>`.
3. Verify:

   ```bash
   curl -fsS https://<prefix>.zeabur.app/healthz
   ```

   Expected: `version` is the new tag.

Migrations, signature verification, and rollback: [Versions, upgrades and rollback](upgrade.en.md).

## Node channel over WebSocket

When port forwarding is unavailable, or nodes should only connect to an HTTPS domain, nodes can use the WebSocket entry on the `web` port: save `wss://<prefix>.zeabur.app` under "Node channel" in **System settings**, or remove `EDGEWEIR_NODE_API_URL` and set `EDGEWEIR_NODE_API_WEBSOCKET=true`. Nodes need edgeweir-node 0.2.0 or later; see [The node channel's WebSocket entry](networking.en.md#the-node-channels-websocket-entry).

## Limitations

| Item | Behavior | Impact |
| --- | --- | --- |
| Port forwarding address | Host and port are assigned by Zeabur and usually stay the same; Zeabur does not guarantee they never change | Enrolled nodes keep connecting to the address they enrolled with: use a domain pointing at the Server IP as the node channel URL |
| Client IP | The HTTP entry passes the client address in `X-Forwarded-For`; the source ranges it connects to containers from are not published | Leave `EDGEWEIR_TRUSTED_PROXIES` empty; audit IPs and sign-in rate limiting use the entry's address; see [Trusted proxies and client IP](networking.en.md#trusted-proxies-and-client-ip) |
| Nodes' connection source address | Whether port forwarding keeps the node's address is not documented; no PROXY protocol | A node's "connection source address" may not be its public address |
| Deploy switchover | Services without volumes start the new instance and end the old one once the health check passes; services with volumes (`postgresql`) stop before they start | Old and new console versions run side by side for a short while; changing the `postgresql` service (image, variables) stops the database briefly, during which console requests and background jobs fail, and they continue once it is back |
| Logs | After a restart or redeploy the previous instance's logs are gone | The setup token is logged again on every start |
| Template variables | Written to every service of the project | The master key also appears among the `postgresql` service's variables |
| `/downloads/*` | The container has no downloads mirror; `EDGEWEIR_DOWNLOADS_DIR` is unset | 404; `install.sh` downloads from GitHub, see [Adding nodes](nodes.en.md#downloads-mirror) |
