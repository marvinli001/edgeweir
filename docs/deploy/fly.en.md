# Fly.io

Deploy the console on Fly.io from the console image, with an external PostgreSQL 18: Dashboard steps with flyctl equivalents.

## Requirements

| Item | Requirement |
| --- | --- |
| Fly.io | An organization that can create apps |
| flyctl | The `fly` CLI after `fly auth login`; app creation, deployment, and upgrades use flyctl, see [Methods](#methods) |
| Console image | `ghcr.io/marvinli001/edgeweir:<YYYYMMDD>-<commit>`, public; tag rules in [Versions, upgrades, and rollback](upgrade.en.md) |
| PostgreSQL | PostgreSQL 18 reachable from the Machine. Fly Managed Postgres offers only 16 and 17 and does not qualify |
| Public addresses | Dedicated IPv4 and dedicated IPv6 |
| Master key | Generated with `openssl rand -base64 32`; stored outside Fly.io and apart from database backups |
| Always on | `auto_stop_machines = "off"` |
| Local commands | `fly`, `openssl`, `curl` |

## Topology

| Fly.io resource | Target | Carries |
| --- | --- | --- |
| App `edgeweir-console`, 1 Machine | — | `ROLE=all` (image default): web UI, API, node channel, pg-boss worker |
| `[http_service]`: 80 (HTTP, redirects to HTTPS), 443 (TLS terminated by Fly Proxy) | Container port 3000 | Browsers, `/api/v1`, `/install.sh`, `/healthz` |
| `[[services]]`: 8443/TCP, no handler | Container port 8443 | Node channel; Fly Proxy forwards TCP as is, the console terminates TLS and mTLS |
| Dedicated IPv4, dedicated IPv6, host name `edgeweir-console.fly.dev` | All ports above | A shared IPv4 does not forward 8443 |
| External PostgreSQL 18 | Secret `DATABASE_URL` | Database |

General rules for ports and the node channel certificate: [Ports, reverse proxy, and trusted proxies](networking.en.md).

## Methods

The Fly.io Dashboard builds and deploys only from a GitHub repository; it does not deploy images. App creation, image deployment, and upgrades use flyctl; the other steps are done in the Dashboard, with flyctl as the equivalent.

| Step | Dashboard | flyctl |
| --- | --- | --- |
| [1. Create the app](#1-create-the-app) | — | `fly apps create` |
| [2. Write fly.toml](#2-write-flytoml) | — | Local file |
| [3. Set secrets](#3-set-secrets) | **Secrets** | `fly secrets set` |
| [4. Deploy](#4-deploy) | — | `fly deploy` |
| [5. Allocate a dedicated IPv4](#5-allocate-a-dedicated-ipv4) | Networking section of **Overview** | `fly ips` |
| [6. Run setup](#6-run-setup) | **Search logs in Grafana** | `fly logs` |
| [Custom domains](#custom-domains) | **Certificates** | `fly certs add` |
| [Upgrade](#upgrade) | — | `fly deploy` |

## 1. Create the app

```bash
fly apps create edgeweir-console --org <organization>
```

App names are globally unique and set the default host name `<app name>.fly.dev`.

## 2. Write fly.toml

Create `fly.toml` in an empty directory. Adjust `app`, `primary_region`, the image tag, and the app name in the URLs.

```toml title="fly.toml"
app = "edgeweir-console"
primary_region = "nrt"

[build]
  image = "ghcr.io/marvinli001/edgeweir:20260929-a1b2c3d"

[env]
  EDGEWEIR_PUBLIC_URL = "https://edgeweir-console.fly.dev"
  EDGEWEIR_NODE_API_URL = "https://edgeweir-console.fly.dev:8443"

[http_service]
  internal_port = 3000
  force_https = true
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    grace_period = "30s"
    interval = "15s"
    timeout = "5s"
    method = "GET"
    path = "/healthz"

[[services]]
  internal_port = 8443
  protocol = "tcp"
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[services.ports]]
    port = 8443

  [[services.tcp_checks]]
    grace_period = "30s"
    interval = "15s"
    timeout = "2s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "1gb"
```

| Setting | Effect |
| --- | --- |
| `[build] image` | Deploys this image; no build |
| `[http_service]`: `internal_port = 3000`, `force_https = true` | 80 redirects to HTTPS; Fly Proxy terminates TLS on 443 and forwards to 3000 |
| `auto_stop_machines = "off"`, `min_machines_running = 1` | Fly Proxy does not stop an idle Machine |
| `[[http_service.checks]]` | `GET /healthz` directly on the Machine over the private network; must return 2xx |
| `[[services]]`: `internal_port = 8443`; `[[services.ports]]`: `port = 8443`, no `handlers` | Fly Proxy forwards TCP as is |
| `[[services.tcp_checks]]` | Checks that 8443 accepts connections |
| `[[vm]]` | The console sets no minimum size; the example uses `shared-cpu-1x`, 1 GB |

## 3. Set secrets

1. Generate the master key locally:

   ```bash
   umask 077
   openssl rand -base64 32 > edgeweir-master-key
   ```

2. Dashboard → `edgeweir-console` → **Secrets**, add:

   | Secret | Value |
   | --- | --- |
   | `EDGEWEIR_MASTER_KEY` | Contents of `edgeweir-master-key`, as is |
   | `DATABASE_URL` | `postgres://edgeweir:<password>@<host>:5432/edgeweir` |

3. Keep them staged; do not click **Deploy Secrets**. The secrets take effect with the deployment in step 4.

flyctl:

```bash
fly secrets set --stage \
  EDGEWEIR_MASTER_KEY="$(cat edgeweir-master-key)" \
  DATABASE_URL='postgres://edgeweir:<password>@<host>:5432/edgeweir'
```

Fly.io does not reveal secret values; store `edgeweir-master-key` offline, apart from database backups; see [Backup and recovery](backup.en.md).

## 4. Deploy

In the directory that holds `fly.toml`:

```bash
fly deploy --ha=false
```

`--ha=false` creates a single Machine. The first deployment assigns the app a dedicated IPv6 and a shared IPv4.

## 5. Allocate a dedicated IPv4

1. Dashboard → `edgeweir-console` → Networking section of **Overview**, assign a **Dedicated IPv4**.
2. In the same section, remove the **Shared IPv4**.

`edgeweir-console.fly.dev` then resolves to the dedicated addresses.

flyctl:

```bash
fly ips allocate-v4 --yes
fly ips list
fly ips release <shared IPv4>
```

## 6. Run setup

An uninitialized console logs the same setup token on every start.

1. Dashboard → `edgeweir-console` → **Logs & Errors** → **Search logs in Grafana**, query `"first-run setup"`. Logs are kept for 7 days.
2. The line's `setupToken` field is the setup token; its `url` field is the setup wizard address (`<EDGEWEIR_PUBLIC_URL>/setup`).
3. Open the wizard and enter the setup token; see [Quick start](../guide/first-site.en.md#1-complete-the-setup-wizard).

flyctl:

```bash
fly logs --no-tail | grep setupToken
```

`fly logs --no-tail` returns only recent logs; if the line is missing, run `fly apps restart edgeweir-console` and read it again.

## Variables

| Variable | Where | Value | Notes |
| --- | --- | --- | --- |
| `DATABASE_URL` | Secret | PostgreSQL 18 connection string | Required. |
| `EDGEWEIR_MASTER_KEY` | Secret | Output of `openssl rand -base64 32` | Required. |
| `EDGEWEIR_PUBLIC_URL` | `[env]` | `https://edgeweir-console.fly.dev` | With a custom domain, use that domain. |
| `EDGEWEIR_NODE_API_URL` | `[env]` | `https://edgeweir-console.fly.dev:8443` | The host name must resolve to the dedicated IPv4 and IPv6; it is added to the node channel certificate automatically. |
| `EDGEWEIR_NODE_API_HOSTNAMES` | `[env]` | Empty | Extra names for the node channel certificate, comma separated. |
| `EDGEWEIR_TRUSTED_PROXIES` | — | Empty | See [Limits](#limits). |
| `EDGEWEIR_VERSION` | — | Not set | The running version built into the image; the tag in `[build] image` sets the version. |
| `BETTER_AUTH_SECRET` | Secret | Not set | Keep the existing value when migrating a deployment that set it. |

A secret takes precedence over an `[env]` entry with the same name. `ROLE`, `HOST`, `PORT`, and `NODE_API_PORT` keep the image defaults `all`, `0.0.0.0`, `3000`, and `8443`, which match `internal_port`. All variables: [Environment variables](../reference/environment.en.md).

## Verification

| Check | Dashboard or command | Expected |
| --- | --- | --- |
| Machine | **Machines**; `fly status` | 1 Machine, state `started`, all checks passing |
| Public addresses | Networking section of **Overview**; `fly ips list` | Dedicated IPv4 and IPv6, no shared IPv4 |
| Web and API | `curl -fsS https://edgeweir-console.fly.dev/healthz` | `{"status":"ok","version":"20260929-a1b2c3d"}` |
| Node channel TLS | `openssl` command below | Issuer `Edgeweir Node Channel CA`; SAN includes `edgeweir-console.fly.dev` |
| Node channel URL | **System**, "Node channel" | `https://edgeweir-console.fly.dev:8443` |
| Node enrollment | **Clusters & nodes** → **Add node** → **Generate command** | `--server` is `https://edgeweir-console.fly.dev:8443`; running it on a node: [Adding nodes](nodes.en.md) |

```bash
openssl s_client -connect edgeweir-console.fly.dev:8443 -servername edgeweir-console.fly.dev </dev/null 2>/dev/null \
  | openssl x509 -noout -text | grep -E 'Issuer:|Subject:|DNS:'
```

Expected:

```text
        Issuer: CN=Edgeweir Node Channel CA, O=Edgeweir
        Subject: CN=edgeweir-node-api, O=Edgeweir
                DNS:localhost, IP Address:127.0.0.1, IP Address:0:0:0:0:0:0:0:1, DNS:<Machine host name>, DNS:edgeweir-console.fly.dev
```

Any other issuer means a device in the path terminates TLS.

## Custom domains

Complete this before enrolling nodes.

1. Dashboard → `edgeweir-console` → **Certificates**, add `console.example.com`; create the `A` (dedicated IPv4) and `AAAA` records shown there in DNS. flyctl: `fly certs add console.example.com`.
2. Change `[env]` in `fly.toml`:

   ```toml title="fly.toml"
   [env]
     EDGEWEIR_PUBLIC_URL = "https://console.example.com"
     EDGEWEIR_NODE_API_URL = "https://console.example.com:8443"
   ```

3. Deploy:

   ```bash
   fly deploy
   ```

4. Verify: run the `curl` and `openssl` commands from [Verification](#verification) against `console.example.com`.

Changing the node channel address for enrolled nodes: [Node channel URL and certificate](networking.en.md#node-channel-url-and-certificate).

## Upgrade

1. Back up the database; see [Backup and recovery](backup.en.md).
2. Change `[build] image` in `fly.toml` to the new tag.
3. Deploy:

   ```bash
   fly deploy
   ```

4. Verify:

   ```bash
   curl -fsS https://edgeweir-console.fly.dev/healthz
   ```

   Expected: `version` is the new tag.

Migrations, signature verification, and rollback: [Versions, upgrades, and rollback](upgrade.en.md).

## Limits

| Item | Behavior | Effect |
| --- | --- | --- |
| Client IP | Fly Proxy passes the client address in `Fly-Client-IP` and `X-Forwarded-For`; the source range Fly Proxy connects to the Machine from is not published; the console does not read `Fly-Client-IP` | Leave `EDGEWEIR_TRUSTED_PROXIES` empty; audit log IPs and sign-in rate limiting use the Fly Proxy address; see [Trusted proxies and client IP](networking.en.md#trusted-proxies-and-client-ip) |
| Shared IPv4 | Forwards only 80, 443, and ports with the `tls` handler | Nodes connecting to 8443 over IPv4 need a dedicated IPv4 |
| No dedicated IPv4 | 8443 is reachable only over the dedicated IPv6 | Nodes without IPv6 cannot connect |
| Deployment strategy | Default `rolling`: each old Machine is stopped and replaced in turn | With one Machine, the web console and the node channel are down during a deployment; conditions for several instances: [Deployment overview](README.en.md#scaling) |
| Auto stop | With `auto_stop_machines` set to `stop` or `suspend`, Fly Proxy stops idle Machines | Must be `off`: a stopped Machine halts the worker's scheduled jobs and the node channel |
| Configuration source | Machine size and HTTP service settings changed in the Dashboard or with `fly scale vm` / `fly scale memory` are reset to `fly.toml` on the next `fly deploy` | Change them in `fly.toml` |
| Secrets | Values cannot be read back | Keep the master key outside Fly.io |
| `/downloads/*` | No downloads mirror directory in the container; `EDGEWEIR_DOWNLOADS_DIR` unset | Returns 404; `install.sh` downloads from GitHub; see [Adding nodes](nodes.en.md#downloads-mirror) |
