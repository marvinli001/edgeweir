# Clusters and system

Clusters, node groups, and nodes; revisions and the configuration canary; site enabling; regions and probes; service accounts; the audit log; and system settings.

For **Global rules** and **IP lists**, see [Rules, IP lists, and GeoIP](rules.en.md); for **Bans**, [Bans](bans.en.md); for **DNS steering** and **Alerts**, [DNS steering and alerts](dns-and-alerts.en.md); for regional probes, scheduling addresses, and scheduling rules, [Regional probes and scheduling](scheduling.en.md). Every page of the sidebar: [Console navigation](account.en.md#console-navigation).

## Clusters and nodes

Page: **Clusters & nodes** (`/clusters`). The top of the page holds **New cluster**, **Add node**, and a summary of the current cluster (**Nodes online**, **Sites**, **Latest revision**). With several clusters, **Select cluster** switches between them. The **Overview** tab holds node groups, nodes, configuration canary, node upgrades, and revisions; the **DNS** tab holds the cluster's DNS binding, see [Bind a cluster](dns-and-alerts.en.md#bind-a-cluster); the **Scheduling** tab holds the cluster's scheduling rules and their preview, see [Scheduling rules](scheduling.en.md#scheduling-rules); the **Port pools** tab (`/clusters?tab=ports`) holds the port ranges the cluster's L4 apps may use, see [Set up port pools](l4.en.md#set-up-port-pools).

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

### Node groups

| Action | Description |
| --- | --- |
| **New node group** | **Node group**: name, at most 64 characters, unique within the cluster; **Region**: optional, see [Regions](#regions); **Canary group**: see [Configuration canary](#configuration-canary) |
| **Edit node group** | Change name, region, and **Canary group** |
| Delete | The default node group (marked **Default**) cannot be deleted; deleting another group moves its nodes back to the default group |

Node groups serve as the lines and backup node groups of **DNS steering**, as canary groups for node upgrades, and as canary groups for the configuration canary. A node group's region is also the region its nodes probe from when they **Also probe**.

### Adding a node

**Add node** generates a one-time install command.

| Field | Description |
| --- | --- |
| **Node name** | Optional, at most 64 characters |
| **Node group** | Defaults to the cluster's default node group |
| **Valid for** | 15 minutes, 1 hour (default), or 24 hours; the API accepts 5 minutes to 7 days |

Result: the **Install command** (shown once, with a countdown) and the **CA fingerprint**. The token starts with `ewt_` and is single-use; the database keeps its SHA-256 and prefix, never the plaintext. For the install flow, see [Adding nodes](../deploy/nodes.en.md).

### Nodes

| Column | Content |
| --- | --- |
| **Node** | Name and host name |
| **Status** | **Online** (heartbeat within 45 seconds), **Offline**, **Disabled**; an online node that reports an unhealthy data plane is also marked **Data plane unhealthy** |
| **Node group** | Node group and region |
| **IP** | Unicast addresses in the node's latest heartbeat (replaced on every heartbeat, at most 64); for the addresses DNS and probes use, see [Scheduling addresses and backup IPs](scheduling.en.md#scheduling-addresses-and-backup-ips) |
| **Metrics** | CPU and memory usage reported by the node (`metrics-v1`); "—" without metrics |
| **Applied** | The revision the node has applied; badge **In sync** (the node's target revision reached), **Behind**, **Apply failed** (hover for the reason), or **Upgrade required** |
| **Agent / engine** | Agent version, engine, and engine version |
| **Heartbeat** | Time of the last heartbeat |

| Action | Description |
| --- | --- |
| **Details** | Also by clicking the node's name (`/clusters?node=<node ID>`): **Metrics**, **Data plane** (Healthy / Data plane unhealthy), **Certificate expires** (the client certificate; marked **Expires soon** with less than 10 days left, by when nodes normally renewed it already, and **Certificate expired** once past), **Also probes**, **Scheduling addresses** (**Edit addresses**), and **Probe results**, see [Regional probes and scheduling](scheduling.en.md) |
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
| Changes that reach every node at once | ACME HTTP-01 challenges; disabling or deleting a site and removing a domain; disabling or deleting an L4 app; a site's **Purge cache**; lowering the access log sampling rate; certificate renewals; challenge key rotation; **Under Attack** of sites and the global one. The stable revision takes these at once; other changes wait in the candidate for the window. **Roll back** in **Revisions** reaches every node at once too |
| Turning the policy off | A running candidate is promoted to every node |

| State | Meaning |
| --- | --- |
| **Idle** | No candidate |
| **Canary** | The candidate runs on the canary nodes under observation |
| **Awaiting promotion** | The window passed; waiting for manual promotion |
| **Promoted** | The candidate is every node's revision |
| **Rolled back** | The canary nodes returned to the stable revision |
| **Published to all** | No canary node was online; the change went to every node |

**Promote to all now** (audited as `cluster.rollout_promote`) and **Abort and roll back** (audited as `cluster.rollout_abort`) need confirmation and are available in **Canary** and **Awaiting promotion** only. Policy changes are audited as `cluster.rollout_policy_update`.

### Revisions

Every change that affects node configuration publishes a new revision in the cluster. The **Revisions** table lists the latest 20: **Revision**, **Content hash**, **Sites**, **Reason**, **Time**. Each cluster keeps its latest 200 revisions; the stable and candidate revisions of the canary are never pruned. Revisions published only for ACME HTTP-01 challenges do not count and are deleted after an hour.

| Reason | Trigger |
| --- | --- |
| Cluster {cluster} created | New cluster |
| Site {site} created / updated / deleted | Site changes |
| Site {site} enabled / disabled | [Site enabling](#site-enabling) |
| L4 application {app} created / updated / deleted | [L4 app](l4.en.md) changes; disabling and enabling use "updated" |
| Site {site} purged | **Purge cache** on a site |
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

When a change needs a capability that active nodes of the cluster lack:

| Publisher | Behavior |
| --- | --- |
| The console account (session or AccessKey) | Published anyway; nodes without the capability show **Upgrade required** and keep their configuration |
| Service accounts | 409 `NODE_CAPABILITY_REQUIRED`; nothing is published |
| Automatic console jobs | Nothing is published |

## Site enabling

**Disable** / **Enable** sits next to **Status** on the site's **Overview** tab (confirmed); for the API, see [Enabling and disabling sites](../reference/api.en.md#enabling-and-disabling-sites).

| Item | Behavior |
| --- | --- |
| List | The **Status** column of **Sites** shows **Active** or **Disabled** |
| Nodes | A disabled site is not shipped; nodes answer 404 for its domains (`X-Edgeweir-Error: unknown-host`) |
| DNS | Records stay |
| Certificates | Renewal continues; HTTP-01 challenges are answered |
| Purge & prefetch | Return `SITE_DISABLED` |
| Rollback | Does not ship a disabled site again |
| Revisions and audit | A change publishes a revision and writes an audit entry (`site.enable`, `site.disable`); an unchanged state does neither |

## Regions

Page: **Regions & probes** (`/regions`), with the tabs **Regions** and **Probes** (`/regions?tab=probes`). A region is a label for node groups and regional probes (for example East China), shown in the node group and node tables; scheduling conditions on probe metrics can count the probers of one region alone. Probes: [Regional probes](scheduling.en.md#regional-probes).

| Action | Description |
| --- | --- |
| **New region** | **Name**: at most 64 characters; **Code**: lowercase letters, digits, and `-`, starting with a letter or digit, at most 32 characters, unique |
| **Edit region** | Change name and code |
| Delete | Refused while probes belong to the region (**N probes still belong to this region**); node groups that reference the region stay, without a region, and their nodes that also probe stop probing |

## Service accounts

Page: **Service accounts** (`/service-accounts`). A service account is an identity integrations use on `/api/v1`: it cannot sign in to the console and calls only the procedures below, with a key (prefix `ews_`, header `x-api-key`).

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
| `sites:read` | `sites.list`, `sites.get`, `dns.siteTarget` |
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
| IP, User-Agent | Request origin; stored only in the `audit_log` table, not returned by the UI or the API. For how the IP is determined, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip) |
| Action | For example `site.create` |
| Target | Type, ID, name; the name is recorded at the time of the action and stays readable after the target is deleted |
| Metadata | JSON with the action's parameters and before/after values |

The page shows **Time**, **Actor**, **Action**, and **Target**, 50 entries per page; filters for **Action**, **Target** type, and time range (**Any time**, **Last hour**, **Last 24 hours**, **Last 7 days**, **Last 30 days**). For reading it through `/api/v1`, see [API and endpoints](../reference/api.en.md).

| Action prefix | Content |
| --- | --- |
| `system.*` | Setup (including `system.setup_rejected` for a wrong setup token), origin allow list, node release source, usage settings, ban settings, protection, CC template, probe settings (`system.probes_update`), recompilation after an upgrade |
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

Page: **System** (`/system`).

### System information

Read-only (card **System**).

| Item | Source |
| --- | --- |
| **Version** | Image version `<YYYYMMDD>-<commit>`; `dev` when run from source |
| **Console URL** | `EDGEWEIR_PUBLIC_URL`; localhost or a loopback address is marked "This machine only", a private address "Private address": nodes on other networks cannot download `install.sh` from it |
| **Node channel** | `EDGEWEIR_NODE_API_URL`; when unset, `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>`. Marked the same way: nodes on other networks cannot enroll |
| **CA fingerprint** | SHA-256 of the node channel's internal CA; install commands carry the same value in `--ca-sha256` |
| **Analytics** | `EDGEWEIR_ANALYTICS` (`lite` / `clickhouse`) |
| **Telemetry** | `EDGEWEIR_TELEMETRY`; **Off** by default |
| **Setup token** | **Not used** or **Used {time}** |
| **OpenAPI** | `/api/v1/openapi.json` |

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

### Platform error pages

| Field | Requests it applies to | Notes |
| --- | --- | --- |
| **Unknown host** | The Host belongs to no site of the cluster | Status 404; empty uses the built-in page |
| **Site disabled** | Domains of disabled sites | Status 503 |

Each template is at most 65536 bytes (UTF-8); the values of the placeholders `{{status}}`, `{{request_id}}`, `{{client_ip}}` and `{{host}}` are HTML-escaped. Saving publishes one revision in every cluster ("Platform error pages updated") and is audited as `system.error_pages_update`. Older nodes ignore platform error pages. See [Error pages](error-pages.en.md#platform-error-pages).

### CC template

Thresholds for sites whose CC mitigation is on and set to **Follow the default template**: highest level, high proof of work instead of the captcha, window, site QPS, per-URL QPS, per-IP QPS, IP ban duration, origin error rate, minimum origin requests, escalate after, step down after. Fields, ranges, and defaults: [CC mitigation](challenges.en.md#cc-mitigation). Saving publishes a revision to every cluster with a following site; changes are audited as `system.cc_template_update`.

### GeoIP databases

Read-only. Shows, per node, the state of the **Country**, **Subdivision**, and **ASN** data (**Ready** / **Unavailable**), with the IPinfo attribution link. Country and ASN data ship in node release images; other databases are configured locally on each node; **Configure databases** links to [Rules, IP lists, and GeoIP](rules.en.md).

### SMTP

Outgoing mail server for email alert channels. Alert channels are managed in the **Alert channels** card of the **Alerts** page; see [Configure alert channels](dns-and-alerts.en.md#configure-alert-channels).

| Field | Default | Description |
| --- | --- | --- |
| **SMTP host** | None | At most 253 characters |
| **SMTP port** | 465 | 1–65535 |
| **Implicit TLS (off uses required STARTTLS)** | On | Off requires STARTTLS; certificate verification is always on |
| **From address** | None | Email address |
| **SMTP username** | None | Required |
| **SMTP password** | None | Envelope-encrypted with the master key before storage; leave blank to keep the current password |
| **CA certificates (PEM)** | Empty | PEM certificates only; when set, replaces the system trust store for this server |

| Constraint | Description |
| --- | --- |
| Changing the destination | Changing host, port, TLS mode, username, or CA certificates requires the password again |
| Outbound policy | The address is resolved and pinned for each delivery; private addresses must be allowed by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |

### Precedence

A value saved in system settings wins over the environment variable, which wins over the default. The environment variables remain only as a fallback for existing deployments.

| Setting | Location | Environment variable | Default |
| --- | --- | --- | --- |
| Node release source | **System → Node release source** | `EDGEWEIR_NODE_RELEASE_BASE_URL` | `https://github.com/marvinli001/edgeweir-node/releases/download` |
| SMTP CA certificates | **System → SMTP → CA certificates (PEM)** | `EDGEWEIR_SMTP_CA_FILE` (path to a PEM file) | System trust store |
| SMTP server and account | **System → SMTP** | None | Not configured |
| Origin allow list | **System → Origin allow list** | None | Empty |
| Usage | **System → Usage** | None | 100 days retention, 60-minute offline threshold |
| Bans | **System → Bans** | None | Limit 10000, automatic bans shared |
| Protection | **System → Protection** | None | Global Under Attack off, challenge type JavaScript, events kept 30 days |

The badge of **Node release source** shows where the value in effect comes from: **Saved**, **Environment**, or **Default**. Addresses saved in system settings are bounded by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS`; values in environment variables are set by the operator and skip that check. For every environment variable, see [Environment variables](../reference/environment.en.md).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **The cluster still has N node(s) and M site(s)** | The cluster is not empty | Delete its nodes and sites, then retry |
| **Turn the cluster's DNS off and wait for its records to be removed** | The cluster's DNS is still **Automatic** or still owns records | Switch to **Not managed** on the **DNS** tab, wait for cleanup, then retry |
| **Cluster name already exists: …** / **Node group already exists: …** / **Region code already exists: …** / **A service account named … exists** | Duplicate name or code | Use another name or code |
| **The default node group cannot be deleted** | Deleting the default node group | The default node group can only be renamed or given another region |
| **N probes still belong to this region** | Deleting a region that still has probes | Delete those probes on the **Probes** tab first |
| **The node group belongs to another cluster** | Moving a node across clusters | Nodes move only within their cluster; changing clusters means deleting and enrolling again |
| **This cluster has reached its limit of 512 published sites** | The cluster's enabled sites reached the limit | Disable sites no longer in use, or create new sites in another cluster through `/api/v1` with `clusterId` |
| **Cluster nodes need these capabilities first: …** | A change published by a service account or an automatic job needs a capability active nodes of the cluster lack | Upgrade the nodes; see [Node upgrades](node-upgrades.en.md) |
| **Rollback references resources that are no longer assigned or available** | A site, domain, certificate, or IP list the chosen revision references was deleted, or the certificate has expired | Pick a more recent revision, or fix the current configuration |
| **Service accounts cannot call this** | A service account called a procedure outside the [Service accounts](#service-accounts) table | Use an AccessKey |
| **Missing scope: …** | The service account lacks the scope the procedure needs | Edit its scopes in **Service accounts** |
| **The release source must use HTTPS and resolve to an allowed address** | Public HTTP URL, or a private address that is not allowed | Use HTTPS, or allow the range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| **Enter a new password when changing the SMTP server or account** | The SMTP destination changed without a password | Enter the password and save |
| **The CA bundle must contain PEM certificates only** | The CA field contains something other than certificates | Paste PEM certificates only |
