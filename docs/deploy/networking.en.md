# Ports, reverse proxy, and trusted proxies

Configure console ports, reverse proxies, node channel passthrough, and client IP resolution.

## Ports

| Port | Protocol | Serves | Exposure | Constraint |
| --- | --- | --- | --- | --- |
| 3000/TCP | HTTP | Web UI, `/rpc`, `/api/v1`, `/healthz`, `/install.sh`, `/downloads/*` | Reverse proxy (may terminate TLS), or direct | Nodes download `/install.sh` and `/downloads/*` from `EDGEWEIR_PUBLIC_URL` during installation; node hosts must reach that URL. |
| 8443/TCP | TLS 1.2 or later, HTTP/2 or HTTP/1.1, Connect-RPC | Node channel | Direct, or layer-4 passthrough | 8443 needs layer-4 passthrough; a proxy that terminates TLS breaks the node CA check and mTLS. |
| 5432/TCP | PostgreSQL | Bundled database | Not published | Reachable only inside the Compose network. |
| 8123/TCP | HTTP | ClickHouse (`analytics` profile) | Not published | Reachable only inside the Compose network. |

## Listen and publish variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Web listen address of the process. |
| `PORT` | `3000` | Web listen port of the process. |
| `NODE_API_HOST` | Empty, uses `HOST` | Node channel listen address of the process. |
| `NODE_API_PORT` | `8443` | Node channel listen port of the process. |
| `EDGEWEIR_HTTP_PORT` | `3000` | Web port published by Compose, optionally with a bind address such as `127.0.0.1:3000`. |
| `EDGEWEIR_NODE_API_PORT` | `8443` | Node channel port published by Compose, optionally with a bind address. |

Values per Compose file:

| Compose file | Process listens on | Host ports |
| --- | --- | --- |
| `compose.yml` | Image defaults `0.0.0.0:3000`, `0.0.0.0:8443` | Port mappings `${EDGEWEIR_HTTP_PORT}:3000`, `${EDGEWEIR_NODE_API_PORT}:8443`, on all interfaces by default |
| `compose.baota.yml` | Image defaults | Port mappings `127.0.0.1:${EDGEWEIR_HTTP_PORT}:3000` (`EDGEWEIR_HTTP_PORT` is a number only), `${EDGEWEIR_NODE_API_PORT}:8443` |
| `compose.baota-host.yml` (host network) | `HOST=127.0.0.1`, `PORT=${EDGEWEIR_HTTP_PORT}`, `NODE_API_HOST=0.0.0.0`, `NODE_API_PORT=${EDGEWEIR_NODE_API_PORT}` | No port mappings; both port variables are numbers only |

With `compose.yml` behind a reverse proxy on the host, set `EDGEWEIR_HTTP_PORT=127.0.0.1:3000` so that 3000 is reachable only locally.

## Node channel URL and certificate

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGEWEIR_NODE_API_URL` | `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>` | URL nodes use for the node channel; `--server` in the install command; "Node channel" in **System**. |
| `EDGEWEIR_NODE_API_HOSTNAMES` | Empty | Extra names for the node channel certificate: DNS names or IPs, comma separated. |

- The internal CA issues the node channel server certificate at every start. Its names: `localhost`, `127.0.0.1`, `::1`, the container host name, the host of `EDGEWEIR_NODE_API_URL`, and every entry of `EDGEWEIR_NODE_API_HOSTNAMES`. Changes apply after a restart.
- The CA fingerprint (SHA-256) appears as `caSha256` in the `node channel listening` startup log, as "CA fingerprint" in **System**, and as `--ca-sha256` in the install command.

| Case | Setting |
| --- | --- |
| The published host port is not 8443, e.g. `EDGEWEIR_NODE_API_PORT=9443` | Set `EDGEWEIR_NODE_API_URL=https://<host>:9443` explicitly: the default uses the process listen port `NODE_API_PORT`, not the published port. |
| Nodes connect through another name or IP (private address, load balancer name) | Add that name to `EDGEWEIR_NODE_API_HOSTNAMES`. |
| The host name of `EDGEWEIR_NODE_API_URL` changes | Keep the old host name in `EDGEWEIR_NODE_API_HOSTNAMES`: enrolled nodes verify the certificate against the `server_url` and TLS server name recorded at enrollment (`/var/lib/edgeweir-node/identity.json`). |

## Reverse proxy for the web console

```nginx title="nginx"
server {
  listen 443 ssl;
  server_name cdn-admin.example.com;
  # ssl_certificate     ...;
  # ssl_certificate_key ...;
  location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
  }
}
```

| Item | Requirement |
| --- | --- |
| `EDGEWEIR_PUBLIC_URL` | The URL the proxy serves, e.g. `https://cdn-admin.example.com`. Sign-in checks the request origin against it; with `https`, session cookies carry `Secure`. |
| `EDGEWEIR_TRUSTED_PROXIES` | The source address the proxy uses to reach the console; see [trusted proxies and client IP](#trusted-proxies-and-client-ip). |
| Forwarding headers | The console reads only `X-Forwarded-For` and `X-Real-IP`, and only when the TCP peer is trusted. |

## Node channel passthrough

Use nginx `stream` layer-4 passthrough when 8443 must go through nginx.

1. Move the node channel to local port 18443:

   | Deployment | Setting |
   | --- | --- |
   | `compose.yml`, `compose.baota.yml` | `.env`: `EDGEWEIR_NODE_API_PORT=127.0.0.1:18443` |
   | Process listening directly (`pnpm dev`, outside a container) | `NODE_API_HOST=127.0.0.1`, `NODE_API_PORT=18443` |
   | `compose.baota-host.yml` | See [baota.en.md](baota.en.md): the file fixes `NODE_API_HOST: 0.0.0.0` |

   `EDGEWEIR_NODE_API_URL` keeps the public `:8443`.

   ```bash
   docker compose up -d
   ```

2. Add outside the `http { }` block of the main nginx configuration:

   ```nginx title="nginx"
   stream {
     server {
       listen 8443;
       proxy_pass 127.0.0.1:18443;
       proxy_timeout 1h;   # long-lived node channel connections (WatchConfig stream)
     }
   }
   ```

   Leave out `ssl`, `proxy_ssl`, and `proxy_protocol`: the server forwards TCP only.

3. Test and reload nginx:

   ```bash
   nginx -t && nginx -s reload
   ```

4. Verify:

   ```bash
   openssl s_client -connect cdn-admin.example.com:8443 -servername cdn-admin.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -issuer
   ```

   Expected: the issuer contains `Edgeweir Node Channel CA`. Any other issuer means a device in between terminates TLS.

## Trusted proxies and client IP

Audit entries and sign-in rate limiting use the client IP the console resolves.

| Condition | Client IP |
| --- | --- |
| `EDGEWEIR_TRUSTED_PROXIES` empty (default) | TCP peer address; all forwarding headers are ignored. |
| TCP peer not in the list | TCP peer address; all forwarding headers are ignored. |
| TCP peer in the list, request has `X-Forwarded-For` | Walked from the right, skipping listed addresses; the first unlisted address. |
| TCP peer in the list, no `X-Forwarded-For` | `X-Real-IP`; the TCP peer address when absent. |

- Format: IPs or CIDR ranges, comma separated, e.g. `172.18.0.1` or `10.0.0.0/24`. IPv4-mapped IPv6 addresses (`::ffff:192.0.2.1`) count as IPv4.
- The console refuses to start on an entry it cannot parse: `EDGEWEIR_TRUSTED_PROXIES: not an IP address or CIDR range: <entry>`.
- Sign-in rate-limit counters live in PostgreSQL, are shared by all instances, and survive restarts.

| Deployment | Proxy source address seen by the console | `EDGEWEIR_TRUSTED_PROXIES` |
| --- | --- | --- |
| No reverse proxy | — | Empty |
| Host nginx → `127.0.0.1:3000` published by `compose.yml` / `compose.baota.yml` | Gateway of the Docker network `edgeweir_default` | That gateway address |
| Host nginx → `compose.baota-host.yml` (host network) | `127.0.0.1` or `::1` | `127.0.0.1,::1` (the file's default) |

Look up the gateway:

```bash
docker network inspect edgeweir_default --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'
```

> [!WARNING]
> List only the addresses the proxy actually uses. A listed address can claim any client IP; trusting a whole private range, or a network clients can enter, defeats rate limiting and audit IPs.

Verify: sign in once through the proxy and query the latest audit entries:

```bash
docker compose exec -T postgres psql -U edgeweir -d edgeweir \
  -c "select occurred_at, action, ip from audit_log order by id desc limit 5"
```

Expected: `ip` is the browser's public address, not the gateway.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Every audit `ip` is the gateway address (e.g. `172.18.0.1`) | `EDGEWEIR_TRUSTED_PROXIES` unset, or different from the actual gateway (recreating the Compose network may change it) | Look up the gateway, update `EDGEWEIR_TRUSTED_PROXIES`, run `docker compose up -d`. |
| Startup fails: `EDGEWEIR_TRUSTED_PROXIES: not an IP address or CIDR range` | An entry is neither an IP nor a CIDR range | Fix the entry. |
| 3000 is reachable from the internet | `compose.yml` publishes 3000 on all interfaces by default | Set `EDGEWEIR_HTTP_PORT=127.0.0.1:3000`. |
| Node enrollment or connection fails | — | See [adding nodes: troubleshooting](nodes.en.md#troubleshooting). |
