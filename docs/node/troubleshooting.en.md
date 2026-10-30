# Node troubleshooting

Connection, configuration apply, certificate, cache and port conflict problems of running nodes, and OpenResty and agent startup problems.

Install and enrollment errors: [Adding nodes](../deploy/nodes.en.md#troubleshooting); L4 apps and HTTPS also have their own: [L4 forwarding](../guide/l4.en.md#troubleshooting) and [HTTPS and certificates](../guide/https.en.md#troubleshooting).

## First checks

1. Run `sudo edgeweir-node diagnose` on the node and look at the `fail` and `warn` checks, listed in [Local check commands](operations.en.md#local-check-commands).
2. Read the recent log: `journalctl -u edgeweir-node -n 100`; OpenResty's entries carry `component=nginx`.
3. In the console, check the node details: **Status**, **Applied**, **Certificate expires**, **Clock offset** and the **Logs** tab, see [Node logs](../guide/node-logs.en.md).
4. For more detail, pull debug logs from the **Logs** tab, or set `EDGEWEIR_LOG_LEVEL=debug` in `/etc/default/edgeweir-node` and restart the service.

Node states in the console:

| State | Meaning |
| --- | --- |
| Online | A heartbeat within 45 seconds |
| Offline | No heartbeat for more than 45 seconds |
| Disabled | Disabled in the console |
| Awaiting heartbeat | Enrolled; the agent has not connected to the node channel over mTLS yet |
| Data plane unhealthy | Online, but the data plane of a node that has applied configuration is not healthy (OpenResty not running or site table pushes failing) |

The **Applied** column:

| Mark | Meaning |
| --- | --- |
| In sync | Applied the cluster's current revision (or the one a canary rollout gives it) |
| Behind | The applied revision is below the target |
| Awaiting configuration | Online and enabled, has not applied any configuration yet |
| Apply failed | The latest apply failed, reason on hover; the node keeps serving the previous configuration |
| Upgrade required | The node lacks a capability the cluster's configuration needs, see [Node capabilities](../guide/node-upgrades.en.md#node-capabilities) |

## Connection

| Symptom | Cause | Action |
| --- | --- | --- |
| Stays **Awaiting heartbeat** | The service is not running (for example `--no-start`), or connecting to the node channel fails | `systemctl status edgeweir-node`, `journalctl -u edgeweir-node -n 50`; handle connection errors as in the rows below |
| Node offline, log shows `cannot reach`, `connection refused`, `i/o timeout` | The node channel address resolves wrongly, a firewall or security group blocks the port, or the console is not running | Run `curl -k https://<address>:8443/` on the node, which should return 404; check DNS and firewall rules |
| `x509: certificate signed by unknown authority`, or the `console` check of `diagnose` reports a certificate error | A proxy or CDN in front of the node channel terminates TLS (a proxied Cloudflare record included), or the address points at another service | Connect directly or use [layer-4 passthrough](../deploy/networking.en.md#node-channel-passthrough); set the Cloudflare record to DNS only |
| `x509: certificate is valid for ..., not ...` | The name the node connects to is not in the node channel certificate, for example after `EDGEWEIR_NODE_API_URL` changed | Add the name to `EDGEWEIR_NODE_API_HOSTNAMES` and restart the console, see [Node channel URL and certificate](../deploy/networking.en.md#node-channel-url-and-certificate) |
| `the console rejected this node's credentials` | The node was deleted in the console, its identity was replaced by a new enrollment, or its certificate expired | [Re-enroll](operations.en.md#re-enrollment) a host that stays in use, else [remove](operations.en.md#removal) the software |
| **Certificate expires** shows **Certificate expired** | The node was offline longer than its certificate had left and could not renew | [Re-enroll](operations.en.md#re-enrollment) and delete the old node in the console |
| **Certificate expires** shows **Certificate refused** | The node channel refuses the certificate for another reason, shown on hover | Check that the node was not deleted and its identity not replaced; re-enroll if needed |
| Nodes go offline after the node channel address changed | Nodes before 1.2.0 use only the address they enrolled with; or the old address went down before the nodes switched | Restore the old address and let the nodes switch (upgrade nodes before 1.2.0 first); on a 1.2.0 or later node that lost the console run `sudo edgeweir-node set-server --server <new address>`, see [Changing the node channel address](operations.en.md#changing-the-node-channel-address) |
| A node shows **Cannot switch** | The node's check of the new address failed; the reason is in the tooltip and the node details: cannot reach the new URL, no node channel WebSocket entry at the URL, the certificate at the URL is not this console's, and so on | Make sure the new address is reachable from the node's network and passed through at layer 4; once fixed, the node switches at its next retry (60 minutes at most), or at once when its service restarts |
| A node shows **On fallback** | The address in use failed for 3 minutes in a row; the node uses the fallback for now and retries the main address every 5 minutes | Make the main address reachable again |
| **Clock offset** shows **Skewed**, or a **Node clock skewed** alert arrives | The node's host does not synchronize its time and is off from the console by the alert rule's seconds (default 30) | Turn on NTP (`sudo timedatectl set-ntp true`, or chrony); later heartbeats update the offset, see [Alerts](../guide/alerts.en.md) |

## Configuration apply

An apply fetches credentials, challenge keys, session ticket keys and certificates, renders `nginx.conf`, runs `openresty -t`, reloads OpenResty and pushes the site table. When any step fails the node keeps serving the previous configuration, logs `configuration not applied; still serving the previous configuration`, and the console marks **Apply failed** with a reason like `revision N not applied: …`. Failures caused by the configuration itself (validation, `openresty -t`, a table that does not fit) are retried when a new revision arrives or after 5 minutes; network failures and timeouts at the next sync.

| Symptom (reason of **Apply failed**) | Cause | Action |
| --- | --- | --- |
| `the site table does not fit the data plane's site store (--sites-dict-mb N)` | The site table exceeds its shared memory | Raise `--sites-dict-mb` and restart the service, see [Shared memory and capacity](configuration.en.md#shared-memory-and-capacity) |
| `the layer-4 table does not fit the data plane's store (--l4-dict-mb N)` | The layer-4 table exceeds its shared memory | Raise `--l4-dict-mb` and restart the service |
| `nginx configuration test failed: …` | `openresty -t` failed; the text is nginx's own diagnostics | Act on the diagnostics; common causes are missing local files or wrong permissions, and `EDGEWEIR_*` flags that conflict with the configuration |
| `nginx did not load the new configuration within 15s (still running …); see the nginx log` | The reload did not take effect and the old workers keep running: usually a port in use | See [Port conflicts](#port-conflicts) |
| `nginx did not come up with the new configuration within 15s` | OpenResty did not start | See [OpenResty does not start](#openresty-does-not-start) |
| `data plane rejected the site table` | The data plane refused the site table | Pull debug logs and report the problem with the agent and OpenResty entries |
| `cannot persist last-known-good configuration` | The state directory cannot be written (disk full, read-only, permissions) | Check `df -h /var/lib/edgeweir-node` and the directory owner (`edgeweir`) |
| `create cache dir: …` | The cache directory cannot be created | Check the owner and free space of `--cache-dir` (default `/var/cache/edgeweir-node`) |
| **Upgrade required** | The cluster's configuration uses a capability the node lacks; the node keeps serving the last configuration it applied | Upgrade the node, see [Node upgrades](../guide/node-upgrades.en.md) |
| **Data plane unhealthy** | Site table pushes kept failing within the push budget, or OpenResty is not running | `sudo edgeweir-node diagnose`; `journalctl -u edgeweir-node -o cat \| grep component=nginx` |
| **Behind** and not moving | The node is online but does not fetch the new revision | Look for the reason after `GetConfig failed` in the node log; restarting the node service syncs at once |

## Certificates

| Symptom | Cause | Action |
| --- | --- | --- |
| The node details show **Certificates not loaded: {count}**, with the certificates on hover | The node cannot load these certificates (material missing, key mismatch, domains not covered) and left them out; sites or L4 apps that use only these certificates refuse TLS handshakes and never answer with another certificate | Check and replace them on the **Certificates** page, see [HTTPS and certificates](../guide/https.en.md#certificates-on-nodes) |
| A node before 1.1.0 shows **Apply failed** with a certificate reason | Older nodes do not apply a revision when one certificate does not load | Fix the certificate, or upgrade the node |
| The node certificate **Expires soon** | Less than 10 days left; the node renews while online | Check that the node is online; once expired it must be re-enrolled, see [Certificate rotation](operations.en.md#certificate-rotation) |

## Cache

| Symptom | Cause | Action |
| --- | --- | --- |
| Responses have no `X-Cache` header | The site turned X-Cache off | See [X-Cache](../guide/origins-and-cache.en.md#x-cache) |
| Some content is still old after a purge | The purge markers do not fit; the node uses whole-site markers instead and logs `cannot install the purge markers; installed site-level markers for the affected sites instead` | Raise `--purge-dict-mb` and restart the service |
| **Cache** in the node details shows **Not reported yet** | The node has not measured its cache use yet | Wait for the next report |
| Disk use above expectations | The cache size comes from the cluster's cache zone and the node's cache size | Set **Size (GiB)** under **Cache** in the node details, or change the cluster's cache zone, see [Cache zone](../guide/origins-and-cache.en.md#cache-zone) |

`sudo edgeweir-node accesslog --site <site ID>` shows each request's cache status live.

## Port conflicts

OpenResty listens on the cluster's HTTP and HTTPS listener ports and the ports L4 apps use in the port pools. When another process holds one of them:

| Case | Symptom |
| --- | --- |
| Reload after adding a listener port or an L4 app | nginx logs `bind() to …:<port> failed (98: Address already in use)` and keeps the old workers; the agent does not see the new configuration within 15 seconds, fails the apply and restores the previous `nginx.conf` |
| Service start | OpenResty exits; the log shows `bind() … failed` and `nginx exited unexpectedly, restarting`; the agent retries at intervals from 1 second up to 30 seconds |
| Container | `docker run` reports `port is already allocated`, or with host networking as above |

Steps:

1. Find the process holding the port: `sudo ss -ltnup 'sport = :80'` (use the port from the error; `-lunp` for UDP ports).
2. Stop and disable that service; common ones are the distribution's `nginx`, `apache2` / `httpd`, `caddy` and `openresty` (the unit declares `Conflicts=openresty.service`).
3. When the port must stay with the other service, change the cluster's listener ports or port pools, see [The cluster's listener ports](../guide/https.en.md#the-clusters-listener-ports) and [Set up port pools](../guide/l4.en.md#set-up-port-pools).
4. Restart the node service, or wait for the next sync to apply again.

## OpenResty does not start

| Symptom | Cause | Action |
| --- | --- | --- |
| `bind() … failed (98: Address already in use)` | A port is in use | See [Port conflicts](#port-conflicts) |
| `nginx exited unexpectedly` again and again | OpenResty crashes or is killed (for example by the OOM killer) | `journalctl -k \| grep -i oom`; check the shared memory flags and the host's memory, see [Resources and kernel parameters](configuration.en.md#resources-and-kernel-parameters) |
| The service stops with exit status 2 and systemd does not restart it | Invalid flags or local settings | Fix `/etc/default/edgeweir-node` or the drop-in from the log, then `sudo systemctl restart edgeweir-node` |
| The node service stops after `openresty.service` starts | The two units conflict | `sudo systemctl disable --now openresty` |
