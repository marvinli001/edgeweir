# Node operations

Service management, local check commands, re-enrollment, certificate rotation, changing the node channel address, disabling and deleting, migration and removal.

Node actions in the console (details, rename, move to group, disable, delete): [Clusters and nodes](../guide/clusters.en.md#nodes); upgrades: [Node upgrades](../guide/node-upgrades.en.md).

## Service management

| Action | systemd | Container |
| --- | --- | --- |
| Status | `systemctl status edgeweir-node` | `docker ps --filter name=edgeweir-node` |
| Start | `sudo systemctl start edgeweir-node` | `docker start edgeweir-node` |
| Stop | `sudo systemctl stop edgeweir-node` | `docker stop edgeweir-node` |
| Restart | `sudo systemctl restart edgeweir-node` | `docker restart edgeweir-node` |
| Start at boot | `sudo systemctl enable edgeweir-node` / `disable` | `--restart unless-stopped` |
| Logs | `journalctl -u edgeweir-node -f` | `docker logs -f edgeweir-node` |

| Item | Behavior |
| --- | --- |
| Restart | Stops the supervisor, agent and OpenResty and starts them again: open connections drop and shared memory (bans, CC state, rate-limit counters, statistics counters not yet uploaded) is cleared; the agent writes statistics counters to `traffic-spool.json` before it exits |
| No reload command | The unit has no `ExecReload`; the console sends configuration and the node reloads on its own; restart the service after changing local flags |
| While stopped | The node serves no traffic; the console marks it **Offline** after 45 seconds without a heartbeat |
| Start | An enrolled node starts OpenResty with the LKG configuration, then connects to the console; it keeps serving the LKG while the console is unreachable |
| Exit status 2 | Invalid flags or local settings; systemd does not restart it; fix them, then `sudo systemctl restart edgeweir-node` |
| `openresty.service` | The unit declares `Conflicts=openresty.service`; do not enable the service of OpenResty's own packages |
| Probes | Unit `edgeweir-probe.service`, same commands |

## Local check commands

`diagnose`, `bans`, `security`, `accesslog` and `healthcheck` read the state directory and the sockets under `/run/edgeweir-node/`; run them as root or as the service user (`sudo`, or `sudo -u edgeweir`).

| Command | Output | Exit status |
| --- | --- | --- |
| `edgeweir-node healthcheck` | `healthy: revision N, M sites`, or `unhealthy: <reason>` | 0 once the data plane has a site table, else 1 |
| `edgeweir-node diagnose [--json]` | One line per check: `ok`, `warn`, `fail` or `skip`; `--json` adds the agent's full status | 1 on any `fail` |
| `edgeweir-node bans [--list]` | Ban status of the data plane (JSON); `--list` also lists up to 1000 bans | 1 on failure |
| `edgeweir-node security` | Challenge keys, captcha pool, each site's CC level and escalated paths (JSON) | 1 on failure |
| `edgeweir-node accesslog [--site ID] [--json]` | Live requests, one per line: time (UTC, milliseconds), client IP, method, host, path, status, bytes sent, duration, cache status, plus `blocked=<reason>` when blocked; `--json` prints JSON Lines; Ctrl-C ends it | — |
| `edgeweir-node pprof PROFILE [--seconds N] [--output FILE]` | A Go profile of the running agent: `profile` (CPU, `--seconds` default 30, at most 120), `trace`, `heap`, `allocs`, `goroutine`, `block`, `mutex`, `threadcreate`; open with `go tool pprof` / `go tool trace` | 1 on failure |
| `edgeweir-node version` | Version, commit, build time, Go version and platform | 0 |

`diagnose` checks:

| Check | `ok` | `warn` / `fail` |
| --- | --- | --- |
| `identity` | Node ID, name and cluster | `fail`: not enrolled (`identity.json` missing) or unreadable |
| `certificate` | Validity | `warn`: renewal is due (the agent renews while it reaches the console); `fail`: expired, [re-enroll](#re-enrollment) |
| `console` | One mTLS call with the node's identity to the node channel address in use, with its duration | `fail`: address, reason code and error |
| `clock` | Clock offset from the console (against the midpoint of the round trip) | `warn`: 1 second or more; `fail`: 30 seconds or more, enable NTP |
| `agent` | Version from the diagnostics socket and the time since the last successful heartbeat | `warn`: waiting for enrollment; `fail`: agent not running (or another `--diag-socket`), never reached the console since it started, or the last successful heartbeat is older than 3 heartbeat intervals, with the latest error |
| `configuration` | Applied revision | `warn`: behind the console, certificates not loaded; `fail`: the latest revision failed, with the reason |
| `data plane` | Revision and number of sites | `fail`: no answer on the control socket or no site table yet |

`accesslog` ignores sample rates and records only while someone watches (the data plane stops 5 seconds after the last read); without `--site` it includes requests for unknown hosts. Requests missed because they expired or exceeded 2000 per second per node are counted on standard error. Query strings, request headers and the peer address are not shown here.

## Re-enrollment

Replaces the node's identity with a new token: a new node appears in the console and the old one must be deleted.

| Case | Detail |
| --- | --- |
| Certificate expired | The node was offline longer than its certificate's remaining lifetime and could not renew; the console shows **Certificate expired** |
| Node deleted | Deleting a node in the console revokes its certificate |
| Moving to another cluster | Enroll with the target cluster's install command |
| Internal CA changed | The console runs with a new internal CA (for example initialised with a new database); nodes do not support CA rotation |

Install command (systemd hosts):

1. In **Clusters & nodes**, click **Add node** for the target cluster and copy the **Install command**.
2. Run it on the node with `--force` appended. `install.sh` stops the service, runs `edgeweir-node enroll --force` with the new token, then starts the service and runs the health check.
3. Delete the old node in the console.

Manual:

```bash title="Node"
sudo systemctl stop edgeweir-node
sudo install -m 0600 /dev/stdin /root/edgeweir-token <<< '<one-time token>'
sudo edgeweir-node enroll --force --server https://cdn-admin.example.com:8443 \
  --token-file /root/edgeweir-token --ca-sha256 <CA fingerprint>
sudo rm /root/edgeweir-token
sudo systemctl start edgeweir-node
```

Container (the running node holds the run lock, so stop the container first):

```bash title="Node"
docker stop edgeweir-node
read -rs EDGEWEIR_TOKEN && export EDGEWEIR_TOKEN
docker run --rm -e EDGEWEIR_TOKEN -v edgeweir-node:/var/lib/edgeweir-node \
  --entrypoint /usr/local/bin/edgeweir-node ghcr.io/marvinli001/edgeweir-node:<version> \
  enroll --force --server https://cdn-admin.example.com:8443 --ca-sha256 <CA fingerprint>
docker start edgeweir-node
```

| Item | Behavior |
| --- | --- |
| `--force` | Deletes the old identity and LKG configuration, then writes the new identity; refused while the node runs (run lock `run.lock`, waits up to 30 seconds) |
| A running agent | Compares `identity.json` every 10 seconds and exits to restart with the new identity when it changed |
| Kept | The cache directory and `/etc/default/edgeweir-node` |

## Certificate rotation

| Certificate | Lifetime | Rotation |
| --- | --- | --- |
| Node certificate (`node.crt`) | 30 days | When less than a third (10 days) remains or the console asks, the node generates a new key and calls `RenewCertificate`; it writes `node.key.new` / `node.crt.new` and swaps them atomically, finishing an interrupted swap at startup; audit `node.certificate_renew`; node log event "Node certificate renewed" |
| Internal CA (`ca.crt`) | 10 years | Not rotated; renewed node certificates must come from the CA pinned at enrollment |
| Node channel server certificate | Issued and renewed by the console | Nodes trust only the internal CA, so a new server certificate does not affect them, see [Node channel URL and certificate](../deploy/networking.en.md#node-channel-url-and-certificate) |
| Health certificate (`health.crt`) | 10 years, self-signed by the node | Generated again at agent startup when missing, damaged or with less than 30 days left |
| Site certificates | Requested and renewed by the console | Fetched by nodes over mTLS, see [HTTPS and certificates](../guide/https.en.md) |

| Console (node details, **Certificate expires**) | Meaning | Action |
| --- | --- | --- |
| A date | Expiry of the node certificate | — |
| **Expires soon** | Less than 10 days left; the node renews while it reaches the console | Check that the node is online |
| **Certificate expired** | The certificate expired and the node channel refuses it | [Re-enroll](#re-enrollment) |
| **Certificate refused** | The node channel refuses the certificate for another reason (shown on hover) | Check whether the node was deleted or its identity replaced; re-enroll if needed |

Disabled nodes can still renew, so their certificate is valid when they are enabled again.

## Changing the node channel address

Nodes 1.2.0 and later follow the node channel address the console gives out: heartbeat answers carry the console's current address, and the node checks it with the pinned CA and its own certificate before rewriting `identity.json`, keeping the old address as the fallback. A failed check is retried after 1, 5, 15 and 60 minutes; after 3 minutes of failures on the address in use the node switches to the fallback temporarily and tries the main address again every 5 minutes. The console's states (**Not switched**, **Cannot switch**, **On fallback**, **Upgrade to switch**): [Changing the node channel URL](../deploy/networking.en.md#changing-the-node-channel-url).

When the old address went down and the node lost the console, run on the node:

```bash title="Node"
sudo edgeweir-node set-server --server https://new-admin.example.com:8443
```

| Flag | Default | Description |
| --- | --- | --- |
| `--server` | required | The new address: `https://<host>[:port]`, or `wss://` / `ws://`, no path |
| `--server-name` | host of `--server` | TLS server name to verify |
| `--probe` | off | Change a probe's address (state directory `/var/lib/edgeweir-probe` by default) |
| `--state-dir` | `/var/lib/edgeweir-node` | State directory of the identity |
| `--timeout` | `30s` | Timeout of the check |

`set-server` first makes one mTLS call to the new address with the node's identity and only then rewrites `identity.json` atomically (the old address becomes the fallback); identity and certificate stay the same and a running agent switches within seconds. A failed check exits with status 1 and changes no file.

## Disabling and deleting

| Action | On the node |
| --- | --- |
| Disable | The node channel refuses its heartbeats and configuration requests (certificate renewal excepted); the node is left out of DNS records; the node process keeps serving requests that reach it with the last configuration it applied |
| Delete | Revokes the node certificate and deletes the node's logs; the node keeps serving its LKG and logs `the console rejected this node's credentials`; [remove](#removal) a host that is no longer used, or [re-enroll](#re-enrollment) one that stays |

## Migrating to a new host

1. Install and enroll the new host as in [Adding nodes](../deploy/nodes.en.md), in the same node group.
2. Check that the new node is **Online** and its **Applied** column shows the in-sync mark.
3. Disable the old node in the console: disabled nodes are left out of DNS records. Wait for the records' TTL and check that the old node's traffic drops to zero.
4. Delete the old node and remove the software from the old host.

Do not copy the state directory to the new host: the new host uses its own identity.

## Removal

1. Delete the node in the console (revokes its certificate).
2. On the node, by install form:

| Install form | Commands |
| --- | --- |
| deb | `sudo apt-get purge edgeweir-node edgeweir-openresty-modsecurity edgeweir-openresty` |
| rpm | `sudo dnf remove edgeweir-node edgeweir-openresty-modsecurity edgeweir-openresty`, then `sudo rm -rf /var/lib/edgeweir-node /var/cache/edgeweir-node /var/lib/edgeweir-probe` |
| tar.gz | `sudo systemctl disable --now edgeweir-node`; `sudo rm -rf /usr/bin/edgeweir-node /usr/share/edgeweir-node /etc/systemd/system/edgeweir-node.service /var/lib/edgeweir-node /var/cache/edgeweir-node`; `sudo systemctl daemon-reload`; remove the OpenResty packages as for deb or rpm |
| Container | `docker rm -f edgeweir-node`, `docker volume rm edgeweir-node edgeweir-node-cache` |

| Item | Behavior |
| --- | --- |
| Stopping | The deb and rpm removal scripts disable and stop `edgeweir-node.service` and `edgeweir-probe.service` |
| State and cache | deb `purge` deletes `/var/lib/edgeweir-node`, `/var/cache/edgeweir-node` and `/var/lib/edgeweir-probe`; deb `remove` and rpm removal keep them |
| User | The `edgeweir` user and group stay: `sudo userdel edgeweir`; `sudo groupdel edgeweir` when the group remains |
| Kernel bans | With kernel bans enabled, delete the nftables table with `sudo nft delete table inet edgeweir` and remove `/etc/systemd/system/edgeweir-node.service.d/` |
| cosign | `/usr/local/bin/cosign` installed by `install.sh` stays |
