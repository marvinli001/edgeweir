# Adding nodes

Install and enroll edge nodes: requirements, releases and verification, install command, SSH install, manual installs, enrollment, decommissioning, ports, client IP, probes, mirror.

Components, ports and files at a glance: [Node overview](../node/README.en.md).

## Requirements

| Item | Requirement |
| --- | --- |
| System | Linux, amd64 or arm64, glibc 2.34 or later: RHEL, Rocky, AlmaLinux 9 or later, Debian 12 or later, Ubuntu 22.04 or later; systemd (not required with `--no-start` or in a container) |
| Privileges | root or sudo |
| Commands | `curl`, `sha256sum`, `tar`; `openssl` (optional, checks the node channel's CA before installing) |
| Console access | `EDGEWEIR_PUBLIC_URL` (`/install.sh`, `/downloads/*`) and the node channel URL ("Node channel" in **System settings**, 8443 by default); see [ports and reverse proxy](networking.en.md) |
| External access | `github.com` and `api.github.com` (unless `--mirror-only`) |
| Ports | 80, 443 and the others not used by another program, see [Ports and firewall](#ports-and-firewall) |

## Releases

Published on [GitHub Releases](https://github.com/marvinli001/edgeweir-node/releases); `<version>` is the version number without `v`.

| File | Content |
| --- | --- |
| `edgeweir-node_<version>_amd64.deb`, `_arm64.deb` | Agent, Lua modules, systemd units, `/etc/default/edgeweir-node`; depends on `edgeweir-openresty (>= 1.31.1.1-3)`, recommends `edgeweir-openresty-modsecurity` and `nftables` |
| `edgeweir-node-<version>-1.x86_64.rpm`, `.aarch64.rpm` | As above |
| `edgeweir-node_<version>_linux_amd64.tar.gz`, `_linux_arm64.tar.gz` | Directory `edgeweir-node_<version>_linux_<arch>/`: `edgeweir-node`, `lua/edgeweir/`, `systemd/edgeweir-node.service`, `systemd/edgeweir-probe.service`, `LICENSE`, `NOTICE` |
| `edgeweir-openresty_1.31.1.1-3_<arch>.deb`, `edgeweir-openresty-1.31.1.1-3.<arch>.rpm` | OpenResty in `/usr/lib/edgeweir-openresty/`; deb and rpm only |
| `edgeweir-openresty-modsecurity_1.31.1.1-3_<arch>.deb`, `.rpm` | ModSecurity module and OWASP CRS 4.29.0; without it the node does not support [OWASP CRS](../guide/waf.en.md) |
| `*.sbom.json` | SBOM (SPDX) of every archive, package and edgeweir-openresty |
| `checksums.txt`, `checksums.txt.sigstore.json` | SHA-256 of every file and the keyless cosign signature |
| Image `ghcr.io/marvinli001/edgeweir-node:<version>` | amd64, arm64; also tagged `X.Y` and `latest`; cosign signature and build provenance |

The openresty.org repositories are no longer used; an openresty.org repository and `openresty` package added by an earlier `install.sh` can be removed.

### Verifying releases

`install.sh` checks signatures and SHA-256 itself. Before a manual install run:

```bash title="Download directory"
cosign verify-blob \
  --bundle checksums.txt.sigstore.json \
  --certificate-identity "https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<version>" \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  checksums.txt
sha256sum --ignore-missing -c checksums.txt
gh attestation verify edgeweir-node_<version>_linux_amd64.tar.gz --repo marvinli001/edgeweir-node
```

| Step | Expected |
| --- | --- |
| `cosign verify-blob` | `Verified OK` |
| `sha256sum` | `OK` for every downloaded file |
| `gh attestation verify` | Build provenance from the release workflow of `marvinli001/edgeweir-node`; for the image use `gh attestation verify oci://ghcr.io/marvinli001/edgeweir-node:<version> --repo marvinli001/edgeweir-node` |

GitHub Actions builds the releases from the tag, reproducibly (`-trimpath`, timestamps from the commit).

## 1. Generate the install command

1. Open **Clusters & nodes**, select a cluster, click **Add node** and switch to **Manual command** (the default tab is [SSH install](#ssh-install)). The dialog shows the **Install command** at once: the cluster's default node group, valid for 1 hour, no node name.
2. For a node name, another node group, or another lifetime, open **Options**: fill in **Node name**, choose a **Node group** (shown when the cluster has several) and **Valid for** (15 minutes, 1 hour, or 24 hours), and click **Regenerate**.
3. Copy the **Install command**. Below it are the time left, **Shown once**, address warnings, and the [node channel connection check](#node-channel-connection-check); once the dialog is closed the command is not shown again, and opening it again generates a new token.
4. Once the command runs on the node, the dialog's **Progress** refreshes every 3 seconds: waiting for the node (or token expired), enrolled (the node name links to its details), online, configuration applied, data plane healthy, has an address for DNS.

| Item | Behavior |
| --- | --- |
| Enrollment token | Prefix `ewt_`, single use, stored as SHA-256 only; generating one writes an audit entry |
| `--server` | The "Node channel" URL in **System settings**; see [Node channel URL and certificate](networking.en.md#node-channel-url-and-certificate) |
| `--ca-sha256` | SHA-256 fingerprint of the node channel internal CA, the same as "CA fingerprint" in **System settings** |
| API | `POST /api/v1/enrollment-tokens`, `ttlMinutes` 5–10080, default 60; `GET /api/v1/enrollment-tokens/{id}` returns `usedAt` and the enrolled node. See [API and endpoints](../reference/api.en.md) |
| Address warnings | When the console URL (where `install.sh` comes from) or the node channel URL is localhost, a loopback or a private address, the dialog warns about each and **System settings** marks the URL "This machine only" or "Private address"; a public console URL over plain HTTP gets "Console URL is plain HTTP: install.sh is sent unencrypted" and the mark "Unencrypted". The console logs a warning for each at startup; generating is not refused |
| Cleanup | Tokens expired or used more than 7 days ago are deleted every 30 minutes |

### Node channel connection check

The console makes a TLS handshake with its own node channel at the node channel URL (no client certificate, no request) and compares the presented certificate chain with the node channel's internal CA; for a `wss://` or `ws://` URL it first completes the WebSocket handshake at `/node-channel` and makes the TLS handshake inside it. **System settings** shows the result below the URL in the "Node channel" card; the add-node dialog shows it as one line, with a "Change" link to **System settings** when the check fails.

| Result (System settings / add-node dialog) | Meaning |
| --- | --- |
| Reachable / Node channel reachable | The handshake completed and the chain includes the internal CA |
| The console cannot connect to this URL / The console cannot connect to the node channel URL | No handshake within 3 seconds: wrong address or DNS, a closed port, or the console's network cannot reach the address |
| Certificate mismatch: a proxy or CDN may be in front / Node channel certificate mismatch: a proxy or CDN may be in front | Another certificate chain answered: a proxy or CDN terminates TLS, or the URL points at another service, and node mTLS will fail; see [Node channel passthrough](networking.en.md#node-channel-passthrough). A refused WebSocket handshake for a `wss://` or `ws://` URL (the entry is closed, or the URL points at another service) gives this result too; see [The node channel's WebSocket entry](networking.en.md#the-node-channels-websocket-entry) |
| The outbound policy does not allow this address / The outbound policy does not allow the node channel address | The URL saved in **System settings** resolves to a private, loopback, or other special-purpose address that `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` does not allow: the console does not connect. `EDGEWEIR_NODE_API_URL` and the default are not limited this way |

When the result is unreachable or a mismatch, the console also checks the [WebSocket entry](networking.en.md#the-node-channels-websocket-entry): `wss://<host[:port] of EDGEWEIR_PUBLIC_URL>` (`ws://` behind an `http://` console URL), and port 443 of an `https://` node channel URL's own host. This works while the entry is closed: the check carries a one-time token the console signs, and the entry relays that check only, nothing else.

| Candidate | Shown |
| --- | --- |
| Passes (the node channel's internal CA answers inside the WebSocket, through the proxy or CDN) | "WebSocket entry `wss://…` works" and **Switch**. It saves that URL as the node channel URL (over `EDGEWEIR_NODE_API_URL`), opens the entry, and writes the audit log; enrolled nodes and probes check the new URL and move to it ([Changing the node channel URL](networking.en.md#changing-the-node-channel-url)). In the add-node dialog it also mints the install command again with the same options |
| Fails | One more line below the result: pass the node channel port through at layer 4, or turn off the CDN proxy for this name (Cloudflare's grey cloud, for example); see [Node channel passthrough](networking.en.md#node-channel-passthrough) |

The check is advisory and blocks nothing: the console reaching its own address does not prove that nodes on other networks do, and where the console's network cannot reach its own public address (no NAT hairpinning) the check fails while nodes may still enroll. A result is reused for 30 seconds and checked again when the URL changes. API: `GET /api/v1/settings/node-channel-check` returns `{ url, result, candidate, checkedAt }`, with `result` `ok`, `unreachable`, `mismatch`, or `refused`, and `candidate` `{ url, result }`, or `null` when none was checked.

## 2. Run the install command

Run the generated command on the node host (not the console host) with an account that may use sudo:

```bash title="Node"
export EDGEWEIR_TOKEN='<one-time token>'
curl -fsSL https://cdn-admin.example.com/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA fingerprint>
```

The token travels only in the `EDGEWEIR_TOKEN` environment variable or through `--token-file PATH`, never in process arguments; `--token` is rejected.

| Option | Default | Effect |
| --- | --- | --- |
| `--server URL` | required | Node channel URL: `https://`, or the WebSocket entry `wss://` / `ws://` (node 0.2.0 or later) |
| `--ca-sha256 HEX` | required | SHA-256 of the internal CA, 64 lowercase hex characters |
| `--token-file PATH` | none | Read the token from a file; wins over `EDGEWEIR_TOKEN` |
| `--version VER` | `latest` | Version to install, `v` prefix allowed; `latest` is the mirror's `latest` file, then the latest GitHub release |
| `--format auto\|deb\|rpm\|tar` | `auto` | deb with `dpkg` and `apt-get`, rpm with `rpm` and `dnf`/`yum`, else tar |
| `--mirror URL` | `<EDGEWEIR_PUBLIC_URL>/downloads/edgeweir-node` | Release mirror, see [Downloads mirror](#downloads-mirror) |
| `--mirror-only` | off | No fallback to GitHub |
| `--no-modsecurity` | off | Do not install `edgeweir-openresty-modsecurity` |
| `--no-start` | off | Install and enroll only: no systemd required, no service start, no health check |
| `--force` | off | Enroll an enrolled host again with a new token |
| `--allow-unsigned` | off | Skip the cosign signature check, development only; the SHA-256 is still verified |

Exit codes: `0` done, `1` any step failed (stderr shows `[edgeweir] error: <reason>`), `2` a required option is missing or `--help`. See also [Command line](../reference/cli.en.md#node-install-script).

## 3. Verify

`install.sh` ends by waiting for `edgeweir-node healthcheck` to pass ([install.sh flow](#installsh-flow), step 11) and prints `done: edgeweir-node is healthy (revision N, M sites)`. Afterwards:

```bash title="Node"
systemctl status edgeweir-node
sudo edgeweir-node diagnose
```

Expected: `edgeweir-node.service` is `active (running)`; every `diagnose` line is `ok`; in **Clusters & nodes** the node is "Online" and **Applied** shows a revision number. After enrolling and before its first connection to the node channel the node shows "Awaiting heartbeat"; online without a configuration yet, **Applied** shows "Awaiting configuration".

## SSH install

Add nodes without signing in to each host: the console connects over SSH once, runs the same `install.sh` as the [install command](#2-run-the-install-command) (same signature checks and options), and disconnects; everything after that still goes through the node channel.

1. The **Add node** dialog opens on **SSH install** (the other tab is **Manual command**; the last choice is remembered).
2. **One host**: fill in **Host**, **Port** (default 22) and **User** (default root). **Batch**: in **Hosts**, one host per line as `host[:port] [user] [node name]` (IPv6 as `[2001:db8::1]:22`), or CSV `host,port,user,node name` (a header line is allowed, empty fields take the defaults); lines starting with `#` are ignored. Up to 200 hosts at once share one credential; a user on a line wins.
3. **Authentication**: **Password**, or **Private key** (OpenSSH, PEM or PPK; with its **Passphrase** when encrypted). For a user other than root: a **sudo password** uses `sudo -S`; without one, passwordless sudo is required (`sudo -n`).
4. **Options**: node name, the expected **Host key fingerprint** (one host), node group, **Version** (default latest), **Package format**, **Download mirror**, **Mirror only**, **Install ModSecurity**, **Concurrency** (batch, default 5, at most 20), **Timeout per host** (default 15 minutes, 1–60).
5. Click **Read host keys**: the console completes the SSH handshake only, reads the host key and disconnects without signing in. Compare each `SHA256:…` fingerprint with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` on the host; a host whose key differs from the fingerprint entered is marked and not installed.
6. Click **Install on N**: each host shows queued, connecting, installing (with its current step: checking, downloading, verifying, installing packages, enrolling, starting, health check), enrolled or why it failed; click a host for the last lines of its output. A single host shows the same **Progress** as the manual command once enrolled. **Stop**, **Retry** failed hosts (with the credential still in the form) and **Copy results** (tab-separated: host, port, user, state, reason, node id).

| Item | Behavior |
| --- | --- |
| Host keys | Negotiated in ssh2's order (ssh-ed25519 first). The install accepts only the confirmed fingerprint; any other key ends the connection before signing in (`host_key_mismatch`), and no credential is sent |
| Enrollment token | One single-use token per host and attempt (valid for the host timeout plus 5 minutes), expired at once after a failure, a stop or a timeout |
| On the host | The login shell runs a fixed `sh` script: the token is the first line of stdin, the sudo password the second; `install.sh` is downloaded as the user into a `mktemp -d` directory, then runs as root with stdin from `/dev/null`; the token goes into an owner-only file in that directory and reaches `install.sh` as `--token-file` (not an environment variable: sudo logs preserved variables with their values), and the directory is removed. Command lines, environments and sudo logs carry only URLs, options and the token file's path |
| Credentials | Held in the console's process memory for that install only and dropped when it ends (every host done or stopped); the console never stores SSH credentials and never writes them to the database, logs, job queue, audit log or error messages. A retry needs the credential again |
| Output | At most the last 64 lines and 16 KiB per host, with passwords, passphrases, tokens and private key blocks removed |
| Run state | In the console's process memory only: kept 1 hour after the run ends, lost when the console restarts (the dialog says so; check the node list). At most 4 runs at once |
| Outbound policy | A host is resolved once and connected by that address; special-purpose addresses (private, loopback …) need `EDGEWEIR_OUTBOUND_ALLOW_CIDRS`, otherwise "The outbound policy does not allow this address" |
| Audit | `ssh_install.start` (cluster, run id, host count), one `ssh_install.host` per host (host, port, user, host key fingerprint, outcome, node id, token id), `ssh_install.cancel` |
| Network | The console must reach the hosts' SSH port; the hosts must reach the console URL (`install.sh`) and the node channel URL, as with the manual command |

Reasons:

| Reason | Meaning |
| --- | --- |
| Host key mismatch | The host presented a key other than the confirmed one: an interception, or the host was reinstalled |
| Unreachable / Timed out | Address, port or firewall; or the host timeout ran out |
| Authentication failed | Wrong user, password or key |
| sudo needs a password / Wrong sudo password / No sudo rights | sudo of a user other than root |
| sudo requires a terminal (requiretty) | sudoers sets `requiretty`, which SSH install does not support: use the manual command, or drop the setting |
| Could not download install.sh | The host cannot reach the console URL |
| System not supported | Not Linux, no systemd, or an unsupported architecture or glibc (exit code 21) |
| Host cannot reach the node channel | The node channel URL is unreachable, the CA fingerprint differs, or the WebSocket entry is closed (22, or `unreachable`, `ca_mismatch` while enrolling) |
| Signature or checksum mismatch | The cosign signature or a SHA-256 failed (24) |
| Token rejected | The console refused this attempt's token (26, the node's `token_rejected`) |
| Enrolled with another console or cluster | The host's identity is pinned to another console's CA (26, the node's `enrolled_elsewhere`), or the enrollment reported a node of another cluster of this console |
| Another install is running on the host | Another `install.sh` or `edgeweir-node enroll` runs (29, or the node's `busy`); retry later |
| Service did not start / Started, not healthy in time | Step 10 (27) or step 11 (28); see the host's output and `journalctl -u edgeweir-node -n 50` |
| install.sh failed | Any other failure; see the host's output |
| Not enrolled (enrolled, but no node of this console) | `install.sh` ended without using the token or reporting a node of this console: edgeweir-node before 1.7.0 with an identity from elsewhere (to enroll again, run the manual command with `--force`) |

Retries and new runs never add a second node: every attempt gets a new one-time token; an enrolled host (edgeweir-node 1.7.0 and later) reports its node through `edgeweir-node enroll --if-not-enrolled`; a node that enrolled while SSH dropped gets the same node again when its key enrolls once more ([idempotent by key](#enrolling-again-and-node-identity)).

API (`/api/v1`, an AccessKey with write scope; service accounts cannot call it; read-only AccessKeys can only read):

| Request | Notes |
| --- | --- |
| `POST /ssh-installs/host-keys` | `{ hosts: [{ host, port }] }`; returns each host's `algorithm`, `fingerprint` or `error` (`unreachable`, `timeout`, `not_ssh`, `outbound_refused`) |
| `POST /ssh-installs` | `{ clusterId, nodeGroupId?, credential: { username, password?, privateKey?, passphrase?, sudoPassword? }, hosts: [{ host, port, username?, nodeName?, hostKeyFingerprint }], options: { version, format, mirror, mirrorOnly, modsecurity, noStart }, concurrency, timeoutMinutes }`; returns the run |
| `GET /ssh-installs/{id}` | The run and each host's `state`, `step` (the current step while installing: `check`, `download`, `verify`, `install`, `enroll`, `start`, `health`; otherwise `null`), `error`, `exitCode`, `tokenId`, `nodeId`, `output`; 404 `SSH_INSTALL_NOT_FOUND` once it expired or the console restarted |
| `POST /ssh-installs/{id}/cancel` | Stops the run |
| `POST /ssh-installs/{id}/retry` | `{ credential, hosts?: [{ id, hostKeyFingerprint? }] }`; by default every failed or stopped host; 409 `SSH_INSTALL_BUSY` while the run is going |

`POST /ssh-installs` and `/retry` refuse an `Idempotency-Key` (the body carries credentials; see [API and endpoints](../reference/api.en.md)).

## install.sh flow

| Step | Behavior | On failure |
| --- | --- | --- |
| 1 | Reads the token (`EDGEWEIR_TOKEN` or `--token-file`), checks the `ewt_` format, and removes it from the environment so child processes do not inherit it. On an enrolled host (`identity.json` in the state directory) no token is needed, and one given is not used; with `--force` the token is required | Exit |
| 2 | Checks Linux, root, `curl`, `sha256sum`, `tar`, systemd, and architecture, and picks the package format. Unless the host is enrolled, then checks the node channel: `--server` must answer HTTP (any status; no token is sent), and with `openssl` on the host, the last certificate the server presents must be the CA pinned by `--ca-sha256`. For a `wss://` or `ws://` URL it requests `https://` (`http://` for `ws://`) `<host[:port]>/node-channel` instead, which must answer 426 (the entry is open); the CA is checked inside the WebSocket at enrollment in step 9 | Exit, naming an unreachable channel, a TLS-terminating proxy, or a closed WebSocket entry |
| 3 | Resolves the version: `--version`, or the `latest` file of the downloads mirror, falling back to the latest GitHub release. On an enrolled host without `--version` and `--force`, steps 3–9 are skipped: nothing is downloaded or installed. Enrolling through a `wss://` or `ws://` URL needs version 0.2.0 or later | Exit, asking for `--version` |
| 4 | Downloads `checksums.txt` and `checksums.txt.sigstore.json`: mirror first, then GitHub | Exit |
| 5 | Verifies the signature with `cosign verify-blob`: the certificate identity must be `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<version>`, the issuer `https://token.actions.githubusercontent.com`. Without cosign on the host, downloads cosign v3.1.3, checks it against the SHA-256 pinned in the script, and installs it to `/usr/local/bin/cosign` | Exit |
| 6 | Picks the package for this host from the signed `checksums.txt`, and `edgeweir-openresty` and `edgeweir-openresty-modsecurity` of the same release (exactly one file per package, format, and architecture); exits on glibc older than 2.34; downloads them (mirror first, then GitHub) and verifies their SHA-256 | Exit |
| 7 | Installs `edgeweir-openresty` and `edgeweir-openresty-modsecurity` first. A tar.gz install uses the host's `dpkg` or `rpm` for them; without either, `edgeweir-openresty` must already be installed | Exit |
| 8 | Installs the deb (`apt-get install`, `dpkg -i` without apt-get), rpm (`dnf`, `yum` or `rpm -Uvh`) or tar.gz | Exit |
| 9 | `edgeweir-node enroll`: checks the CA fingerprint before sending the token, generates the private key locally, and exchanges a CSR for the node certificate; from then on, mTLS only. Skipped on an enrolled host; with `--force`, stops `edgeweir-node.service` and replaces the identity with `edgeweir-node enroll --force` and the new token; step 10 starts it again | Exit |
| 10 | Disables `openresty.service`, enables and starts `edgeweir-node.service` (`--no-start` skips steps 10 and 11); a tar.gz install and a rerun that skipped the install first restart a running service (deb and rpm package scripts do that themselves) | Exit |
| 11 | Runs `edgeweir-node healthcheck` every 3 seconds for up to 90 seconds, until the data plane has applied its configuration; on success prints `done: edgeweir-node is healthy (revision N, M sites)` | Exit code 28, pointing to `journalctl -u edgeweir-node -n 50` |

- Nothing downloaded runs before steps 5 and 6 pass.
- The script consists of functions and calls `main` on its last line: a truncated download executes nothing.
- An enrolled host can run the same command again: nothing is downloaded or reinstalled, the service is started (restarted when running) and health-checked; with `--version <version>` that version is installed first. Without `/usr/bin/edgeweir-node` on the host, the latest version is installed. From edgeweir-node 1.7.0, `edgeweir-node enroll --if-not-enrolled` checks the identity first: one of this console reports its node, one of another console fails with exit code 26 and the service is not restarted.
- The console never stores SSH credentials ([SSH install](#ssh-install) uses them in memory for that install only); the node private key never leaves the node.

### Result lines and exit codes

`install.sh` writes its messages to stderr; stdout has one `EDGEWEIR_RESULT {"v":1,"step":"…","status":"…"}` line per step (JSON on the same line; ignore unknown fields) for SSH install and other automation. Steps are `args`, `check`, `download`, `verify`, `install`, `enroll`, `start`, `health`; `status` is `ok`, `skipped` or `failed` (a failed line has an English `message`). From edgeweir-node 1.7.0 the node writes the enroll line itself (`enrolled`, `already_enrolled`, `token_rejected`, `enrolled_elsewhere` …, with `node_id`). The last line is `{"step":"done","status":"ok|failed","failed_step":"…","exit":N}`.

| Exit code | Meaning |
| --- | --- |
| 0 | Done |
| 1 | Any other error |
| 20 | Bad arguments |
| 21 | System not supported (not Linux or root, a missing command, architecture, glibc) |
| 22 | Node channel unreachable, CA fingerprint mismatch, or the WebSocket entry is closed |
| 23 | Download failed |
| 24 | Signature or SHA-256 check failed |
| 25 | Package install failed |
| 26 | Enrollment failed (the enroll result line says why), or enrolled with another console |
| 27 | The service did not start |
| 28 | Health check timed out |
| 29 | Another install is running on the host (`/run/edgeweir-install.lock`) |

## Enrolling again and node identity

The console knows a node by its certificate's public key: the same private key enrolling again (for example a retry after the answer was lost) gets the same node and a new certificate, never a second node. The token must be the one that node used, or an unused token of the same cluster (and node group); another cluster's token is refused. From edgeweir-node 1.7.0 the node keeps its pending key until an enrollment succeeds, so retries reuse it.

Nodes report a digest of the host's machine-id; when a new node enrolls from the machine of an existing one (a reinstalled state directory, or a cloned image), the `node.enroll` audit entry records `sameMachineAs` and the console logs a warning. It is a hint only; nodes are never merged.

## Decommissioning a node

Retire a node without signing in to the host (edgeweir-node 1.7.0 and later, feature `decommission-v1`): in **Clusters & nodes**, choose **Decommission** in the node's menu or on its detail page and confirm. The node stops OpenResty, deletes its identity, last known good configuration and cache, and leaves a marker so that it does not serve again (also after a reboot) until it enrolls anew; the console then revokes its certificate and deletes the node (audit `node.delete`, `decommissioned: true`).

- A request for an offline node waits until it connects; **Withdraw** it until then.
- When the node reports a failure, the request is cleared and the detail page shows "Last decommission failed" with the reason; decommission again.
- The packages stay on the host; removing them needs root: `apt-get remove edgeweir-node edgeweir-openresty edgeweir-openresty-modsecurity` (`dnf remove` on rpm hosts).
- Nodes without the feature have no **Decommission**: **Delete** them and stop the service on the host.

The deb and rpm package scripts create the `edgeweir` user, `/var/lib/edgeweir-node` (0700) and `/var/cache/edgeweir-node` (0750); for tar.gz `install.sh` creates them and installs the unit to `/etc/systemd/system/`. Installed files: [Files and directories](../node/README.en.md#files-and-directories).

## Manual installation

Without `install.sh`, first [verify the releases](#verifying-releases), then follow the install form. Put the token in a file only root can read and delete it after enrollment.

### deb / rpm

```bash title="Node (Debian, Ubuntu)"
sudo apt-get install ./edgeweir-openresty_1.31.1.1-3_amd64.deb \
  ./edgeweir-openresty-modsecurity_1.31.1.1-3_amd64.deb ./edgeweir-node_<version>_amd64.deb
```

```bash title="Node (RHEL, Rocky, AlmaLinux)"
sudo dnf install ./edgeweir-openresty-1.31.1.1-3.x86_64.rpm \
  ./edgeweir-openresty-modsecurity-1.31.1.1-3.x86_64.rpm ./edgeweir-node-<version>-1.x86_64.rpm
```

```bash title="Node"
sudo install -m 0600 /dev/stdin /root/edgeweir-token <<< '<one-time token>'
sudo edgeweir-node enroll --server https://cdn-admin.example.com:8443 \
  --token-file /root/edgeweir-token --ca-sha256 <CA fingerprint>
sudo rm /root/edgeweir-token
sudo systemctl disable --now openresty 2>/dev/null || true
sudo systemctl enable --now edgeweir-node
```

The packages do not enable the service: enable it after enrollment. On a host with OpenResty's own packages, disable their `openresty.service` (the unit declares `Conflicts=openresty.service`).

### tar.gz

Needs `edgeweir-openresty` installed (deb or rpm).

```bash title="Node"
tar -xzf edgeweir-node_<version>_linux_amd64.tar.gz
cd edgeweir-node_<version>_linux_amd64
sudo groupadd --system edgeweir
sudo useradd --system --gid edgeweir --home-dir /var/lib/edgeweir-node --no-create-home \
  --shell /usr/sbin/nologin edgeweir
sudo install -m 0755 edgeweir-node /usr/bin/edgeweir-node
sudo install -d -m 0755 /usr/share/edgeweir-node/lua/edgeweir
sudo install -m 0644 lua/edgeweir/*.lua /usr/share/edgeweir-node/lua/edgeweir/
sudo install -D -m 0644 systemd/edgeweir-node.service /etc/systemd/system/edgeweir-node.service
sudo install -d -o edgeweir -g edgeweir -m 0700 /var/lib/edgeweir-node
sudo install -d -o edgeweir -g edgeweir -m 0750 /var/cache/edgeweir-node
sudo systemctl daemon-reload
```

Then enroll and start as in [deb / rpm](#deb--rpm).

### Docker

```bash title="Node"
docker run -d --name edgeweir-node --restart unless-stopped \
  -p 80:80 -p 443:443 -p 443:443/udp \
  -v edgeweir-node:/var/lib/edgeweir-node \
  -v edgeweir-node-cache:/var/cache/edgeweir-node \
  ghcr.io/marvinli001/edgeweir-node:<version>
read -rs EDGEWEIR_TOKEN && export EDGEWEIR_TOKEN
docker exec -e EDGEWEIR_TOKEN edgeweir-node edgeweir-node enroll \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA fingerprint>
```

| Item | Behavior |
| --- | --- |
| Entry point | `edgeweir-node supervise --manage-nginx`; the agent, nginx master and workers run as uid 10001 |
| Enrollment | The running node checks the state directory every 2 seconds and connects once `enroll` has written the identity; before that every host answers `404 unknown-host` |
| Volumes | `/var/lib/edgeweir-node`: identity and LKG configuration, deleting it loses the enrollment; `/var/cache/edgeweir-node`: cache, removed with the container when not mounted |
| Health check | Built-in `edgeweir-node healthcheck`, every 10 seconds, 15-second start period, `unhealthy` after 3 failures |
| Ports | Publish extra listener ports and L4 port pools as well, or use `--network host`, see [Ports and firewall](#ports-and-firewall) |
| Flags | `-e EDGEWEIR_<FLAG>=<value>`, see [Node configuration](../node/configuration.en.md) |
| GeoIP | IPinfo Lite (countries, ASNs) is bundled |

## Enrollment and mTLS

| Item | Behavior |
| --- | --- |
| Token | One-time, prefix `ewt_`; given through `EDGEWEIR_TOKEN`, `--token-file` (`EDGEWEIR_TOKEN_FILE`) or `--token`; command-line flags win over environment variables, and a token plus a token file on the same level is an error; removed from the environment once read; `--token` shows in the process list and prints a warning |
| CA pinning | One certificate of the chain the node channel presents must have the DER SHA-256 given by `--ca-sha256`; it is the only root for verifying the server certificate and host name (the host of `--server` unless `--server-name` is given); the token is sent only after that |
| Keys | The node generates an ECDSA P-256 key and CSR; the console issues the node certificate (valid for 30 days) and returns the CA certificate, whose hash, issuer, usage and public key the node checks |
| Files | `node.key` (0600), `node.crt`, `ca.crt`, then `identity.json` last; run as root with a state directory owned by `edgeweir`, the files are handed to that user |
| Afterwards | Every RPC uses mTLS and trusts only the internal CA; the certificate renews itself when less than a third of its lifetime remains, see [Certificate rotation](../node/operations.en.md#certificate-rotation) |
| Already enrolled | `enroll` refuses an existing identity unless `--force` is given; `--force` is refused while the node runs (stop the service first) and deletes the old identity and LKG configuration |
| Failures | A used or expired token: `console rejected the enrollment token (expired or already used)`; wrong CA: `CA pin mismatch` |

`enroll` flags:

| Flag | Default | Description |
| --- | --- | --- |
| `--server` | required | Node channel URL: `https://<host>:8443`, or the WebSocket entry `wss://<host>` (`ws://` for a plain-HTTP console), no path |
| `--ca-sha256` | required | SHA-256 of the internal CA certificate (DER), hex (a `sha256:` prefix and colons are accepted) |
| `--token-file` | none | Token file (surrounding whitespace ignored) |
| `--token` | none | Token; prefer `EDGEWEIR_TOKEN` or `--token-file` |
| `--server-name` | host of `--server` | TLS server name to verify |
| `--state-dir` | `/var/lib/edgeweir-node` | State directory |
| `--force` | off | Replace an existing identity |
| `--timeout` | `30s` | Enrollment RPC timeout |
| `--log-level`, `--log-format` | `info`, `text` | Log level and format |

WebSocket entry: TLS runs inside the WebSocket and is terminated by the console, so CA pinning and mTLS are unchanged; the certificate of the `wss://` address itself is checked against the system roots; the handshake follows `HTTPS_PROXY`, `HTTP_PROXY` and `NO_PROXY`. See [The node channel's WebSocket entry](networking.en.md#the-node-channels-websocket-entry).

## Ports and firewall

Nodes accept user traffic on these ports; open them in the host firewall and the cloud security group. Nodes only connect out to the console's node channel and need no inbound port for the console. Outbound destinations: [Ports](../node/README.en.md#ports).

| Port | Use | When |
| --- | --- | --- |
| 80/TCP | HTTP, ACME HTTP-01 | Always |
| 443/TCP | HTTPS | A site of the cluster with a certificate is bound to 443 |
| 443/UDP | HTTP/3 | A site bound to 443 has HTTP/3 on, see [Listening ports](../guide/https.en.md#listening-ports) |
| The cluster's extra HTTP / HTTPS ports (TCP) | HTTP, HTTPS | Set on the cluster's **Settings** tab, see [The cluster's listener ports](../guide/https.en.md#the-clusters-listener-ports) |
| UDP of the same number as an extra HTTPS port | HTTP/3 | A site bound to that port has HTTP/3 on |
| The cluster's port pools | [L4 forwarding](../guide/l4.en.md) | TCP for TCP pools, UDP for UDP pools, both for TCP + UDP; opening only the ports L4 apps use is enough |

| Item | Notes |
| --- | --- |
| Privileges | Port pools hold 1024–65535 only; extra ports below 1024 are bound by the nginx master like 80 and 443; the systemd unit and the image need no extra privileges |
| Container nodes | Publish the ports of the pools, for example `-p 9000:9000 -p 9000:9000/udp`, a range as `-p 20000-20100:20000-20100`; use host networking (`--network host`) for large pools |
| Port changes | Creating or deleting an L4 app or changing its port, and adding or removing the cluster's extra listener ports, reload the node; old workers keep serving open connections, see [Reloads and long connections](../guide/l4.en.md#reloads-and-long-connections) and [How long old workers stay](../node/configuration.en.md#how-long-old-workers-stay) |
| Port ranges | Every port takes a listening socket; with UDP one per worker (`reuseport`). The node raises `worker_connections` by the number of listening sockets and its own open-file soft limit to the hard limit |
| Port in use | The reload does not take effect, the revision is recorded as failed and the node keeps serving the previous configuration, see [Node troubleshooting](../node/troubleshooting.en.md#port-conflicts) |

## Client IP

**Client IP** on a cluster's **Settings** tab decides the visitor address of the nodes' HTTP and HTTPS listeners: rules' `ip.src`, bans, CC, access logs, `{{client_ip}}` of error pages, the allowed addresses of maintenance mode, the PURGE limit per client address and `X-Real-IP` towards the origins all use it. Saving publishes a configuration revision; nodes reload.

| Source | Behavior | For |
| --- | --- | --- |
| Direct (default) | The TCP peer | Visitors connect to the nodes directly |
| PROXY protocol | Every TCP connection must start with a PROXY protocol v1 or v2 header, connections without one are closed; the visitor address is the header's source address (the TCP peer for `UNKNOWN`). HTTP/3 (QUIC) has no PROXY protocol: the UDP peer | A layer-4 load balancer that sends the PROXY protocol |
| Trusted proxy header | When the peer is inside the **Trusted CIDRs** (1–64), the **Header** (`X-Forwarded-For`, `X-Real-IP`, `CF-Connecting-IP`, `True-Client-IP` or a custom name) names the visitor; otherwise the peer's own address. `X-Forwarded-For` is read from right to left past trusted addresses; the first untrusted one is the visitor | A layer-7 proxy or another CDN in front of the nodes |

| Item | Notes |
| --- | --- |
| Headers towards origins | `X-Real-IP` is the visitor address; `X-Forwarded-For` is the received `X-Forwarded-For` followed by the direct peer (with the PROXY protocol, the balancer). In direct mode **Drop the client's X-Forwarded-For** sends the direct peer alone |
| `ip.peer` | The rule field `ip.peer` is always the direct peer |
| Trusted proxies | Addresses inside the trusted CIDRs are never banned and not counted per address by CC |
| Header format | Parsed by nginx's realip module: a value that is no address leaves the peer's address; `address:port` takes the address; a single-value header such as `X-Real-IP` with commas takes its last item; an invalid item before trusted addresses in `X-Forwarded-For` leaves the last valid trusted address; when every address is trusted, the leftmost one |
| Kernel bans | Match the TCP peer only: with the last two sources they do not apply to visitor addresses, see [Load balancers in front of the nodes](../guide/bans.en.md#load-balancers-in-front-of-the-nodes) |
| Probes | Region probes send a PROXY v1 header first to listeners that require one |
| Node capability | PROXY protocol, trusted proxy header and **Drop the client's X-Forwarded-For** need `client-ip-v1`; while an active node of the cluster lacks it, the card shows "Some nodes in the cluster do not support it" |
| Audit | `cluster.client_ip_update` |

> [!WARNING]
> With the PROXY protocol, any client that reaches a node port directly can claim any address in the header: open the nodes' HTTP and HTTPS ports to the load balancer only. List only the addresses your proxies actually use as trusted CIDRs: an address there can claim any visitor address.

## Regional probes

A regional probe measures every node's scheduling addresses from its region; the results drive backup IPs and scheduling, see [Regional probes and scheduling](../guide/scheduling.en.md). A probe is the `probe` mode of `edgeweir-node`: it runs no OpenResty, listens on no port, and has an identity separate from nodes. Its enrollment token comes from **System settings** → **Monitoring** → **Add probe** and is shown once.

| Item | Requirement |
| --- | --- |
| Runs as | The node image (Docker, amd64 / arm64), or the systemd unit and binary on Linux amd64 / arm64 |
| Outbound | The node channel URL (8443 by default) and the listener ports on the nodes' scheduling addresses |
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

The edgeweir-node deb and rpm packages include `edgeweir-probe.service` (not enabled), and the tar.gz has the same unit under `systemd/`. The packages depend on `edgeweir-openresty`, which probe mode does not start; [verify the releases](#verifying-releases) first, and do not enable `edgeweir-node.service` on a probe host.

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
| `--server` | None (required on the first run) | Node channel URL, same forms as `enroll` |
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
| The node channel URL changes | From v1.2.0 the probe gets the new URL with every round of targets and, once its check passes, switches and writes it to `probe.json`; one that lost the console runs `edgeweir-node set-server --probe --server <new URL>`, see [Changing the node channel URL](networking.en.md#changing-the-node-channel-url) |
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
    latest                      # version number, e.g. 1.6.2
    v1.6.2/
      checksums.txt
      checksums.txt.sigstore.json
      edgeweir-node_1.6.2_amd64.deb
      edgeweir-node-1.6.2-1.x86_64.rpm
      edgeweir-node_1.6.2_linux_amd64.tar.gz
      edgeweir-openresty_1.31.1.1-3_amd64.deb
      edgeweir-openresty-1.31.1.1-3.x86_64.rpm
      edgeweir-openresty-modsecurity_1.31.1.1-3_amd64.deb
      edgeweir-openresty-modsecurity-1.31.1.1-3.x86_64.rpm
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

The release source for signed node upgrades is set in **System settings → Node release source** and in the node's `EDGEWEIR_UPGRADE_SOURCE`, independent of this mirror; see [Node upgrades](../guide/node-upgrades.en.md#private-mirrors-and-own-releases).

## Troubleshooting

Errors during installation and enrollment. Connection, configuration, certificate and cache problems of running nodes: [Node troubleshooting](../node/troubleshooting.en.md).

| Symptom | Cause | Fix |
| --- | --- | --- |
| `no enrollment token` | `sudo` did not keep `EDGEWEIR_TOKEN` | Run the generated command as is: `export` and `sudo --preserve-env=EDGEWEIR_TOKEN` |
| `the enrollment token is malformed (expected ewt_...)` | The token was copied incompletely | Copy the install command again |
| `--server must be an https://, wss:// or ws:// URL` | Missing or wrong scheme | Use the "Node channel" URL from **System settings** |
| `systemd is required (use --no-start to only install and enroll)` | No systemd on the host | Use a systemd host, add `--no-start` to install and enroll only, or use [Docker](#docker) |
| `unsupported architecture: …` | Neither amd64 nor arm64 | Use an amd64 or arm64 host |
| `could not determine the latest edgeweir-node version; pass --version` | The mirror has no `latest`, and GitHub is unreachable or has no release | Pass `--version`, or set up the [downloads mirror](#downloads-mirror) |
| `edgeweir-openresty needs glibc 2.34 or later` | The distribution is too old | Use RHEL, Rocky, AlmaLinux 9, Debian 12, Ubuntu 22.04 or later |
| `checksums.txt does not list exactly one ... package of edgeweir-openresty...` | The mirror or release lacks the package, or holds several versions for one architecture | Complete the mirror directory from `checksums.txt`; add `--no-modsecurity` for a release without the ModSecurity module |
| `edgeweir-openresty comes as .deb and .rpm only` | A tar.gz install on a host without `dpkg`, `rpm` and an installed `edgeweir-openresty` | Use a host with deb or rpm package management, or [Docker](#docker) |
| `cosign signature verification FAILED`, `SHA-256 verification FAILED` | Downloaded content does not match the signature or checksum | Check the download source and the mirror directory; never skip verification |
| `cannot reach the node channel` | Wrong address or DNS for `--server`, the firewall or security group blocks the port, or the node channel URL is a local or private address | Check the address and DNS and open the port; `curl -k https://<address>:8443/` on the node should return 404. For a wrong address, change "Node channel" in **System settings** and generate a new install command |
| `does not present the console's node CA`, `CA pin mismatch` | A proxy or CDN terminates TLS in front of the node channel (including a proxied Cloudflare record), or `--server` points at another service | Connect directly or through [layer-4 passthrough](networking.en.md#node-channel-passthrough); switch a Cloudflare record to DNS only |
| `answers 404: the console's WebSocket entry is closed` | The WebSocket entry of a `wss://` / `ws://` URL is closed | Save a `wss://` node channel URL in **System settings** or set `EDGEWEIR_NODE_API_WEBSOCKET=true`, see [The node channel's WebSocket entry](networking.en.md#the-node-channels-websocket-entry) |
| `cannot connect through <URL>: wss:// and ws:// node channel URLs need 0.2.0 or later` | `--version` names a version before 0.2.0 | Use 0.2.0 or later |
| `console rejected the enrollment token (expired or already used)` | The token expired or was used | Generate a new install command |
| `node is already enrolled (use --force to replace the identity)` | The host already has a node identity (`/var/lib/edgeweir-node/identity.json`) | Keep the enrollment; to replace the identity see [Re-enrollment](../node/operations.en.md#re-enrollment) |
| `edgeweir-node is installed but not healthy after 90s` | The node did not apply a configuration within 90 seconds: node channel unreachable, certificate refused, a port in use, or OpenResty failed to start | Run `sudo edgeweir-node diagnose` and `journalctl -u edgeweir-node -n 50`; after fixing, run the same command again (it only restarts and checks) |
| Enrollment times out, or the node stays at "Awaiting heartbeat" | The service is not running (for example `--no-start`), or the mTLS connection fails | See [Node troubleshooting](../node/troubleshooting.en.md#connection) |
| `probe is not enrolled: the first run needs --server, --ca-sha256 and a probe token` | The probe's first start lacks enrollment settings (exit status 2) | Set `EDGEWEIR_SERVER`, `EDGEWEIR_CA_SHA256` and `EDGEWEIR_TOKEN`, then start again |
| `probe enrollment failed: console rejected the enrollment token (expired or already used)` | The probe token expired or was used | Generate a new one with **Add probe** |
| A probe container shows `unhealthy` | The image's health check asks the data plane | Turn the container health check off, see [Container](#container) |
