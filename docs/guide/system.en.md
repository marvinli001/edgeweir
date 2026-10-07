# Clusters and system

Clusters, node groups, and nodes; revisions and the configuration canary; what needs attention; site enabling; regions; service accounts; the audit log; and system settings.

For **Global rules** and **IP lists**, see [Rules, IP lists, and GeoIP](rules.en.md); for **Bans**, [Bans](bans.en.md); for **DNS steering** and **Alerts**, [DNS steering and alerts](dns-and-alerts.en.md); for regional probes, scheduling addresses, and scheduling rules, [Regional probes and scheduling](scheduling.en.md). Every page of the sidebar: [Console navigation](account.en.md#console-navigation).

## Clusters and nodes

Page: **Clusters & nodes** (`/clusters`); the **Clusters | Regions** switch at the top moves between clusters and [regions](#regions) (`/clusters?view=regions`). The clusters view has the page actions **New cluster** and **Add node**, then a summary of the current cluster. With several clusters, **Select cluster** switches between them. A cluster without nodes shows only its node section (with **Add node**); the summary and the tabs appear once it has a node. The **Overview** tab holds node groups, nodes, configuration canary, cache zone, node upgrades, and revisions; the **DNS** tab holds the cluster's DNS binding, see [Bind a cluster](dns-and-alerts.en.md#bind-a-cluster); the **Scheduling** tab holds the cluster's scheduling rules and their preview, see [Scheduling rules](scheduling.en.md#scheduling-rules); the **Port pools** tab (`/clusters?tab=ports`) holds the port ranges the cluster's L4 apps may use, see [Set up port pools](l4.en.md#set-up-port-pools).

| Summary | Content |
| --- | --- |
| **Nodes online** | Online nodes / all nodes |
| **Sites** | The cluster's sites |
| **Latest revision** | The cluster's latest revision, such as `#12 · 7/8 applied`: 8 online enabled nodes, 7 of which run their target revision. While a canary runs, the canary nodes' target is the candidate and the other nodes' the stable revision, see [Configuration canary](#configuration-canary) |

### Clusters

A cluster is a set of nodes plus the sites assigned to them; each cluster has its own revision sequence.

| Action | Description |
| --- | --- |
| **New cluster** | **Cluster name**: lowercase letters, digits, and `-`, starting with a letter or digit, at most 64 characters, unique; **Description**: at most 500 characters. Creation adds the default node group `default` and publishes revision #1 |
| **Edit cluster** | Change name and description |
| **Delete** | Only when the cluster has no nodes and no sites, its DNS is not **Automatic**, and its written DNS records are removed |

| Rule | Description |
| --- | --- |
| Cluster of a site | With several clusters, the new-site form has a **Cluster** field (default: the oldest cluster); through `/api/v1`, `clusterId`. A site cannot change clusters later |
| Capacity | A cluster publishes at most 512 enabled sites and has at most 256 [L4 apps](l4.en.md) |
| Cache zone | The **Cache zone** card on the **Overview** sets the size and idle removal time of every node's cache zone, see [Cache zone](origins-and-cache.en.md#cache-zone) |

### Node groups

| Action | Description |
| --- | --- |
| **New node group** | **Node group**: name, at most 64 characters, unique within the cluster; **Region**: optional, see [Regions](#regions); **Canary group**: see [Configuration canary](#configuration-canary) |
| **Edit node group** | Change name, region, and **Canary group** |
| Delete | The default node group (marked **Default**) cannot be deleted; deleting another group moves its nodes back to the default group |

Node groups serve as the lines and backup node groups of **DNS steering**, as canary groups for node upgrades, and as canary groups for the configuration canary. A node group's region is also the region its nodes probe from when they **Also probe**.

### Adding a node

The **Add node** dialog generates a one-time install command as it opens: the cluster's default node group, valid for 1 hour, no node name. **Options** shows the fields below; **Regenerate** generates a new command with them.

| Field | Description |
| --- | --- |
| **Node name** | Optional, at most 64 characters |
| **Node group** | Defaults to the cluster's default node group; hidden when the cluster has only one |
| **Valid for** | 15 minutes, 1 hour (default), or 24 hours; the API accepts 5 minutes to 7 days |

The dialog shows the **Install command** (with a countdown, shown once), address warnings, and one line with the node channel connection check (with a "Change" link to [Node channel](#node-channel) when it fails), then **Progress**. The CA fingerprint is in the command's `--ca-sha256` and in [System information](#system-information). Every opening of the dialog generates a new token; once closed, the command is not shown again. The token starts with `ewt_` and is single-use; the database keeps its SHA-256 and prefix, never the plaintext. Address warnings, the connection check, and the install flow: [Adding nodes](../deploy/nodes.en.md).

### Nodes

| Column | Content |
| --- | --- |
| **Node** | Name and host name |
| **Status** | **Online** (heartbeat within 45 seconds), **Offline**, **Disabled**; an enrolled node that has not connected to the node channel since shows **Awaiting heartbeat** (grey); an online node that reports an unhealthy data plane is also marked **Data plane unhealthy**; an offline node whose certificate the node channel refuses is marked **Certificate expired** or **Certificate refused** |
| **Node group** | Node group and region |
| **IP** | Unicast addresses in the node's latest heartbeat (replaced on every heartbeat, at most 64); for the addresses DNS and probes use, see [Scheduling addresses and backup IPs](scheduling.en.md#scheduling-addresses-and-backup-ips); marked **No public address** when DNS has no address for the node, see [Nodes without a public address](scheduling.en.md#nodes-without-a-public-address) |
| **Metrics** | CPU and memory usage reported by the node (`metrics-v1`); "—" without metrics |
| **Applied** | The revision the node has applied; badge **In sync** (the node's target revision reached), **Behind**, **Apply failed** (hover for the reason), or **Upgrade required**; an online node without any configuration yet shows **Awaiting configuration** |
| **Agent / engine** | Agent version, engine, and engine version |
| **Heartbeat** | Time of the last heartbeat |

| Action | Description |
| --- | --- |
| **Details** | Also by clicking the node's name (`/clusters?node=<node ID>`): **Metrics**, **Data plane** (Healthy / Data plane unhealthy), **Connects from**, **Certificate expires** (the client certificate; marked **Expires soon** with less than 10 days left, by when nodes normally renewed it already, and **Certificate expired** or **Certificate refused** once past or refused by the node channel), **Also probes**, **Scheduling addresses** (**Edit addresses**), and **Probe results**, see [Regional probes and scheduling](scheduling.en.md); **Cache** shows the cache usage and sets this node's own size, see [Cache zone](origins-and-cache.en.md#cache-zone) |
| **Rename** | At most 64 characters |
| **Move to group** | Node groups of the same cluster only |
| **Disable** / **Enable** | A disabled node is refused by the node channel (except for certificate renewal, so its certificate is still valid when enabled) and keeps serving its last successfully applied configuration; its unfinished purge & prefetch deliveries are marked **Skipped**. Once the node is enabled and pulls tasks again, it gets one whole-site purge for every site those purges touched |
| **Delete** | Revokes the node certificate; the node must enroll again with a new install command |

### Node upgrades

The **Node upgrades** section runs signed upgrades with a canary node group and explicit promotion; see [Node upgrades](node-upgrades.en.md).

### Configuration canary

The **Configuration canary** card sets the cluster's policy and shows the current rollout. Off by default.

| Policy field | Values | Default |
| --- | --- | --- |
| **Enable canary** | On / off | Off |
| **Observation window (minutes)** | 1–60 | 5 |
| **Promote automatically** | On: promote to every node when the window passes; off: wait for **Promote to all now** | On |
| **5xx ratio multiple of the baseline** | 1–100 | 2 |
| **5xx ratio floor (%)** | 0.1–100 | 5 |
| **Minimum requests** | 1–1000000 | 100 |

| Item | Behavior |
| --- | --- |
| Canary nodes | Enabled nodes of **Canary group** node groups that are online when the window starts. They stay the same until the window ends: a node that leaves the group meanwhile remains a canary node, one that joins waits for the next window |
| Target revisions | Canary nodes get the candidate, the other nodes the stable revision; a node never gets a revision newer than its target |
| DNS | Each node is compared with its own target; non-canary nodes are not removed during the window |
| Rollback when (any, within the window) | A canary node fails to apply; its data plane is unhealthy or it goes offline; the canary 5xx ratio exceeds max(the non-canary nodes' 5xx ratio × multiple, floor) with at least the minimum requests; a canary node has not applied the candidate one window after the window ended |
| Rollback | The stable content is published as a new revision and every node returns to it, without sites disabled or deleted and domains removed during the window, and with the current cache generations and certificates; audited as the system, and "Configuration canary rolled back" goes to the alert channels with **Receive every alert** on |
| After a rollback | The cluster stays on the stable revision. The database keeps the change; the next publication goes through the canary again |
| New publication during the window | The new candidate replaces the old one; the window keeps its start and its canary nodes |
| No canary node online | The change goes to every node, `cluster.rollout_direct` is audited and an alert is sent; publishing is not blocked |
| Changes that reach every node at once | ACME HTTP-01 challenges; disabling or deleting a site and removing a domain; disabling or deleting an L4 app; lowering the access log sampling rate; certificate renewals; challenge key rotation; **Under Attack** of sites and the global one. The stable revision takes these at once; other changes wait in the candidate for the window. **Roll back** in **Revisions** reaches every node at once too |
| Turning the policy off | A running candidate is promoted to every node |

| State | Meaning |
| --- | --- |
| **Idle** | No candidate |
| **Canary** | The candidate runs on the canary nodes under observation |
| **Awaiting promotion** | The window passed; waiting for manual promotion |
| **Promoted** | The candidate is every node's revision |
| **Rolled back** | The canary nodes returned to the stable revision |
| **Published to all** | No canary node was online; the change went to every node |

While a rollout runs, the card also shows:

| Item | Content |
| --- | --- |
| **Changes** | Sites the candidate adds, changes, and removes against the stable revision, by name under **Added**, **Changed**, **Removed**; "No site changes" when no site differs |
| **Reasons** | Why the revisions after the stable one were published, without repeats |
| **Window ends** | A countdown; hover for the time |

**Promote to all now** (audited as `cluster.rollout_promote`) and **Abort and roll back** (audited as `cluster.rollout_abort`) need confirmation and are available in **Canary** and **Awaiting promotion** only. Policy changes are audited as `cluster.rollout_policy_update`.

### Revisions

Every change that affects node configuration publishes a new revision in the cluster. The **Revisions** table lists the latest 20: **Revision**, **Content hash**, **Sites**, **Reason**, **Time**. Each cluster keeps its latest 200 revisions; the stable and candidate revisions of the canary are never pruned. Revisions published only for ACME HTTP-01 challenges do not count and are deleted after an hour.

| Reason | Trigger |
| --- | --- |
| Cluster {cluster} created | New cluster |
| Site {site} created / updated / deleted | Site changes |
| Site {site} enabled / disabled | [Site enabling](#site-enabling) |
| L4 application {app} created / updated / deleted | [L4 app](l4.en.md) changes; disabling and enabling use "updated" |
| Site {site} purged | **Purge cache** on a site in older consoles (now a node task that publishes no revision) |
| Certificate policy for {site} updated | HTTPS settings changed; a certificate used by the site was issued or renewed |
| ACME challenge updated | HTTP-01 challenge changes |
| Rules and IP lists updated | Site rule, global rule, or IP list changes |
| Protection of {site} updated | Under Attack, CC mitigation, or challenge settings changed on the site's **Security** tab |
| OWASP CRS of {site} updated | OWASP CRS settings changed on the site's **Security** tab |
| Global Under Attack updated | Global Under Attack changed in [Protection](#protection); every cluster publishes one revision |
| CC template updated | [CC template](#cc-template) changed; every cluster with a site following the template publishes one revision |
| Challenge keys rotated | The daily challenge key rotation; every cluster whose configuration carries challenge keys publishes one revision |
| Origin allow list updated | [Origin allow list](#origin-allow-list) changed; every cluster publishes one revision |
| Rolled back to #{revision} | **Roll back** |
| Canary of revision {revision} rolled back | [Configuration canary](#configuration-canary) rollback |
| Configuration recompiled after an upgrade | A console upgrade changed what the stored configuration compiles to; every cluster publishes one revision |

**Roll back** publishes the content of the chosen revision as a new revision; history is kept. Sites and L4 apps that are currently disabled do not return through a rollback; IP lists, global rules, global Under Attack, and the origin allow list keep their current values. A rollback is refused when a site, domain, certificate, IP list, or L4 app the chosen revision references was deleted, an L4 app's port is no longer inside a port pool, or the certificate has expired.

The confirmation of **Roll back** lists the sites the rollback adds, changes, and removes against the latest revision (**Added**, **Changed**, **Removed**); "Same as the current revision" when the content equals the latest revision, "No site changes" when only settings other than sites differ. When the rollback cannot be done (for example `ROLLBACK_RESOURCE_UNAVAILABLE`), the reason shows instead and the confirm button stays disabled. The preview writes nothing; for the API, see [Clusters and overview](../reference/api.en.md#clusters-and-overview).

When a change needs a capability that active nodes of the cluster lack:

| Publisher | Behavior |
| --- | --- |
| The console account (session or AccessKey) | Published anyway; nodes without the capability show **Upgrade required** and keep their configuration |
| Service accounts | 409 `NODE_CAPABILITY_REQUIRED`; nothing is published |
| Automatic console jobs | Nothing is published |

## Needs attention

**Needs attention** at the top of **Overview** (`/overview`) lists what needs the operator, each row with its cluster; a row opens the cluster (DNS items its **DNS** tab). It is hidden when nothing does. The sidebar shows the number of items beside **Overview**. Items come in this order:

| Item | Condition |
| --- | --- |
| **Unhealthy nodes: N** | Enabled nodes that connected before and are now offline, failed to apply, have an unhealthy data plane (after applying a configuration), or whose certificate the node channel refuses |
| **DNS revision #N failed** | The cluster's DNS is not **Not managed** and a DNS revision failed to publish |
| **DNS publication held back by the mass removal protection** | [Mass removal protection](dns-and-alerts.en.md#mass-removal-protection) stopped the cluster's DNS publication |
| **Upgrade to X failed** | The cluster's latest [node upgrade](node-upgrades.en.md) failed, within the last 24 hours |
| **Canary #N rolled back** | The [configuration canary](#configuration-canary) rolled back, within the last 24 hours |
| **Canary #N awaits promotion** | The window passed; waiting for **Promote to all now** |
| **Canary #N under observation** | The candidate runs on the canary nodes, with a countdown to the window's end |
| **Lagging nodes: N** | Online, healthy nodes that do not run their target revision or need an upgrade |
| **Nodes without a public address: N** | Online nodes without an address DNS can use, only in clusters whose DNS is not **Not managed**; see [Nodes without a public address](scheduling.en.md#nodes-without-a-public-address) |

API: `attention` of `GET /api/v1/overview`, see [Clusters and overview](../reference/api.en.md#clusters-and-overview).

## Site enabling

**Disable** / **Enable** sits next to **Status** on the site's **Overview** tab (confirmed); for the API, see [Enabling and disabling sites](../reference/api.en.md#enabling-and-disabling-sites).

| Item | Behavior |
| --- | --- |
| Status | The **Status** column of **Sites** and the site's **Overview** tab show whether the site runs on the nodes: **Not live yet** (the cluster has no online node, or no online node has applied a revision with the site), **Rolling out N/M** (N of the M online nodes run the site's latest configuration with a healthy data plane), **Active** (every online node runs it), **Disabled**. During a [configuration canary](#configuration-canary) window it shows **Canary N/M, all nodes at HH:MM** (the nodes outside the canary keep the previous version until the window ends; **awaiting promotion** when promotion is manual). Until the site is live the page refreshes every 5 seconds |
| Notices | After saving, creating, enabling or disabling a site the notice follows the nodes: **Rolling out N/M** → **Live on every node** (the window's end during a canary; **Removing N/M** → **Removed from the nodes** when disabling), for up to 3 minutes |
| Nodes | A disabled site is not shipped; nodes answer HTTP requests for its domains with 503 (`X-Edgeweir-Error: site-disabled`) and the **Site disabled** [platform error page](#platform-error-pages) or the built-in page; HTTPS requests fail in the TLS handshake |
| DNS | Records stay |
| Certificates | Renewal continues; HTTP-01 challenges are answered |
| Purge & prefetch | Return `SITE_DISABLED` |
| Rollback | Does not ship a disabled site again |
| Revisions and audit | A change publishes a revision and writes an audit entry (`site.enable`, `site.disable`); an unchanged state does neither |

## Regions

Page: the **Regions** view of **Clusters & nodes** (`/clusters?view=regions`; `/regions` redirects there), with the page action **New region**. A region is a label for node groups and regional probes (for example East China), shown in the node group and node tables; scheduling conditions on probe metrics can count the probers of one region alone. Probes are on the **Monitoring** tab of **System settings**, see [Regional probes](scheduling.en.md#regional-probes).

| Action | Description |
| --- | --- |
| **New region** | **Name**: at most 64 characters; **Code**: lowercase letters, digits, and `-`, starting with a letter or digit, at most 32 characters, unique |
| **Edit region** | Change name and code |
| Delete | Refused while probes belong to the region (**N probes still belong to this region**); node groups that reference the region stay, without a region, and their nodes that also probe stop probing |

## Service accounts

Page: the **Service accounts** tab of **System settings** (`/system?tab=service-accounts`; `/service-accounts` redirects there), with the page action **New service account**. A service account is an identity integrations use on `/api/v1`: it cannot sign in to the console and calls only the procedures below, with a key (prefix `ews_`, header `x-api-key`).

| Action | Description |
| --- | --- |
| **New service account** | **Name** (at most 64 characters, unique), **Scopes**, **Enabled** |
| **Edit** | Change name, scopes, and enabled state; keys of a disabled service account are refused |
| **Keys** | **New key** (optional **Key name**; the key is shown once); **Revoke** needs confirmation. The list shows **Revoked** and **Last used** |
| Delete | Needs confirmation; all of its keys stop working |

| Scope | Callable procedures |
| --- | --- |
| No scope needed | `system.status`, `account.me`, `dns.catalog` |
| `system:read` | `settings.get` |
| `clusters:read` | `clusters.list`, `clusters.get` |
| `sites:read` | `sites.list`, `sites.get`, `sites.launch`, `dns.siteTarget` |
| `sites:write` | `sites.setEnabled` |
| `usage:read` | `usage.list`, `usage.changes` |

| Item | Behavior |
| --- | --- |
| Other procedures | 403 `SERVICE_ACCOUNT_FORBIDDEN` |
| Missing scope | 403 `SCOPE_REQUIRED`; `data.scope` names the scope needed |
| Node capabilities | A change that needs a capability active nodes of the cluster lack returns 409 `NODE_CAPABILITY_REQUIRED`; see [Revisions](#revisions) |
| Audit | Changes made by a service account are audited with the actor **Service account**; changes to service accounts and their keys are audited as `service_account.*` |

Endpoints and request format: [Service accounts](../reference/api.en.md#service-accounts).

## Audit log

Page: **Audit log** (`/audit`). Management actions are written to the audit log. The console's own changes commit together with their audit entry in one transaction; sign-in, password, two-factor, and passkey changes are completed by better-auth, and their entries are written after it commits, with write failures only logged. The audit log is never pruned automatically.

| Field | Content |
| --- | --- |
| Time | When the action happened |
| Actor | Type (**User**, **AccessKey**, **Service account**, **Node**, **Probe**, **System**), ID, name |
| IP, User-Agent | Request origin; empty for actions no request carried (nodes, probes, the system). For how the IP is determined, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip) |
| Action | A code such as `site.create`; the UI shows its name (e.g. **Site created**) |
| Target | Type, ID, name; the name is recorded at the time of the action and stays readable after the target is deleted |
| Metadata | JSON with the action's parameters and before/after values |

The page shows **Time**, **Actor**, **Action** (name and code), and **Target**, 50 entries per page; filters for **Action**, **Target** type, and time range (**Any time**, **Last hour**, **Last 24 hours**, **Last 7 days**, **Last 30 days**). **Details** at the end of a row shows every field: the full time, the actor and target IDs, IP, User-Agent, and the metadata as formatted JSON. Older codes without a name are shown as they are. `/api/v1` returns every field; see [API and endpoints](../reference/api.en.md).

| Action prefix | Content |
| --- | --- |
| `system.*` | Setup (including `system.setup_rejected` for a wrong setup token), node channel URL (`system.node_channel_update`), origin allow list, node release source, usage settings, ban settings, protection, CC template, probe settings (`system.probes_update`), recompilation after an upgrade |
| `auth.*` | Successful (`auth.sign_in`, with the sign-in method) and failed (`auth.sign_in_failed`) sign-ins |
| `account.*` | Password change, two-factor enable / disable, passkey add / delete, account recovery on the server (`account.recover`, see [Account recovery](account.en.md#account-recovery)) |
| `api_key.*` | AccessKey create, revoke |
| `service_account.*` | Service accounts and their keys |
| `cluster.*`, `node_group.*`, `region.*`, `node.*`, `enrollment_token.*` | Clusters (including the configuration canary, rollbacks, challenge key rotation, and port pools `cluster.port_pools_update`), node groups, regions, nodes (including enrollment, certificate renewal, upgrades, scheduling addresses `node.set_addresses`, probing `node.set_probe`), install commands |
| `probe.*` | Probe tokens (`probe.token_create`), enrollment (`probe.enroll`) and certificate renewal (`probe.certificate_renew`, actor **Probe**), renaming and enabling (`probe.update`), deletion (`probe.delete`) |
| `scheduling.*` | Scheduling rule changes (`scheduling.rule_create`, `scheduling.rule_update`, `scheduling.rule_delete`); rule actions taking effect and recovering (`scheduling.activate`, `scheduling.recover`, actor **System**) |
| `l4_app.*` | L4 apps: `l4_app.create`, `l4_app.update`, `l4_app.enable`, `l4_app.disable`, `l4_app.delete` |
| `site.*`, `cache.*`, `certificate.*`, `dns_credential.*`, `ip_list.*`, `platform.*` | Sites (including enabling, HTTPS, logs, protection, OWASP CRS, and site rules), purge & prefetch, certificates, DNS credentials, IP lists, global rules |
| `ban.*` | Manual bans: `ban.create`, `ban.update` (banned again), `ban.delete` (unbanned) |
| `dns.*`, `alert.*` | DNS steering (including provider accounts, cluster bindings, rollbacks, mass removal protection, and forced publications), alert channels, alert rules, SMTP, alert subscriptions |

## System settings

Page: **System settings** (`/system`), with the tabs:

| Tab | Content |
| --- | --- |
| **General** | The sections below: system information, node channel, origin allow list, node release source, usage, platform error pages |
| **Monitoring** | `/system?tab=probes`: the regional probe list (page action **Add probe**) and the **Probe settings** card, see [Regional probes](scheduling.en.md#regional-probes); `/regions?tab=probes` redirects there |
| **Service accounts** | `/system?tab=service-accounts`, see [Service accounts](#service-accounts) |

### System information

Read-only (card **System**).

| Item | Source |
| --- | --- |
| **Version** | Image version `<YYYYMMDD>-<commit>`; `dev` when run from source |
| **Console URL** | `EDGEWEIR_PUBLIC_URL`; localhost or a loopback address is marked "This machine only", a private address "Private address": nodes on other networks cannot download `install.sh` from it; a public address over HTTP is marked "Unencrypted": `install.sh` reaches the hosts that run it as root unencrypted |
| **CA fingerprint** | SHA-256 of the node channel's internal CA; install commands carry the same value in `--ca-sha256` |
| **Analytics** | `EDGEWEIR_ANALYTICS` (`lite` / `clickhouse`) |
| **Setup token** | **Not used** or **Used {time}** |
| **OpenAPI** | `/api/v1/openapi.json` |

### Node channel

**URL**: where nodes and region probes reach the node channel, `--server` in the install command. While the field is empty, `EDGEWEIR_NODE_API_URL` applies, and when that is unset `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>`; the placeholder shows the URL in effect and the badge where it comes from.

| Constraint | Description |
| --- | --- |
| Format | `https://host[:port]` without a path, query, or credentials; saved with the host name in lower case, without a trailing `/` or the default port 443 |
| Effect | Applies on saving, without a restart: new install and probe commands carry the URL, and the node channel certificate adds its host name or IP |
| Enrolled nodes | Keep connecting to the URL they enrolled with, whose name stays in the certificate; while editing, the card notes "Enrolled nodes keep connecting to the previous URL: keep it reachable" |
| Clearing | Saving an empty value falls back to the environment variable or the default |

A localhost, loopback, or private address is marked "This machine only" or "Private address": nodes on other networks cannot enroll. Below the URL is the result of the [connection check](../deploy/nodes.en.md#node-channel-connection-check): **Reachable**, **The console cannot connect to this URL**, **Certificate mismatch: a proxy or CDN may be in front**, or **The outbound policy does not allow this address** (the saved URL is a private, loopback, or other special-purpose address that `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` does not allow, so the console does not connect). Changes are audited as `system.node_channel_update`. For the certificate names, see [Node channel URL and certificate](../deploy/networking.en.md#node-channel-url-and-certificate).

### Origin allow list

**Allowed ranges (one CIDR per line)**, at most 256 entries. Private, loopback, and other special-purpose addresses in the list become usable as origins. Saving publishes one revision in every cluster and is audited as `system.origin_allow_list_update`. For origin address rules, see [Origin address restrictions](origins-and-cache.en.md#origin-address-restrictions).

### Node release source

**Release source URL**: the mirror from which node upgrades read release manifests, laid out as `<url>/v<version>/checksums.txt`.

| Constraint | Description |
| --- | --- |
| Format | `http(s)` URL without credentials, query, or fragment |
| Protocol | Public addresses require HTTPS; HTTP only for private addresses allowed by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Outbound policy | The host name is resolved on save; the address must be public or allowed by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Clearing | Saving an empty value falls back to the environment variable or the default |

Each node also pins its own release source and signature trust locally, out of the console's reach; see [Node upgrades](node-upgrades.en.md).

### Usage

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Retention (days)** | 35–400 | 100 | How long usage records are kept |
| **Offline nodes stop holding completeness (minutes)** | 5–1440 | 60 | Nodes without a heartbeat for longer no longer hold back `completeUntil` |

Changes are audited as `system.usage_update`. The usage API and the definition of `completeUntil`: [Usage](../reference/api.en.md#usage).

### Platform error pages

| Field | Requests it applies to | Notes |
| --- | --- | --- |
| **Unknown host** | The Host belongs to no site of the cluster | Status 404; empty uses the built-in page |
| **Site disabled** | Domains of disabled sites | Status 503 |

Each template is at most 65536 bytes (UTF-8); the values of the placeholders `{{status}}`, `{{request_id}}`, `{{client_ip}}`, `{{host}}`, `{{time}}` and `{{path}}` are HTML-escaped; with `{{time}}` or `{{path}}` the configurations of every cluster need the node capability `rules-v3`. Saving publishes one revision in every cluster ("Platform error pages updated") and is audited as `system.error_pages_update`. Older nodes ignore platform error pages. See [Error pages](error-pages.en.md#platform-error-pages).

### Precedence

A value saved in the console wins over the environment variable, which wins over the default. The environment variables remain only as a fallback for existing deployments.

| Setting | Location | Environment variable | Default |
| --- | --- | --- | --- |
| Node channel | **System settings → Node channel** | `EDGEWEIR_NODE_API_URL` | `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>` |
| Node release source | **System settings → Node release source** | `EDGEWEIR_NODE_RELEASE_BASE_URL` | `https://github.com/marvinli001/edgeweir-node/releases/download` |
| SMTP CA certificates | **Alerts → SMTP → CA certificates (PEM)** | `EDGEWEIR_SMTP_CA_FILE` (path to a PEM file) | System trust store |
| SMTP server and account | **Alerts → SMTP** | None | Not configured |
| Origin allow list | **System settings → Origin allow list** | None | Empty |
| Usage | **System settings → Usage** | None | 100 days retention, 60-minute offline threshold |
| Bans | **Protection settings → Bans** | None | Limit 10000, automatic bans shared |
| Protection | **Protection settings → Protection** | None | Global Under Attack off, challenge type JavaScript, events kept 30 days |

The badges of **Node channel** and **Node release source** show where the value in effect comes from: **Saved**, **Environment**, or **Default**. Release source addresses saved in system settings are bounded by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS`; values in environment variables are set by the operator and skip that check. For every environment variable, see [Environment variables](../reference/environment.en.md).

## Protection settings

Page: **Protection settings** (`/protection`), under **Access control** in the sidebar.

### Bans

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Limit of manual bans** | 100–100000 | 10000 | Active manual bans in total, site and global bans together; beyond it `BAN_PLATFORM_LIMIT` |
| **Share automatic bans in the cluster** | On / off | On | Whether automatic bans of a node go to the other nodes of its cluster; off keeps them for viewing only |

Changes are audited as `system.bans_update`. See [Bans](bans.en.md).

### Protection

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Global Under Attack** | On / off | Off | Every GET/HEAD request without a pass is challenged first, on every site; switching asks for confirmation |
| **Challenge type** | Cookie redirect / JavaScript / Proof of work / Image captcha | JavaScript | Challenge type of global Under Attack |
| **Security event retention (days)** | 7–365 | 30 | How long CC mitigation events reported by nodes are kept |

Switching global Under Attack, or changing the challenge type while it is on, publishes one revision in every cluster. Changes are audited as `system.protection_update`. Global Under Attack needs the node capability `challenge-v1`; nodes without it keep their configuration, see [Revisions](#revisions). For a site's own Under Attack and CC mitigation, see [Challenges and CC mitigation](challenges.en.md).

### CC template

Thresholds for sites whose CC mitigation is on and set to **Follow the default template**: highest level, high proof of work instead of the captcha, window, site QPS, per-URL QPS, per-IP QPS, IP ban duration, origin error rate, minimum origin requests, escalate after, step down after. **Preset** picks Loose, Standard, or Strict, or **Custom** to set each field; fields, ranges, defaults, and the presets' values: [CC mitigation](challenges.en.md#cc-mitigation). Saving publishes a revision to every cluster with a following site; changes are audited as `system.cc_template_update`.

### GeoIP databases

Read-only. Shows, per node, the state of the **Country**, **Subdivision**, and **ASN** data (**Ready** / **Unavailable**), with the IPinfo attribution link. Country and ASN data ship in node release images; other databases are configured locally on each node; **Configure databases** links to [Rules, IP lists, and GeoIP](rules.en.md).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **The cluster still has N node(s) and M site(s)** | The cluster is not empty | Delete its nodes and sites, then retry |
| **Turn the cluster's DNS off and wait for its records to be removed** | The cluster's DNS is still **Automatic** or still owns records | Switch to **Not managed** on the **DNS** tab, wait for cleanup, then retry |
| **Cluster name already exists: …** / **Node group already exists: …** / **Region code already exists: …** / **A service account named … exists** | Duplicate name or code | Use another name or code |
| **The default node group cannot be deleted** | Deleting the default node group | The default node group can only be renamed or given another region |
| **N probes still belong to this region** | Deleting a region that still has probes | Delete those probes on the **Monitoring** tab of **System settings** first |
| **The node group belongs to another cluster** | Moving a node across clusters | Nodes move only within their cluster; changing clusters means deleting and enrolling again |
| **This cluster has reached its limit of 512 published sites** | The cluster's enabled sites reached the limit | Disable sites no longer in use, or create new sites in another cluster through `/api/v1` with `clusterId` |
| **Cluster nodes need these capabilities first: …** | A change published by a service account or an automatic job needs a capability active nodes of the cluster lack | Upgrade the nodes; see [Node upgrades](node-upgrades.en.md) |
| **Rollback references resources that are no longer assigned or available** (in the rollback confirmation) | A site, domain, certificate, or IP list the chosen revision references was deleted, or the certificate has expired | Pick a more recent revision, or fix the current configuration |
| **Service accounts cannot call this** | A service account called a procedure outside the [Service accounts](#service-accounts) table | Use an AccessKey |
| **Missing scope: …** | The service account lacks the scope the procedure needs | Edit its scopes on the **Service accounts** tab of **System settings** |
| **The release source must use HTTPS and resolve to an allowed address** | Public HTTP URL, or a private address that is not allowed | Use HTTPS, or allow the range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
