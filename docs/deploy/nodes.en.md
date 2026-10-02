# Adding nodes

Generate an install command for a cluster, then install and enroll an edge node on a Linux host; node ports and firewall; run regional probes.

## Requirements

| Item | Requirement |
| --- | --- |
| System | Linux, amd64 or arm64, glibc 2.34 or later: RHEL, Rocky, AlmaLinux 9 or later, Debian 12 or later, Ubuntu 22.04 or later; systemd (not required with `--no-start`) |
| Privileges | root or sudo |
| Commands | `curl`, `sha256sum`, `tar` |
| Console access | `EDGEWEIR_PUBLIC_URL` (`/install.sh`, `/downloads/*`) and `EDGEWEIR_NODE_API_URL` (node channel, 8443 by default); see [ports and reverse proxy](networking.en.md) |
| External access | GitHub Releases and `api.github.com` (unless `--mirror-only`) |

Nodes use OpenResty built for Edgeweir, released with edgeweir-node and listed in the same signed `checksums.txt`:

| Package | Contents | Installed |
| --- | --- | --- |
| `edgeweir-openresty` | OpenResty 1.31.1.1 with HTTP/2, HTTP/3, Brotli, and Zstandard; `/usr/lib/edgeweir-openresty/` (nginx at `/usr/lib/edgeweir-openresty/nginx/sbin/nginx`) | `edgeweir-node` depends on it; always installed |
| `edgeweir-openresty-modsecurity` | The ModSecurity dynamic module `/usr/lib/edgeweir-openresty/modules/ngx_http_modsecurity_module.so` and the OWASP CRS rules in `/usr/share/edgeweir-openresty/crs/` | Recommended by `edgeweir-node`; `install.sh` installs it unless `--no-modsecurity` is given, in which case the node does not support [OWASP CRS](../guide/waf.en.md) |

Both packages come as deb and rpm only (amd64, arm64). The openresty.org repositories are no longer used; an openresty.org repository and `openresty` package added by an earlier `install.sh` can be removed.

## 1. Generate the install command

1. Open **Clusters & nodes**, select a cluster, and click **Add node**.
2. Fill in **Node name**, choose a **Node group** (default: the cluster's default node group) and **Valid for** (15 minutes, 1 hour, or 24 hours; default 1 hour).
3. Click **Generate command**. The dialog shows the **Install command** and the **CA fingerprint**, once.

| Item | Behavior |
| --- | --- |
| Enrollment token | Prefix `ewt_`, single use, stored as SHA-256 only; generating one writes an audit entry. |
| `--server` | `EDGEWEIR_NODE_API_URL`. |
| `--ca-sha256` | SHA-256 fingerprint of the node channel internal CA. |
| API | `POST /api/v1/enrollment-tokens`, `ttlMinutes` 5–10080, default 60; see [API and endpoints](../reference/api.en.md). |
| Cleanup | Tokens expired or used more than 7 days ago are deleted every 30 minutes. |

## 2. Run the install command

Run the generated command on the node host (not the console host) with an account that may use sudo:

```bash title="Node"
export EDGEWEIR_TOKEN='<one-time token>'
curl -fsSL https://cdn-admin.example.com/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA fingerprint>
```

The token travels only in the `EDGEWEIR_TOKEN` environment variable or through `--token-file PATH`, never in process arguments; `--token` is rejected. All options: [command line](../reference/cli.en.md).

## 3. Verify

```bash title="Node"
systemctl status edgeweir-node
journalctl -u edgeweir-node -f
```

Expected: `edgeweir-node.service` is `active (running)`; in **Clusters & nodes** the node is "Online" and **Applied** shows a revision number.

## install.sh flow

| Step | Behavior | On failure |
| --- | --- | --- |
| 1 | Reads the token (`EDGEWEIR_TOKEN` or `--token-file`), checks the `ewt_` format, and removes it from the environment so child processes do not inherit it. On an enrolled host (`identity.json` in the state directory) no token is needed, and one given is not used | Exit |
| 2 | Checks Linux, root, `curl`, `sha256sum`, `tar`, systemd, and architecture; with `--format auto`, picks deb when `dpkg` and `apt-get` exist, rpm when `rpm` and `dnf`/`yum` exist, else tar.gz | Exit |
| 3 | Resolves the version: `--version`, or the `latest` file of the downloads mirror, falling back to the latest GitHub release | Exit, asking for `--version` |
| 4 | Downloads `checksums.txt` and `checksums.txt.sigstore.json`: mirror first, then GitHub | Exit |
| 5 | Verifies the signature with `cosign verify-blob`: the certificate identity must be `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<version>`, the issuer `https://token.actions.githubusercontent.com`. Without cosign on the host, downloads cosign v3.1.3, checks it against the SHA-256 pinned in the script, and installs it to `/usr/local/bin/cosign` | Exit |
| 6 | Picks the package for this host from the signed `checksums.txt`, and `edgeweir-openresty` and `edgeweir-openresty-modsecurity` of the same release (exactly one file per package, format, and architecture); exits on glibc older than 2.34; downloads them (mirror first, then GitHub) and verifies their SHA-256 | Exit |
| 7 | Installs `edgeweir-openresty` and `edgeweir-openresty-modsecurity` first. A tar.gz install uses the host's `dpkg` or `rpm` for them; without either, `edgeweir-openresty` must already be installed | Exit |
| 8 | Installs the deb, rpm, or tar.gz | Exit |
| 9 | `edgeweir-node enroll`: checks the CA fingerprint before sending the token, generates the private key locally, and exchanges a CSR for the node certificate; from then on, mTLS only. Skipped on an enrolled host (enroll again with `edgeweir-node enroll --force`) | Exit |
| 10 | Disables `openresty.service`, enables and starts `edgeweir-node.service` (skipped with `--no-start`); a tar.gz install first restarts a running service (deb and rpm package scripts do that themselves) | — |

- Nothing downloaded runs before steps 5 and 6 pass. `--allow-unsigned` skips step 5 for development only; the SHA-256 is still verified.
- The script consists of functions and calls `main` on its last line: a truncated download executes nothing.
- An enrolled host can run the same command again: to retry after a failed step, or to update the packages.
- The console never stores SSH credentials; the node private key never leaves the node.

Installed files:

| Path | Contents |
| --- | --- |
| `/usr/bin/edgeweir-node` | Agent |
| `/usr/share/edgeweir-node/lua/edgeweir/` | OpenResty Lua modules |
| `/usr/lib/edgeweir-openresty/` | OpenResty (`edgeweir-openresty`); the ModSecurity module in `modules/` |
| `/usr/share/edgeweir-openresty/crs/` | OWASP CRS rules (`edgeweir-openresty-modsecurity`; the version is fixed by the package, nothing is downloaded at run time) |
| `/var/lib/edgeweir-node/` | State directory (user `edgeweir`, 0700): `node.key`, `node.crt`, `ca.crt`, `identity.json`, `config/` (last-known-good configuration and `receipts.json`) |
| `/var/cache/edgeweir-node/` | Cache directory (user `edgeweir`, 0750) |
| `edgeweir-node.service` | deb, rpm: `/usr/lib/systemd/system/`; tar.gz: `/etc/systemd/system/` |

For deb and rpm, the package scripts create the `edgeweir` user and directories; for tar.gz, `install.sh` does.

## Ports and firewall

Nodes accept user traffic on these ports; open them in the host firewall and the cloud security group. Nodes only connect out to the console's node channel and need no inbound port for the console.

| Port | Use | When |
| --- | --- | --- |
| 80/TCP | HTTP, ACME HTTP-01 | Always |
| 443/TCP | HTTPS | A site of the cluster has a certificate selected |
| 443/UDP | HTTP/3 | A site has HTTP/3 on, see [Listening ports](../guide/https.en.md#listening-ports) |
| The cluster's port pools | [Layer-4 forwarding](../guide/l4.en.md) | TCP for TCP pools, UDP for UDP pools, both for TCP + UDP; opening only the ports L4 apps use is enough |

| Item | Notes |
| --- | --- |
| Privileges | Port pools hold 1024–65535 only: the systemd unit and the image need no extra privileges |
| Container nodes | Publish the ports of the pools, for example `-p 9000:9000 -p 9000:9000/udp`, a range as `-p 20000-20100:20000-20100`; use host networking (`--network host`) for large pools |
| Port changes | Creating or deleting an L4 app or changing its port reloads the node; old workers keep serving open connections, see [Reloads and long connections](../guide/l4.en.md#reloads-and-long-connections) |

### How long old workers stay

After a reload, old workers serve their open connections (long layer-4 connections, HTTP keep-alive, WebSocket) until these end by default, so frequent structural changes leave several sets of old workers. The node option `--stream-shutdown-timeout` (environment variable `EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT`) bounds that time:

| Value | Behavior |
| --- | --- |
| `0` (default) | No bound; an old worker exits after its last connection |
| A duration such as `30m` or `2h` | After that long, old workers close every connection they still serve (nginx `worker_shutdown_timeout`): layer-4, HTTP, and WebSocket connections alike |

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m
```

Then run `sudo systemctl restart edgeweir-node`. Container nodes take `-e EDGEWEIR_STREAM_SHUTDOWN_TIMEOUT=30m`.

## Regional probes

A regional probe measures every node's scheduling addresses from its region; the results drive backup IPs and scheduling, see [Regional probes and scheduling](../guide/scheduling.en.md). A probe is the `probe` mode of `edgeweir-node`: it runs no OpenResty, listens on no port, and has an identity separate from nodes. Its enrollment token comes from **Regions & probes** → **Probes** → **Add probe** and is shown once.

| Item | Requirement |
| --- | --- |
| Runs as | The node image (Docker, amd64 / arm64), or the systemd unit and binary on Linux amd64 / arm64 |
| Outbound | The node channel (`EDGEWEIR_NODE_API_URL`, 8443 by default) and the listener ports on the nodes' scheduling addresses |
| Inbound | None |
| Placement | Inside the carrier or regional network it stands for |
| Count | Reachability is decided by a strict majority of all probers: with a single prober its own network failure marks addresses unreachable; with two or more, more than half must fail at once |

### Container

The console's **Start command** is a `docker run`, see [Add a probe](../guide/scheduling.en.md#add-a-probe). With Compose:

```yaml title="compose.yml (probe host)"
services:
  probe:
    image: ghcr.io/marvinli001/edgeweir-node:latest
    entrypoint: ["/usr/local/bin/edgeweir-node", "probe"]
    environment:
      EDGEWEIR_STATE_DIR: /var/lib/edgeweir-probe
      EDGEWEIR_SERVER: https://cdn-admin.example.com:8443
      EDGEWEIR_CA_SHA256: <CA fingerprint>
      EDGEWEIR_TOKEN: <enrollment token>   # used on the first start only
    volumes:
      - probe-state:/var/lib/edgeweir-probe
    healthcheck:
      disable: true
    restart: unless-stopped
volumes:
  probe-state:
```

| Item | Behavior |
| --- | --- |
| Health check | The image's own health check asks the data plane, which a probe does not run: turn it off in Compose (as above) or add `--no-healthcheck` to `docker run` (the console's command has it); otherwise the container shows `unhealthy`, which does not affect probing |
| User | The container runs as uid 10001 with its state directory in the volume |
| Token | Ignored after enrollment; it can be removed from the configuration |

### systemd

The edgeweir-node deb and rpm packages include `edgeweir-probe.service` (not enabled), and the tar.gz has the same unit under `systemd/`. The packages depend on `edgeweir-openresty`, which probe mode does not start; verify the release files first as described in [SECURITY.md](../../SECURITY.en.md#verifying-releases), and do not enable `edgeweir-node.service` on a probe host.

```bash title="Probe host"
sudo tee /etc/default/edgeweir-probe >/dev/null <<'CONF'
EDGEWEIR_SERVER=https://cdn-admin.example.com:8443
EDGEWEIR_CA_SHA256=<CA fingerprint>
EDGEWEIR_TOKEN=<enrollment token>
CONF
sudo chmod 600 /etc/default/edgeweir-probe
sudo systemctl enable --now edgeweir-probe
journalctl -u edgeweir-probe -f
```

| Item | Behavior |
| --- | --- |
| User and privileges | User `edgeweir`, no capabilities, a read-only file system except the state directory, IP and unix sockets only |
| Configuration | `/etc/default/edgeweir-probe` (0600) is read by systemd only; the token line can be removed after enrollment |
| Missing enrollment settings | Exit status 2, no automatic restart |

### Command line

```text
EDGEWEIR_TOKEN=<enrollment token> edgeweir-node probe --server URL --ca-sha256 HEX [--server-name NAME] [--state-dir DIR]
edgeweir-node probe [--state-dir DIR]     # enrolled
```

| Flag | Default | Description |
| --- | --- | --- |
| `--server` | None (required on the first run) | Node channel URL |
| `--ca-sha256` | None (required on the first run) | SHA-256 of the node channel's internal CA certificate (DER), hex |
| `--token-file` | None | File with the enrollment token (first run) |
| `--token` | None | Enrollment token (first run); visible in the process list, prefer `EDGEWEIR_TOKEN` or `--token-file` |
| `--server-name` | Host name of `--server` | TLS server name to verify |
| `--state-dir` | `/var/lib/edgeweir-probe` | Probe identity directory, separate from the node's |
| `--timeout` | `30s` | Timeout of each console RPC |
| `--log-level` | `info` | `debug`, `info`, `warn`, `error` |
| `--log-format` | `text` | `text`, `json` |

Every flag can also be set with the environment variable `EDGEWEIR_<flag name>` (for example `--state-dir` → `EDGEWEIR_STATE_DIR`); the command line wins.

### Enrollment and identity

| Item | Behavior |
| --- | --- |
| First start | Generates an ECDSA P-256 key and CSR locally, checks the CA fingerprint, then sends the token for a probe certificate; while the console is unreachable or busy it retries the same token with backoff (1–30 seconds), and a refused token or a pin mismatch ends it |
| Later starts | The token is ignored and every call uses mTLS; the certificate renews itself once less than a third of its lifetime remains |
| State directory | `/var/lib/edgeweir-probe` (0700): `probe.key` (0600), `probe.crt`, `ca.crt`, `probe.json` |
| Enroll again | Delete the probe in the console (which revokes its certificate), delete `probe.json` (or the whole state directory), and start with a new token |
| Same host as a node | Possible; the state directories are separate. A node that also probes needs no separate probe process, see [Nodes that also probe](../guide/scheduling.en.md#nodes-that-also-probe) |

## Downloads mirror

When nodes reach GitHub poorly, the console can serve release files at `/downloads/*`. The mirror is only a transport: nodes still verify signatures and SHA-256.

| Item | Behavior |
| --- | --- |
| Enable | Set `EDGEWEIR_DOWNLOADS_DIR`; unset, every `/downloads/*` request returns 404 |
| Default mirror URL | `install.sh` uses `<EDGEWEIR_PUBLIC_URL>/downloads/edgeweir-node`; `--mirror URL` overrides it |
| Fallback | Files missing from the mirror come from GitHub; `--mirror-only` disables the fallback |
| Projects | `edgeweir-node` and `cosign` only |
| Path rules | `<project>/latest` or `<project>/v<semver>/<file>`; other paths, directories, and symlinks leading out of the directory return 404 |
| Cache headers | `latest`: `no-cache`; other files: `public, max-age=86400, immutable` |
| Permissions | The directory and files must be readable by the container user `node` (uid 1000). When the directory is missing or unreadable at startup, the console logs `EDGEWEIR_DOWNLOADS_DIR cannot be served`; a file that exists but cannot be read answers 404 and logs `cannot read the download mirror` (at most once a minute per error) |

Layout:

```text
downloads/
  edgeweir-node/
    latest                      # version number, e.g. 0.2.0
    v0.2.0/
      checksums.txt
      checksums.txt.sigstore.json
      edgeweir-node_0.2.0_amd64.deb
      edgeweir-node-0.2.0-1.x86_64.rpm
      edgeweir-node_0.2.0_linux_amd64.tar.gz
      edgeweir-openresty_1.31.1.1-2_amd64.deb
      edgeweir-openresty-1.31.1.1-2.x86_64.rpm
      edgeweir-openresty-modsecurity_1.31.1.1-2_amd64.deb
      edgeweir-openresty-modsecurity-1.31.1.1-2.x86_64.rpm
      ...
  cosign/
    v3.1.3/
      cosign-linux-amd64
      cosign-linux-arm64
```

Enable it with `compose.yml`:

1. Place the files from the edgeweir-node release page in `/opt/edgeweir/downloads` using the layout above.
2. Uncomment `volumes` in the `console` service of `compose.yml`: `./downloads:/srv/edgeweir-downloads:ro`.
3. Set `EDGEWEIR_DOWNLOADS_DIR=/srv/edgeweir-downloads` in `.env` and run `docker compose up -d`.
4. Verify:

   ```bash
   curl -s https://cdn-admin.example.com/downloads/edgeweir-node/latest
   ```

   Expected: the version number.

The release source for agent self-upgrades is set in **System → Node release source** and is independent of this mirror; see [node upgrades](../guide/node-upgrades.en.md).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `no enrollment token` | `sudo` dropped `EDGEWEIR_TOKEN` | Run the generated command unchanged: `export` and `sudo --preserve-env=EDGEWEIR_TOKEN`. |
| `the enrollment token is malformed (expected ewt_...)` | Token copied incompletely | Copy the install command again. |
| `systemd is required` | No systemd on the host | Use a systemd host, or add `--no-start` to install and enroll only. |
| `could not determine the latest edgeweir-node version; pass --version` | No `latest` in the mirror, and GitHub unreachable or without a release | Add `--version`, or set up the downloads mirror. |
| `edgeweir-openresty needs glibc 2.34 or later` | The distribution is too old | Use RHEL, Rocky, AlmaLinux 9, Debian 12, Ubuntu 22.04, or later. |
| `checksums.txt does not list exactly one ... package of edgeweir-openresty...` | The mirror or release lacks the package, or lists several versions for the architecture | Complete the mirror directory from `checksums.txt`; add `--no-modsecurity` when the release has no ModSecurity module. |
| `edgeweir-openresty comes as .deb and .rpm only` | A tar.gz install on a host without `dpkg`, `rpm`, or an installed `edgeweir-openresty` | Use a host with deb or rpm package management. |
| `cosign signature verification FAILED`, `SHA-256 verification FAILED` | Downloaded content does not match the signature or checksum | Check the download source and the mirror contents; do not skip verification. |
| `CA pin mismatch` | A proxy or CDN terminates TLS on 8443, or `--server` points at another service | Connect directly or use [layer-4 passthrough](networking.en.md#node-channel-passthrough). |
| `console rejected the enrollment token (expired or already used)` | Token expired or already used | Generate a new install command. |
| `node is already enrolled (use --force to replace the identity)` | The host already has a node identity (`/var/lib/edgeweir-node/identity.json`) | Keep the existing enrollment; to replace the identity, run `edgeweir-node enroll --force` with a new token; flags in [edgeweir-node](https://github.com/marvinli001/edgeweir-node). |
| `x509: certificate is valid for ..., not ...` | The name the node connects to is not in the node channel certificate | Add the name to `EDGEWEIR_NODE_API_HOSTNAMES` and restart the console; see [node channel URL and certificate](networking.en.md#node-channel-url-and-certificate). |
| Enrollment times out, or the node stays offline | Firewall or security group blocks 8443; `EDGEWEIR_NODE_API_URL` resolves incorrectly | Open 8443; check DNS resolution. |
| Connections to an L4 app's port time out | The node firewall or security group does not open the port pools; a container node does not publish the ports | Open or publish them as in [Ports and firewall](#ports-and-firewall). |
| `probe is not enrolled: the first run needs --server, --ca-sha256 and a probe token` | A probe's first start lacks the enrollment settings (exit status 2) | Set `EDGEWEIR_SERVER`, `EDGEWEIR_CA_SHA256`, and `EDGEWEIR_TOKEN`, then start it again. |
| `probe enrollment failed: console rejected the enrollment token (expired or already used)` | The probe token expired or was already used | **Add probe** again for a new token. |
| A probe container shows `unhealthy` | The image's health check asks the data plane | Turn the container health check off, see [Container](#container). |

