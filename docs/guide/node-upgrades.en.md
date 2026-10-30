# Node upgrades

Signed batch upgrades from the console (canary, promotion, verification, automatic rollback), manual upgrades, downgrades and node capabilities.

## Concepts

| Term | Definition |
| --- | --- |
| Canary group | The canary node group. The other nodes wait as **Waiting for the canary group** until promotion |
| Release source | The base URL of the node release files, one `v<version>/` directory per release |
| Supervisor | `edgeweir-node supervise --manage-nginx`, which downloads, verifies, switches and rolls back |
| Base install | The `edgeweir-node` and Lua modules installed by the package or image; signed upgrades are kept in the state directory under `upgrades/releases/` |
| Node capability | A feature identifier a node reports. When a node lacks a capability the cluster's configuration needs, **Clusters & nodes** shows **Upgrade required** |

## Ways to upgrade

| Way | Updates | For |
| --- | --- | --- |
| [Signed upgrade from the console](#upgrade-nodes) | Agent binary and Lua modules | Nodes running `supervise` under systemd or in a container |
| [Package or image](#manual-upgrades) | Agent, Lua, supervisor, cosign, OpenResty | Every node; fixes to OpenResty and the supervisor arrive only this way |

## Prerequisites

| Item | Requirement |
| --- | --- |
| Cluster nodes | Every active node of the cluster: a heartbeat within 45 seconds, a healthy data plane, the cluster's current revision applied, Linux, an architecture (amd64 or arm64) the release has, and `self-upgrade-v1` reported. A node that shows **Upgrade required** because it lacks a [capability](#node-capabilities) of the current configuration only needs an earlier revision applied |
| Size | At most 1000 active nodes per cluster |
| Concurrency | No other upgrade in progress for nodes of the cluster |
| Supervisor | The node runs `supervise --manage-nginx` (the default of the node image and the systemd unit) and finds `cosign`; when `EDGEWEIR_UPGRADE_PUBLIC_KEY` is set, that file exists |
| Release files | The release source's `v<version>/` directory has `checksums.txt`, `checksums.txt.sigstore.json` and the `edgeweir-node_<version>_linux_<arch>.tar.gz` listed in `checksums.txt` |

Nodes that do not meet the supervisor requirements do not report `self-upgrade-v1`. Nodes installed with `--allow-unsigned` get no `cosign`; without `cosign` on the host a node cannot be upgraded remotely. Installing nodes: [Adding nodes](../deploy/nodes.en.md).

## Upgrade nodes

1. Open **Clusters & nodes**, select the cluster, and switch to the **Releases** tab (`/clusters?tab=releases`).
2. In **Node upgrades**, click **New upgrade**.
3. Enter **Target version**, for example `1.6.2` (the tag `v1.6.2` works too), and select **Canary node group**.
4. Click **Start upgrade**. While the dialog lists **Nodes not ready**, it cannot start: deal with those nodes first (see below).
5. Wait until the canary nodes show **Succeeded** and stay healthy for 30 seconds.
6. Click **Promote remaining nodes**. The rest are upgraded in batches: at most a quarter of them at a time (at least one, by node name); when a node succeeds the next one is released.
7. Verify: the upgrade shows **Succeeded**; **Agent / engine** of the nodes on the **Nodes** tab shows the target version.

An upgrade restarts the node's agent. OpenResty runs under the supervisor: it keeps serving during an upgrade and reloads the configuration, and bans, CC state and rate-limit counters survive; a rollback to an older version restarts it. An upgrade is not guaranteed to be hitless; choose a canary group whose traffic other nodes can absorb.

### The dialog

| Item | Behavior |
| --- | --- |
| Target version | Prefilled with the latest version of the release source: the latest GitHub release for the default source, a mirror's `latest` file otherwise (as `install.sh` reads it), cached by the console for 10 minutes; empty when it cannot be read. When every active node already runs that version or a newer one, the dialog says "Every node runs … or newer" and cannot start |
| Canary node group | Defaults to a canary node group (**Canary** turned on in the group's settings) with active nodes, else the non-default group with the fewest active nodes. Options show the active node count; when the chosen group holds every node (more than one), the dialog says "The group holds all … nodes; none remain for the rollout" |
| Nodes not ready | Active nodes of the cluster that stop the upgrade, with the reason: Upgrade in progress, Offline, Not Linux, Unsupported architecture, No signed upgrades, Data plane unhealthy, Configuration not applied, Behind. A node showing **Upgrade required** that runs an earlier revision is not behind |

### Health window

| Item | Behavior |
| --- | --- |
| Condition | The canary nodes report the target agent version, revision and content hash, with a healthy data plane |
| Duration | Promotion is possible after at least 30 seconds (two heartbeat intervals) of that ("Promotable after the canary group is healthy for 30 s") |
| Restart | An unhealthy report or a heartbeat gap above 45 seconds starts the window again |

### States

| Upgrade state | Meaning |
| --- | --- |
| Canary | The canary group is upgrading or being observed |
| Rollout | The other nodes are upgrading in batches |
| Succeeded / Failed / Cancelled | Final result. The latest upgrade lists its nodes; each earlier finished upgrade is one row with version, result and time; the arrow at the end of the row expands its nodes and errors |

| Node state | Meaning |
| --- | --- |
| Waiting for the canary group | A non-canary node waiting for promotion |
| Queued | Promoted, waiting for the previous batch |
| Pending | Released, not started by the node yet; shows the deadline |
| Upgrading | The node is downloading, verifying or in its trial run; shows the deadline |
| Succeeded / Failed / Cancelled | The node's result; **Diagnostics** shows what the node reported |

### Cancellation and expiry

| Action | Behavior |
| --- | --- |
| **Cancel queued work** | Cancels node tasks in **Waiting for the canary group**, **Queued** and **Pending**; upgraded nodes keep their version; not possible while a node is **Upgrading** |
| Expiry | A node task not finished 30 minutes after release is recorded as "Upgrade task expired" and the whole upgrade fails; canary nodes are released when the upgrade is created, the others when their batch is released. The observation before promotion has no time limit |
| Disabling or deleting a node | Its task is recorded as "Node disabled or deleted; not upgraded" and the other nodes continue; once every canary node is disabled or deleted the upgrade cannot be promoted: cancel it and start a new one |

## Checks on the node

The node accepts only the release source configured on the node (`--upgrade-source` / `EDGEWEIR_UPGRADE_SOURCE`, default `https://github.com/marvinli001/edgeweir-node/releases/download`). The URLs the console sends must match the target version, the node's Linux architecture and the expected file names exactly.

1. Downloads `checksums.txt` (at most 2 MiB), `checksums.txt.sigstore.json` (at most 4 MiB) and the archive (at most 128 MiB) with a 90-second HTTP timeout and at most 4 minutes for the whole preparation. Redirects stay on the same scheme and host, at most 5; with the default release source GitHub's download hosts (`release-assets.githubusercontent.com`, `objects.githubusercontent.com`) are allowed as well.
2. Verifies `checksums.txt` with `cosign`: certificate identity `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<version>`, issuer `https://token.actions.githubusercontent.com`.
3. Checks that the SHA-256 in the task matches the signed list, then verifies the archive's SHA-256.
4. Unpacks while refusing path traversal, links, special files and duplicate entries; at most 512 entries, 128 MiB per file and 256 MiB in total; checks the ELF architecture and the version `edgeweir-node version` prints.
5. Places the binary and Lua in a private directory `upgrades/releases/<task ID>/` (0700) of the state directory and switches after persisting its state.

The console cannot send shell commands, change the public key nodes trust or skip signature checks. Plain-HTTP test mirrors are verified the same way.

## Supervisor and rollback

| Item | Behavior |
| --- | --- |
| Exclusion | The supervisor holds the exclusive lock `upgrades/supervisor.lock` in the state directory, so a second process cannot mistake a running trial for an interrupted one; the private Unix socket `upgrade.sock` is mode 0600 |
| Success | The candidate completes mTLS calls and applies the desired configuration (applied, healthy data plane, revision equal to the console's latest), and stays healthy for at least 10 seconds within a 90-second trial; the agent reports to the supervisor every 5 seconds, independent of the heartbeat interval |
| Rollback | Failing within 90 seconds, exiting during the trial or a supervisor restart restores the previous binary, Lua and configuration snapshot |
| Downgrades | A version older than the running one is refused ("Version … was rejected; the previous version is kept"); nodes started with `--upgrade-allow-downgrade` accept it, see [Rolling back to an older version](#rolling-back-to-an-older-version) |
| Results | The result stays on disk until the console confirms it; a failed confirmation write does not drop it; failed downloads, verification or persistence are never reported as success |
| Never rolled back | Identity keys, certificates, credentials and statistics cursors do not go back with the binary |
| Disk | Only the current, the previous and the version being prepared are kept |

| Component | Updated by |
| --- | --- |
| Agent binary, Lua | Signed upgrades, or the package or image |
| Supervisor, `cosign`, OpenResty | The node image or the deb / rpm packages only; security fixes in these components need the full image or system packages |

When a package or image update changes the base install's binary or Lua, the supervisor takes the new install instead of an older signed upgrade in the state directory; an upgrade task not yet confirmed is recorded as "The task for version … was superseded by a local package update". The console shows the running agent's version; `edgeweir-node version` from the system path shows the base install's version.

## Manual upgrades

[Verify the releases](../deploy/nodes.en.md#verifying-releases) first. Package upgrades restart a running `edgeweir-node.service` from the package scripts (`systemctl try-restart`); OpenResty restarts with the service.

| Install form | Command |
| --- | --- |
| Install command | Run the original install command again on the enrolled host (no token needed) with `--version <version>` appended: it verifies and installs that version, restarts the service and runs the health check |
| deb | `sudo apt-get install ./edgeweir-node_<version>_amd64.deb` (list the new `edgeweir-openresty` and `edgeweir-openresty-modsecurity` packages too when OpenResty changes) |
| rpm | `sudo dnf install ./edgeweir-node-<version>-1.x86_64.rpm` (as above) |
| tar.gz | Replace `/usr/bin/edgeweir-node` and the Lua modules as in [tar.gz](../deploy/nodes.en.md#targz), then `sudo systemctl restart edgeweir-node` |
| Container | Pull the new tag and recreate the container with the same volumes and flags: `docker pull ghcr.io/marvinli001/edgeweir-node:<version>` |

```bash title="Node (enrolled)"
curl -fsSL https://cdn-admin.example.com/install.sh | sudo bash -s -- \
  --server https://cdn-admin.example.com:8443 --ca-sha256 <CA fingerprint> --version 1.6.2
```

Verify: `edgeweir-node version` prints the new version; **Agent / engine** in **Clusters & nodes** shows it.

## Rolling back to an older version

A failed signed upgrade rolls back by itself. To go back to an older version on purpose:

| Way | Steps |
| --- | --- |
| deb | `sudo apt-get install --allow-downgrades ./edgeweir-node_<older version>_amd64.deb` |
| rpm | `sudo dnf downgrade ./edgeweir-node-<older version>-1.x86_64.rpm` |
| Container | Recreate the container with the older tag and the same state volume |
| Console task | Set `EDGEWEIR_UPGRADE_ALLOW_DOWNGRADE=true` on the nodes and restart the service; the dialog cannot start while every node runs the target version or newer, so start it through the API with `POST /api/v1/node-upgrades` |

| Constraint | Detail |
| --- | --- |
| Base install first | After a package or image downgrade the supervisor takes the new base install; a newer signed upgrade in the state directory is no longer used |
| Capabilities | An older version that lacks a capability the cluster's configuration needs keeps the last configuration it applied and shows **Upgrade required**, see [Node capabilities](#node-capabilities); as the candidate of a signed task it cannot apply the current configuration and rolls back after 90 seconds |
| Major versions | Across major versions the state directory may be incompatible; within one major version it is compatible |
| OpenResty | The supervisor stops OpenResty before switching to an older binary and starts it again |

## Private mirrors and own releases

| Item | Setting |
| --- | --- |
| Console release source | Where the console reads release manifests, set in **System settings → Node release source**, see [Node release source](system.en.md#node-release-source) |
| Node release source | The node's `EDGEWEIR_UPGRADE_SOURCE`, the same `v<version>/` layout as the console release source |
| Mirror requirements | The mirror serves the files directly; nodes refuse cross-origin redirects |
| Own signing key | Set `EDGEWEIR_UPGRADE_PUBLIC_KEY` on the node to a public key the operator deploys there; the node verifies against it instead of the public transparency log, and changing the console's database cannot change the key a node trusts |
| Plaintext mirrors | `EDGEWEIR_UPGRADE_ALLOW_HTTP=true` only for a deliberately chosen local test or air-gapped mirror; default `false` |

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_UPGRADE_SOURCE=https://mirror.example.com/edgeweir-node
EDGEWEIR_UPGRADE_PUBLIC_KEY=/etc/edgeweir-node/release.pub
```

Run `sudo systemctl restart edgeweir-node` afterwards. Flag table: [Node configuration](../node/configuration.en.md#upgrades-supervise); signing and verifying: [Sigstore documentation](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/).

## Node capabilities

Nodes report their capabilities in every heartbeat. The console derives the capabilities each cluster's configuration needs when it compiles it.

### Capabilities a configuration needs

A node without one shows **Upgrade required**; it keeps using the last configuration it applied and refuses configurations with unknown capabilities or enum values.

| Capability | Needed for |
| --- | --- |
| `tls-v1` | Sites with HTTPS settings (the **HTTPS** tab has been saved) |
| `http01-v1` | ACME HTTP-01 validation |
| `tls-pending-domains-v1` | Domains served over HTTP until the certificate covers them |
| `http3-v1` | Sites with HTTP/3 on |
| `brotli-v1`, `zstd-v1` | Sites with Brotli or Zstandard compression |
| `modsecurity-v1` | Sites with the OWASP CRS; the node needs `edgeweir-openresty-modsecurity` |
| `rules-v1` | Site rules, global rules, **Allow** or **Block** IP lists |
| `rules-v2` | Rule engine extensions: functions and the new fields, expression targets and query parameter edits, origin overrides, compression rules, the new override settings, cache rule expression conditions and browser TTLs, bulk redirects, origin groups, see [Rules](rules.en.md#node-capabilities-and-publishing) |
| `rules-v3` | Expression fields and header values: cookies and query parameters by name, new fields such as User-Agent and Referer, new functions and wildcard comparisons, expression values for request headers, response headers and query parameters, appended response headers, redirect 303, `{{time}}` and `{{path}}` in error pages, see [Rules](rules.en.md#node-capabilities-and-publishing) |
| `rules-body-v1` | Rules that read request body fields, or a rules body limit |
| `waf-v2` | The ban, respond, close and skip rule actions; access log lines from `log` rules; rate-limit bans; CRS overrides and exclusions by path |
| `challenge-v1` | The challenge action, Under Attack, CC mitigation, or session affinity (which needs challenge keys) |
| `challenge-v2` | Verified search engine crawlers, crawler fields, challenge page texts, bans after failed challenges |
| `ja4-v1` | Rules that read or count by `tls.ja4`, or access logs recording JA4 |
| `geoip-city-v1` | Rules or geo access control by country (or subdivision); reported when the node has country data |
| `geoip-asn-v1` | Rules or geo access control by ASN; reported when the node has ASN data |
| `geoip-subdivision-v1` | Rules using `ip.geoip.subdivision`, or geo access control by subdivision; reported when the node has a City MMDB, checked by the console only; older nodes that do not report `geoip-country-v1` count `geoip-city-v1` instead |
| `access-logs-v1` | Access log sampling |
| `access-logs-v2` | A site logs blocked, challenged and authentication-refused requests always, or records query strings, request headers or the peer address, see [Access logs](access-logs.en.md#enable-access-logs) |
| `access-auth-v1` | Access authentication rules |
| `access-control-v1` | A site's access control |
| `error-pages-v1` | Site error pages |
| `site-content-v1` | Cache keys that drop parameters, caching responses with `Set-Cookie`, the PURGE method, hiding `X-Cache`, error pages for more statuses and redirects, maintenance mode, charsets, the gzip level and largest compressed response, request body limits, origin retry settings |
| `cache-zone-v1` | A node with its own cache size |
| `active-health-v1`, `active-health-grpc-v1` | Active health checks of origin pools; gRPC checks |
| `session-affinity-v1` | Session affinity |
| `origin-http2-v1` | HTTP/2 to origins and end-to-end gRPC |
| `origin-proxy-protocol-v1` | PROXY protocol towards origins |
| `origin-mtls-v1` | Client certificates towards origins |
| `origin-ca-v1`, `origin-ca-rotation-v1` | The Origin CA as the only trust anchor; trusting the previous Origin CA as well during a rotation |
| `multi-certificate-v1` | Several certificates for one site |
| `client-cert-v1` | Visitor client certificates (mTLS) and the `tls.client.*` fields |
| `image-convert-v1` | A site converts images to WebP / AVIF, see [Image format conversion](image-convert.en.md); nodes running with `--image-workers 0` do not report it |
| `edge-ports-v1` | The cluster has extra listener ports, a site is bound to ports other than the defaults, or the HTTPS redirect uses a status, port or excluded domains other than the defaults, see [HTTPS](https.en.md#the-clusters-listener-ports) |
| `client-ip-v1` | The cluster's client IP is not direct (or drops the client's X-Forwarded-For), or a rule reads `ip.peer`, see [Client IP](../deploy/nodes.en.md#client-ip) |
| `domains-v2` | A site (disabled ones included) has `.` suffix or pattern domains, see [Domain forms](domains.en.md#domain-forms) |
| `unknown-host-v1` | The cluster's unknown host settings are not the defaults (a handling other than the unknown host page, or scan protection on), see [Unknown hosts and node IP access](domains.en.md#unknown-hosts-and-node-ip-access) |
| `l4-v1` | The cluster has an enabled [L4 app](l4.en.md): layer-4 forwarding and L4 statistics. Without it the port pools tab, the L4 app list and the dialog warn "Nodes {nodes} in {cluster} lack L4 forwarding and skip configurations with L4 apps until upgraded" |
| `l4-v2` | An L4 app uses a port range, origins on the arriving port or TLS termination, see [L4 forwarding](l4.en.md#port-ranges-and-origin-ports) |
| `stats-sequence-v1` | Sequenced statistics reports; without it the node always shows **Upgrade required** |

Such nodes can be [upgraded](#upgrade-nodes) directly and apply the current configuration afterwards; the target version must have the missing capability, otherwise the candidate cannot apply the current configuration and rolls back after 90 seconds. Console accounts (session or AccessKey) can publish a configuration that needs a new capability, and nodes without it keep their configuration as above; service accounts and background jobs publishing such a configuration get 409 `NODE_CAPABILITY_REQUIRED`.

### Task capabilities

Without one the console refuses that task for the affected cluster; **Upgrade required** is not shown.

| Capability | Task |
| --- | --- |
| `purge-tag-v1` | Purge by host and by Cache-Tag |
| `prefetch-v2` | Prefetch of desktop and mobile variants, sitemap prefetch |
| `debug-logs-v1` | Pull debug logs ("Node version too old" without it), see [Node logs](node-logs.en.md#debug-logs) |

### Other capabilities

Without one **Upgrade required** is not shown; the feature is unavailable for that node or its data is partial.

| Capability | Purpose |
| --- | --- |
| `self-upgrade-v1` | Signed upgrades; reported when the supervisor runs and finds `cosign` |
| `metrics-v1` | Host metrics in the heartbeat (CPU, load, memory, egress, active connections), reported by Linux nodes; without it node metrics and node-metric scheduling conditions show **No data** |
| `stats-dims-v1` | Statistics dimensions (regions, networks, referrers, clients, protocols, block reasons, challenges); while an active node of a cluster lacks it the statistics page notes that data is incomplete |
| `origin-stats-v1`, `rule-log-v1` | Origin fetch statistics per origin; hit counts of `log` rules; partial without them |
| `probe-health-v1` | The health endpoint `/.edgeweir/health` on the edge listeners; when every active node of a cluster has it, [regional probes](scheduling.en.md#probe-methods) probe with HTTP / HTTPS, otherwise TCP connections only |
| `node-logs-v1` | Uploading node logs, see [Node logs](node-logs.en.md) |
| `channel-follow-v1` | Following the node channel address the console gives out (1.2.0 and later); without it the node shows **Upgrade to switch** |
| `bans-v1`, `greylist-v1`, `kernel-ban-v1`, `conn-limit-v1` | Receiving dynamic bans; receiving greylist entries; kernel bans active; understanding the cluster's per-address connection limits (enforced through nftables) |
| `auth-identity-headers-v1`, `certificate-isolation-v1` | Security fixes: identity headers of disabled access authentication rules are removed; a certificate that cannot be loaded is skipped alone. A node that lacks either and does not show **Upgrade required** is marked **Upgrade recommended** under **Agent / engine** (tooltip: "Missing security fixes from newer releases") |
| `encoded-path-exemptions-v1` | Paths with `%2F` or `;` under prefixes a site lists are compared and cached as they are; older nodes ignore the setting |

## API

| Procedure | Endpoint | Purpose |
| --- | --- | --- |
| `upgrades.release` | `GET /node-releases/{version}` | Read a release manifest: archive, SHA-256 and signature URLs per architecture |
| `upgrades.latestVersion` | `GET /node-upgrades/latest-version` | The latest `version` of the release source; `null` when unknown |
| `upgrades.list` | `GET /node-upgrades` | Upgrades with each node's state; `clusterId` limits it to one cluster |
| `upgrades.create` | `POST /node-upgrades` | Start an upgrade: `version` (a leading `v` is dropped), `nodeGroupId` (the canary group) |
| `upgrades.promote` | `POST /node-upgrades/{id}/promote` | Promote the remaining nodes |
| `upgrades.cancel` | `POST /node-upgrades/{id}/cancel` | Cancel queued work |

The endpoints live under `/api/v1`. Read-only AccessKeys can call the GET endpoints only; service accounts cannot call these procedures.

## Limits

| Item | Detail |
| --- | --- |
| Interruption | Signed upgrades restart the agent; OpenResty restarts only on a rollback to an older version or an image or package update. Upgrades are not hitless |
| Platforms | Linux amd64 and arm64 only |
| Scope | Signed upgrades update only the agent binary and Lua |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "These nodes must be online, healthy, in sync and support signed upgrades: …" | The listed active nodes (up to 10, the rest as "+N") are offline, have not applied the current revision (except nodes behind only for a missing capability), have an unhealthy data plane, lack `self-upgrade-v1`, or have an architecture the release lacks | Fix or disable those nodes and retry |
| "The canary node group has no enabled nodes" | The chosen group has no active nodes | Choose another group |
| "An upgrade covers at most 1000 nodes" | The cluster has more than 1000 active nodes | Split the cluster |
| "Use a version such as 0.2.0" | **Target version** is not `major.minor.patch` (a pre-release suffix such as `1.0.0-rc.1` is allowed) | Correct the version |
| "This release manifest is unavailable" | The version does not exist, the release source is unreachable, or the manifest lacks a Linux archive | Check the version and the console release source |
| "The release source must use HTTPS and resolve to an allowed address" | The release source saved in **System settings → Node release source** violates the outbound policy | See [Node release source](system.en.md#node-release-source) |
| "These nodes already have an unfinished upgrade: …" | The listed nodes already have a task, or they are **Upgrading** when cancelling | Wait for the current task to finish |
| "The upgrade has already finished" | Cancelling a finished upgrade | — |
| "Canary nodes have not passed the health window" | The canary group has been healthy for less than 30 seconds | Wait, then promote |
| "Version … was rejected; the previous version is kept" | Download, signature, checksum, archive or version check failed, or the target is older than the running version | See **Diagnostics**; check the node release source and public key |
| "Version … failed the health check and was rolled back" | The candidate did not apply the configuration and stay healthy within 90 seconds | See [Node logs](node-logs.en.md) |
| "Upgrade task expired" | Not finished within 30 minutes of release | Check the node's connection and start again |
| "The task for version … was superseded by a local package update" | The node's package or image was updated before the upgrade was confirmed | The installed version stands; start again if needed |
| "Queued node upgrades were cancelled" | **Cancel queued work** was clicked, or the queued tasks stopped after a node failed | Fix the failed node and start again if needed |
| "Node disabled or deleted; not upgraded" | The node was disabled or deleted during the upgrade | — |
| The node does not report `self-upgrade-v1` | It runs `run`, finds no `cosign`, or the file `EDGEWEIR_UPGRADE_PUBLIC_KEY` names does not exist | Use the default systemd unit or image; install `cosign`; [upgrade manually](#manual-upgrades) |
