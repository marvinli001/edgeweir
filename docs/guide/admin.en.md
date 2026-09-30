# Platform administration

The Admin area: clusters and nodes, regions, organizations and users, audit log, system settings, and other platform-wide settings.

## Platform administrators

Platform administrator is an account-level role (the better-auth `admin` role), unrelated to the organization role **Admin**.

| Source | Description |
| --- | --- |
| Setup wizard | Creates the first platform administrator |
| **Admin → Organizations & users → Users** | Turn on **Platform admin** in **New user**, or use **Make platform admin** / **Revoke platform admin** on an existing user |

| Right | Description |
| --- | --- |
| Admin area | Access to `/admin/*`; other users are redirected to `/overview` and the matching API calls return 403 |
| Cross-organization view | **Sites** in the console lists the sites of every organization, with **Organization** and **Cluster** columns and a cluster filter when there are several clusters |
| Own organizations | Treated as owner in the organizations they belong to; resources created in the console belong to the current organization, and a platform administrator without any organization cannot create sites in the console |
| Cluster choice | Can pick the cluster of a new site (`clusterId` on `/api/v1`); sites created in the UI land on the organization's default cluster |
| Domain ownership | Domains of sites created by a platform administrator skip the TXT check; pending domains can be released with **Approve without TXT**. See [Verify domain ownership](dns-and-alerts.en.md#verify-domain-ownership) |
| Two-factor policy | Not bound by an organization's **Require two-factor authentication** |

For organization roles and account security, see [Organizations, members, and account security](organizations.en.md).

## Console and Admin switch

Platform administrators see a segmented switch **Console | Admin** in the header: **Console** opens `/overview`, **Admin** opens `/admin`. Other users do not see the switch. Admin sidebar:

| Menu | Path | Content |
| --- | --- | --- |
| **Platform** | `/admin` | Clusters, nodes, recent revisions, and platform-wide analytics |
| **Clusters & nodes** | `/admin/clusters` | Clusters, node groups, nodes, node upgrades, revisions |
| **Alert channels** | `/admin/alerts` | Notification channels and alert rules |
| **Platform DNS** | `/admin/dns` | DNS provider accounts, each cluster's DNS binding, and mass removal protection |
| **Platform rules** | `/admin/rules` | Rules applied to every site |
| **Platform IP lists** | `/admin/ip-lists` | Platform-level IP lists |
| **Bans** | `/admin/bans` | Bans of every organization and platform bans |
| **Regions** | `/admin/regions` | Region labels for node groups |
| **Organizations & users** | `/admin/organizations` | Organizations, members, user accounts |
| **Audit log** | `/admin/audit` | Record of every management action |
| **System** | `/admin/settings` | System information and platform-wide settings |

## Platform overview

| Block | Content |
| --- | --- |
| **Clusters** | Number of clusters; online and total nodes per cluster |
| **Nodes** | Online and total nodes, sorted by state: **Offline**, **Apply failed**, **Behind**, **Pending**, **Disabled**, **In sync**. Shows **Add node** when there are no nodes |
| **Recent revisions** | The latest revisions across all clusters, with their reasons |
| **Analytics** | Platform-wide traffic, ranges from 1 hour to 30 days; **Top sites** and **Top nodes** |

The page refreshes every 10 seconds.

## Clusters and nodes

The top of the page holds **New cluster**, **Add node**, and a summary of the current cluster (**Nodes online**, **Sites**, **Latest revision**). With several clusters, **Select cluster** switches between them. The **Overview** tab holds node groups, nodes, configuration rollout, node upgrades, and revisions; the **DNS** tab holds the cluster's DNS binding, see [Bind a cluster](dns-and-alerts.en.md#bind-a-cluster).

### Clusters

A cluster is a set of nodes plus the sites assigned to them; each cluster has its own revision sequence.

| Action | Description |
| --- | --- |
| **New cluster** | **Cluster name**: lowercase letters, digits, and `-`, starting with a letter or digit, at most 64 characters, unique on the platform; **Description**: at most 500 characters. Creation adds the default node group `default` and publishes revision #1 |
| **Edit cluster** | Change name and description |
| **Delete** | Only when the cluster has no nodes and no sites, its DNS is Not managed, and its written records are removed |

A cluster publishes at most 512 sites.

### Node groups

| Action | Description |
| --- | --- |
| **New node group** | **Node group**: name, at most 64 characters, unique within the cluster; **Region**: optional, see [Regions](#regions); **Canary group**: see [Configuration canary](#configuration-canary) |
| **Edit node group** | Change name, region and **Canary group** |
| Delete | The default node group (marked **Default**) cannot be deleted; deleting another group moves its nodes back to the default group |

Node groups serve as platform DNS lines, as canary groups for node upgrades and for the configuration canary.

### Adding a node

**Add node** generates a one-time install command.

| Field | Description |
| --- | --- |
| **Node name** | Optional, at most 64 characters |
| **Node group** | Defaults to the cluster's default node group |
| **Valid for** | 15 min, 1 h (default), or 24 h; the API accepts 5 minutes to 7 days |

Result: the **Install command** (shown once, with a countdown) and the **CA fingerprint**. The token starts with `ewt_` and is single-use; the database keeps its SHA-256 and prefix, never the plaintext. For the install flow, see [Adding nodes](../deploy/nodes.en.md).

### Nodes

| Column | Content |
| --- | --- |
| **Node** | Name and host name |
| **Status** | **Online** (heartbeat within 45 seconds), **Offline**, **Disabled** |
| **Node group** | Node group and region |
| **IP** | Addresses reported by the node |
| **Applied** | The revision the node has applied; badge **In sync** (the node's target revision reached), **Behind**, **Apply failed** (hover for the reason), or **Upgrade required** |
| **Agent / engine** | Agent version, engine, and engine version |
| **Heartbeat** | Time of the last heartbeat |

| Action | Description |
| --- | --- |
| **Rename** | At most 64 characters |
| **Move to group** | Node groups of the same cluster only |
| **Disable** / **Enable** | A disabled node is refused by the node channel and keeps serving its last successfully applied configuration; its unfinished purge & prefetch deliveries are marked **Skipped**, and a whole-site purge makes them up once the node is enabled and pulls tasks again |
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
| Canary nodes | Enabled nodes of the cluster's **Canary group** node groups; those online when the window starts decide the outcome |
| Target revisions | Canary nodes get the candidate, the other nodes the stable revision; a node never gets a revision newer than its target |
| DNS | Each node is compared with its own target; non-canary nodes are not removed during the window |
| Rollback when (any, within the window) | A canary node fails to apply; its data plane is unhealthy or it goes offline; the canary 5xx ratio exceeds max(the non-canary nodes' 5xx ratio × multiple, floor) with at least the minimum requests; a canary node has not applied the candidate one window after the window ended |
| Rollback | The stable content is published as a new revision and every node returns to it; audited as the system and the platform alert "Configuration canary rolled back" fires |
| After a rollback | The cluster stays on the stable revision. The database keeps the change; the next publication goes through the canary again |
| New publication during the window | The new candidate replaces the old one and the window restarts |
| No canary node online | The change goes to every node, `cluster.rollout_direct` is audited and a platform alert fires; publishing is not blocked |
| Changes that reach every node at once | ACME HTTP-01 challenges (the stable revision takes them too); **Roll back** in **Revisions** |
| Turning the policy off | A running candidate is promoted to every node |

| State | Meaning |
| --- | --- |
| **Idle** | No candidate |
| **Canary** | The candidate runs on the canary nodes under observation |
| **Awaiting promotion** | The window passed; waiting for an administrator |
| **Promoted** | The candidate is every node's revision |
| **Rolled back** | The canary nodes returned to the stable revision |
| **Published to all** | No canary node was online; the change went to every node |

**Promote to all now** (audited as `cluster.rollout_promote`) and **Abort and roll back** (audited as `cluster.rollout_abort`) need confirmation and are available in **Canary** and **Awaiting promotion** only. Policy changes are audited as `cluster.rollout_policy_update`.

### Revisions

Every change that affects node configuration publishes a new revision in the cluster. The **Revisions** table lists the latest 20: **Revision**, **Content hash**, **Sites**, **Reason**, **Time**.

| Reason | Trigger |
| --- | --- |
| Cluster {cluster} created | New cluster |
| Site {site} created / updated / deleted | Site changes |
| Site {site} purged | **Purge cache** on a site |
| Certificate policy for {site} updated | HTTPS settings changed; a certificate used by the site was issued or renewed |
| ACME challenge updated | HTTP-01 challenge changes |
| Rules and IP lists updated | Rule or IP list changes |
| Domain verified / Domain verification revoked | Domain ownership changes |
| Origin allow list updated | [Origin allow list](#origin-allow-list) changed; every cluster publishes one revision |
| Rolled back to #{revision} | **Roll back** |
| Site {site} enabled / disabled / suspended / resumed | Site state changes |
| Canary of revision {revision} rolled back | [Configuration canary](#configuration-canary) rollback |

**Roll back** publishes the content of the chosen revision as a new revision; history is kept. A rollback is refused when certificates, domains, or other resources it references were removed, transferred, or are unavailable; unverified domains cannot return through a rollback.

## Alert channels

Notification channels (Webhook, Email, DingTalk, WeCom, Telegram) and **Alert rules** (offline threshold, certificate warning, minimum requests, window, 5xx threshold). Each channel has **Notification language**, **Receive alerts for all sites**, and **Allow tenant subscriptions**, and supports **Send test**, **Enable** / **Disable**, and **Replace channel credentials**. Email channels use the [SMTP](#smtp) settings. See [Configure alert channels](dns-and-alerts.en.md#configure-alert-channels).

## Platform DNS

**DNS provider accounts** (credential forms generated from the provider catalog, **List zones**, **Test connection**), **Cluster bindings** (each cluster's mode, cluster domain, and publication state), and **Mass removal protection**. Each cluster's DNS is set on the **DNS** tab of the **Clusters** page: mode (Not managed / Manual / Automatic), provider account, cluster domain, TTL, lines, plus **Current records**, the manual record list and zone file, and **DNS revisions** (**Roll back DNS**, **Repair records**). Once configured, a site's **Domains** tab shows the **CNAME target**. See [Configure platform DNS](dns-and-alerts.en.md#configure-platform-dns).

## Platform rules and IP lists

| Page | Content |
| --- | --- |
| **Platform rules** | Rules applied to every site; in each phase platform rules run before site rules |
| **Platform IP lists** | Platform-level IP lists with **Action** **Referenced by rules**, **Block**, or **Allow**; block and allow lists apply to every site, ahead of rules |

For expressions, phases, and list limits, see [Rules, IP lists, and GeoIP](rules.en.md).

## Bans

**Admin → Bans** lists the active bans of every organization and the platform bans, filtered by scope, site, and source. **New ban** with "Scope" "Platform" applies to every site and is dropped in the kernel on nodes with `kernel-ban-v1`; with "Site" it targets a site of any organization. Ban rules, permissions, and how to enable kernel bans: [Bans](bans.en.md).

## Regions

A region is a label for node groups (for example East China), shown in the node group and node tables.

| Action | Description |
| --- | --- |
| **New region** | **Name**: at most 64 characters; **Code**: lowercase letters, digits, and `-`, starting with a letter or digit, at most 32 characters, unique on the platform |
| **Edit region** | Change name and code |
| Delete | Node groups that reference the region stay, without a region |

## Sites

**Admin → Sites** lists the sites of every organization, with search.

| Action | Description |
| --- | --- |
| **Suspend** | Choose a **Reason** (Billing, Abuse, Security, Other) and an optional **Note** (up to 256 characters, visible to platform administrators and service accounts only). A suspended site is not shipped to nodes and keeps its DNS records; members see the localized reason and cannot lift it |
| **Resume** | Needs confirmation |

Suspending and resuming are audited (`site.suspend`, `site.resume`) and publish a revision. Behavior: [Site enabling and platform suspension](organizations.en.md#site-enabling-and-platform-suspension).

## Service accounts

**Admin → Service accounts** manages the service accounts integrations use on `/api/v1`: name, scopes, enabled, and keys (shown once) with revocation. Scopes and callable procedures: [Service accounts](../reference/api.en.md#service-accounts).

## Organizations and users

The page has two tabs: **Organizations** and **Users**.

### Organizations

| Action | Description |
| --- | --- |
| **New organization** | **Organization**: at most 100 characters; **Slug**: derived from the name when empty, lowercase letters, digits, and `-`, at most 48 characters, unique on the platform; **Default cluster**: **Oldest cluster** when empty; **Require two-factor authentication** |
| **Edit** | Change name, default cluster, and two-factor policy |
| **Members** | Opens **Members of {name}**: **Add user** (an existing user with a role), **Invite member** (creates an invitation link), change roles, remove |
| **Limits** | Each limit with its current use; empty means no limit, see [Technical limits](organizations.en.md#technical-limits) |

Platform administrators manage the members of any organization with owner rights, owners included. Organizations cannot be deleted. For member and invitation rules, see [Organizations, members, and account security](organizations.en.md#invitations-and-member-management).

### Users

| Action | Description |
| --- | --- |
| Search | By name or email; at most 500 users returned |
| **New user** | **Name**, **E-mail**, **Password** (12–128 characters); optionally one organization with a **Role**; optionally **Platform admin** |
| **Make platform admin** / **Revoke platform admin** | An administrator cannot revoke their own role |
| **Disable account** / **Enable account** | Disabling deletes all of the user's sessions; while disabled, sign-in and AccessKey calls are refused. An administrator cannot disable their own account |

Users cannot be deleted.

## Audit log

Every management action is written to the audit log. The console's own changes commit together with their audit entry in one transaction; sign-in, password, two-factor, passkey, and AccessKey changes are completed by better-auth, and their entries are written after it commits, with write failures only logged. The audit log is never pruned automatically.

| Field | Content |
| --- | --- |
| Time | When the action happened |
| Actor | Type (**User**, **AccessKey**, **Service account**, **Node**, **System**), ID, name |
| IP, User-Agent | Request origin; stored only in the `audit_log` table, not returned by the UI or the API. For how the IP is determined, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip) |
| Organization | The organization concerned, if any |
| Action | For example `site.create` |
| Target | Type, ID, name; the name is recorded at the time of the action and stays readable after the target is deleted |
| Metadata | JSON with the action's parameters and before/after values |

The page shows **Time**, **Actor**, **Action**, and **Target**, 50 entries per page; filters for **Action**, **Target** type, and time range (**Any time**, **Last hour**, **Last 24 hours**, **Last 7 days**, **Last 30 days**). For reading it through `/api/v1`, see [API and endpoints](../reference/api.en.md).

| Action prefix | Content |
| --- | --- |
| `system.*` | Setup (including `system.setup_rejected` for a wrong setup token), origin allow list, node release source, ownership check DNS, usage settings, ban settings |
| `auth.*` | Successful (`auth.sign_in`, with the sign-in method) and failed (`auth.sign_in_failed`) sign-ins |
| `account.*` | Password change, two-factor enable / disable, passkey add / delete |
| `api_key.*` | AccessKey create, delete, revoke |
| `service_account.*` | Service accounts and their keys |
| `user.*`, `organization.*`, `member.*`, `invitation.*` | Users, organizations, members, and invitations |
| `cluster.*`, `node_group.*`, `region.*`, `node.*`, `enrollment_token.*` | Clusters (including the configuration canary), node groups, regions, nodes (including enrollment, certificate renewal, upgrades), install commands |
| `site.*`, `cache.*`, `domain.*`, `certificate.*`, `dns_credential.*`, `ip_list.*`, `platform.*` | Sites, purge & prefetch, domain ownership, certificates, DNS credentials, IP lists, platform rules |
| `ban.*` | Manual bans: `ban.create`, `ban.update` (banned again), `ban.delete` (unbanned) |
| `dns.*`, `alert.*` | Platform DNS (including mass removal protection and forced publications), alert channels, alert rules, SMTP, alert subscriptions |

## System settings

### System information

Read-only (card **System**).

| Item | Source |
| --- | --- |
| **Version** | Image version `<YYYYMMDD>-<commit>`; `dev` when run from source |
| **Console URL** | `EDGEWEIR_PUBLIC_URL` |
| **Node channel** | `EDGEWEIR_NODE_API_URL`; when unset, `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>` |
| **CA fingerprint** | SHA-256 of the node channel's internal CA; install commands carry the same value in `--ca-sha256` |
| **Analytics** | `EDGEWEIR_ANALYTICS` (`lite` / `clickhouse`) |
| **Telemetry** | `EDGEWEIR_TELEMETRY`; **Off** by default |
| **Setup token** | **Not used** or **Used {time}** |
| **OpenAPI** | `/api/v1/openapi.json` |

### Origin allow list

**Allowed ranges (one CIDR per line)**, at most 256 entries. Private, loopback, and other special-purpose addresses in the list become usable as origins for every organization. Saving publishes one revision in every cluster and writes an audit entry. For origin address rules, see [Origin address restrictions](origins-and-cache.en.md#origin-address-restrictions).

### Node release source

**Release source URL**: the mirror from which node upgrades read release manifests, laid out as `<url>/v<version>/checksums.txt`.

| Constraint | Description |
| --- | --- |
| Format | `http(s)` URL without credentials, query, or fragment |
| Protocol | Public addresses require HTTPS; HTTP only for private addresses allowed by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Outbound policy | The host name is resolved on save; the address must be public or allowed by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Clearing | Saving an empty value falls back to the environment variable or the default |

Each node also pins its own release source and signature trust locally, out of the console's reach; see [Node upgrades](node-upgrades.en.md).

### Ownership check DNS

**Recursive DNS servers**: the recursive resolvers used for domain ownership TXT checks, at most 8. Format: IP, `IPv4:port`, `[IPv6]:port`, or host name with optional port; default port 53. Addresses are resolved and pinned on save and must be public or allowed by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS`. Enter trusted recursive resolvers only: their answers decide domain ownership. With an empty field, the placeholder shows the servers in effect or **System resolver**.

### Usage

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Retention (days)** | 35–400 | 100 | How long usage records are kept |
| **Offline nodes stop holding completeness (minutes)** | 5–1440 | 60 | Nodes without a heartbeat for longer no longer hold back `completeUntil` |

Changes are audited as `system.usage_update`. The usage API and the definition of `completeUntil`: [Usage](../reference/api.en.md#usage).

### Bans

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Platform limit of manual bans** | 100–100000 | 10000 | Active manual bans (platform and site) across the platform; beyond it `BAN_PLATFORM_LIMIT` |
| **Share automatic bans in the cluster** | On / off | On | Whether automatic bans of a node go to the other nodes of its cluster; off keeps them for viewing only |

Changes are audited as `system.bans_update`. See [Bans](bans.en.md).

### GeoIP databases

Read-only. Shows, per node, the state of the **Country**, **Subdivision**, and **ASN** data (**Ready** / **Unavailable**), with the IPinfo attribution link. Country and ASN data ship in node release images; other databases are configured locally on each node; **Configure databases** links to [Rules, IP lists, and GeoIP](rules.en.md).

### SMTP

Outgoing mail server for email alert channels.

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

A value saved in Admin wins over the environment variable, which wins over the default. The environment variables remain only as a fallback for existing deployments.

| Setting | Admin location | Environment variable | Default |
| --- | --- | --- | --- |
| Node release source | **Node release source** | `EDGEWEIR_NODE_RELEASE_BASE_URL` | `https://github.com/marvinli001/edgeweir-node/releases/download` |
| Ownership check DNS | **Ownership check DNS** | `EDGEWEIR_DNS_RESOLVERS` (comma-separated) | System resolver |
| SMTP CA certificates | **SMTP → CA certificates (PEM)** | `EDGEWEIR_SMTP_CA_FILE` (path to a PEM file) | System trust store |
| SMTP server and account | **SMTP** | None | Not configured |
| Origin allow list | **Origin allow list** | None | Empty |
| Usage | **Usage** | None | 100 days retention, 60-minute offline threshold |
| Bans | **Bans** | None | Limit 10000, automatic bans shared |

The badges of **Node release source** and **Ownership check DNS** show where the value in effect comes from: **Saved**, **Environment**, or **Default**. Addresses saved in Admin are bounded by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS`; values in environment variables are set by the operator and skip that check. For every environment variable, see [Environment variables](../reference/environment.en.md).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **The cluster still has N node(s) and M site(s)** | The cluster is not empty | Delete its nodes and sites, then retry |
| **Cluster name already exists: …** / **Node group already exists: …** / **Region code already exists: …** | Duplicate name or code | Use another name or code |
| **The default node group cannot be deleted** | Deleting the default node group | The default node group can only be renamed or given another region |
| **The node group belongs to another cluster** | Moving a node across clusters | Nodes move only within their cluster; changing clusters means deleting and enrolling again |
| **Rollback references resources that are no longer assigned or available** | Certificates or domains referenced by the target revision are gone | Pick a more recent revision, or fix the current configuration |
| **You cannot do this to your own account** | Disabling oneself or revoking one's own platform admin role | Another platform administrator performs the action |
| **E-mail already registered: …** | The new user's email exists | Add the existing user to the organization |
| **Organization slug already exists: …** | Duplicate slug | Use another slug |
| **The release source must use HTTPS and resolve to an allowed address** | Public HTTP URL, or a private address that is not allowed | Use HTTPS, or allow the range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| **The DNS server must resolve to an allowed address** | The server resolves to a private address that is not allowed | Use a public resolver, or allow the range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| **Enter a new password when changing the SMTP server or account** | The SMTP destination changed without a password | Enter the password and save |
| **The CA bundle must contain PEM certificates only** | The CA field contains something other than certificates | Paste PEM certificates only |
