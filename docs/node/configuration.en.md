# Node configuration

Environment variables and flags of the node service: paths, network, shared memory, GeoIP, kernel bans, image conversion, logs, resource limits and old workers.

The console sends sites, cache, rules and the rest of the configuration; the flags below are set on the node only and the console cannot change them. Upgrade flags: [Node upgrades](../guide/node-upgrades.en.md#private-mirrors-and-own-releases).

## Setting values

| Method | Where | Takes effect |
| --- | --- | --- |
| Environment file (deb, rpm, tar.gz) | `/etc/default/edgeweir-node`, one `EDGEWEIR_<FLAG>=<value>` per line; the file the packages install is all comments, and package upgrades keep local edits | `sudo systemctl restart edgeweir-node` |
| systemd drop-in | `/etc/systemd/system/edgeweir-node.service.d/<name>.conf` | `sudo systemctl daemon-reload && sudo systemctl restart edgeweir-node` |
| Container | `docker run -e EDGEWEIR_<FLAG>=<value>`, or `environment` in Compose | Recreate the container |
| Command line | `edgeweir-node supervise --manage-nginx --<flag> <value>` | Wins over environment variables |

| Rule | Detail |
| --- | --- |
| Variable names | `EDGEWEIR_` plus the flag name in upper case with `-` as `_`: `--stream-shutdown-timeout` → `EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT` |
| Booleans | `true`, `false` |
| Durations | Go duration format: `500ms`, `30s`, `10m`, `2h` |
| Paths | Absolute, without spaces or special characters |
| Validation | Every flag is checked at startup; an invalid value ends the process with exit status 2 and systemd does not restart it (`RestartPreventExitStatus=2`); the reason is in `journalctl -u edgeweir-node -n 20` |
| Unit presets | The systemd unit sets `EDGEWEIR_NGINX_BIN=/usr/lib/edgeweir-openresty/nginx/sbin/nginx` and `EDGEWEIR_LUA_DIR=/usr/share/edgeweir-node/lua`; the same variables in the environment file override them |
| Image presets | `EDGEWEIR_STATE_DIR`, `EDGEWEIR_NGINX_BIN`, `EDGEWEIR_LUA_DIR`, `EDGEWEIR_CACHE_DIR`, `EDGEWEIR_CONTROL_SOCKET`, `EDGEWEIR_ORIGIN_SOCKET` are set to the default paths |

Example:

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_LOG_FORMAT=json
EDGEWEIR_RESOLVER=1.1.1.1,8.8.8.8
EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m
```

## Flags

`supervise` and `run` take the same flags.

### Paths and processes

| Flag | Default | Description |
| --- | --- | --- |
| `--state-dir` | `/var/lib/edgeweir-node` | State directory: identity, LKG configuration, key material |
| `--cache-dir` | `/var/cache/edgeweir-node` | Parent directory of the cache zones |
| `--manage-nginx` | `false` | The node runs OpenResty; required for `supervise` |
| `--nginx-bin` | `/usr/lib/edgeweir-openresty/nginx/sbin/nginx` (when present), otherwise `openresty` from `PATH` | OpenResty binary |
| `--nginx-prefix` | `<state-dir>/nginx` | nginx prefix directory |
| `--nginx-user` | empty | User of the nginx workers when the agent runs as root; not needed with the systemd unit or the image, which do not run as root |
| `--lua-dir` | `/usr/share/edgeweir-node/lua` | Directory containing `edgeweir/*.lua` |
| `--worker-processes` | `auto` | nginx `worker_processes` |
| `--default-port` | `80` | HTTP port served before any configuration, 1–65535 |
| `--control-socket` | `/run/edgeweir-node/control.sock` | Data plane control API |
| `--diag-socket` | `/run/edgeweir-node/diag.sock` | Diagnostics socket (0600); empty turns it off, and the agent and configuration checks of `diagnose` then fail |
| `--origin-socket` | `/run/edgeweir-node/origin.sock` | Internal origin layer; the HTTP/2 and gRPC origin layers are in the same directory |
| `--origin-socket-noverify` | `origin-noverify.sock` next to the origin socket | Origin layer without certificate verification |
| `--edge-socket` | `edge.sock` next to the control socket | Local edge listener for prefetching |
| `--l4-socket` | `l4.sock` next to the control socket | Control relay of the stream subsystem |

### Network and resolution

| Flag | Default | Description |
| --- | --- | --- |
| `--listen-ipv6` | `auto` | Listen on IPv6: `auto` (when the host can bind IPv6), `on`, `off` |
| `--resolver-ipv6` | `auto` | Resolve AAAA records of origins: `auto` (when the host has a global IPv6 address), `on`, `off` |
| `--resolv-conf` | `/etc/resolv.conf` | Source of the nginx resolvers |
| `--resolver` | empty | Comma-separated resolver addresses; `--resolv-conf` is not read when set |
| `--trusted-ca` | the system CA file | CA file for HTTPS origin certificates (origin fetches and active health checks); the default is the first of `/etc/ssl/certs/ca-certificates.crt`, `/etc/pki/tls/certs/ca-bundle.crt`, `/etc/ssl/ca-bundle.pem`, `/etc/ssl/cert.pem` |

### Shared memory and capacity

Every `*-dict-mb` takes 1–65536 (MiB). A site table or layer-4 table that does not fit fails the apply, and the reason names the flag to raise.

| Flag | Default | Description |
| --- | --- | --- |
| `--sites-dict-mb` | `64` | Site table (`edgeweir_sites`): current and previous site tables, error page templates included |
| `--l4-dict-mb` | `32` | Layer-4 table (`edgeweir_l4`): current and previous, IP lists included |
| `--stats-dict-mb` | `16` | Statistics counters (`edgeweir_stats`), drained by the agent every minute |
| `--purge-dict-mb` | `32` | Purge markers (`edgeweir_purge`) |
| `--purge-markers-per-site` | `1000` | URL and prefix markers per site before they collapse into one site-wide marker |
| `--purge-tags-per-site` | `5000` | Tag markers per site before they collapse into one site-wide marker |
| `--tag-dict-mb` | `64` | Cache-Tag index (`edgeweir_tags`), LRU eviction when full |
| `--ban-capacity` | `100000` | Dynamic bans held, 1–10000000; the oldest automatic bans go first when full |
| `--ban-dict-mb` | `32` | Ban store (`edgeweir_bans`) |
| `--cc-dict-mb` | `32` | CC mitigation store (`edgeweir_cc`) |
| `--challenge-dict-mb` | `8` | Challenge store (`edgeweir_challenge`) |
| `--rate-limit-dict-kb` | `256` | Rate-limit counters of each published site (`edgeweir_rate_<hex site ID>`), 64–65536 KiB; new counts pass when full |

### Tasks and reporting

| Flag | Default | Description |
| --- | --- | --- |
| `--prefetch-budget` | `4m` | Time one pulled batch of prefetch tasks may take, above 0; the console hands unfinished tasks out again after 5 minutes |
| `--cache-usage-interval` | `10m` | How often the cache zones' disk usage is measured (a walk over the cache directory), at least `1s` |
| `--stats-interval` | `1m` | How often statistics are drained and uploaded, `1s`–`1m` |

### Security modules

| Flag | Default | Description |
| --- | --- | --- |
| `--kernel-bans` | `auto` | Write platform bans to nftables: `auto` (when `nft` runs and `CAP_NET_ADMIN` is held), `off`; see [Kernel bans](#kernel-bans) |
| `--nft-bin` | `nft` | nftables binary |
| `--modsecurity-module` | `auto` | ModSecurity dynamic module: `auto` (`modules/` of the edgeweir-openresty that `--nginx-bin` belongs to), a path, `off`; loaded only when a site enables the OWASP CRS |
| `--crs-dir` | `/usr/share/edgeweir-openresty/crs` | OWASP CRS directory (`crs-setup.conf`, `rules/`); must not be empty |

The node reports `modsecurity-v1` when the module and the CRS exist and a load test passes; without it, sites with the OWASP CRS cannot be served by that node.

### GeoIP

| Flag | Default | Description |
| --- | --- | --- |
| `--geoip-ipinfo` | `auto` | IPinfo Lite MMDB (countries, ASNs): `auto` (the image's bundled `/usr/share/edgeweir-node/geoip/ipinfo_lite.mmdb`, unused when absent), `off`, a path |
| `--geoip-city` | empty | City MMDB (subdivisions; also countries IPinfo does not have) |
| `--geoip-asn` | empty | ASN MMDB (ASNs IPinfo does not have) |

| Item | Detail |
| --- | --- |
| Bundled data | Only the container image bundles IPinfo Lite; the deb, rpm and tar.gz carry no GeoIP data, so point `--geoip-ipinfo` or `--geoip-city` / `--geoip-asn` at files when needed |
| Lookups | Done on the node; no download at run time, visitor addresses are not sent to third parties |
| Updates | Replace the file or pull a new image, then restart the node service |
| Capabilities | `geoip-city-v1` with country data, `geoip-asn-v1` with ASN data, `geoip-subdivision-v1` with a City MMDB; a configuration whose rules read GeoIP fields the node has no data for is refused, see [Node capabilities](../guide/node-upgrades.en.md#node-capabilities) |
| File access | Files must be readable by the `edgeweir` user; the systemd unit's file system is read-only except the state, cache and runtime directories, so keep the files under existing directories such as `/usr/share` or `/var/lib` |

### Image conversion

| Flag | Default | Description |
| --- | --- | --- |
| `--image-workers` | min(4, max(1, CPUs / 2)) | Concurrent WebP / AVIF conversions, 0–64; each is a child process on one CPU. `0` turns conversion off: the node does not report `image-convert-v1` and sites that convert cannot be served by it |
| `--image-memory-mb` | `1024` | Memory the running conversions may use together, 64–1048576 MiB; estimated from the pixels, the original is returned when it would not fit |
| `--image-timeout` | `8s` | Longest single conversion, `1s`–`5m`; the child is killed and the original returned |

### Logs

| Flag | Default | Description |
| --- | --- | --- |
| `--log-level` | `info` | `debug`, `info`, `warn`, `error`; written to standard error (the journal under systemd) |
| `--log-format` | `text` | `text`, `json` |
| `--debug-log-buffer` | `5000` | Recent log entries of every level kept in memory (at most 4 MiB), 0–100000; `0` turns it off and the node does not report `debug-logs-v1`, see [Debug logs](../guide/node-logs.en.md#debug-logs) |

### Upgrades (supervise)

| Flag | Default | Description |
| --- | --- | --- |
| `--cosign-bin` | `cosign` | Signature verifier |
| `--upgrade-source` | `https://github.com/marvinli001/edgeweir-node/releases/download` | Release source trusted by this node; upgrade tasks cannot change it |
| `--upgrade-public-key` | empty | Operator-provided release public key; when empty, the GitHub OIDC identity of the official release workflow is checked |
| `--upgrade-allow-http` | `false` | Allow a plaintext HTTP release source (local tests, air-gapped networks) |
| `--upgrade-allow-downgrade` | `false` | Let upgrade tasks install a version older than the running one |

### How long old workers stay

After a reload, old workers serve existing connections (layer-4 sessions, HTTP keep-alive, WebSocket) until they end by default; frequent structural changes leave several generations of old workers.

| `--stream-shutdown-timeout` | Behavior |
| --- | --- |
| `0` (default) | No limit; old workers exit after their last connection ends |
| A duration such as `30m` or `2h` | After that time the old workers close every connection they still serve (nginx `worker_shutdown_timeout`); layer-4, HTTP and WebSocket connections alike |

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m
```

Container nodes use `-e EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m`. Layer-4 details: [Reloads and long connections](../guide/l4.en.md#reloads-and-long-connections).

## Kernel bans

Platform bans are enforced at the HTTP layer (`403`) by default. With kernel bans, nftables (`table inet edgeweir`) drops inbound packets of banned addresses and the node reports `kernel-ban-v1`, see [Bans](../guide/bans.en.md).

| Deployment | Steps |
| --- | --- |
| systemd | Install `nftables` (recommended by the deb and rpm); create the drop-in below; `sudo systemctl daemon-reload && sudo systemctl restart edgeweir-node`; the log line `kernel bans active: nftables table inet edgeweir` confirms it |
| Container | Build the image with `docker build --build-arg NFT_CAPABILITY=true` (adds `cap_net_admin+ep` to `/usr/sbin/nft`) and start the container with `--cap-add NET_ADMIN` (Compose: `cap_add: [NET_ADMIN]`); the published image does not carry the file capability |

```ini title="/etc/systemd/system/edgeweir-node.service.d/kernel-ban.conf"
[Service]
AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
```

| Item | Detail |
| --- | --- |
| Matching | By the TCP connection's source address; behind a PROXY protocol load balancer or a layer-7 proxy only their addresses are seen, see [Load balancers in front of nodes](../guide/bans.en.md#load-balancers-in-front-of-the-nodes) |
| Outbound | Every inbound packet of a banned address is dropped, so the node cannot connect to it either (for example when it is an origin) |
| Layer-4 applications | Dynamic bans reach layer-4 applications only through the kernel |
| Failure | Without a working `nft` or the capability, bans fall back to the HTTP layer |

## Resources and kernel parameters

| Item | Value |
| --- | --- |
| Open files | Unit `LimitNOFILE=1048576`; the node raises its soft limit to the hard limit and sets `worker_rlimit_nofile` to the hard limit (at most 1048576) |
| `worker_connections` | 4096; half the hard limit (at least 256) when the hard limit is below 8192; raised with the number of listening sockets for port ranges |
| Privileged ports | The unit grants only `CAP_NET_BIND_SERVICE` (inherited by OpenResty); the nginx master binds 80, 443 and extra ports below 1024; the container runs as uid 10001 and binds inside its network namespace |
| Kernel parameters | The node changes no sysctl |
| Memory | The shared memory above, plus `--rate-limit-dict-kb` per published site, plus `--image-memory-mb` for image conversion |
| Disk | Cache zone sizes are set in the console (per cluster or per node), see [Cache zones](../guide/origins-and-cache.en.md#cache-zone); spool files in the state directory have their own limits |
| CPU | `worker_processes auto` runs one worker per CPU; sites with the OWASP CRS cost about 0.5 ms of CPU more per request |
| systemd hardening | `ProtectSystem=strict`, `NoNewPrivileges=yes`, `PrivateTmp=yes`, `RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK`, `SystemCallFilter=@system-service`; `MemoryDenyWriteExecute` is not set (LuaJIT needs it off) |
