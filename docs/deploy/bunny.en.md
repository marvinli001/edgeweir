# bunny.net Magic Containers

Deploy the console on bunny.net Magic Containers from the console image, with an external PostgreSQL 18: Dashboard steps with bunny CLI equivalents.

## Requirements

| Item | Requirement |
| --- | --- |
| bunny.net | An account with a verified payment card. Trial accounts are limited to one app and 1 CPU, 4 GiB of memory per instance |
| bunny CLI | Optional: `npm install -g @bunny.net/cli` (0.18) after `bunny login`; usage and limits in [Methods](#methods) |
| Console image | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`, public; Magic Containers runs linux/amd64 only, which the image includes. Tag rules in [Versions, upgrades, and rollback](upgrade.en.md) |
| PostgreSQL | PostgreSQL 18 reachable from the container. When it filters by source address, allow the addresses listed at `https://api.bunny.net/mc/nodes/plain`; the list changes. bunny Database is libSQL and does not replace PostgreSQL |
| Public address | One Anycast IPv4 (USD 2 per month); Anycast has no IPv6. It can be added after deployment, see [Adding the Anycast IP later](#adding-the-anycast-ip-later) |
| Master key | Generated with `openssl rand -base64 32`; stored outside bunny.net and apart from database backups |
| Always on | Minimum of 1 instance; the platform does not scale to zero |
| Local commands | `openssl`, `curl` |

## Topology

| Magic Containers resource | Target | Carries |
| --- | --- | --- |
| App `edgeweir-console`, container `edgeweir`, 1 region, 1 instance | — | `ROLE=all` (image default): web UI, API, node channel, pg-boss worker |
| CDN endpoint: host name `mc-<id>.bunny.run`, backed by the pull zone `mc-<id>` (system host name `mc-<id>.b-cdn.net`) | Container port 3000 | HTTPS terminated at the bunny.net edge: browsers, `/api/v1`, `/install.sh`, `/healthz` |
| Anycast endpoint: 8443/TCP on the Anycast IPv4 | Container port 8443 | Node channel; forwarded as TCP, the console terminates TLS and mTLS |
| External PostgreSQL 18 | Environment variable `DATABASE_URL` | Database |

General rules for ports and the node channel certificate: [Ports, reverse proxy, and trusted proxies](networking.en.md).

## Methods

Create the app in the Dashboard or with the bunny CLI. The `bunny apps` commands of CLI 0.18 are experimental: they do not send health checks, and every `bunny apps deploy` rewrites the container from `bunny.jsonc`, removing health checks and endpoints the file does not list. Health checks and upgrades are done in the Dashboard or through the API with `bunny api`.

| Step | Dashboard | bunny CLI |
| --- | --- | --- |
| [1. Generate the master key](#1-generate-the-master-key) | — | Local `openssl` |
| [2. Create the app](#2-create-the-app) | **Magic Containers → + Add App** | `bunny apps deploy` |
| [3. Set variables](#3-set-variables) | **Container Settings → Edit → Environment Variables** | `bunny apps env push` |
| [4. Health checks](#4-health-checks) | **Container Settings → Edit → Monitoring** | `bunny api PATCH` |
| [5. Pull zone settings](#5-pull-zone-settings) | **CDN → Pull Zones →** `mc-<id>` | `bunny api POST` |
| [6. Run setup](#6-run-setup) | **Logging → Logs → Application** | — |
| [Custom domains](#custom-domains) | **Hostnames** of the pull zone | — |
| [Upgrade](#upgrade) | **Container Settings → Edit** | `bunny api PATCH` |

## 1. Generate the master key

```bash
umask 077
openssl rand -base64 32 > edgeweir-master-key
```

Use the output as is. Keep `edgeweir-master-key` offline and apart from database backups, see [Backup and recovery](backup.en.md).

## 2. Create the app

1. Dashboard → **Magic Containers → + Add App**.
2. Image: search for `marvinli001/edgeweir` (GitHub) and pick the target tag, not `latest`. Rename the container to `edgeweir`.
3. **Endpoints**: delete the endpoints the page pre-fills from the image's `EXPOSE`, then add:

   | Type | Container port | Exposed port | Other |
   | --- | --- | --- | --- |
   | **+ CDN** | 3000 | — | **SSL for origin** off |
   | **+ Anycast IP** | 8443 | 8443 | — |

   Do not add an Anycast endpoint for 3000: HTTP would bypass the CDN and be exposed directly.
4. **Environment variables → Raw editor**:

   ```ini
   DATABASE_URL=postgres://edgeweir:<password>@<host>:5432/edgeweir
   EDGEWEIR_MASTER_KEY=<contents of edgeweir-master-key>
   ```

5. Under **Region**, pick one region near PostgreSQL that supports Anycast; set **App name** to `edgeweir-console`; click **Deploy**.
6. In the app's **Regions and Scaling**, set the minimum and maximum instances to 1 and keep this single region: autoprovisioning starts instances in regions with growing demand.

The console still lacks `EDGEWEIR_PUBLIC_URL` at this point: it fails to start and the platform keeps restarting it until step 3. Do step 3 soon: restarts have a deadline, after which the platform removes the instance.

bunny CLI: create `bunny.jsonc` in an empty directory and adjust `regions` and the image tag:

```jsonc title="bunny.jsonc"
{
  "$schema": "https://raw.githubusercontent.com/BunnyWay/cli/main/packages/config/generated/schema.json",
  "version": "2026-05-11",
  "app": {
    "name": "edgeweir-console",
    "regions": ["DE"],
    "scaling": { "min": 1, "max": 1 },
    "containers": {
      "edgeweir": {
        "image": "ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d",
        "endpoints": [
          { "type": "cdn", "ssl": false, "ports": [{ "public": 443, "container": 3000 }] },
          { "type": "anycast", "ports": [{ "public": 8443, "container": 8443 }] }
        ]
      }
    }
  }
}
```

| Setting | Effect |
| --- | --- |
| `regions` | Region IDs, listed by `bunny apps regions list`; the array form makes them both required and allowed, so the app does not spread to other regions |
| `scaling` | Minimum and maximum instances per region |
| `"ssl": false` | The CDN connects to port 3000 over HTTP. With the default `true` it connects over HTTPS and the console does not answer |
| No `env` | When a container declares `env`, every `bunny apps deploy` replaces all its variables with it; set variables with `bunny apps env push` in step 3 |

In that directory run:

```bash
bunny apps deploy ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d
```

Pass the image on the first run: it creates the app, writes `.bunny/app.json` (the app ID), and deploys. When the CLI asks `Is ghcr.io public, or do you need credentials?`, choose **Public**. Without an image the CLI redeploys from `bunny.jsonc` and does not ask about the registry.

## 3. Set variables

1. Read the endpoint addresses in the app's **Endpoints**, or:

   ```bash
   bunny apps endpoints list
   ```

   The CDN endpoint is `mc-<id>.bunny.run` (the CLI prints it as `http://…` when `ssl` is `false`; the variables still use `https://`); the Anycast endpoint is `<Anycast IP>:8443`.
2. In the app's **Container Settings → Edit → Environment Variables**, complete the variables, click **Update Container**, then **Save Changes**:

   ```ini
   DATABASE_URL=postgres://edgeweir:<password>@<host>:5432/edgeweir
   EDGEWEIR_MASTER_KEY=<contents of edgeweir-master-key>
   EDGEWEIR_PUBLIC_URL=https://mc-<id>.bunny.run
   EDGEWEIR_NODE_API_URL=https://<Anycast IP>:8443
   ```

`EDGEWEIR_NODE_API_URL` can also stay unset: after setup, enter `https://<Anycast IP>:8443` under "Node channel" in **System settings**, which applies on saving without a rolling update.

bunny CLI: write the four lines above to `.env.bunny` (`umask 077`), then:

```bash
bunny apps env push .env.bunny --container edgeweir
```

Changing variables starts a rolling update; `bunny apps env push` merges with the existing variables, and with `--replace` drops those missing from the file. Magic Containers has no secret storage: values are shown in plain text in the Dashboard, the API, and `bunny apps env pull`. Each variable is described in [Variables](#variables).

## 4. Health checks

In the app's **Container Settings → Edit → Monitoring**, enable all three checks with type **HTTP GET**, path `/healthz`, port `3000`, click **Update Container**, then **Save Changes**. When the Dashboard lacks a parameter of the table below, use `probes.json` instead: with the API defaults the startup check fails after about 40 seconds, less than the 60 seconds the console waits for PostgreSQL.

| Check | Effect | Suggested parameters |
| --- | --- | --- |
| Startup | No requests are routed before it passes | Period 5 seconds, failure threshold 30: the first start runs migrations, and the console waits up to 60 seconds for an unreachable PostgreSQL |
| Readiness | Requests stop while it fails | Period 10 seconds, failure threshold 3 |
| Liveness | The container restarts when it fails | Period 15 seconds, failure threshold 4 |

bunny CLI: create `probes.json`:

```json title="probes.json"
{
  "probes": {
    "startup": { "initialDelaySeconds": 5, "periodSeconds": 5, "timeoutSeconds": 3, "failureThreshold": 30, "httpGet": { "request": { "path": "/healthz", "portNumber": 3000 } } },
    "readiness": { "periodSeconds": 10, "timeoutSeconds": 3, "failureThreshold": 3, "httpGet": { "request": { "path": "/healthz", "portNumber": 3000 } } },
    "liveness": { "periodSeconds": 15, "timeoutSeconds": 5, "failureThreshold": 4, "httpGet": { "request": { "path": "/healthz", "portNumber": 3000 } } }
  }
}
```

Look up the container ID (`containerTemplates[].id`; the app ID is in `.bunny/app.json`), then write the checks:

```bash
bunny api GET /mc/apps/<app ID>
bunny api PATCH /mc/apps/<app ID>/containers/<container ID> --body "$(cat probes.json)"
```

`bunny apps deploy` removes the health checks; write them again after running it.

## 5. Pull zone settings

The CDN endpoint creates the pull zone `mc-<id>`. The console sends `Cache-Control: no-store` on every response except `/assets/*`; the settings below keep its responses out of the cache and let the session cookie reach the browser.

| Setting | Location | Value |
| --- | --- | --- |
| Smart Cache | **Caching** | On (default): HTML and JSON are never cached |
| Cache expiration time | **Caching** | Respect origin Cache-Control (default) |
| Disable Cookies | **Caching** | Off (default): when on, `Set-Cookie` is removed and sign-in fails |
| Force SSL | **General → Hostnames**, every host name | On: HTTP requests redirect to HTTPS |
| Edge Rules | **Edge Rules** | No **Override Cache Time** rule for console paths |

bunny CLI (`<pull zone ID>` is the `pullZoneId` of the CDN endpoint in `bunny api GET /mc/apps/<app ID>/endpoints`):

```bash
bunny api POST /pullzone/<pull zone ID>/setForceSSL --body '{"Hostname":"mc-<id>.bunny.run","ForceSSL":true}'
bunny api POST /pullzone/<pull zone ID>/setForceSSL --body '{"Hostname":"mc-<id>.b-cdn.net","ForceSSL":true}'
```

## 6. Run setup

An uninitialized console logs the same setup token on every start.

1. In the app's **Logging → Logs → Application**, search for `first-run setup`. Logs are kept for 5 days and may hold setup tokens from before a database change: use the latest line.
2. The `setupToken` field of that line is the setup token; the `url` field is the setup wizard (`<EDGEWEIR_PUBLIC_URL>/setup`).
3. Open the wizard and enter the setup token, see [Getting started](../guide/first-site.en.md#1-complete-the-setup-wizard).

Without that line, restart the app (the app's **Restart**, or `bunny apps restart`) and search again.

## Variables

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | PostgreSQL 18 connection string | Required. |
| `EDGEWEIR_MASTER_KEY` | Output of `openssl rand -base64 32` | Required. |
| `EDGEWEIR_PUBLIC_URL` | `https://mc-<id>.bunny.run` | Required. Change to your domain when you use a custom domain. |
| `EDGEWEIR_NODE_API_URL` | `https://<Anycast IP>:8443` | Required while no URL is saved under "Node channel" in **System settings**: the default `https://<public host>:8443` points at the CDN and is unreachable. The host name or IP is added to the node channel certificate. |
| `EDGEWEIR_NODE_API_HOSTNAMES` | Empty | Extra names for the node channel certificate, comma-separated. |
| `EDGEWEIR_TRUSTED_PROXIES` | Empty, or the bunny.net edge server addresses | See [Limits](#limits). |
| `EDGEWEIR_VERSION` | Not set | The running version built into the image; the image tag sets it. |
| `BETTER_AUTH_SECRET` | Not set | Keep the existing value when migrating from a deployment that set it. |

The value of `EDGEWEIR_TRUSTED_PROXIES` is built from the two bunny.net edge server lists:

```bash
( curl -fsS https://api.bunny.net/system/edgeserverlist/plain; echo
  curl -fsS https://api.bunny.net/system/edgeserverlist/ipv6/plain ) | grep -v '^$' | paste -sd, -
```

`ROLE`, `HOST`, `PORT`, and `NODE_API_PORT` keep the image defaults `all`, `0.0.0.0`, `3000`, and `8443`, which match the endpoints' container ports. All variables: [Environment variables](../reference/environment.en.md).

## Verification

| Check | Dashboard or command | Expected |
| --- | --- | --- |
| App | The app's **Overview**; `bunny apps show` | Status Active, 1 instance |
| Web and API | `curl -fsS https://mc-<id>.bunny.run/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| Cache | `curl -sI https://mc-<id>.bunny.run/api/v1/system/status`, twice | Never `cdn-cache: HIT` (`MISS` or `BYPASS`) |
| HTTPS | `curl -sI http://mc-<id>.bunny.run/healthz` | `301` with an HTTPS `Location` |
| Node channel TLS | The `openssl` command below | Issuer `Edgeweir Node Channel CA`, SAN includes the Anycast IP |
| Node channel URL | **System settings**, "Node channel" | `https://<Anycast IP>:8443` |
| Node enrollment | **Clusters & nodes** → **Add node** (the dialog shows the install command as it opens) | `--server` is `https://<Anycast IP>:8443`; running it on a node: [Adding nodes](nodes.en.md) |

```bash
openssl s_client -connect <Anycast IP>:8443 </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
```

Expected:

```text
        Issuer: CN=Edgeweir Node Channel CA, O=Edgeweir
        Subject: CN=edgeweir-node-api, O=Edgeweir
                DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, DNS:<container host name>, IP Address:<Anycast IP>
```

Any other issuer means a middlebox terminated TLS.

## Adding the Anycast IP later

The app can start with the CDN endpoint only and `EDGEWEIR_NODE_API_URL` unset; "Node channel" in **System settings** is then `https://mc-<id>.bunny.run:8443`, the connection check shows "The console cannot connect to this URL", and nodes cannot enroll. To add nodes:

1. Check that the app's region supports Anycast: the Anycast column of `bunny apps regions list`.
2. Add an Anycast endpoint in the app's **Endpoints**: container port 8443, public port 8443. Endpoint changes apply at once without a rolling update and do not restart the console; the Anycast IP is billed from then on. bunny CLI:

   ```bash
   bunny apps endpoints add --type anycast --container-port 8443 --public-port 8443 --container edgeweir
   ```

   With `bunny.jsonc`, add the same endpoint to the file, or the next `bunny apps deploy` removes it.
3. Read the Anycast IP in the app's **Endpoints**, or with `bunny apps endpoints list`.
4. In the console, **System settings** → "Node channel", enter `https://<Anycast IP>:8443`, or a name pointing at it (see [Custom domains](#custom-domains)), and save. It applies at once: the node channel certificate adds the name, the connection check shows "Reachable", and new install commands carry the URL.
5. Verify with the `openssl` command of [Verification](#verification).

## Custom domains

Do this before enrolling nodes.

1. Web console: pull zone `mc-<id>` → **General → Hostnames**, add `console.example.com`; add the `CNAME` the page shows (`mc-<id>.b-cdn.net`) in DNS; click **Verify & Activate SSL**, then turn on **Force SSL** for that host name.
2. Node channel: pull zones do not forward TCP. Add an `A` record for `nodes.example.com` pointing at the Anycast IP; on Cloudflare, turn the proxy off (DNS only). Nodes enrolled with the name only need this record changed when the Anycast IP changes.
3. Change the variables (starts a rolling update):

   ```ini
   EDGEWEIR_PUBLIC_URL=https://console.example.com
   EDGEWEIR_NODE_API_URL=https://nodes.example.com:8443
   ```

   The node channel URL can instead be changed only under "Node channel" in **System settings** to `https://nodes.example.com:8443`, without a rolling update; once a URL is saved there, `EDGEWEIR_NODE_API_URL` has no effect.

4. Verify: run the `curl` commands of [Verification](#verification) with the new domain, and the `openssl` command with `nodes.example.com:8443` and `-servername nodes.example.com`; the SAN includes `DNS:nodes.example.com`.

Changing the node channel URL of enrolled nodes: [Node channel URL and certificate](networking.en.md#node-channel-url-and-certificate).

## Upgrade

1. Back up the database, see [Backup and recovery](backup.en.md).
2. In the app's **Container Settings → Edit**, pick the new tag in the image drop-down, click **Update Container**, then **Save Changes** and confirm.
3. Verify:

   ```bash
   curl -fsS https://mc-<id>.bunny.run/healthz
   ```

   Expected: `version` is the new tag.

bunny CLI (step 2): change only the image tag; variables, endpoints, and health checks stay as they are:

```bash
bunny api PATCH /mc/apps/<app ID>/containers/<container ID> --body '{"imageTag":"<new tag>"}'
```

`bunny apps deploy <image>` removes the health checks and is not used for upgrades. Migrations, signature verification, and rollback: [Versions, upgrades, and rollback](upgrade.en.md).

## Limits

| Item | Behavior | Impact |
| --- | --- | --- |
| Client IP | The TCP peer of CDN requests is a bunny.net edge server, listed publicly at `https://api.bunny.net/system/edgeserverlist/plain` and `https://api.bunny.net/system/edgeserverlist/ipv6/plain` (900+ entries that change); the edge passes the visitor address as a single `X-Forwarded-For` and `X-Real-IP` and drops those headers when visitors send them | With `EDGEWEIR_TRUSTED_PROXIES` empty, audit log IPs and sign-in rate limits use the edge address, see [Trusted proxies and client IP](networking.en.md#trusted-proxies-and-client-ip). With both lists set (comma-joined, about 17 KB) they use the visitor address; update the variable when the lists change, requests from new edges use the edge address until then |
| Anycast | IPv4 only | Nodes without IPv4 cannot reach the node channel |
| Anycast IP | Fixed while the endpoint exists; removing and adding the endpoint again, or a `bunny apps deploy` that rewrites the endpoints from `bunny.jsonc`, may give a new IP | Enrolled nodes keep the URL they enrolled with: use a name pointing at the Anycast IP as the node channel URL, so an IP change only needs a DNS change |
| Variables | Shown in plain text in the Dashboard, the API, and the CLI | Keep the master key outside bunny.net as well |
| CLI 0.18 | `bunny apps deploy` rewrites the container from `bunny.jsonc`: removes health checks and endpoints the file does not list; an `env` block replaces all variables | Use the Dashboard or `bunny api` for health checks and upgrades |
| Rolling update | After a variable, image, or health check change, a new instance starts and the old one stops once health checks pass; endpoint changes do not start one. The old one gets SIGTERM and 30 seconds to exit (1 second for apps created before 1 February 2026; adjustable with `terminationGracePeriodSeconds` in the API). A new instance not running within 10 minutes aborts the update and keeps the old one. Apps with persistent volumes stop the old instance before starting the new one | Old and new versions run side by side briefly; node channel connections on the old instance drop and reconnect. Updating `EDGEWEIR_TRUSTED_PROXIES` is a variable change too. A single instance with a persistent volume is briefly down during an update |
| Regions | An app can run in several regions; Anycast routes nodes to the nearest one | Every region connects to the same PostgreSQL; multi-instance conditions in [Deployment overview](README.en.md#scaling) |
| Mail ports | 25, 465, 587, and 2525 are restricted by default (inbound and outbound) | The SMTP channel of alert notifications cannot send; ask bunny.net support to open the ports |
| Billing | Minimum of 1 instance; the Anycast IP is billed monthly, prorated for the time it is attached | The Anycast IP is billed even after the app is undeployed, until the endpoint is removed |
| `/downloads/*` | The container has no downloads mirror; `EDGEWEIR_DOWNLOADS_DIR` is unset | Returns 404; `install.sh` downloads from GitHub, see [Adding nodes](nodes.en.md#downloads-mirror) |
