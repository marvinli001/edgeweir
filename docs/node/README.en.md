# Node overview

Edge node components, processes, console communication, how configuration takes effect, ports, file layout and versioning.

A node is the Go agent `edgeweir-node` plus an OpenResty data plane; it receives configuration from the console over mTLS and serves visitor traffic. Installation and enrollment: [Adding nodes](../deploy/nodes.en.md); parameters: [Node configuration](configuration.en.md).

## Components

| Component | Delivered as | Role |
| --- | --- | --- |
| Agent | `edgeweir-node` (static binary): `/usr/bin/edgeweir-node` from the packages, `/usr/local/bin/edgeweir-node` in the image | Enrollment, mTLS channel, configuration validation and apply, tasks (purge, prefetch, upgrade, debug logs), heartbeats and statistics, ban sync, active health checks, OCSP |
| Supervisor | The same binary in `supervise --manage-nginx` mode; entry point of the systemd unit and the image | Runs the agent and OpenResty; signed upgrades, trial runs and rollback, see [Node upgrades](../guide/node-upgrades.en.md) |
| OpenResty | Package `edgeweir-openresty` 1.31.1.1-3: `/usr/lib/edgeweir-openresty/` (HTTP/2, HTTP/3, Brotli, Zstandard) | Data plane: routing, cache, origin fetches, rules, WAF, challenges, layer-4 forwarding (stream) |
| Lua modules | `/usr/share/edgeweir-node/lua/edgeweir/` | Data plane logic; receives the site table the agent pushes over a local unix socket |
| ModSecurity and OWASP CRS | Package `edgeweir-openresty-modsecurity` (optional): module in `/usr/lib/edgeweir-openresty/modules/`, CRS 4.29.0 in `/usr/share/edgeweir-openresty/crs/` | Loaded only when a site enables the [OWASP CRS](../guide/waf.en.md) |
| cosign | The host's `cosign`, or v3.1.3 installed by `install.sh` (`/usr/local/bin/cosign`); bundled in the image | Verifies `checksums.txt` for signed upgrades |
| Image conversion | Internal child process of `edgeweir-node` | WebP / AVIF conversion, see [Image format conversion](../guide/image-convert.en.md) |
| Regional probe | `edgeweir-node probe`, unit `edgeweir-probe.service` | Probes the nodes' scheduling addresses; runs no OpenResty, see [Regional probes](../deploy/nodes.en.md#regional-probes) |

The console requests and renews site certificates; nodes fetch the certificate material over mTLS. Nodes answer ACME HTTP-01 challenges on port 80.

## Processes

```text
systemd: edgeweir-node.service (user edgeweir)
└─ edgeweir-node supervise --manage-nginx        supervisor
   ├─ edgeweir-node run --manage-nginx …          agent (base install or self-upgraded version)
   │  └─ edgeweir-node imgconv                    image conversion, one per conversion
   └─ nginx master (edgeweir-openresty)
      └─ nginx worker × worker_processes
```

| Item | Behavior |
| --- | --- |
| OpenResty ownership | Run by the supervisor; the agent tests and reloads configuration through it. Restarting or upgrading the agent does not restart OpenResty; shared memory (bans, CC state, rate-limit counters, statistics counters) is kept |
| Agent restarts | The supervisor restarts an agent that exits, after 2 seconds doubling up to 1 minute; on exit status 2 (invalid flags or local settings) the supervisor exits with status 2 and systemd does not restart it (`RestartPreventExitStatus=2`) |
| Stop | SIGTERM goes to the supervisor; the agent stops first, then OpenResty exits gracefully; whatever remains after `TimeoutStopSec=30s` is killed |
| Without configuration | Before enrollment or without a usable configuration the data plane listens on `--default-port` (default 80) and answers every host with `404` (`X-Edgeweir-Error: unknown-host`) |
| `run` mode | `edgeweir-node run --manage-nginx` runs without a supervisor and the agent runs OpenResty itself; no signed upgrades, `self-upgrade-v1` is not reported |

## Communication with the console

Nodes only connect out to the console's node channel; the console never connects to nodes.

| Item | Behavior |
| --- | --- |
| Address | `--server` given at enrollment: the node channel port (default `https://<console>:8443`), or the WebSocket entry on the console's web port (`wss://`, `ws://`; node 0.2.0 or later), see [Ports, reverse proxies and trusted proxies](../deploy/networking.en.md) |
| Protocol | Connect RPC (protobuf) over HTTP/2; `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY` apply |
| Enrollment | One-time token (prefix `ewt_`); the TLS chain must contain the internal CA pinned by `--ca-sha256` before the token is sent; the private key (ECDSA P-256) is generated on the node and never leaves it |
| After enrollment | Every RPC uses mTLS: the node certificate as client certificate, only the internal CA trusted |
| Configuration | The `WatchConfig` stream pushes new revisions; `GetConfig` also polls every 30 seconds (±20%) |
| Heartbeat | `ReportStatus` every 15 seconds (and right after an apply); a heartbeat within 45 seconds counts as **Online** |
| Statistics and logs | Statistics every 60 seconds; sampled access logs every 10 seconds; node logs drained every second, see [Node logs](../guide/node-logs.en.md) |
| Node certificate | Valid for 30 days; renewed automatically with a newly generated key when less than a third (10 days) remains or the console asks |
| Console unreachable | The node keeps serving the last configuration it applied (last-known-good, LKG); statistics, access logs and node logs are spooled in the state directory |
| Address changes | Nodes 1.2.0 and later follow the node channel address the console gives out, see [Changing the node channel address](../deploy/networking.en.md#changing-the-node-channel-url) |

## How configuration takes effect

| Step | Behavior |
| --- | --- |
| Validation | Content hash, cluster, capabilities and field ranges; an invalid configuration is refused as a whole, the LKG keeps serving and the same revision is not retried for 5 minutes |
| Single bad items | Invalid domains, origins, listeners and similar items are skipped and reported as warnings; the rest applies |
| Structural changes | Listeners, cache zones, the set of sites, HTTPS sites' domains, protocol and compression settings, the OWASP CRS, layer-4 ports and protocols: `nginx.conf` is rendered again and reloaded after `openresty -t` passes; old workers serve existing connections until they end (limit: [How long old workers stay](configuration.en.md#how-long-old-workers-stay)) |
| Other changes | Hot update of the site table over the local control socket, no reload |
| Persistence | After a successful apply the revision is written to `config/current.binpb`; the previous one stays as `config/previous.binpb` |
| Capabilities | A configuration that needs a capability the node lacks is refused as a whole and the console shows **Upgrade required**, see [Node capabilities](../guide/node-upgrades.en.md#node-capabilities) |

## Ports

Inbound (open in the host firewall and cloud security groups; conditions in [Ports and firewall](../deploy/nodes.en.md#ports-and-firewall)):

| Port | Use |
| --- | --- |
| 80/TCP | HTTP, ACME HTTP-01; default listener before any configuration |
| 443/TCP, 443/UDP | HTTPS, HTTP/3 |
| The cluster's extra HTTP / HTTPS ports | See [The cluster's listening ports](../guide/https.en.md#the-clusters-listener-ports) |
| The cluster's port pool (1024–65535) | [Layer-4 forwarding](../guide/l4.en.md) |

Outbound:

| Destination | Use |
| --- | --- |
| The console's node channel (default 8443/TCP; the console's web port for the WebSocket entry) | Enrollment and every RPC |
| The console's `EDGEWEIR_PUBLIC_URL` | `install.sh` and the [downloads mirror](../deploy/nodes.en.md#downloads-mirror) (installation only) |
| `github.com`, `api.github.com` and GitHub's download hosts | `install.sh` and the default release source of signed upgrades |
| Origins | Origin fetches and active health checks |
| OCSP responders | Sites with OCSP stapling |
| DNS servers | `/etc/resolv.conf` or `--resolver`, for origin host names |
| Other nodes' scheduling addresses | When the node also probes, see [Nodes as probes](../guide/scheduling.en.md#nodes-that-also-probe) |

Local unix sockets (no TCP listener):

| Path | Use |
| --- | --- |
| `/run/edgeweir-node/control.sock` | Data plane control API; used by `healthcheck`, `bans`, `security`, `accesslog` |
| `/run/edgeweir-node/diag.sock` | Agent diagnostics (0600); used by `diagnose`, `pprof` |
| `/run/edgeweir-node/control.sock.geo` | GeoIP lookups (served by the agent to Lua) |
| `/run/edgeweir-node/edge.sock`, `edge-tls.sock` | Local edge listener for prefetching |
| `/run/edgeweir-node/origin*.sock` | Internal origin layer (`origin`, `origin-noverify` and their `-h2`, `-grpc` variants) |
| `/run/edgeweir-node/l4.sock` | Control relay of the stream subsystem (with layer-4 applications) |
| `/run/edgeweir-node/agent.sock`, `image.sock` | PURGE method, image conversion |
| `/var/lib/edgeweir-node/upgrade.sock` | Supervisor (0600) |

## Files and directories

| Path | Content |
| --- | --- |
| `/usr/bin/edgeweir-node` | Agent (same path for tar.gz installs; `/usr/local/bin/edgeweir-node` in the image) |
| `/usr/share/edgeweir-node/lua/edgeweir/` | Lua modules |
| `/usr/share/edgeweir-node/geoip/` | Bundled IPinfo Lite and `NOTICE` (container image only) |
| `/usr/lib/edgeweir-openresty/` | OpenResty: `nginx/sbin/nginx`, `luajit/`, `lualib/`; `modules/` and `lib/libmodsecurity.so.3` come from `edgeweir-openresty-modsecurity` |
| `/usr/share/edgeweir-openresty/` | OWASP CRS (`crs/`) and `modsecurity/unicode.mapping` |
| `/etc/default/edgeweir-node` | Environment of the service (deb, rpm; local edits are kept), see [Node configuration](configuration.en.md) |
| `/etc/default/edgeweir-probe` | Environment of the probe service (0600) |
| `/usr/lib/systemd/system/edgeweir-node.service`, `edgeweir-probe.service` | systemd units (deb, rpm); tar.gz installs `/etc/systemd/system/edgeweir-node.service` |
| `/var/lib/edgeweir-node/` | State directory (user `edgeweir`, 0700), see below |
| `/var/cache/edgeweir-node/<zone>/` | Cache (0750) |
| `/var/lib/edgeweir-probe/` | Probe identity (0700): `probe.key` (0600), `probe.crt`, `ca.crt`, `probe.json` |

State directory `/var/lib/edgeweir-node/`:

| File | Content |
| --- | --- |
| `node.key` (0600), `node.crt`, `ca.crt` | Node private key, node certificate, internal CA certificate |
| `identity.json` | Node ID, cluster ID, node name, node channel address and server name, CA fingerprint, enrollment time, fallback address; its presence marks the node as enrolled |
| `config/current.binpb`, `previous.binpb`, `receipts.json` | LKG configuration and the one before, configuration receipts signed by the console (0600) |
| `certificates.json`, `origin-client-certificates.json` | Site certificate chains, private keys and OCSP responses; origin client certificates (0600) |
| `credentials.json` | S3 origin credentials, PURGE keys, access authentication secrets (plaintext, 0600) |
| `challenge-keys.json`, `session-ticket-keys.json` | Challenge pass keys, TLS session ticket keys (0600) |
| `bans.json`, `purge.json` | Dynamic bans, purge markers (0600) |
| `health.crt`, `health.key` | Self-signed certificate of the health endpoint (0600) |
| `traffic-spool.json`, `logs-spool.json`, `nodelogs-spool.json` | Statistics, access log and node log batches the console has not confirmed (0600) |
| `run.lock`, `identity.lock` | Agent run lock, identity rewrite lock |
| `upgrades/` | Supervisor state `state.json` and version directories `releases/<task ID>/` (0700) |
| `nginx/` | nginx prefix: `conf/nginx.conf`, `logs/`, `tmp/` |

> [!WARNING]
> The state directory holds the node's private key, site private keys and origin credentials; copying it copies the node's identity. Enroll a new host with a new install command instead of copying another node's state directory.

## Commands

| Command | Purpose |
| --- | --- |
| `edgeweir-node enroll` | Enroll with a one-time token; `--force` replaces an existing identity |
| `edgeweir-node supervise --manage-nginx` | Supervisor (entry point of the systemd unit and the image) |
| `edgeweir-node run [--manage-nginx]` | Run the agent without a supervisor |
| `edgeweir-node probe` | Regional probe |
| `edgeweir-node set-server` | Change the node channel address after a check |
| `edgeweir-node healthcheck` | Exit status 0 once the data plane has a site table; prints `healthy: revision N, M sites` |
| `edgeweir-node diagnose [--json]` | Check identity, certificate, console connectivity, clock, agent, configuration and data plane |
| `edgeweir-node pprof PROFILE` | Fetch a Go profile of the running agent |
| `edgeweir-node bans [--list]` | Ban status of the data plane (JSON); `--list` lists up to 1000 bans |
| `edgeweir-node security` | Challenge keys, captcha pool and the sites' CC levels (JSON) |
| `edgeweir-node accesslog [--site ID] [--json]` | Watch this node's requests live |
| `edgeweir-node version` | Version, commit, build time, Go version and platform |

Flags and usage: [Node operations](operations.en.md) and [Node configuration](configuration.en.md).

## Supported platforms

| Item | Requirement |
| --- | --- |
| Operating system | Linux with glibc 2.34 or later: RHEL, Rocky, AlmaLinux 9 or later, Debian 12 or later, Ubuntu 22.04 or later |
| Architecture | amd64 (`x86_64` for rpm), arm64 (`aarch64` for rpm) |
| Service manager | systemd; not needed for the container image |
| Install forms | deb, rpm, tar.gz (needs the `edgeweir-openresty` deb or rpm), container image `ghcr.io/marvinli001/edgeweir-node` |

## Versions

| Item | Rule |
| --- | --- |
| Version numbers | Semantic versions `vX.Y.Z` on [GitHub Releases](https://github.com/marvinli001/edgeweir-node/releases); image tags `X.Y.Z`, `X.Y` and `latest` (newest final release) |
| Patch releases | Fixes only |
| Minor releases | New capabilities (`*-vN`), new commands, new optional flags |
| Major releases | Removed capabilities or proto fields, an incompatible state directory or `identity.json`, higher system requirements, re-enrollment |
| With the console | The console sends configuration by the capabilities a node reports and does not compare version numbers; every 1.x minor release works with the current console |
