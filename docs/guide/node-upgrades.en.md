# Node upgrades

Staged node upgrades: canary, promotion, signature checks and automatic rollback on the node, and node capabilities.

## Concepts

| Term | Definition |
| --- | --- |
| Canary group | The node group upgraded first. Other nodes stay **Waiting for canary** until promotion. |
| Release source | The base URL of node release artifacts, with one `v<version>/` directory per version. |
| Supervisor | `edgeweir-node supervise --manage-nginx`, which downloads, verifies, switches, and rolls back. |
| Node capability | A feature flag a node reports. When the cluster configuration needs a capability a node lacks, **Clusters & nodes** shows **Upgrade required**. |

## Prerequisites

| Item | Requirement |
| --- | --- |
| Cluster nodes | Every enabled node of the cluster: heartbeat within 45 seconds, healthy data plane, current cluster revision applied, Linux, architecture (amd64 or arm64) present in the release, reports `self-upgrade-v1` |
| Count | At most 1000 enabled nodes per cluster |
| Concurrency | No other upgrade is in progress on the cluster's nodes |
| Supervisor | The node runs `supervise --manage-nginx` (the default of the node image and systemd unit) and finds `cosign`; when `EDGEWEIR_UPGRADE_PUBLIC_KEY` is set, that file exists |
| Artifacts | The release source's `v<version>/` directory holds `checksums.txt`, `checksums.txt.sigstore.json`, and the `edgeweir-node_<version>_linux_<arch>.tar.gz` archives listed in `checksums.txt` |

Nodes that do not meet the supervisor conditions do not report `self-upgrade-v1`. An install with `--allow-unsigned` does not install `cosign`; a host without `cosign` cannot be upgraded remotely. Node installation is covered in [Adding nodes](../deploy/nodes.en.md).

## Upgrade nodes

1. Open **Clusters & nodes** and select the cluster.
2. In **Node upgrades**, click **New upgrade**.
3. Enter **Target version** without the `v` prefix, for example `0.1.0`, and select **Canary node group**.
4. Click **Start canary**.
5. Wait until the canary nodes show **Succeeded** and stay healthy for 30 seconds.
6. Click **Promote remaining nodes**. The rest are upgraded in batches: at most a quarter of them at a time (at least one, by node name); when a node succeeds the next one is released.
7. Verify: the upgrade shows **Succeeded**; the **Agent / engine** column of the **Nodes** list shows the target version.

An upgrade restarts the node's agent and OpenResty and is not guaranteed to be hitless. Choose a canary group whose traffic other nodes can absorb.

### Health window

| Item | Behavior |
| --- | --- |
| Condition | The canary node reports the target agent version, revision, and content hash, with a healthy data plane |
| Duration | At least 30 continuous seconds before promotion ("Promote after the canary group stays healthy for 30 seconds.") |
| Restart | An unhealthy report or a heartbeat gap over 45 seconds restarts the window |

### States

| Upgrade state | Meaning |
| --- | --- |
| Canary | The canary group is upgrading or under observation |
| Rollout | The remaining nodes are upgraded in batches |
| Succeeded / Failed / Cancelled | Final result |

| Node state | Meaning |
| --- | --- |
| Waiting for canary | Not in the canary group; waits for promotion |
| Queued | Promoted; waits for the previous batch |
| Pending | Sent; the node has not started; shows the deadline |
| Upgrading | The node is downloading, verifying, or in its trial; shows the deadline |
| Succeeded / Failed / Cancelled | The node's result; **Diagnostics** shows the details the node reported |

### Cancellation and expiry

| Action | Behavior |
| --- | --- |
| **Cancel queued work** | Cancels node tasks that are **Waiting for canary**, **Queued** or **Pending**; completed nodes keep their current version; not possible while a node is **Upgrading** |
| Expiry | A node task not finished 30 minutes after it was sent shows "Upgrade task expired" and fails the upgrade; the canary group's tasks are sent when the upgrade is created, the others when their batch is released. Observing the canary before promotion has no time limit |
| Disabled or deleted node | Its task shows "Node disabled or deleted; not upgraded" and the other nodes go on; with every canary node disabled or deleted the upgrade cannot be promoted: cancel it and start again |

## Checks on the node

A node accepts only its locally configured release source (`--upgrade-source` / `EDGEWEIR_UPGRADE_SOURCE`, default `https://github.com/marvinli001/edgeweir-node/releases/download`). URLs from the console must match the target version, the local Linux architecture, and the expected file names exactly.

1. Downloads `checksums.txt` (up to 2 MiB), `checksums.txt.sigstore.json` (up to 4 MiB), and the archive (up to 128 MiB) with a 90-second HTTP timeout and at most 4 minutes for the whole staging. Redirects are allowed only to the same scheme and host, at most 5; with the default source, GitHub's download hosts are also allowed.
2. Verifies `checksums.txt` with `cosign`: the certificate identity is fixed to `https://github.com/marvinli001/edgeweir-node/.github/workflows/release.yml@refs/tags/v<version>` and the issuer to `https://token.actions.githubusercontent.com`.
3. Checks that the task's SHA-256 equals the signed manifest, then the archive's SHA-256.
4. Refuses path traversal, links, special files, and duplicate entries when unpacking; at most 512 entries, 128 MiB per file, 256 MiB in total; checks the ELF architecture and the version printed by `edgeweir-node version`.
5. Places the program and Lua in a private directory (0700) under the state directory (default `/var/lib/edgeweir-node`), persists the state, then switches.

The console cannot send shell commands, replace the key the node trusts, or skip signature checks. Plain-HTTP test mirrors are verified the same way.

## Supervisor and rollback

| Item | Behavior |
| --- | --- |
| Exclusion | The supervisor holds an exclusive lock in the state directory, so a second process never mistakes a running trial for an interrupted one; its private Unix socket has mode 0600 |
| Success | The candidate completes mTLS, applies the desired configuration (applied, healthy data plane, revision equal to the console's latest), and stays healthy for at least 10 seconds within a 90-second trial |
| Rollback | Failing within 90 seconds, exiting during the trial, or a supervisor restart restores the previous program, Lua, and configuration snapshot |
| Result | Kept on disk until the console acknowledges it; a failed acknowledgment write does not lose it; download, verification, or persistence failures are never reported as success |
| No regression | Identity keys, certificates, credentials, and analytics cursors do not roll back with the program |
| Disk | Only the current, previous, and staging version directories are kept |

| Component | Update path |
| --- | --- |
| Agent program, Lua | Signed self-upgrade |
| Supervisor, `cosign`, OpenResty | Update the node image or deb/rpm packages; security fixes in these components need a full image or package update |

After a package or image update changes the installed base program and Lua, the supervisor prefers the new installation over an older self-upgraded version in the state directory; an unacknowledged upgrade task becomes "The task for version … was superseded by a local package update". The console shows the running agent version; running `edgeweir-node version` from the system path shows the base installation's version.

## Private mirrors and own releases

| Item | Setting |
| --- | --- |
| Console release source | Where the console reads release manifests, set in **System → Node release source**, see [Node release source](system.en.md#node-release-source) |
| Node release source | The node's `EDGEWEIR_UPGRADE_SOURCE`, pointing at the same base URL with `v<version>/` directories |
| Mirror requirements | The mirror serves the files directly; nodes refuse cross-origin redirects |
| Own signing key | Set `EDGEWEIR_UPGRADE_PUBLIC_KEY` on the node to a public key deployed by the operator; the node verifies against that key without the public transparency log; changing the console database cannot change the key a node trusts |
| Plain-HTTP mirror | `EDGEWEIR_UPGRADE_ALLOW_HTTP=true` only for deliberately chosen local test or air-gapped mirrors; default `false` |

```bash title="/etc/default/edgeweir-node"
EDGEWEIR_UPGRADE_SOURCE=https://mirror.example.com/edgeweir-node
EDGEWEIR_UPGRADE_PUBLIC_KEY=/etc/edgeweir-node/release.pub
```

Signing and verification are covered in the [Sigstore documentation](https://docs.sigstore.dev/cosign/signing/signing_with_blobs/).

## Node capabilities

| Capability | Needed for |
| --- | --- |
| `tls-v1` | Sites whose **HTTPS** tab has been saved |
| `http01-v1` | ACME HTTP-01 validation |
| `http3-v1` | Sites with HTTP/3 on |
| `rules-v1` | Site rules, global rules, **Allow** or **Block** IP lists |
| `rules-v2` | Rule engine extensions: functions and the new fields, expression targets and query parameter edits, origin overrides, compression rules, the new override settings, cache rule expression conditions and browser TTLs, bulk redirects, origin groups, see [Rules](rules.en.md#node-capabilities-and-publishing) |
| `access-logs-v1` | Access log sampling |
| `geoip-city-v1` / `geoip-asn-v1` | Rules using GeoIP fields; reported only when the node has country / ASN data |
| `geoip-subdivision-v1` | Rules using `ip.geoip.subdivision`; reported when the node has a City MMDB, checked by the console only; older nodes that do not report `geoip-country-v1` count `geoip-city-v1` instead |
| `stats-sequence-v1` | Sequenced analytics reports; without it the node always shows **Upgrade required** |
| `self-upgrade-v1` | Signed upgrades; reported when the supervisor runs and finds `cosign` |
| `probe-health-v1` | The health endpoint `/.edgeweir/health` on the edge listeners; when every active node of a cluster has it, [regional probes](scheduling.en.md#probe-methods) probe with HTTP / HTTPS, otherwise they only open TCP connections. Never shows **Upgrade required** |
| `metrics-v1` | Host metrics in the heartbeat (CPU, load, memory, egress, active connections), reported by Linux nodes; without it node metrics and node-metric scheduling conditions show **No data**. Never shows **Upgrade required** |
| `l4-v1` | The cluster has an enabled [L4 app](l4.en.md): layer-4 forwarding and L4 statistics. Without it the node refuses configurations with L4 apps, and the port pools tab, the L4 app list, and the dialog warn "Nodes {nodes} of {cluster} lack L4 forwarding and refuse configurations with L4 apps until upgraded" |

When a node lacks a capability the cluster's current configuration needs, or lacks `stats-sequence-v1`, the node list in **Clusters & nodes** shows **Upgrade required**; the node keeps its last-known-good configuration and rejects configurations with unknown capabilities or enum values.

The console account (session or AccessKey) can publish a configuration that needs a new capability; nodes without it keep their configuration as above. Service accounts and background jobs that publish such a configuration get 409 `NODE_CAPABILITY_REQUIRED`.

## API

| Procedure | Endpoint | Purpose |
| --- | --- | --- |
| `upgrades.release` | `GET /node-releases/{version}` | Reads a release manifest: archive, SHA-256, and signature URLs per architecture |
| `upgrades.list` | `GET /node-upgrades` | Upgrades with the state of every node; `clusterId` limits the list to one cluster |
| `upgrades.create` | `POST /node-upgrades` | Starts an upgrade: `version` (without `v`), `nodeGroupId` (canary group) |
| `upgrades.promote` | `POST /node-upgrades/{id}/promote` | Promotes the remaining nodes |
| `upgrades.cancel` | `POST /node-upgrades/{id}/cancel` | Cancels queued work |

The endpoints are under `/api/v1`. Read-only AccessKeys can call the GET endpoints only; service accounts cannot call these procedures.

## Limits

| Item | Description |
| --- | --- |
| Interruption | An upgrade restarts the agent and OpenResty; it is not hitless |
| Platforms | Linux amd64 and arm64 only |
| Scope | Self-upgrade updates only the agent program and Lua |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "Invalid input" | **Target version** has a `v` prefix or is not in `major.minor.patch` form | Remove the `v` prefix |
| "All target nodes must be online, in sync and support signed upgrades" | An enabled node of the cluster is offline, has not applied the current revision, has an unhealthy data plane, lacks `self-upgrade-v1`, or has an architecture missing from the release | Fix or disable those nodes and retry |
| "This release manifest is unavailable" | The version does not exist, the release source is unreachable, or the manifest lists no Linux archive | Check the version and the console release source |
| "The release source must use HTTPS and resolve to an allowed address" | The release source saved in **System → Node release source** fails the outbound policy | See [Node release source](system.en.md#node-release-source) |
| "A node already has an upgrade in progress" | A node has a task, or a node is **Upgrading** during cancellation | Wait for the current task to finish |
| "Canary nodes have not passed the health window" | The canary group has been healthy for less than 30 seconds | Wait, then promote |
| "Version … was rejected; the previous version is kept" | Download, signature, checksum, archive, or version check failed | Read **Diagnostics**; check the node release source and public key |
| "Version … failed the health check and was rolled back" | The candidate did not apply the configuration and stay healthy within 90 seconds | Read the node logs |
| "Upgrade task expired" | Not finished within 30 minutes after it was sent | Check node connectivity and start again |
| "The task for version … was superseded by a local package update" | The node's package or image was updated before the upgrade was acknowledged | The installed version applies; start again if needed |
| "Queued node upgrades were cancelled" | **Cancel queued work** was clicked, or a node failed and the remaining queued tasks stopped | Fix the failed node, then start again if needed |
