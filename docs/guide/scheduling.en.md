# Regional probes and scheduling

Regional probes, node metrics, scheduling addresses with backup IP levels, and scheduling rules that change DNS by metrics.

## Concepts

| Term | Definition |
| --- | --- |
| Region | A geographic label for node groups and probes (for example East China), see [Regions](system.en.md#regions). |
| Regional probe | A process running `edgeweir-node probe` in a region that probes every node's scheduling addresses from there. It runs no OpenResty and listens on no port. |
| Prober | A regional probe, or a node with **Also probes** on. |
| Scheduling address | A node address DNS and probes use, with a level: primary, backup 1, backup 2. |
| Node metrics | CPU, load, memory, egress bandwidth, and active connections from the node's heartbeat. |
| Scheduling rule | A rule that acts on a cluster's DNS records by node metrics or probe results. |

## How it works

1. Each round, a prober gets its targets from the console (every scheduling address of every enabled node × every listener port of its cluster), probes them, and reports the results.
2. Every 10 seconds the console decides whether each address is reachable and evaluates every rule for every node; a probe report triggers another evaluation right away.
3. When a node moves to a backup address, or a rule's action takes effect or recovers, the console publishes the cluster's DNS revision and writes it to the provider.

Only clusters whose DNS mode is **Automatic** are affected, see [DNS steering and alerts](dns-and-alerts.en.md#configure-dns-steering).

## Regional probes

### Add a probe

Prerequisites: a region exists (**Clusters & nodes** → **Regions** → **New region**); the probe host can reach the node channel URL ("Node channel" in **System settings**, 8443 by default) and the nodes' listener ports. No inbound port is needed.

1. Open **System settings**, switch to the **Monitoring** tab (`/system?tab=probes`), and click **Add probe**.
2. Fill in **Probe name** (at most 64 characters) and select **Region** and **Valid for** (15 minutes, 1 hour, or 24 hours; 1 hour by default).
3. Click **Generate token**. The dialog shows the **Start command**, the time left, the **Enrollment token**, the **Node channel**, and the **CA fingerprint**, once.
4. Run the **Start command** on the probe host:

   ```bash title="Probe host"
   export EDGEWEIR_TOKEN='<enrollment token>'
   docker run -d --name edgeweir-probe --restart unless-stopped --no-healthcheck -e EDGEWEIR_TOKEN \
     -e EDGEWEIR_SERVER=https://cdn-admin.example.com:8443 -e EDGEWEIR_CA_SHA256=<CA fingerprint> \
     -e EDGEWEIR_STATE_DIR=/var/lib/edgeweir-probe -v edgeweir-probe:/var/lib/edgeweir-probe \
     --entrypoint /usr/local/bin/edgeweir-node ghcr.io/marvinli001/edgeweir-node:latest probe
   ```

   Without containers, run the systemd unit `edgeweir-probe.service` on a host with edgeweir-node installed:

   ```bash title="Probe host"
   sudo tee /etc/default/edgeweir-probe >/dev/null <<'CONF'
   EDGEWEIR_SERVER=https://cdn-admin.example.com:8443
   EDGEWEIR_CA_SHA256=<CA fingerprint>
   EDGEWEIR_TOKEN=<enrollment token>
   CONF
   sudo chmod 600 /etc/default/edgeweir-probe
   sudo systemctl enable --now edgeweir-probe
   ```

5. Verify: the probe appears in the list on the **Monitoring** tab as **Online**, and **Last round** shows loss and RTT.

Compose, binary flags, the state directory, and re-enrollment: [Adding nodes](../deploy/nodes.en.md#regional-probes).

| Item | Behavior |
| --- | --- |
| Enrollment token | `ewp_` prefix, single-use; the database keeps only its SHA-256 and prefix. Creating one is audited as `probe.token_create` |
| Validity | The UI offers 15 minutes, 1 hour, or 24 hours; the API accepts 5 minutes to 7 days, 60 minutes by default |
| Node channel | The node channel URL in **System settings**, the same as for nodes |
| CA fingerprint | SHA-256 of the node channel's internal CA; the probe checks it before sending the token |
| Enrollment | The probe enrolls with the token on its first start and appears in the list from then on; audited as `probe.enroll` with the actor **Probe**. Later starts ignore the token |
| No region | The dialog shows **Create a region first** |

### Probe methods

| Listener | One attempt | Success |
| --- | --- | --- |
| HTTP | Connect, then `GET /.edgeweir/health` with `Host: health.edgeweir.invalid` | Status 200 |
| HTTPS | TLS (SNI `health.edgeweir.invalid`, certificate not verified), then as HTTP | Status 200 |
| Every listener, while an active node of the cluster lacks `probe-health-v1` | Open a TCP connection and close it | Connection established |

| Item | Behavior |
| --- | --- |
| Targets | Every scheduling address (all levels) of every enabled node × every listener port in the cluster's latest revision; a node that also probes skips itself |
| PROXY protocol | Listeners that require PROXY protocol get a PROXY v1 header first |
| Attempts | Each target gets **Attempts per round** attempts in a row per round, each bounded by **Timeout per attempt**; one probe probes at most 32 targets at a time |
| Results | Attempts sent, attempts lost, the median RTT of successful attempts (ms), and the error code of the last failure |
| Rounds | The next round starts one **Interval** after the current one started, or right away when the current one takes longer |

Health endpoint: on every edge listener, a node answers `GET /.edgeweir/health` for any Host with `200 ok` before any site lookup; it is not cached, not counted in statistics or access logs, and not affected by bans or rules. HTTPS listeners answer handshakes with SNI `health.edgeweir.invalid`, or without SNI, with a self-signed certificate the node generates at startup; such connections reach the health endpoint only, and other requests get 421. Nodes report the capability `probe-health-v1`.

### Probe settings

The **Probe settings** card on the **Monitoring** tab applies to every prober; probers pick up new values with their next round. Changes are audited as `system.probes_update`.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Interval (seconds) | 5–60 | 10 | Time between two rounds |
| Timeout per attempt (ms) | 500–10000, not longer than the interval | 3000 | Longest time one attempt may take |
| Attempts per round | 1–10 | 3 | Attempts per target and round |
| Loss that fails an address (%) | 1–100 | 50 | A prober whose loss on an address reaches this value counts the address as failing |
| Failing before unreachable (seconds) | 5–3600 | 30 | How long an address fails before it counts as unreachable |
| Answering before reachable (seconds) | 5–3600 | 60 | How long an unreachable address answers before it counts as reachable again |

### Probe list

| Column | Content |
| --- | --- |
| Probe | Name and host name |
| Region | Region name and code |
| Status | **Online**: asked for targets or reported within 3 intervals (at least 30 seconds); **Offline**; **Disabled** |
| Last seen | When it last asked for targets or reported |
| Version | The probe's agent version |
| Last round | Loss, mean RTT of the answering targets, and targets that lost every attempt (**N targets unreachable**) |
| Targets | The probe's current target count |

| Action | Description |
| --- | --- |
| Probe results | The probe's latest result for every node address and port; clicking the probe's name opens it too |
| Rename | At most 64 characters |
| Disable / Enable | Disabling deletes its results, which no longer count; the node channel refuses it, except for certificate renewal |
| Delete | After confirming **Delete probe {name}? Its certificate is revoked**, revokes its certificate and deletes its results; joining again needs a new token |

Probe result columns: **Prober** (in node details) or **Node** (in a probe's results), **Address** (address:port and method), **Loss**, **RTT**, **Error**, **Checked**. Error codes:

| Error | Code | Meaning |
| --- | --- | --- |
| Timed out | `timeout` | The attempt exceeded the timeout |
| Connection refused | `refused` | The port refused the connection |
| Connection reset | `reset` | The peer reset the connection |
| TLS handshake failed | `tls` | The handshake with an HTTPS listener failed |
| Unexpected status | `status` | The health endpoint did not answer 200 |
| Unreachable | `unreachable` | The network is unreachable |

Only the latest result per prober, node, address, and port is kept; results not updated for 1 hour are deleted.

### Nodes that also probe

1. In the node list, click the node's name, or **Actions** → **Details** (`/clusters?node=<node ID>`).
2. Turn on **Also probes**.

| Item | Behavior |
| --- | --- |
| Region | The region of the node's node group; without one the switch is unavailable and shows **The node group has no region** |
| Probing | The node runs the same probes with its own certificate and skips itself; its results are marked **Node** in the **Prober** column |
| Stopping | Turning the switch off deletes its results; once the node is disabled or its node group loses its region, the console no longer accepts its probes |
| Audit | `node.set_probe` |

### Probe identity

| Item | Behavior |
| --- | --- |
| Certificate | Signed by the node channel's internal CA, `CN=<probe ID>`, `O=Edgeweir Probe`, client authentication only, valid for 30 days; the probe renews it once less than a third remains, audited as `probe.certificate_renew` |
| Separation | Probe certificates can only call `ProbeService`, never the node RPCs; node certificates cannot enroll or renew probes |
| Private key | Generated on the probe host and kept in its state directory (`/var/lib/edgeweir-probe` by default, 0600); it never leaves the host |

## Node metrics

Nodes with `metrics-v1` (Linux) report host metrics in every heartbeat (15 seconds). The **Metrics** column of the node list shows CPU and memory; **Metrics** in the node's details shows them all with **Reported …**, or **No metrics**.

| Metric | Source |
| --- | --- |
| CPU | Whole-host CPU usage, the difference of `/proc/stat` between two heartbeats |
| Load (1 / 5 / 15 min) | `/proc/loadavg` |
| Memory | Used (`MemTotal − MemAvailable`) and total |
| Egress | Send rate of the non-loopback interfaces between two heartbeats |
| Connections | nginx active connections, [L4 app](l4.en.md) client connections, upstream connections, and UDP sessions included |

The two rates are 0 in a node's first heartbeat. For a node in a container, CPU, load, and memory are the host's values and egress is the container interface's. Scheduling rules treat metrics older than 60 seconds as missing.

## Scheduling addresses and backup IPs

The **Scheduling addresses** table in a node's details: **Address**, **Level** (Primary / Backup 1 / Backup 2), **Source** (Reported / Configured), **Reachability** (Reachable / Unreachable); the level DNS uses now is marked **In use**.

| Source | Addresses |
| --- | --- |
| Reported | Used while none are configured: the public addresses in the node's heartbeat, all primary |
| Configured | Addresses and levels the operator sets; while there are any, DNS and probes use only them. They may be private |

Configure addresses:

1. Open the node's details and click **Edit addresses** under **Scheduling addresses**.
2. Click **Add address**, enter a single IP, and select its level. At most 8; a primary address is required.
3. Click **Save**. **Use reported addresses** clears every configured address.

### Nodes without a public address

A node behind NAT that reports only private addresses, with none configured, gives DNS nothing to answer with: the **IP** column of the node list and **Scheduling addresses** in its details are marked **No public address**.

| Item | Behavior |
| --- | --- |
| Connects from | The node's details show the source address of its enrollment and latest heartbeat connection to the console (the NAT's public address; a proxy's when the node connects through one) |
| Add source address | While editing, when the source address is public and not listed, **Add source address …** adds it to the list to save; it is never used on its own |

Saving publishes the cluster's DNS revision (reason **Binding saved**) and is audited as `node.set_addresses`. An address must be a single unicast IP: no CIDR, host name, loopback, link-local, or multicast address, and no duplicates ("Not a single unicast IP address: …").

### Reachability from the probes

| Item | Behavior |
| --- | --- |
| Failing | Among the probers that reported the address within the window (3 intervals, at least 15 seconds), more than half (a strict majority) see a loss of at least **Loss that fails an address** over all its ports |
| Unreachable | Failing for **Failing before unreachable** (30 seconds by default) |
| Reachable again | Not failing for **Answering before reachable** (60 seconds by default) after being unreachable |
| No results | Does not count as failing |
| Only a few regions cannot reach it | Not failing; region-scoped [scheduling rules](#scheduling-rules) handle it |

Only results of enabled probes and of enabled nodes that still probe count.

### Level switching

| Case | Addresses DNS uses |
| --- | --- |
| Normal | The reachable addresses of the lowest level that has any |
| Primary unreachable | The next level with a reachable address; back to primary once it is reachable again |
| Every level unreachable | The node has no address; its line may fall below its minimum of healthy addresses and use its [backup node groups](dns-and-alerts.en.md#backup-node-groups); if still empty, the [mass removal protection](dns-and-alerts.en.md#mass-removal-protection) keeps the previous records |
| A **Switch to backup IP** action in effect | At least backup 1; the higher of the two levels applies. Unchanged when the node has no reachable backup address |

A level change publishes the cluster's DNS revision (reason **Node health changed**) without another audit entry. **Target addresses** entered for a node in the DNS binding take precedence over scheduling addresses: on that line the node does not switch levels. **Manual** mode lists primary addresses only and does not follow reachability.

Example: a node has `203.0.113.10` (primary) and `198.51.100.10` (backup 1). After most probers fail to reach `203.0.113.10` for 30 seconds, DNS answers with `198.51.100.10`; after `203.0.113.10` answers again for 60 seconds, DNS moves back.

## Scheduling rules

Page: **Clusters & nodes** → select the cluster → **Scheduling** tab (`/clusters?tab=scheduling`, shown once the cluster has a node), with **Scheduling rules** on top and **Preview** below.

### Create a rule

1. Click **New rule**.
2. Fill in **Rule name**, select **Line** and **Action**, select **Match**, and fill in **Hold at least (seconds)** and **Recover after (seconds)**.
3. Under **Conditions**, select **Metric** and **Comparison** and fill in **Threshold** and **For (seconds)**; probe metrics also take **Aggregate** and **Region**. **Add condition** adds more.
4. Check that **Enabled** is on and click **Create**.
5. Verify: the rule appears under **Scheduling rules**; in **Preview** its state for every node is **Idle** or **Pending**.

The switch on a rule's row enables or disables it, **Edit rule** changes it, and deleting asks **Delete rule {name}? Its actions in effect end**.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Rule name | 1–100 characters | — | Name in the rule list, DNS revision reasons, and alerts |
| Line | **All lines** or a line of the cluster's DNS binding | All lines | Lines and nodes the rule applies to |
| Action | Remove the node / Switch to backup groups / Switch to backup IP | Remove the node | See [Actions](#actions) |
| Match | All conditions / Any condition | All conditions | AND / OR between conditions |
| Hold at least (seconds) | 0–86400 | 300 | Shortest time an action stays in effect |
| Recover after (seconds) | 0–86400 | 300 | How long the conditions stay clear before the action recovers |
| Enabled | On / Off | On | Disabled rules are not evaluated |

Each rule has 1–8 conditions:

| Field | Values | Default for a new condition | Effect |
| --- | --- | --- | --- |
| Metric | See below | CPU usage | Value compared |
| Comparison | `>`, `≥`, `<`, `≤` | `>` | — |
| Threshold | 0–10¹², in the metric's unit | 90 | — |
| For (seconds) | 0–3600 | 60 | How long the comparison must hold before the condition counts |
| Aggregate | Average / Maximum / Minimum | Average | Probe metrics only: how the probers' values combine |
| Region | **All regions** or one region | All regions | Probe metrics only: counts the probers of that region alone |

| Metric | Unit | Value |
| --- | --- | --- |
| CPU usage | % | Reported by the node |
| Load (1 min) | — | Reported by the node |
| Memory usage | % | Used / total |
| Egress bandwidth | Mbps | Reported by the node |
| Active connections | — | Reported by the node |
| Probe loss | % | Each prober's share of lost attempts over all ports of the node's primary addresses (lowest level), combined by **Aggregate** |
| Probe latency | ms | Each prober's mean of the median RTTs of answering targets, combined by **Aggregate** |

Node metrics show **No data** when the node lacks `metrics-v1` or sent no heartbeat within 60 seconds; probe metrics show **No data** without fresh prober results. A comparison without data does not hold.

| Line | Nodes the rule looks at |
| --- | --- |
| All lines | Every enabled node of the cluster |
| One line | The enabled nodes of the line's node group; for **Remove the node** and **Switch to backup IP** also those of its backup node groups |

### Actions

| Action | Effect | Requires |
| --- | --- | --- |
| Remove the node | A matching node leaves the records of the rule's line (every line with **All lines**), and with that `all.<cluster domain>` | — |
| Switch to backup groups | When a node of the line's node group matches, the line answers with its backup node groups (the first with **Minimum healthy IPs**) | A line, with backup node groups |
| Switch to backup IP | A matching node uses at least its backup 1 addresses on the rule's line (or every line) | A reachable backup address on the node |

### States and timing

| State | Meaning |
| --- | --- |
| Idle | The comparisons do not hold |
| Pending | The comparisons hold, but not yet for their **For (seconds)** |
| Active | The action is in effect |
| Recovering | The comparisons no longer hold; waiting to recover |

| Phase | Rule |
| --- | --- |
| Activation | The conditions match by **Match**, each comparison having held for its **For (seconds)** |
| Holding | Once active, the action stays while the comparisons hold by **Match**, durations no longer counted |
| Recovery | When the comparisons stop holding, the state is **Recovering**; the action ends once they stayed clear for **Recover after (seconds)** and **Hold at least (seconds)** passed since activation |
| Holding again | A comparison that holds again while recovering returns the state to **Active**; the recovery wait restarts |
| Rule changes | Disabling or deleting the rule, or changing its line, match, action, or conditions, ends its actions at once and its states start over; changing only the name, hold, or recover time does not |

### Activation and recovery

| Item | Behavior |
| --- | --- |
| DNS | Every activation and recovery publishes one DNS revision of the cluster, reason **Scheduling: {rule} on {node}**, followed by the action and **Activated** or **Recovered** |
| Audit | Actor **System**: `scheduling.activate`, `scheduling.recover`, with node, action, line, condition values, and DNS revision in the metadata. Rule changes are audited as `scheduling.rule_create`, `scheduling.rule_update`, `scheduling.rule_delete` |
| Alert | Activation fires **Scheduling rule acting on a node** (`scheduling_action`, named "rule · node"); recovery resolves it; see [Cluster and DNS alerts](dns-and-alerts.en.md#cluster-and-dns-alerts) |
| Protection | Removals remain subject to the [mass removal protection](dns-and-alerts.en.md#mass-removal-protection) |
| Rule list | **Acting on** lists the nodes in **Active** or **Recovering** |

### Evaluation

| Item | Behavior |
| --- | --- |
| Interval | Every 10 seconds per cluster: address reachability first, then every rule for every node |
| After a probe report | The clusters the report concerns are evaluated right away, at most every 2 seconds per cluster and process |
| Process | Periodic evaluation runs in a process with `ROLE=worker` or `ROLE=all`; one console process evaluates at a time |
| Writing | DNS revisions from an evaluation are written to the provider right away; propagation is bound by TTL and resolver caches |

### Preview

**Preview** shows every rule against every node it looks at under the current metrics: **Node**, **Status**, **Conditions** (current value, threshold, seconds held / required, or **No data**), and **Outcome**:

| Outcome | Meaning |
| --- | --- |
| Acts at the next evaluation | The conditions match; the next evaluation starts the action |
| Recovers at the next evaluation | Recovery is due; the next evaluation ends the action |
| In effect, recovers {time} at the earliest | The action is in effect; earliest end if the conditions stay clear |
| In effect | The action is in effect and the conditions still hold |
| No change | — |

The preview writes nothing and refreshes with the rule list.

### Examples

| Goal | Line | Condition | Action |
| --- | --- | --- | --- |
| Take a node with sustained high CPU out of DNS | All lines | CPU usage > 90% for 60 seconds | Remove the node |
| Switch a line to its backup groups when East China probes cannot reach it | `telecom-east` | Probe loss (Average · East China) ≥ 50% for 30 seconds | Switch to backup groups |
| Move a node near its egress limit to its backup IP | All lines | Egress bandwidth > 900 Mbps for 120 seconds | Switch to backup IP |

## Limits

| Item | Description |
| --- | --- |
| DNS mode | Applies only to clusters in **Automatic** DNS mode; **Manual** mode lists primary addresses only and applies neither rules nor backup node groups |
| Conditions | At most 8 per rule, combined in one all / any level |
| One report | At most 10,000 results per prober and round |
| Scale | A prober's target count is the enabled nodes' scheduling addresses × listener ports. With every target unreachable, a round takes about ⌈targets / 32⌉ × attempts per round × timeout per attempt; when that exceeds the interval the next round starts right after, and decisions slow down accordingly. Probes × targets is what the console stores per round |
| Results | Only the latest result per prober, node, address, and port; no time series |
| Host metrics | Linux nodes only |
| Resolution lines | Answering with different nodes per carrier or region works only with providers that support it, see [Resolution lines](dns-and-alerts.en.md#resolution-lines) |
| Authoritative DNS | Edgeweir runs no authoritative DNS; scheduling writes records through provider APIs only |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| The probe does not appear in the list | Enrollment failed: token expired or used, CA fingerprint mismatch, node channel unreachable or TLS terminated by a proxy | Read the probe's log (`docker logs edgeweir-probe` or `journalctl -u edgeweir-probe`); generate a new token |
| The probe is **Offline** | No targets asked for or results reported within 3 intervals | Check the probe process and its network path to the node channel |
| **Targets** is 0 | No enabled node, or the cluster has no revision yet | Add nodes |
| Every result is TCP | An active node of the cluster lacks `probe-health-v1` | [Upgrade the nodes](node-upgrades.en.md) |
| Error **Unexpected status** or **TLS handshake failed** | Something other than an Edgeweir node listener answers on the address, or a device sits in front of it | Check the scheduling addresses and port forwarding |
| **Also probes** is unavailable, with **The node group has no region** | The node group has no region | Edit the node group and select a region |
| "Give the node's group a region before the node probes" | The same, through the API | The same |
| "N probes still belong to this region" | Deleting a region that still has probes | Delete those probes first |
| "Not a single unicast IP address: …" | A scheduling address is a CIDR, a host name, a special-purpose address, or a duplicate | Enter one IP per row |
| "The rule needs a line of the cluster's DNS binding" | **Switch to backup groups** without a line, or a line missing from the binding | Select a line of the binding |
| The preview shows **No data** | The node lacks `metrics-v1` or stopped sending heartbeats, or the region has no prober online | Upgrade the node; check the probes |
| A rule is active but DNS did not change | DNS mode is not Automatic; the mass removal protection held the publication back; the node has no reachable backup address; the line has no backup node groups | Check the revisions and their reasons on the cluster's **DNS** tab |
| An address only one region cannot reach did not switch to a backup IP | Reachability is decided by a strict majority | Use a rule scoped to that region |
