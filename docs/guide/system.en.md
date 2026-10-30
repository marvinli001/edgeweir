# System settings and audit

System settings (General, Monitoring and Service accounts tabs), the audit log, and the protection settings page.

Clusters, nodes and regions: [Clusters and nodes](clusters.en.md); DNS steering: [DNS steering](dns.en.md); alerts: [Alerts](alerts.en.md); regional probes and scheduling: [Regional probes and scheduling](scheduling.en.md); every page of the sidebar: [Console navigation](account.en.md#console-navigation).

## System settings

Page: **System settings** (`/system`), with the tabs:

| Tab | Content |
| --- | --- |
| **General** | The sections below, in page order: system information, node channel, origin allow list, node release source, certificate authorities, usage, access logs, node log retention, platform error pages, login IP allow list, demo account |
| **Monitoring** | `/system?tab=probes`: the regional probe list (page action **Add probe**), the **Last round** card (a latency matrix of probers × nodes) and the **Probe settings** card, see [Regional probes](scheduling.en.md#regional-probes); `/regions?tab=probes` redirects there |
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

**URL**: where nodes and region probes reach the node channel, `--server` in the install command. While the field is empty, `EDGEWEIR_NODE_API_URL` applies; when that is unset, `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>`, or with `EDGEWEIR_NODE_API_WEBSOCKET=true` `wss://<host and port of EDGEWEIR_PUBLIC_URL>` (`ws://` when the console URL is `http://`); the placeholder shows the URL in effect and the badge where it comes from.

| Constraint | Description |
| --- | --- |
| Format | `https://host[:port]` (the node channel port), or `wss://host[:port]` or `ws://host[:port]` (the [WebSocket entry](../deploy/networking.en.md#the-node-channels-websocket-entry) on the web port); without a path, query, or credentials; saved with the host name in lower case, without a trailing `/` or the default port (443, 80 for `ws://`) |
| Effect | Applies on saving, without a restart: new install and probe commands carry the URL, and the node channel certificate adds its host name or IP |
| Enrolled nodes | Nodes and probes from v1.2.0 check the new URL and switch to it; the previous URL's name stays in the certificate. While editing, the card notes "Keep the previous URL reachable until every node has switched". See [Changing the node channel URL](../deploy/networking.en.md#changing-the-node-channel-url) |
| Clearing | Saving an empty value falls back to the environment variable or the default |

A localhost, loopback, or private address is marked "This machine only" or "Private address": nodes on other networks cannot enroll. Below the URL is the result of the [connection check](../deploy/nodes.en.md#node-channel-connection-check): **Reachable**, **The console cannot connect to this URL**, **Certificate mismatch: a proxy or CDN may be in front**, or **The outbound policy does not allow this address** (the saved URL is a private, loopback, or other special-purpose address that `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` does not allow, so the console does not connect). Changes are audited as `system.node_channel_update`. For the certificate names, see [Node channel URL and certificate](../deploy/networking.en.md#node-channel-url-and-certificate).

With enrolled nodes or probes, the URL is followed by **Nodes switched N/M** and **Probes switched N/M** (those with a valid certificate, and those already on the current URL), refreshed every 15 seconds.

| Item | Description |
| --- | --- |
| **Earlier names in the certificate** | Host names or IPs URLs in effect before left in the certificate (names from the environment are not listed), with the nodes and probes still connecting with each (**Nodes N · probes N**, or **Unused**). Once **Unused**, **Remove** takes the name out of every console instance's certificate; while nodes or probes use it the button is disabled and the API answers `NODE_CHANNEL_NAME_IN_USE`. A fallback a node keeps for later does not count |
| **WebSocket entry** | Shown once a `wss://` or `ws://` URL was used and the current one no longer needs the entry, with the nodes and probes still using it; **Close** once **Unused**. With `EDGEWEIR_NODE_API_WEBSOCKET=true` or a `wss://` or `ws://` current URL the entry stays open and this is not shown |

Removing a name and closing the entry are audited as `system.node_channel_update` too (metadata `removedName`, `webSocket: closed`).

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

### Certificate authorities

The custom ACME directory: besides Let's Encrypt, ZeroSSL and Google Trust Services, **Certificate authority** of a certificate request offers **Custom ACME directory**, for example a private PKI or a staging CA.

| Field | Values | Notes |
| --- | --- | --- |
| **Custom ACME directory** | `https://` URL, at most 2048 characters, no credentials or fragment; empty | The ACME directory URL. Before saving, the console reads it (10 seconds, at most 1 MiB, no redirects) and refuses an answer that is not an ACME directory (no `newNonce`, `newAccount` or `newOrder`): "The URL does not answer with an ACME directory". Private addresses are allowed; `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` does not apply. Saving an empty value falls back to the environment variable or to none |
| **EAB key ID** / **EAB HMAC key** | Both or neither | The external account binding the directory requires; a request with empty EAB fields uses these. The HMAC key is envelope-encrypted and write-only: once saved the placeholder reads "Saved; leave empty to keep it", and leaving it empty with the same key ID keeps it |
| **CA certificates (PEM)** | 1–10 certificates, at most 64 KiB; empty | Issuers of the directory's HTTPS certificate, trusted in addition to the system trust store; empty: the system trust store only |

The URL and the CA certificates each show their source badge (**Saved**, **Environment** or **Default**): a value saved here wins over `EDGEWEIR_ACME_DIRECTORY` and `EDGEWEIR_ACME_CA_FILE`. The directory's `meta.caaIdentities` show as **CAA issuers** and requests check CAA against them; without them CAA is not checked. Changes are audited as `system.acme_directory_update`. Requests and ACME accounts: [HTTPS and certificates](https.en.md#certificate-authorities).

### Usage

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Retention (days)** | 35–400 | 100 | How long usage records are kept |
| **Offline nodes stop holding completeness (minutes)** | 5–1440 | 60 | Nodes without a heartbeat for longer no longer hold back `completeUntil` |

Changes are audited as `system.usage_update`. The usage API and the definition of `completeUntil`: [Usage](../reference/api/monitoring.en.md#usage).

### Access logs

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Retention (days)** | PostgreSQL 1–30, ClickHouse 1–90 | 7 | How long access logs are kept; the card shows the days of the current analytics mode (`EDGEWEIR_ANALYTICS`) only |

Changes are audited as `system.log_retention_update`; the next minute's maintenance drops partitions by the new days (ClickHouse changes the TTL), see [access log retention](access-logs.en.md#retention).

### Node log retention

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Days kept** | 1–30 | 7 | How long node log entries are kept |
| **Entries per node** | 1000–100000 | 10000 | Most entries kept per node |

Changes are audited as `system.node_log_retention_update`. When entries are deleted: [Node log retention](node-logs.en.md#retention).

### Platform error pages

| Field | Requests it applies to | Notes |
| --- | --- | --- |
| **Unknown host** | The Host belongs to no site of the cluster (a cluster can close such connections or hand them to its default site instead, see [unknown hosts](domains.en.md#unknown-hosts-and-node-ip-access)) | Status 404; empty uses the built-in page |
| **Site disabled** | Domains of disabled sites | Status 503 |

Each template is at most 65536 bytes (UTF-8); the values of the placeholders `{{status}}`, `{{request_id}}`, `{{client_ip}}`, `{{host}}`, `{{time}}` and `{{path}}` are HTML-escaped; with `{{time}}` or `{{path}}` the configurations of every cluster need the node capability `rules-v3`. Saving publishes one revision in every cluster ("Platform error pages updated") and is audited as `system.error_pages_update`. Older nodes ignore platform error pages. See [Error pages](error-pages.en.md#platform-error-pages).

### Login IP allow list

Only addresses on the list may sign in to the console. An empty list turns it off (the default).

| Field | Description |
| --- | --- |
| **Networks that may sign in** | One IPv4 or IPv6 CIDR per line; a single address counts as /32 or /128; at most 64 entries. IPv4-mapped IPv6 addresses (`::ffff:1.2.3.4`) compare as IPv4 |
| **Current IP** | The address the console resolved for this request, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip); **Add current IP** puts it on the list |

While the list is not empty:

| Scope | Addresses outside the list |
| --- | --- |
| Sign-in: password, two-factor authentication, passkeys | `LOGIN_IP_NOT_ALLOWED` (403), without checking the password or counting toward the sign-in rate limit |
| Existing sessions: `/rpc` and `/api/auth` (reading the session, password, two-factor and passkey changes) | `LOGIN_IP_NOT_ALLOWED`; the session itself stays and works again from an address on the list. Signing out is not limited |
| AccessKeys and service account keys on `/api/v1` | Not limited |
| The [demo account](#demo-account) | Not limited |
| The setup wizard (`system.setup`), the sign-in page, the node channel and the install script | Not limited |

| Item | Description |
| --- | --- |
| Lockout protection | A list without the current IP is refused (`LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP`); saving through an AccessKey checks the caller's address the same way |
| Proxy hint | When the current IP is a private, CGNAT, loopback or similar address, or the request carried forwarding headers from a peer outside `EDGEWEIR_TRUSTED_PROXIES`, the card notes it may be a proxy's address. Behind the proxy of Zeabur, Render, Fly.io, Railway, bunny.net and the like without `EDGEWEIR_TRUSTED_PROXIES`, every visitor shows the same proxy address and the list does not help |
| Locked out | Run `recover.js --clear-login-allowlist` on the server, see [Account recovery](account.en.md#account-recovery) |
| Records | Changes are audited as `system.login_allow_list_update` (`cidrs`, `added`, `removed`); refused requests only go to the console log (one line per address and minute, at most 20 lines a minute), not to the audit log |

### Demo account

A view-only account for public demos. It sits beside the operator account and leaves it unchanged.

| Field | Description |
| --- | --- |
| **Allow demo sign-in** | On creates the account `demo@edgeweir.com` with the password `demo`, and the sign-in page shows **Sign in to the demo**; off deletes the account and ends all its sessions. Off by default |

The demo account can open every page of the console and change nothing:

- Every change returns `DEMO_READ_ONLY` (403): all non-GET procedures except `rules.validate`. It cannot create AccessKeys, enrollment tokens or service accounts
- It cannot change its password, turn two-factor authentication on or off, or add or delete passkeys
- Client addresses in the audit log and access logs show only their network (IPv4 /24, IPv6 /48); access logs leave out recorded request headers, and failed sign-ins leave out the typed e-mail
- The [login IP allow list](#login-ip-allow-list) does not limit the demo account; the list and its audit entries show it only the networks (/24, /48) as well
- Secrets are never returned to anyone; everything else (sites, nodes, certificates, DNS and alert settings and so on) looks as it does to the operator, so check it before you publish the demo

The switch is refused while the operator account uses `demo@edgeweir.com` (`DEMO_EMAIL_TAKEN`). Changes are audited as `system.demo_update`; the demo account's sign-ins are audited too.

### Precedence

A value saved in the console wins over the environment variable, which wins over the default. The environment variables remain only as a fallback for existing deployments.

| Setting | Location | Environment variable | Default |
| --- | --- | --- | --- |
| Node channel | **System settings → Node channel** | `EDGEWEIR_NODE_API_URL` | `https://<host of EDGEWEIR_PUBLIC_URL>:<NODE_API_PORT>`; with `EDGEWEIR_NODE_API_WEBSOCKET=true` `wss://<host and port of EDGEWEIR_PUBLIC_URL>` |
| Node release source | **System settings → Node release source** | `EDGEWEIR_NODE_RELEASE_BASE_URL` | `https://github.com/marvinli001/edgeweir-node/releases/download` |
| Custom ACME directory | **System settings → Certificate authorities** | `EDGEWEIR_ACME_DIRECTORY` | None |
| CA certificates of the ACME directory | **System settings → Certificate authorities → CA certificates (PEM)** | `EDGEWEIR_ACME_CA_FILE` (path to a PEM file) | System trust store |
| EAB of the ACME directory | **System settings → Certificate authorities** | None | None |
| SMTP CA certificates | **Alerts → SMTP → CA certificates (PEM)** | `EDGEWEIR_SMTP_CA_FILE` (path to a PEM file) | System trust store |
| SMTP server and account | **Alerts → SMTP** | None | Not configured |
| Origin allow list | **System settings → Origin allow list** | None | Empty |
| Login IP allow list | **System settings → Login IP allow list** | None | Empty (off) |
| Usage | **System settings → Usage** | None | 100 days retention, 60-minute offline threshold |
| Access log retention | **System settings → Access logs** | None | 7 days |
| Node log retention | **System settings → Node log retention** | None | 7 days, 10000 entries per node |
| Bans | **Protection settings → Bans** | None | Limit 10000, automatic bans shared |
| Protection | **Protection settings → Protection** | None | Global Under Attack off, challenge type JavaScript, events kept 30 days |

The badges of **Node channel**, **Node release source** and **Certificate authorities** show where the value in effect comes from: **Saved**, **Environment**, or **Default**. Release source addresses saved in system settings are bounded by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS`; values in environment variables are set by the operator and skip that check. For every environment variable, see [Environment variables](../reference/environment.en.md).

## Service accounts

Page: the **Service accounts** tab of **System settings** (`/system?tab=service-accounts`; `/service-accounts` redirects there), with the page action **New service account**. A service account is an identity integrations use on `/api/v1`: it cannot sign in to the console and calls only the procedures below, with a key (prefix `ews_`, header `x-api-key`).

| Action | Description |
| --- | --- |
| **New service account** | **Name** (at most 64 characters, unique), **Scopes**, **Enabled** |
| **Edit service account** | Under **⋯** at the end of the row; change name, scopes, and enabled state; keys of a disabled service account are refused |
| **Keys** | Opens from a click on the service account's row; **New key** (optional **Key name**; the key is shown once); **Revoke** needs confirmation. The list shows **Revoked** and **Last used** |
| Delete | **Delete** under **⋯** at the end of the row, confirmed; all of its keys stop working |

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
| Node capabilities | A change that needs a capability active nodes of the cluster lack returns 409 `NODE_CAPABILITY_REQUIRED`; see [Revisions](clusters.en.md#revisions) |
| Audit | Changes made by a service account are audited with the actor **Service account**; changes to service accounts and their keys are audited as `service_account.*` |

Endpoints and request format: [Service accounts](../reference/api.en.md#service-accounts).

## Audit log

Page: **Audit log** (`/audit`). Management actions are written to the audit log. The console's own changes commit together with their audit entry in one transaction; sign-in, password, two-factor, and passkey changes are completed by better-auth, and their entries are written after it commits, with write failures only logged. The audit log is never pruned automatically.

| Field | Content |
| --- | --- |
| Time | When the action happened |
| Actor | Type (**User**, **Access key**, **Service account**, **Node**, **Probe**, **System**), ID, name |
| IP, User-Agent | Request origin; empty for actions no request carried (nodes, probes, the system). For how the IP is determined, see [Trusted proxies and client IP](../deploy/networking.en.md#trusted-proxies-and-client-ip) |
| Action | A code such as `site.create`; the UI shows its name (e.g. **Site created**) |
| Target | Type, ID, name; the name is recorded at the time of the action and stays readable after the target is deleted |
| Metadata | JSON with the action's parameters and before/after values |

The page shows **Time**, **Actor**, **Action** (name and code), and **Target**, 50 entries per page; filters for **Action**, **Target** type, and time range (**Any time**, **Last hour**, **Last 24 hours**, **Last 7 days**, **Last 30 days**). **Details** at the end of a row shows every field: the full time, the actor and target IDs, IP, User-Agent, and the metadata as formatted JSON. Older codes without a name are shown as they are. `/api/v1` returns every field; see [API and endpoints](../reference/api.en.md).

| Action prefix | Content |
| --- | --- |
| `system.*` | Setup (`system.setup`; a wrong setup token is `system.setup_rejected`), node channel (`system.node_channel_update`), origin allow list (`system.origin_allow_list_update`), node release source (`system.release_source_update`), certificate authorities (`system.acme_directory_update`), usage (`system.usage_update`), access log retention (`system.log_retention_update`), node log retention (`system.node_log_retention_update`), platform error pages (`system.error_pages_update`), login IP allow list (`system.login_allow_list_update`), demo account (`system.demo_update`), ban settings (`system.bans_update`), protection (`system.protection_update`), CC template (`system.cc_template_update`), probe settings (`system.probes_update`), recompilation after an upgrade (`system.recompile`) |
| `auth.*` | Successful (`auth.sign_in`, with the sign-in method) and failed (`auth.sign_in_failed`) sign-ins |
| `account.*` | Password change, two-factor enable / disable, passkey add / delete, account recovery on the server (`account.recover`, see [Account recovery](account.en.md#account-recovery)) |
| `api_key.*` | AccessKey create (`api_key.create`), name and requests-per-minute changes (`api_key.update`), revoke (`api_key.revoke`) |
| `service_account.*` | Service accounts and their keys |
| `cluster.*`, `node_group.*`, `region.*`, `node.*`, `enrollment_token.*` | Clusters (including the configuration canary, rollbacks, challenge and session ticket key rotation, listening ports, visitor IP, unknown hosts, cache zone, port pools `cluster.port_pools_update`, and connection limits `cluster.connection_limits_update`), node groups, regions, nodes (including enrollment, certificate renewal, upgrades, scheduling addresses `node.set_addresses`, probing `node.set_probe`, debug log pulls `node.debug_logs_pull`), install commands |
| `probe.*` | Probe tokens (`probe.token_create`), enrollment (`probe.enroll`) and certificate renewal (`probe.certificate_renew`, actor **Probe**), renaming and enabling (`probe.update`), deletion (`probe.delete`) |
| `scheduling.*` | Scheduling rule changes (`scheduling.rule_create`, `scheduling.rule_update`, `scheduling.rule_delete`); rule actions taking effect and recovering (`scheduling.activate`, `scheduling.recover`, actor **System**) |
| `greylist.*` | Greylist: `greylist.create`, `greylist.update`, `greylist.delete` |
| `origin_ca.*`, `origin_certificate.*`, `origin_client_ca.*`, `origin_client_certificate.*` | [Origin protection](https.en.md#origin-protection): creating, rotating, issuing, revoking and retiring the Origin CA and its certificates and the origin client CA and certificates |
| `site_tag.*` | Site tag rename (`site_tag.rename`) and delete (`site_tag.delete`) |
| `acme_account.*` | ACME account deletion (`acme_account.delete`) |
| `l4.*` | An L4 app's CNAME prefix (`l4.cname_update`) |
| `l4_app.*` | L4 apps: `l4_app.create`, `l4_app.update`, `l4_app.enable`, `l4_app.disable`, `l4_app.delete` |
| `site.*`, `cache.*`, `certificate.*`, `dns_credential.*`, `ip_list.*`, `platform.*` | Sites (including enabling, HTTPS, logs, protection, OWASP CRS, and site rules), purge & prefetch, certificates, DNS credentials, IP lists, global rules |
| `ban.*` | Manual bans: `ban.create`, `ban.update` (banned again), `ban.delete` (unbanned) |
| `dns.*`, `alert.*` | DNS steering (including provider accounts, cluster bindings, rollbacks, mass removal protection, and forced publications), alert channels, alert rules, SMTP, alert subscriptions |

## Protection settings

Page: **Protection settings** (`/protection`), under **Access control** in the sidebar. Cards in page order: protection, bans, CC template, connection limits, GeoIP databases.

### Protection

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Global Under Attack** | On / off | Off | GET/HEAD requests without a pass are challenged first, on every site; switching asks for confirmation |
| **Challenge type** | Cookie redirect / JavaScript / Non-interactive challenge / Managed challenge / Interactive challenge | JavaScript | Challenge type of global Under Attack |
| **Interactive challenge** | The built-in image captcha, or a third-party provider and its secrets | Built-in image captcha | The CAPTCHA of sites that follow the global setting, see [CAPTCHA providers](challenges.en.md#captcha-providers) |
| **Security event retention (days)** | 7–365 | 30 | How long CC mitigation events reported by nodes are kept |

Switching global Under Attack, or changing the challenge type while it is on, publishes one revision in every cluster. Changes are audited as `system.protection_update`. Global Under Attack needs the node capability `challenge-v1`; nodes without it keep their configuration, see [Revisions](clusters.en.md#revisions). For a site's own Under Attack and CC mitigation, see [Challenges and CC mitigation](challenges.en.md).

### Bans

| Field | Values | Default | Description |
| --- | --- | --- | --- |
| **Limit of manual bans** | 100–100000 | 10000 | Active manual bans in total, site and global bans together; beyond it `BAN_PLATFORM_LIMIT` |
| **Share automatic bans in the cluster** | On / off | On | Whether automatic bans of a node go to the other nodes of its cluster; off keeps them for viewing only |

Changes are audited as `system.bans_update`. See [Bans](bans.en.md).

### CC template

Thresholds for sites whose CC mitigation is on and set to **Follow the default template**: highest level, high proof of work instead of the captcha, window, site QPS, per-URL QPS, per-IP QPS, IP ban duration, origin error rate, minimum origin requests, escalate after, step down after. **Preset** picks Loose, Standard, or Strict, or **Custom** to set each field; fields, ranges, defaults, and the presets' values: [CC mitigation](challenges.en.md#cc-mitigation). Saving publishes a revision to every cluster with a following site; changes are audited as `system.cc_template_update`.

### Connection limits

Limits the TCP connections of each client (an IPv4 address or an IPv6 /64) per cluster in the nodes' kernel; the setting travels in configuration revisions.

| Field | Values | Description |
| --- | --- | --- |
| **Cluster** | A cluster | Shown with more than one cluster |
| **Enabled** | On / off | — |
| **Concurrent connections per IP** | 0–100000 | 0 is no limit |
| **New connections per IP per second** | 0–100000 | 0 is no limit |
| **Burst** | 0–1000000 | New connections a client may open above the rate at once; 0 takes the per-second value; not below the per-second value |
| **Ports** | **Cluster listener ports** / **Custom ports** | Cluster listener ports are the cluster's HTTP / HTTPS listeners and TCP L4 app ports; with custom ports fill in the **Port list**, 1–64 ports or port ranges |

Enabled limits need at least one limit ("Set at least one limit"). The card shows the **Limited ports** and "N / M nodes enforce it"; nodes that do not enforce it and "Nodes on an older version" (without `conn-limit-v1`) are listed one by one. Changes are audited as `cluster.connection_limits_update`, revision reason "Connection limits updated". Behavior and node requirements: [Connection limits](bans.en.md#connection-limits).

### GeoIP databases

Read-only. Shows, per node, the state of the **Country**, **Subdivision**, and **ASN** data (**Ready** / **Unavailable**), with the IPinfo attribution link. Country and ASN data ship in node release images; other databases are configured locally on each node; **Configure databases** links to [Rules, IP lists, and GeoIP](rules.en.md).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **A service account named … exists** | Duplicate name | Use another name |
| **Service accounts cannot call this** | A service account called a procedure outside the [Service accounts](#service-accounts) table | Use an AccessKey |
| **Missing scope: …** | The service account lacks the scope the procedure needs | Edit its scopes on the **Service accounts** tab of **System settings** |
| **The release source must use HTTPS and resolve to an allowed address** | Public HTTP URL, or a private address that is not allowed | Use HTTPS, or allow the range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
