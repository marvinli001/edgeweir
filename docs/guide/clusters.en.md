# Clusters and nodes

Clusters, node groups, nodes and regions, configuration revisions and the configuration canary, site enabling and items needing attention.

## The page

Page: **Clusters & nodes** (`/clusters`), under **Infrastructure** in the sidebar.

| Element | Description |
| --- | --- |
| View switch | **Clusters \| Regions**: clusters (default) and [regions](#regions) (`?view=regions`) |
| **Select cluster** | Shown with more than one cluster, not in the regions view; the chosen cluster is in `?cluster=<cluster ID>` |
| Page actions | Clusters view: **New cluster**, **Add node** (once a cluster exists); regions view: **New region** |
| No clusters | "No clusters" with **New cluster** |
| Cluster summary | The cluster name, **⋯** (**Edit cluster**, **Delete**) and the items below; a cluster without nodes shows only the name, **⋯** and the node section |

| Summary | Content |
| --- | --- |
| **Nodes online** | Online nodes / all nodes |
| **Sites** | The cluster's sites |
| **Latest revision** | The cluster's latest revision `#N` and "X/Y applied": Y online enabled nodes, X of which run their target revision; "Unpublished" before the first revision. Target revisions: [Configuration canary](#configuration-canary) |

Once the cluster has a node, the tabs (`?tab=`) appear:

| Tab | `tab` | Content |
| --- | --- | --- |
| **Nodes** | omitted (default) | The [node](#nodes) table and [node groups](#node-groups) |
| **Releases** | `releases` | [Revisions](#revisions), [configuration canary](#configuration-canary), [node upgrades](#node-upgrades) |
| **DNS** | `dns` | The cluster's DNS binding, records and DNS revisions, see [Bind a cluster](dns.en.md#bind-a-cluster) |
| **Scheduling** | `scheduling` | Scheduling rules and their preview, see [Scheduling rules](scheduling.en.md#scheduling-rules) |
| **Settings** | `network` | [Listener ports](https.en.md#the-clusters-listener-ports), [client IP](../deploy/nodes.en.md#client-ip), [unknown hosts](domains.en.md#unknown-hosts-and-node-ip-access), [cache zone](origins-and-cache.en.md#cache-zone) |
| **Port pools** | `ports` | Port ranges L4 apps may use, see [Set up port pools](l4.en.md#set-up-port-pools) |

Other query parameters: `?node=<node ID>` opens the node details, `?nodeTab=logs` their **Logs** tab; `?enroll=true` opens the **Add node** dialog (the setup wizard ends there).

## Clusters

A cluster is a set of nodes plus the sites and L4 apps assigned to them; each cluster has its own revision sequence.

| Action | Where | Description |
| --- | --- | --- |
| **New cluster** | Page action | **Cluster name**: lowercase letters, digits and `-`, starting with a letter or digit, at most 64 characters, unique; **Description**: at most 500 characters. Creation adds the default node group `default` and publishes revision #1 |
| **Edit cluster** | **⋯** of the summary | Change name and description |
| **Delete** | **⋯** of the summary | Allowed when the cluster has no nodes and no sites, its DNS is not **Automatic**, and its written DNS records are removed |

| Rule | Description |
| --- | --- |
| Cluster of a site | With several clusters, the new-site form has a **Cluster** field (default: the oldest cluster); through `/api/v1`, `clusterId`. A site cannot change clusters later |
| Capacity | A cluster publishes at most 512 enabled sites (`CLUSTER_SITE_LIMIT`) and has at most 256 [L4 apps](l4.en.md) (`L4_APP_LIMIT`) |
| Cache zone | The **Cache zone** card on the **Settings** tab sets the size and idle removal time of every node's cache zone, see [Cache zone](origins-and-cache.en.md#cache-zone) |

## Node groups

The node group table on the **Nodes** tab: **Node group** (the default group marked **Default**, canary groups **Canary**), **Region** ("name · code", "—" when unset), **Nodes**.

| Action | Description |
| --- | --- |
| **New node group** | **Node group**: name, at most 64 characters, unique within the cluster; **Region**: optional, see [Regions](#regions); **Canary group**: see [Configuration canary](#configuration-canary) |
| **Edit node group** | Opens from a click on the row; change name, region and **Canary group** |
| Delete | **Delete** under **⋯** at the end of the row, confirming "Delete node group {name}? Its nodes move back to the default group". The default node group has no **⋯** and cannot be deleted |

Node groups serve as the lines and [backup node groups](dns.en.md#backup-node-groups) of DNS bindings and as canary groups of [node upgrades](node-upgrades.en.md) and the [configuration canary](#configuration-canary). A node group's region is the region its nodes probe from when they [also probe](scheduling.en.md#nodes-that-also-probe).

## Adding a node

The **Add node** dialog generates a one-time install command as it opens: the cluster's default node group, valid for 1 hour, no node name. **Options** shows the fields below; **Regenerate** generates a new command with them.

| Field | Description |
| --- | --- |
| **Node name** | Optional, at most 64 characters |
| **Node group** | Defaults to the cluster's default node group; hidden when the cluster has only one |
| **Valid for** | 15 minutes, 1 hour (default) or 24 hours; the API accepts 5 minutes to 7 days |

| Item | Description |
| --- | --- |
| **Install command** | With a countdown, shown once; every opening of the dialog generates a new token, and a closed dialog does not show it again |
| Token | Starts with `ewt_`, single use; the database keeps its SHA-256 and prefix, never the plaintext |
| CA fingerprint | The command's `--ca-sha256`, the same as **CA fingerprint** in [System information](system.en.md#system-information) |
| Connection check | One line with the node channel connection check; when it fails, a "Change" link opens **System settings** ([Node channel](system.en.md#node-channel)) |
| **Progress** | Waiting for the node → Enrolled → Configuration applied → Data plane healthy → Has an address for DNS; "Token expired" once the token expires |

Address warnings, the connection check and the install flow: [Adding nodes](../deploy/nodes.en.md).

## Nodes

The node table on the **Nodes** tab has one row per node and sorts by **Node**, **Node group**, **Egress**, **Applied** and **Heartbeat** (`?sort=`). **Egress** is hidden below the `lg` width, **Agent / engine** and **Heartbeat** below `xl`. A cluster without nodes shows "No nodes" with **Add node**.

| Column | Content |
| --- | --- |
| **Node** | Name and first IP (hover for the host name); a node that also probes is marked **Also probes** |
| **Status** | **Online** (heartbeat within 45 seconds), **Offline**, **Disabled**; an enrolled node that has not connected to the node channel yet shows **Awaiting heartbeat**; an online node with an unhealthy data plane is also marked **Data plane unhealthy**; an offline node whose certificate the node channel refuses is marked **Certificate expired** or **Certificate refused**; marked **No public address** when DNS has no address for the node, see [Nodes without a public address](scheduling.en.md#nodes-without-a-public-address) |
| **Node group** | Node group and region |
| **Load** | CPU and memory usage (`metrics-v1`), with a dot in the warning color from 75% and in the error color from 90%; "—" when offline or without metrics |
| **Egress** | Egress reported by the node |
| **Applied** | `#N`, marked **In sync** (the node's target revision reached), **Behind**, **Apply failed** (hover for the reason) or **Upgrade required**; an online node without any configuration yet shows **Awaiting configuration**; when the node reports certificates it cannot load, also "Certificates not loaded: N" (hover for their names) |
| **Agent / engine** | Agent version, marked **Upgrade recommended** when due; a node not on the current [node channel URL](system.en.md#node-channel) yet is also marked **Not switched**, **Cannot switch** (hover for the reason), **On fallback** or **Upgrade to switch** (nodes before v1.2.0) |
| **Heartbeat** | How long ago the last heartbeat came; hover for the time |

### Node details

A click on the node's row, or **Details** under **⋯** (`/clusters?node=<node ID>`). Tabs **Overview** and **Logs** (`?nodeTab=logs`, see [Node logs](node-logs.en.md)).

| Item | Content |
| --- | --- |
| **Node group** | Node group and region |
| **Applied** | Marked **Apply failed** when applying failed |
| **Agent / engine** | Agent version, engine and engine version, marked **Upgrade recommended** when due |
| **Heartbeat** | How long ago the latest heartbeat came |
| **Clock offset** | The latest reported value: "In sync", "N s ahead", "N s behind"; marked **Skewed** at the **Clock skew (seconds)** of the [alert rules](alerts.en.md#set-alert-rules) |
| **IP** | Every unicast address of the latest heartbeat, at most 64; a heartbeat without addresses keeps the previous ones. The addresses DNS and probes use: [Scheduling addresses and backup IPs](scheduling.en.md#scheduling-addresses-and-backup-ips) |
| **Metrics** | Gauges of CPU and memory usage (warning color from 75%, error color from 90%), the 1 / 5 / 15 min load, egress and connections; "No metrics" without metrics |
| **Data plane** | Healthy / Data plane unhealthy |
| **Connects from** | The source address the node connects to the console from |
| **Node channel** | The URL in use and its mark, why the node cannot switch or runs on its fallback, and the fallback it keeps |
| **Certificate expires** | The client certificate (30 days; the node renews it when less than a third is left); marked **Expires soon** with less than 10 days left, and **Certificate expired** or **Certificate refused** once past or refused by the node channel |
| **Also probes**, **Scheduling addresses**, **Probe results** | See [Regional probes and scheduling](scheduling.en.md) |
| **Cache** | Cache usage and this node's own size, see [Cache zone](origins-and-cache.en.md#cache-zone) |

### Node actions

**⋯** at the end of a row:

| Action | Description |
| --- | --- |
| **Details** | See [Node details](#node-details) |
| **Rename** | At most 64 characters |
| **Move to group** | Node groups of the same cluster only |
| **Disable** / **Enable** | A disabled node is refused by the node channel (except for certificate renewal, so its certificate is still valid when enabled) and keeps serving its last successfully applied configuration; its unfinished purge & prefetch deliveries are marked **Skipped**. Once the node is enabled and pulls tasks again, it gets one whole-site purge for every site those purges touched |
| **Delete** | Revokes the node certificate; the node must enroll again with a new install command |

## Revisions

A change that affects node configuration publishes a new revision in the cluster; none when the content hash equals the previous one. The **Revisions** table on the **Releases** tab lists the latest 20: **Revision**, **Content hash**, **Sites**, **Reason**, **Time**; every row except the latest has **Roll back**.

| Item | Value |
| --- | --- |
| Retention | The latest 200 revisions per cluster, pruned hourly; the canary's stable and candidate revisions are never pruned |
| ACME HTTP-01 | Revisions published only for HTTP-01 challenges do not count and are deleted after an hour |
| Revision number | One more than the larger of the latest stored revision and the highest revision the cluster's nodes have applied; it does not go back after a database restore |

| Reason | Trigger |
| --- | --- |
| Cluster {cluster} created | New cluster |
| Site {site} created / updated / deleted | Site changes |
| Site {site} enabled / disabled | [Site enabling](#site-enabling) |
| {count} sites enabled / disabled / deleted | Bulk actions of the site list, see [Bulk actions](site-management.en.md#batch-actions) |
| Settings of {source} copied to {site} / Site {site} cloned from {source} | [Copy settings](site-management.en.md#copying-settings) and [Clone a site](site-management.en.md#cloning-a-site) |
| L4 app {app} created / updated / deleted | [L4 app](l4.en.md) changes; enabling and disabling use "updated" |
| Site {site} purged | Purging a site in older consoles; a whole-site purge is now a node task that publishes no revision |
| Certificate policy for {site} updated | HTTPS settings changed; a certificate used by the site was issued or renewed |
| ACME challenge updated | HTTP-01 challenge changes |
| Rules and IP lists updated | Site rule, global rule or IP list changes |
| Protection of {site} updated | The site's Under Attack, CC mitigation or challenge settings changed |
| OWASP CRS of {site} updated | The site's OWASP CRS settings changed |
| Error pages / Maintenance / Access authentication / Access control of {site} updated | The matching site settings changed |
| Usage limit of {site} reached / Usage protection of {site} lifted | [Usage protection](usage-protection.en.md) actions applied and lifted |
| Automatic mitigation turned on / off Under Attack for {site} | [Automatic mitigation](attack-dashboard.en.md) |
| Global Under Attack updated | Global Under Attack changed in [Protection](system.en.md#protection); every cluster publishes one revision |
| CC template updated | [CC template](system.en.md#cc-template) changed; every cluster with a site following the template publishes one revision |
| Challenge keys rotated | The daily challenge key rotation; every cluster whose configuration carries challenge keys publishes one revision |
| Challenge keys for the greylist | Saving a [greylist](bans.en.md#greylist) entry whose action is a challenge; the clusters it applies to (every cluster for a global entry) whose configuration has no challenge keys yet publish one revision each |
| TLS session ticket keys rotated | Ticket key rotation of [TLS session resumption](https.en.md#tls-session-resumption) |
| Origin allow list updated | [Origin allow list](system.en.md#origin-allow-list) changed; every cluster publishes one revision |
| Platform error pages updated | [Platform error pages](system.en.md#platform-error-pages) changed; every cluster publishes one revision |
| Listener ports / Client IP setting / Unknown host settings / Cache zone updated | The matching card on the **Settings** tab |
| Cache size of node {node} updated | **Cache** in the node details |
| Connection limits updated | [Connection limits](system.en.md#connection-limits) |
| Origin certificate revoked / Origin client certificate replaced / Origin CA rotation started, cancelled / Previous Origin CA retired | [Origin protection](https.en.md#origin-protection) |
| Rolled back to #{revision} | **Roll back** |
| Canary of revision {revision} rolled back | [Configuration canary](#configuration-canary) rollback |
| Configuration recompiled after an upgrade | A console upgrade changed what the stored configuration compiles to; every cluster publishes one revision |

### Rollback

**Roll back**, after confirming "Publish a new revision from #{revision}?", publishes the chosen revision's content as a new revision, keeps the history and is audited as `cluster.rollback`.

| Item | Behavior |
| --- | --- |
| Current values | IP lists, global rules, global Under Attack and the origin allow list |
| Not shipped | Sites and L4 apps that are currently disabled |
| Refused | A site, domain, certificate, IP list or L4 app the chosen revision references was deleted, an L4 app's port is no longer inside a port pool, or the certificate has expired (`ROLLBACK_RESOURCE_UNAVAILABLE`) |
| Preview | The confirmation lists the sites **Added**, **Changed** and **Removed** against the latest revision; "Same as the current revision" for equal content, "No site changes" when only settings other than sites differ; when the rollback cannot be done the reason shows and the confirm button stays disabled. The preview writes nothing; API: [Clusters and overview](../reference/api/clusters.en.md#clusters) |
| Canary | A rollback reaches every node at once; a running canary ends with the outcome "Rolled back manually" |

### Node capabilities

When a change needs a capability that active nodes of the cluster lack:

| Publisher | Behavior |
| --- | --- |
| The console account (session or AccessKey) | Published anyway; nodes without the capability show **Upgrade required** and keep their configuration |
| Service accounts | 409 `NODE_CAPABILITY_REQUIRED`; nothing is published |
| Automatic console jobs | Nothing is published |

## Configuration canary

The **Configuration canary** card on the **Releases** tab sets the policy per cluster and shows the current rollout. Off by default.

| Policy field | Values | Default |
| --- | --- | --- |
| **Enable canary** | On / off | Off |
| **Observation window (minutes)** | 1–60 | 5 |
| **5xx ratio multiple of the baseline** | 1–100 | 2 |
| **5xx ratio floor (%)** | 0.1–100 | 5 |
| **Minimum requests** | 1–1000000 | 100 |
| **Promote automatically** | On: promote to every node once the window passes; off: wait for **Promote to all now** | On |

Canary groups are set with the **Canary group** switch of a [node group](#node-groups).

| Item | Behavior |
| --- | --- |
| Canary nodes | Enabled nodes in a canary group that are online when the window starts. They stay fixed until the window ends: a node that leaves the canary group meanwhile remains a canary node, a node that joins waits for the next window |
| Target revision | Canary nodes get the candidate, the other nodes the stable revision; a node only receives its own target revision |
| DNS | Every node is judged by its own target revision; nodes outside the canary are not removed during the window |
| 5xx statistics | Nodes report whole minutes. Each canary node counts from the first whole minute after it applied the candidate; earlier requests (the same minute included) do not count. Nodes outside the canary count from the earliest of those minutes |
| End of the window | The window's time has passed and the canary nodes have reported every minute of the window and at least one whole minute of the candidate; late statistics are awaited for at most 2 more minutes, then the data at hand decides. Fewer requests than the minimum (no traffic included) skip the 5xx check |
| Rollback conditions (any of them during the window) | A canary node failed to apply; an unhealthy data plane or an offline canary node; the canary nodes' 5xx ratio exceeds max(5xx ratio of the other nodes × multiple, floor) with at least the minimum requests; still not applied one window after the window's end |
| Rollback | Publishes a new revision with the stable revision's content and every node returns to it; sites disabled or deleted and domains removed during the window do not come back, cache generations and certificates keep their current values; audited (actor **System**), and the alert "Configuration canary rolled back" is sent, see [Cluster and DNS alerts](alerts.en.md#cluster-and-dns-alerts) |
| After a rollback | The cluster stays on the stable revision; database changes are not undone, and later publications still go through the canary |
| A new publication during the window | The new candidate replaces the old one; the window's start and canary nodes stay; only the new candidate's traffic counts, and a candidate applied at the window's end extends the window to the end of its first whole minute |
| Candidate withdrawn | When a new publication's content equals the stable revision, the canary ends with the outcome "Candidate withdrawn" |
| No canary node online | Published to every node at once, audited as `cluster.rollout_direct` with an alert; publishing is not blocked |
| Changes that reach every node at once | ACME HTTP-01 challenges; disabling and deleting sites and removing domains; disabling and deleting L4 apps; lowering access log sampling; certificate renewals; challenge key rotation; site and global Under Attack. They enter the stable revision too, while the other changes wait in the candidate. A [rollback](#rollback) also reaches every node at once |
| Turning the policy off | A running candidate is promoted to every node |

| State | Meaning |
| --- | --- |
| **Idle** | No candidate |
| **Canary** | The candidate runs on the canary nodes under observation |
| **Awaiting promotion** | The window passed; waiting for manual promotion |
| **Promoted** | The candidate is every node's revision |
| **Rolled back** | The canary nodes returned to the stable revision |
| **Published directly** | No canary node was online; the change was published directly |

| Card content | Description |
| --- | --- |
| State and outcome | The current state and the last rollout's outcome: Promoted automatically, Promoted manually, A canary node failed to apply it, A canary node did not apply it in time, A canary node became unhealthy, 5xx ratio over the threshold, Aborted manually, No canary node online, Policy turned off, Rolled back manually, Candidate withdrawn |
| **Stable revision** / **Candidate revision** | Revision numbers |
| **Last candidate** | The candidate rolled back or promoted last, with how long ago |
| **Changes** | During a rollout, the sites the candidate **adds**, **changes** and **removes** against the stable revision; "No site changes" when no site differs |
| **Reasons** | The publication reasons of the revisions after the stable one, without duplicates |
| **Window ends** | Countdown; hover for the time |
| **Canary traffic** / **Baseline traffic** | "N requests, M 5xx" |
| **Canary nodes** | Each canary node's applied revision, marked **In the window** when it takes part in this window; "No canary nodes" without any |

**Promote to all now** (confirming "Promote revision #{revision} to every node?", audited as `cluster.rollout_promote`) and **Abort and roll back** (confirming "Abort the canary of revision #{revision} and roll back?", audited as `cluster.rollout_abort`) are available in **Canary** and **Awaiting promotion** only. Policy changes are audited as `cluster.rollout_policy_update`.

## Node upgrades

The **Node upgrades** section of the **Releases** tab rolls signed upgrades out through canary node groups, see [Node upgrades](node-upgrades.en.md).

## Regions

Page: the **Regions** view of **Clusters & nodes** (`/clusters?view=regions`; `/regions` redirects there), with the page action **New region**. A region is a location label for node groups and regional probes (for example East China), shown in the node group and node tables; scheduling conditions on probe metrics can count the probers of one region alone. Probes are on the **Monitoring** tab of **System settings**, see [Regional probes](scheduling.en.md#regional-probes).

A dot map above the list marks the regions, placed by the city their code or name mentions (such as `ap-tokyo` or Tokyo); regions without a known city appear only in the list, and the map is hidden when none has one.

| Action | Description |
| --- | --- |
| **New region** | **Name**: at most 64 characters; **Code**: lowercase letters, digits and `-`, starting with a letter or digit, at most 32 characters, unique |
| **Edit region** | Opens from a click on the row; change name and code |
| Delete | **Delete** under **⋯** at the end of the row; refused while probes belong to the region ("N probes still belong to this region"); node groups that reference the region stay, without a region, and their nodes that also probe stop probing |

## Site enabling

**Disable** / **Enable** sits next to **Status** on the site's **Overview** tab (confirmed); API: [Enabling and disabling sites](../reference/api/sites.en.md#enabling-and-disabling-sites).

| Item | Behavior |
| --- | --- |
| Status | The **Status** column of **Sites** and the site's **Overview** tab: **Not live yet** (the cluster has no online node, or no online node has applied a revision with the site), **Rolling out N/M** (N of the M online nodes run the site's latest configuration with a healthy data plane), **Active** (every online node runs it), **Disabled**. During a [configuration canary](#configuration-canary) window "Canary N/M, all nodes at HH:MM"; with **Promote automatically** off in the policy "Canary N/M, awaiting promotion". While a [usage protection](usage-protection.en.md) action holds, also **Over usage limit**. Until the site is live everywhere the page refreshes every 5 seconds |
| Notices | After saving, creating, enabling or disabling a site the notice follows the nodes: **Rolling out N/M** → **Live on every node** (the window's end during a canary; **Removing N/M** → **Removed from the nodes** when disabling; "No online nodes" when the cluster has none), for up to 3 minutes |
| Nodes | A disabled site is not shipped; nodes answer HTTP requests for its domains with 503 (`X-Edgeweir-Error: site-disabled`) and the **Site disabled** [platform error page](system.en.md#platform-error-pages) or the built-in page; HTTPS requests fail in the TLS handshake |
| DNS | Records stay |
| Certificates | Renewal continues; HTTP-01 challenges are answered |
| Purge & prefetch | Return `SITE_DISABLED` |
| Rollback | Does not ship a disabled site again |
| Revisions and audit | A change publishes a revision and writes an audit entry (`site.enable`, `site.disable`); an unchanged state does neither |

## Needs attention

**Needs attention** at the top of **Overview** (`/overview`) lists what needs the operator, each row with its cluster; it is hidden when nothing does. The sidebar shows the number of items beside **Overview**, and the alerts bell in the top bar gets a red dot. Items come in this order:

| Item | Condition | A click opens |
| --- | --- | --- |
| **Unhealthy nodes: N** | Enabled nodes that connected before and are now offline, failed to apply, have an unhealthy data plane (after applying a configuration), or whose certificate the node channel refuses | The cluster |
| **DNS revision #N failed** | The cluster's DNS is not **Not managed** and a DNS revision failed to publish | The **DNS** tab |
| **DNS publication held by mass removal protection** | [Mass removal protection](dns.en.md#mass-removal-protection) stopped the cluster's DNS publication | The **DNS** tab |
| **Upgrade to X failed** | The cluster's latest [node upgrade](node-upgrades.en.md) failed, within the last 24 hours | The **Releases** tab |
| **Canary #N rolled back** | The configuration canary rolled back, within the last 24 hours; shows how long ago | The **Releases** tab |
| **Canary #N awaiting promotion** | The window passed; waiting for **Promote to all now** | The **Releases** tab |
| **Canary #N under observation** | The candidate runs on the canary nodes, with a countdown to the window's end | The **Releases** tab |
| **Lagging nodes: N** | Online, healthy nodes that do not run their target revision or need an upgrade | The cluster |
| **Nodes without a public address: N** | Online nodes without an address DNS can use, only in clusters whose DNS is not **Not managed**; see [Nodes without a public address](scheduling.en.md#nodes-without-a-public-address) | The cluster |

The three canary items appear only while the cluster's canary policy is on. API: `attention` of `GET /api/v1/overview`, see [Clusters and overview](../reference/api/clusters.en.md#clusters).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **The cluster still has N node(s) and M site(s)** | The cluster is not empty | Delete its nodes and sites, then retry |
| **Turn the cluster's DNS off and wait for its records to be removed** | The cluster's DNS is still **Automatic** or still owns records | Switch to **Not managed** on the **DNS** tab, wait for cleanup, then retry |
| **Cluster name already exists: …** / **Node group already exists: …** / **Region code already exists: …** | Duplicate name or code | Use another name or code |
| **The default node group cannot be deleted** | Deleting the default node group | The default node group can only be renamed or given another region |
| **N probes still belong to this region** | Deleting a region that still has probes | Delete those probes on the **Monitoring** tab of **System settings** first |
| **The node group belongs to another cluster** | Moving a node across clusters | Nodes move only within their cluster; changing clusters means deleting and enrolling again |
| **This cluster has reached its limit of 512 published sites** | The cluster's enabled sites reached the limit | Disable sites no longer in use, or create new sites in another cluster through `/api/v1` with `clusterId` |
| **Nodes do not support {features} yet: {nodes}** | A change published by a service account or an automatic job needs a capability active nodes of the cluster lack | Upgrade the nodes; see [Node upgrades](node-upgrades.en.md) |
| **The rollback references resources that are gone or unavailable** (in the rollback confirmation) | A site, domain, certificate, IP list or L4 app the chosen revision references was deleted, an L4 app's port is outside the port pools, or the certificate has expired | Pick a more recent revision, or fix the current configuration |
