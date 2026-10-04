# Ports, reverse proxy, and trusted proxies

Configure console ports, reverse proxies, node channel passthrough, and client IP resolution.

## Ports

| Port | Protocol | Serves | Exposure | Constraint |
| --- | --- | --- | --- | --- |
| 3000/TCP | HTTP | Web UI, `/rpc`, `/api/v1`, `/healthz`, `/install.sh`, `/downloads/*`; the node channel's WebSocket entry `/node-channel` | Reverse proxy (may terminate TLS), or direct | Nodes download `/install.sh` and `/downloads/*` from `EDGEWEIR_PUBLIC_URL` during installation; node hosts must reach that URL. `/node-channel` is closed by default; see [The node channel's WebSocket entry](#the-node-channels-websocket-entry). |
| 8443/TCP | TLS 1.2 or later, HTTP/2 or HTTP/1.1, Connect-RPC | Node channel (nodes and regional probes) | Direct, or layer-4 passthrough | 8443 needs layer-4 passthrough; a proxy that terminates TLS breaks the CA check and mTLS of nodes and probes. Where it cannot be opened to the internet, use the WebSocket entry. |
| 5432/TCP | PostgreSQL | Bundled database | Not published | Reachable only inside the Compose network. |
| 8123/TCP | HTTP | ClickHouse (`analytics` profile) | Not published | Reachable only inside the Compose network. |

## Listen and publish variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Web listen address of the process. |
| `PORT` | `3000` | Web listen port of the process. |
| `NODE_API_HOST` | Empty, uses `HOST` | Node channel listen address of the process. |
| `NODE_API_PORT` | `8443` | Node channel listen port of the process. |
| `EDGEWEIR_HTTP_PORT` | `127.0.0.1:3000` (`compose.yml`) | Web port published by Compose, optionally with a bind address. |
| `EDGEWEIR_NODE_API_PORT` | `8443` | Node channel port published by Compose, optionally with a bind address. |
| `EDGEWEIR_NODE_API_HOST` | `0.0.0.0` | `compose.baota-host.yml` only: node channel listen address, used as `NODE_API_HOST`. |

Values per Compose file:

| Compose file | Process listens on | Host ports |
| --- | --- | --- |
| `compose.yml` | Image defaults `0.0.0.0:3000`, `0.0.0.0:8443` | Port mappings `${EDGEWEIR_HTTP_PORT}:3000` (default `127.0.0.1:3000`) and `${EDGEWEIR_NODE_API_PORT}:8443` (all interfaces by default) |
| `compose.baota.yml` | Image defaults | Port mappings `127.0.0.1:${EDGEWEIR_HTTP_PORT}:3000` (`EDGEWEIR_HTTP_PORT` is a number only), `${EDGEWEIR_NODE_API_PORT}:8443` |
| `compose.baota-host.yml` (host network) | `HOST=127.0.0.1`, `PORT=${EDGEWEIR_HTTP_PORT}`, `NODE_API_HOST=${EDGEWEIR_NODE_API_HOST}` (default `0.0.0.0`), `NODE_API_PORT=${EDGEWEIR_NODE_API_PORT}` | No port mappings; both port variables are numbers only |

The web port of `compose.yml` is reachable only locally by default, served by a reverse proxy on the host: ports Docker publishes bypass host firewalls such as ufw and firewalld. To reach it directly without a proxy, set `EDGEWEIR_HTTP_PORT=3000`.

## Node channel URL and certificate

The node channel URL is where nodes and region probes reach the node channel: `--server` in the install command. Change it in the "Node channel" card of **System settings**; saving applies at once, without restarting the console. Precedence:

| Order | Source | Mark in the card |
| --- | --- | --- |
| 1 | The URL saved in **System settings** | Saved |
| 2 | `EDGEWEIR_NODE_API_URL` | Environment |
| 3 | `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>`; with `EDGEWEIR_NODE_API_WEBSOCKET=true`, `wss://<host[:port] of EDGEWEIR_PUBLIC_URL>` (`ws://` when `EDGEWEIR_PUBLIC_URL` is plain HTTP) | Default |

Saving an empty field returns to 2 and 3. The format is `https://host[:port]` (the node channel port), or `wss://host[:port]` or `ws://host[:port]` (the [WebSocket entry](#the-node-channels-websocket-entry) on the web port), without a path, query, or credentials; without a port it is 443 (80 for `ws://`).

| Variable | Default | Purpose |
| --- | --- | --- |
| `EDGEWEIR_NODE_API_URL` | `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>` | The node channel URL while none is saved in **System settings**. |
| `EDGEWEIR_NODE_API_WEBSOCKET` | `false` | `true`: the default URL becomes the WebSocket entry, `wss://<host[:port] of EDGEWEIR_PUBLIC_URL>`, and the entry is always open. |
| `EDGEWEIR_NODE_API_HOSTNAMES` | Empty | Extra names for the node channel certificate: DNS names or IPs, comma separated. |

- The internal CA issues the node channel server certificate. Its names: `localhost`, `127.0.0.1`, `::1`, the container host name, the host of `EDGEWEIR_NODE_API_URL` (of the default URL when unset), every entry of `EDGEWEIR_NODE_API_HOSTNAMES`, the host name or IP of the URL saved in **System settings**, and those of node channel URLs in effect before it (the latest 32).
- Once a URL is saved in **System settings**, every console instance reissues the certificate for the new name at once: new handshakes get the new certificate, established connections keep theirs. Changes to the variables apply after a restart.
- Enrolled nodes and probes keep the `server_url` and TLS server name recorded at enrollment (`/var/lib/edgeweir-node/identity.json`); changing the URL does not move them. Keep the old address reachable (its name stays in the certificate), or enroll them again.
- The CA fingerprint (SHA-256) appears as `caSha256` in the `node channel listening` startup log, as "CA fingerprint" in **System settings**, and as `--ca-sha256` in the install command.

| Case | Setting |
| --- | --- |
| The published host port is not 8443, e.g. `EDGEWEIR_NODE_API_PORT=9443` | Enter `https://<host>:9443` in **System settings**, or set `EDGEWEIR_NODE_API_URL`: the default uses the process listen port `NODE_API_PORT`, not the published port. |
| The node channel's public address exists only after deployment (an Anycast IP or TCP proxy added later on the platform) | Enter it in **System settings** once it works, then generate install commands. |
| The platform forwards HTTP only (Render), or 8443 cannot be opened to the internet | Use the [WebSocket entry](#the-node-channels-websocket-entry). |
| Nodes connect through another name or IP (private address, load balancer name) | Add that name to `EDGEWEIR_NODE_API_HOSTNAMES`. |
| The node channel's DNS name is on Cloudflare | Turn the proxy off for that record (DNS only): Cloudflare proxies HTTPS on port 8443 too, terminates TLS, and nodes report `CA pin mismatch`. |
| The node channel URL changes | Change it in **System settings**; enrolled nodes keep connecting to the old address, which must stay reachable. |
| The host name of `EDGEWEIR_NODE_API_URL` changes (no URL saved in System settings) | Keep the old host name in `EDGEWEIR_NODE_API_HOSTNAMES`: enrolled nodes verify the certificate against the name recorded at enrollment. |

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
   | `compose.baota-host.yml` | `.env`: `EDGEWEIR_NODE_API_HOST=127.0.0.1`, `EDGEWEIR_NODE_API_PORT=18443`; not in `compose.override.yml`, which BaoTa / aaPanel skip when they run the project with `docker compose -f`, see [baota.en.md](baota.en.md#node-channel-port) |

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

   Leave out `ssl`, `proxy_ssl`, and `proxy_protocol`: the server forwards TCP only. `listen 8443;` listens on IPv4 only; add `listen [::]:8443;` when the node channel's DNS name has an AAAA record. When the main configuration already has a `stream` block (BaoTa / aaPanel: see [baota.en.md](baota.en.md#node-channel-port)), put the `server` into it; when the distribution builds stream as a dynamic module (such as Debian's `libnginx-mod-stream`), install and load that module first.

3. Test and reload nginx:

   ```bash
   nginx -t && nginx -s reload
   ```

4. Verify:

   ```bash
   openssl s_client -connect cdn-admin.example.com:8443 -servername cdn-admin.example.com </dev/null 2>/dev/null \
     | openssl x509 -noout -issuer
   ```

   Expected: the issuer contains `Edgeweir Node Channel CA`. Any other issuer means a device in between terminates TLS. The connection check in the "Node channel" card of **System settings** does the same from the console's network against the node channel URL; see [Node channel connection check](nodes.en.md#node-channel-connection-check).

## The node channel's WebSocket entry

When the platform forwards HTTP only (for example Render), or 8443 cannot be opened to the internet, nodes reach the node channel through the WebSocket entry on the web port.

| Item | Details |
| --- | --- |
| URL | The node channel URL is `wss://<host>[:port]`, or `ws://` when the web port is reached over HTTP; usually the host and port of `EDGEWEIR_PUBLIC_URL`. Nodes connect to `<URL>/node-channel` with the WebSocket subprotocol `edgeweir-node-channel` |
| TLS | The node channel's TLS runs inside the WebSocket and is terminated by the console; CA pinning and mTLS are the same as on 8443, and proxies or CDNs only forward TLS records. Nodes and `install.sh` verify the certificate of a `wss://` URL itself against the system roots: it must come from a public CA |
| When it is open | `EDGEWEIR_NODE_API_WEBSOCKET=true`; or the node channel URL in effect is a `wss://` or `ws://` one; or, when a URL was saved in **System settings**, the URL in effect before or the one saved was such a URL (nodes enrolled through the entry keep connecting after the URL changes). Otherwise it answers 404 |
| Refused | Requests with an `Origin` header (browsers) get 403; requests without the subprotocol `edgeweir-node-channel` get 400 |
| Plain requests | `GET /node-channel` answers 426 while the entry is open and 404 while it is closed; `install.sh` takes 426 as reachable |
| Source address | The "connection source address" of a node is the client address of the WebSocket request, resolved as in [Trusted proxies and client IP](#trusted-proxies-and-client-ip) |
| Node version | edgeweir-node 0.2.0 or later; `install.sh` refuses to enroll an earlier version through a `wss://` or `ws://` URL |

1. Set the node channel URL, either way:
   - In the "Node channel" card of **System settings**, enter `wss://cdn-admin.example.com` and save; it applies at once.
   - Set `EDGEWEIR_NODE_API_WEBSOCKET=true` and restart the console: without `EDGEWEIR_NODE_API_URL` and without a URL saved in **System settings**, the default URL is `wss://<host[:port] of EDGEWEIR_PUBLIC_URL>`.
2. With a reverse proxy in front of the console, forward the WebSocket upgrade of `/node-channel`. nginx:

   ```nginx title="nginx"
   location = /node-channel {
     proxy_pass http://127.0.0.1:3000;
     proxy_http_version 1.1;
     proxy_set_header Host $host;
     proxy_set_header Upgrade $http_upgrade;
     proxy_set_header Connection "upgrade";
     proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
     proxy_read_timeout 1h;   # long-lived node channel connections (WatchConfig streams)
     proxy_send_timeout 1h;
   }
   ```

3. Verify:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://cdn-admin.example.com/node-channel
   ```

   Expected: `426`. The connection check in the "Node channel" card of **System settings** completes the TLS handshake through the WebSocket and shows "Reachable".

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
| 3000 is reachable from the internet | `EDGEWEIR_HTTP_PORT` without a bind address (e.g. `3000`), or an older `compose.yml` that published it on all interfaces | Set `EDGEWEIR_HTTP_PORT=127.0.0.1:3000`, or update `compose.yml`. |
| `install.sh`: `answers 404: the console's WebSocket entry is closed` | The node channel URL is a `wss://` or `ws://` one, but the console's entry is not open, or the URL points at another service | Save the URL in **System settings**, or set `EDGEWEIR_NODE_API_WEBSOCKET=true`; see [The node channel's WebSocket entry](#the-node-channels-websocket-entry). |
| `install.sh`: `cannot reach the node channel WebSocket entry` | The node host cannot reach the web port, the system roots do not trust the certificate of the `wss://` URL, or a reverse proxy does not forward `/node-channel` | Run `curl -v https://<host>/node-channel` on the node; configure the reverse proxy as above. |
| Node enrollment or connection fails | — | See [adding nodes: troubleshooting](nodes.en.md#troubleshooting). |
