# DNS steering

Per-cluster DNS steering through third-party providers: provider accounts, cluster bindings, health removal and DNS revisions.

## Concepts

| Term | Definition |
| --- | --- |
| Provider account | One set of DNS provider credentials and its zone, used by DNS steering. |
| DNS binding | A cluster's DNS steering settings: mode, provider account, cluster domain, TTL, and lines. |
| Cluster domain | The parent domain of a cluster's steering records; it must lie inside the provider account's zone. |
| Line | The A/AAAA records of one node group in DNS steering; it maps to a resolution line and may have backup node groups. |
| Resolution line | A provider line that answers differently by carrier or region: default, China Telecom, China Unicom, China Mobile, education network, overseas. |
| Backup node group | A node group that answers, in order, while a line's own node group has too few healthy addresses. |
| DNS revision | A snapshot of a cluster's DNS binding and its records, separate from node configuration revisions. |

## Configure DNS steering

DNS steering writes steering records for each cluster; the CNAME targets of sites and [L4 apps](l4.en.md#dns) point at the healthy nodes of their cluster. Edgeweir does not run an authoritative DNS server; it manages records through each provider's API.

Page: **DNS steering** (`/dns`), under **Infrastructure** in the sidebar, with the page action **Add provider account**. Cards in page order: **DNS provider accounts**, **Cluster bindings**, **Mass removal protection**. A cluster's binding, records and DNS revisions are on the **DNS** tab of **Clusters & nodes**: the held-back change (only while held back), **DNS binding**, **Current records** (Automatic mode) or **Records to create** with the zone file (Manual mode), **DNS revisions**.

### Add a provider account

1. Open **DNS steering** and click **Add provider account**.
2. Fill in **Name**, select **DNS provider**, and fill in the credential fields the form shows (fields and required permissions: [Providers and credentials](#providers-and-credentials)).
3. For providers that can list zones, click **List zones** and pick the **Zone**; otherwise type the **Zone**.
4. Click **Test connection**. Verify: **Connected: N records in the zone** appears.
5. Click **Create**. Saving first runs the same test as **Test connection**; when it fails, the dialog shows the error and the button becomes **Save anyway**.

An account is one set of credentials and one zone; for several zones under the same credentials, add one account per zone. A click on the account's row opens the edit dialog, which renames the account; **⋯** at the end of the row holds **Test connection** (reads the zone with the saved credentials) and **Delete**. When editing, turn on **Replace credentials** and fill in every field again to rotate secrets, which are tested before saving too. A rename alone is not tested. After a failed test, changing any field makes the next save test again. The provider and zone cannot change after creation. Credentials are envelope-encrypted with the master key and are write-only.

### Bind a cluster

1. Open **Clusters & nodes**, select the cluster, and switch to the **DNS** tab (shown once the cluster has a node).
2. Select **Mode**: **Not managed**, **Manual**, or **Automatic**.
3. Select **Provider account**; **Zone** shows the account's zone. Fill in **Cluster domain** and **TTL (seconds)**.
4. If needed, click **Add line**, fill in **Line name**, and select a **Node group** of this cluster; if needed, select a **Resolution line**, fill in **Minimum healthy IPs**, and use **Add backup group** under **Backup node groups**, ordering the groups. For a node behind NAT or on a private network, enter its public addresses in the node's **node name: target addresses** field, or configure the node's [scheduling addresses](scheduling.en.md#scheduling-addresses-and-backup-ips); leave it empty to use the node's scheduling addresses. Without lines, `all.<cluster domain>` answers with the addresses of every healthy node of the cluster.
5. Click **Save**. The console shows **DNS revision N created**.
6. Verify: the **Current records** card shows **Published**, and the site's **Domains** tab shows the **CNAME target**.

   ```bash
   dig +short CNAME <CNAME prefix>.<cluster domain>
   dig +short A all.<cluster domain>
   ```

   The first prints `all.<cluster domain>.`, the second the addresses of the cluster's healthy nodes.
7. In each site domain's DNS, CNAME the domain to the **CNAME target**. Below it the card lists where each domain resolves (**Points here**, **Points elsewhere**, **Not resolved**, **Not checked**; **Not checkable** for suffix and regex domains); the **Launch check** on the site's **Overview** tab sums it up as **DNS pointed N/M**.

Clusters may use different provider accounts and cluster domains. The **Cluster bindings** table on the **DNS steering** page lists **Cluster**, **Cluster domain** (shown when a binding has one), and **Status** for each cluster: the state of the latest revision when the mode is **Automatic** and a DNS revision exists (**Published**, **Pending**, **Failed**, **Held back**, possibly with "Over the mass removal limit" or the revision's error), otherwise the mode (**Not managed**, **Manual**, **Automatic**); a click on the cluster's row opens its **DNS** tab.

### Binding fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Mode | Not managed / Manual / Automatic | Not managed | Automatic: the console writes the provider; Manual: lists the records to create, the console writes no DNS; Not managed: sites have no CNAME target and written records are removed |
| Provider account | An added account | None | Required for Automatic; Manual can use **No account**, in which case the zone is the cluster domain |
| Zone | The account's zone | — | Read-only |
| Cluster domain | A name inside the zone, up to 180 characters | None | Parent of all of the cluster's records; the CNAME target of a site or L4 app is `<CNAME prefix>.<cluster domain>` |
| TTL (seconds) | 30–3600 | 600 | TTL of every record; some providers or plans require a higher minimum, see the provider table |
| Keep per-site line targets | On / Off | Off | Keeps `<line>.<CNAME prefix>.<cluster domain>` for every site and enabled L4 app, see [Upgrading from the global DNS configuration](#upgrading-from-the-global-dns-configuration) |
| Line name | Lowercase letters, digits, `-`, 1–32 characters, not `all`, not a [CNAME prefix](domains.en.md#cname-prefixes) of a site or L4 app | `line-N` | First label of the line's host name |
| Node group | A node group of this cluster; at most one line per group | The first unused group | Nodes in the line |
| Resolution line | Default / China Telecom / China Unicom / China Mobile / Education network / Overseas, only those the account's provider supports | Default | `all.<cluster domain>` answers with this line's addresses on that resolution line, see [Records per resolution line](#records-per-resolution-line) |
| Minimum healthy IPs | 1–64 | 1 | Below this many healthy addresses in the line's node group, the backup node groups answer |
| Backup node groups | Other node groups of this cluster, at most 4, ordered | None | See [Backup node groups](#backup-node-groups) |
| Target addresses | Up to 8 IPs per node, comma-separated | Empty (the node's scheduling addresses) | Replace the node's scheduling addresses on this line, without level switching; may be private, never loopback, link-local, multicast, or other special-purpose addresses |

A binding has at most 128 lines and 10,000 system-managed records. Two bindings with the same cluster domain in the same zone cannot share line names or the all-lines record name, and a line name cannot equal a CNAME prefix (old prefixes within 24 hours of a change included) (`DNS_BINDING_CONFLICT`).

With a provider that has the default line only, **Resolution line** is unavailable and shows **This provider has only the default line**; selecting an account whose provider lacks a resolution line moves those lines back to default in the form. Saving a resolution line the provider does not support returns `DNS_LINE_UNSUPPORTED` ("This DNS provider has no {line} resolution line"). Manual mode without a provider account can use every resolution line.

### Generated records

| Name | Type | Content |
| --- | --- | --- |
| `all.<cluster domain>` | A / AAAA | Healthy node addresses of the cluster's lines, written per resolution line, see [Records per resolution line](#records-per-resolution-line); without lines, the addresses of every healthy node of the cluster |
| `<line name>.<cluster domain>` | A / AAAA | Healthy node addresses of the line's node group (of the backup node groups while they answer); default line only |
| `<site's CNAME prefix>.<cluster domain>` | CNAME | `all.<cluster domain>`; one per site with at least one domain, disabled sites included; default line only |
| `<app's CNAME prefix>.<cluster domain>` | CNAME | `all.<cluster domain>`; one per enabled [L4 app](l4.en.md), none for disabled apps; default line only |
| `<old CNAME prefix>.<cluster domain>` | CNAME | `all.<cluster domain>`; kept for 24 hours after a prefix change, see [CNAME prefixes](domains.en.md#cname-prefixes) |
| `<line name>.<CNAME prefix>.<cluster domain>` | CNAME | `<line name>.<cluster domain>`; one set per site and per enabled L4 app (prefixes replaced in the last 24 hours included), only with **Keep per-site line targets**; default line only |

Address records are written once per cluster (`all.<cluster domain>` once per resolution line in use): the record count is "sites + enabled L4 apps + cluster addresses", plus "(sites + enabled L4 apps) × lines" with per-site line targets. With per-site line targets off, the line targets on a site's **Domains** tab and on an L4 app's page are `<line name>.<cluster domain>`.

The **Resolution line** column of the **Current records** and **Records to create** tables shows each record's resolution line.

### Records per resolution line

`all.<cluster domain>` has one record set on every resolution line in use; every other record is on the default line only.

| Resolution line | Addresses of `all.<cluster domain>` |
| --- | --- |
| China Telecom, China Unicom, China Mobile, Education network, Overseas | The union of every binding line mapped to that resolution line; not written when no line maps to it |
| Default | The union of the binding lines mapped to **Default**; when there is none, or they have no address, the union of every line; when the binding has no lines, the addresses of every healthy node of the cluster |

- Resolvers no other resolution line matches get the default line's records; DNSPod requires a record on the default line.
- Writing a name and type replaces its records on every resolution line; copies on resolution lines no longer in use are deleted. A binding that uses the default line only writes the same records as before.
- Records on a resolution line the account's provider no longer supports are not written.

Example:

| Line name | Node group | Resolution line |
| --- | --- | --- |
| `ct` | telecom-nodes | China Telecom |
| `cu` | unicom-nodes | China Unicom |
| `intl` | overseas-nodes | Default |

`all.<cluster domain>` answers China Telecom users with the addresses of telecom-nodes, China Unicom users with those of unicom-nodes, and everyone else with those of overseas-nodes. Without `intl`, the default line answers with every address of `ct` and `cu`.

### Backup node groups

| Item | Behavior |
| --- | --- |
| Switch | The line's node group has fewer healthy addresses than **Minimum healthy IPs**, or a [scheduling rule](scheduling.en.md#scheduling-rules) with **Switch to backup groups** acts on the line |
| Choice | The backup node groups are checked in order; the first with at least **Minimum healthy IPs** healthy addresses answers |
| None has enough | Every still-healthy address of the line's node group and all its backup node groups answers; if that is empty too, the [mass removal protection](#mass-removal-protection) keeps the previous records |
| Scope | The line's `<line name>.<cluster domain>`, and `all.<cluster domain>` on the resolution line it maps to |
| Health | Nodes of backup node groups are judged the same way: [health removal](#health-removal-and-repair), the reachability of scheduling addresses, and scheduling rules |
| Recovery | The line moves back once its node group has the minimum again |
| Publication | Switches and recoveries are published by the next reconciliation (reason **Node health changed**), without another audit entry |
| Mode | Automatic only; Manual mode never switches |

A node group may back up several lines, but not its own line.

### Manual mode

The console writes no DNS. The cluster's **DNS** tab lists the records to create (absolute names) and a BIND zone file; **Download** saves it as `<zone>.zone`.

| Item | Behavior |
| --- | --- |
| Addresses | Every enabled node's primary addresses (the lowest level of its scheduling addresses), regardless of health or probe reachability: manual records do not follow node health; no backup node groups, no scheduling rules |
| Resolution lines | Records list their resolution line; the BIND zone file holds the default line's records, and records of other resolution lines follow as comments (`; line telecom`) to be created on those lines at the provider |
| Sites | One CNAME per site; a single `*.<cluster domain> CNAME all.<cluster domain>` can replace the per-site records |
| L4 apps | One CNAME per enabled app; a disabled app drops out of the list, delete its record by hand |
| CNAME target | Shown on the site's **Domains** tab as usual, with the state **Manual** |
| Switching modes | From Automatic to Manual, written records stay and the console stops changing them; only **Not managed** removes them |

### Upgrading from the global DNS configuration

Earlier versions had one global DNS steering configuration. On upgrade it becomes one binding per cluster, and the CNAME records of site domains need no change:

- Every cluster's cluster domain is the former CNAME domain, so each site's CNAME target keeps its name and resolves to the same addresses as before.
- A configuration that was on becomes Automatic with **Keep per-site line targets** on, so the line targets a site's **Domains** tab listed, `<line>.<site UUID>.<CNAME domain>`, keep resolving; one that was off becomes Not managed, with account, domain, and lines kept in the form.
- When several clusters share the former CNAME domain, their all-lines records are named `all`, `all-2`, … (clusters with sites first) and each site's CNAME points at its cluster's record.
- The former per-site address records `all.<site UUID>.<CNAME domain>` are removed by the next reconciliation, which deletes only names the console registered.
- If the first publication after the upgrade would leave only CNAMEs and no address records (for example before any node has reconnected), the cluster keeps its previous records and the revision shows **Held back**, as in [Mass removal protection](#mass-removal-protection); it continues once nodes are back, or with **Publish anyway**.
- Earlier DNS revisions stay in the database and are no longer shown.
- In `/api/v1`, `/dns/config`, `/dns/revisions`, and `/dns/force-publish` become the per-cluster `/clusters/{clusterId}/dns`, `/clusters/{clusterId}/dns/revisions`, and `/clusters/{clusterId}/dns/force-publish`; `/dns/bindings` lists every cluster's binding.

### Health removal and repair

| Item | Behavior |
| --- | --- |
| Address set | Nodes that are enabled, sent a heartbeat within 45 seconds, report a healthy data plane, and applied their cluster's current revision |
| Node addresses | Each node answers with the lowest reachable level of its [scheduling addresses](scheduling.en.md#scheduling-addresses-and-backup-ips); with every level unreachable, with none |
| Scheduling | Active [scheduling rules](scheduling.en.md#scheduling-rules) remove nodes, move them to backup IPs, or switch lines to backup node groups; reachability and rules are evaluated every 10 seconds and changes are published right away |
| Publication grace | For 2 minutes after a revision is published, nodes that were up to date keep their place while they apply it, so routine changes do not take nodes out of DNS |
| Check interval | A background job recomputes every automatic binding each minute, up to 4 clusters at a time; offline or disabled nodes, nodes whose apply failed, and nodes more than 2 minutes behind are removed and added back after recovery |
| Failure isolation | Each binding publishes and reconciles on its own; an unavailable provider fails only the DNS revisions of the clusters that use it |
| Propagation | Bound by TTL and resolver caches; not an instant switch |
| Drift repair | System-managed names deleted or changed outside the console are restored at the next check; **Repair records** runs one for the cluster immediately |
| Takeover scope | Only names this cluster registered are changed; a new name that already has unmanaged records is refused (`DNS_RECORD_CONFLICT`), as is a name managed by another cluster (`DNS_BINDING_CONFLICT`); the error and the failed DNS revision name the conflicting name (`data.name`) |
| Write order | Names are registered first; changed address RRsets are replaced as a whole, then CNAMEs, in batches of at most 100 records; records no longer needed are deleted; the result is read back. New records are written before the records they replace (for example, addresses moving from A to AAAA), so a name never resolves empty in between; only a name changing to or from a CNAME loses its old records first. On failure the registration stays and the next cycle retries |
| TTL | A provider raising the TTL to its own minimum is not drift; after the binding's TTL changes, the next reconciliation rewrites the records with the new TTL |
| Concurrency | One console process at a time reconciles a cluster (a 15-minute lease that expires if the process exits); **Repair records** waits for a reconciliation in progress and then runs one more, and returns `DNS_RECONCILE_BUSY` when the other is still running after 30 seconds |
| Configuration canary | Each node is compared with its own target revision: during a canary window the non-canary nodes run the stable revision and stay, see [Configuration canary](clusters.en.md#configuration-canary) |

A failed DNS revision shows its reason: provider authentication failed, zone not found at the provider, provider unreachable, provider rate limit, a name has unmanaged records, a name belongs to another cluster, server address refused by the outbound policy, and so on.

### Mass removal protection

When a publication would empty a cluster's previously non-empty `all.` or line record set (each resolution line counted separately), or remove more address records than the threshold allows, the cluster's previous records stay and nothing is written to the provider. The same applies when the console loses its node channel and every node looks offline.

| Item | Behavior |
| --- | --- |
| Threshold | Share of the cluster's previous address records one publication may remove: 50% by default, adjustable in **DNS steering → Mass removal protection** (5%–100%) for all clusters |
| Not counted | Names no longer managed (deleted sites, disabled or deleted L4 apps, removed lines); resolution lines no longer in use; a change of provider account, cluster domain, or all-lines record name; modes other than Automatic; address changes from backup node group switches do not count toward the share, though emptying a record set still does |
| Scheduling | Removals by scheduling rules count as usual |
| When held back | The top of the cluster's **DNS** tab shows the held-back change (address records it would remove); the DNS revision list shows it as **Held back**, and the **Cluster bindings** table shows the cluster as **Held back**; the alert "DNS mass removal blocked" fires for the cluster |
| Recovery | The hold ends by itself once a publication passes; the alert resolves |
| Force | Click **Publish anyway** on the cluster's **DNS** tab and confirm; the current state is published and `dns.force_publish` is audited |

### DNS revisions and rollback

Each cluster has its own DNS revisions, which do not advance the node configuration revision. **Roll back DNS** restores the binding settings of the chosen revision (mode, account, cluster domain, TTL, lines with their resolution lines, backup node groups, and minimum healthy IPs); addresses are still computed from the current sites and node health, so offline nodes are not restored. Manual-mode revisions are **Published** as soon as they are saved. Each cluster keeps its latest 200 DNS revisions; the current, published, and **Blocked** revisions are never pruned.

Columns of the **DNS revisions** table: **Version**, **Status**, **Reason**, **Records**, **Created**. The **Current records** card shows the current revision's error above its table. The **Reason** column:

| Reason | Trigger |
| --- | --- |
| Binding saved | Saving the DNS binding; changing a node's scheduling addresses |
| Node health changed | A reconciliation found a different address set; a probe-driven address level change; a backup node group switch or recovery |
| Rolled back | **Roll back DNS** |
| Force-published | **Publish anyway** |
| Scheduling: {rule} on {node} | A scheduling rule took effect or recovered; followed by the action and **Activated** or **Recovered** |
| CNAME prefix of {name} changed | A site or L4 app's CNAME prefix was regenerated or customized |
| Replaced CNAME prefixes expired | 24 hours after a prefix change the old name leaves the plan |

Before deleting a provider account, point the clusters that use it at another account or switch them to Not managed and wait for cleanup (the account no longer owns system-managed records); otherwise the console returns `DNS_PROVIDER_IN_USE`. Likewise, before deleting a cluster, switch its DNS to Not managed and wait for cleanup (`DNS_BINDING_IN_USE`).

### Providers and credentials

DNS steering provider accounts and the DNS credentials used for certificate DNS-01 (see [HTTPS and certificates](https.en.md#add-a-dns-credential)) use the same provider catalog and forms. Give credentials the least permission the zone needs.

Each provider adapter is tested only with recorded API exchanges (requests and answers built from the provider's official API reference); none has been accepted against a real account. Use **Test connection** before relying on one.

| Provider | Credential fields | Least permission | Zone listing | Apex | Notes |
| --- | --- | --- | --- | --- | --- |
| Cloudflare | API token; zone token (optional) | API token: Zone → DNS → Edit and Zone → Zone → Read on the zone (zone read can live in the zone token instead) | Yes | CNAME flattening | TTL at least 60 s; new records are not proxied |
| Alibaba Cloud | AccessKey ID, AccessKey secret, region (optional), STS token (optional) | RAM: `alidns:AddDomainRecord`, `alidns:UpdateDomainRecord`, `alidns:DeleteDomainRecord` on `acs:alidns:*:<account ID>:domain/<domain>`; `alidns:DescribeDomainRecords` and, for zone listing, `alidns:DescribeDomains` on `*` | Yes | — | China and international accounts use the same endpoint; free edition TTL at least 600 (retried once at 600 when refused) |
| Huawei Cloud | Access key ID, secret access key, region (default `cn-north-4`) | IAM: `dns:zone:list`, `dns:recordset:list`, `dns:recordset:create`, `dns:recordset:update`, `dns:recordset:delete` | Yes | — | Public zones are global; international accounts can use `ap-southeast-3` |
| DNSPod (token) | API token (`ID,Token`) | A DNSPod token of the main account, covering the whole account; sub-accounts cannot use it | Yes | — | DNSPod marks the token API as legacy; prefer Tencent Cloud DNSPod (API 3.0) for new setups; free plan TTL at least 600 |
| Tencent Cloud DNSPod (API 3.0) | SecretId, SecretKey, site (shown as `site` in the form, options `cn` China / `intl` international) | CAM: `dnspod:DescribeRecordList`, `dnspod:CreateRecord`, `dnspod:ModifyRecord`, `dnspod:DeleteRecord` on `qcs::dnspod::uin/<main account UIN>:domain/<domain ID>`; `dnspod:DescribeDomainList` for zone listing | Yes | — | The international site uses the international endpoint; free plan TTL at least 600 |
| Volcengine | Access key ID, secret access key | A custom policy allowing `ListZones`, `ListRecords`, `CreateRecord`, `UpdateRecord`, `DeleteRecord` (the preset DNSFullAccess is broader) | Yes | — | Free edition TTL at least 600 |
| Baidu AI Cloud | Access key ID, secret access key | An IAM sub-user with a custom "operations" policy for Intelligent Cloud DNS limited to the zone (or the preset DNSOperatePolicy); the account must be real-name verified | Yes | — | Free edition TTL at least 300 |
| West.cn | Username, API password | The API password covers the whole account | Yes | — | The API is for West.cn resellers; allow the console's egress IP at West.cn (error "ip 授权失败"); TTL within 60–86400 |
| DNS.LA | API ID, API secret | An API key enabled under My account → API, covering the whole account | Yes | — | Minimum TTL depends on the plan |
| Amazon Route 53 | Access key ID, secret access key, session token (optional), hosted zone ID (optional), partition (shown as `partition` in the form: `aws` / `aws-cn` / `aws-us-gov`) | `route53:GetHostedZone`, `route53:ListResourceRecordSets`, `route53:ChangeResourceRecordSets` on `arn:aws:route53:::hostedzone/<ID>`; add `route53:ListHostedZonesByName` without a hosted zone ID and `route53:ListHostedZones` for zone listing (both on `*`) | Yes | — | Writes simple records only; alias records can only target AWS resources |
| Google Cloud DNS | Service account key (JSON), project ID (optional), managed zone name (optional) | `dns.changes.create`, `dns.resourceRecordSets.create`, `.update`, `.delete`, `.list`, plus `dns.managedZones.get` (with a managed zone name) or `dns.managedZones.list`; `roles/dns.admin` covers all | Yes | ALIAS | ALIAS works in public zones only and not together with DNSSEC |
| Azure DNS | Tenant ID, client ID, client secret, subscription ID, resource group | "DNS Zone Contributor" on the zone; zone listing also needs `Microsoft.Network/dnszones/read` on the resource group | Yes | — | Azure public cloud only |
| DigitalOcean | API token | Custom scopes `domain:read` and `domain:update`, covering the account or team | Yes | — | TTL at least 30 |
| Vultr | API key | The API key of a user with the `dns` permission | Yes | — | Allow the console's egress IPs (IPv4 and IPv6) in Vultr's API access control |
| Akamai (Linode) | API token | A personal access token with Domains Read/Write; to limit it to one domain, create it as a restricted user granted `read_write` on that domain | Yes | — | TTLs snap to Linode's allowed values, at least 300 |
| Hetzner | API token | A Hetzner Cloud project API token with Read & Write | Yes | — | Uses the Hetzner Cloud API; tokens from the old DNS Console do not work; TTL at least 60 |
| OVHcloud | Endpoint (`ovh-eu` / `ovh-ca` / `ovh-us`), application key, application secret, consumer key | Consumer key access rules: `GET /domain/zone` (zone listing), `GET /domain/zone/<zone>/record`, `GET`, `PUT`, `DELETE /domain/zone/<zone>/record/*`, `POST /domain/zone/<zone>/record`, `POST /domain/zone/<zone>/refresh` | Yes | — | Reading records takes one request per record, slow for large zones; TTL at least 60 |
| Gandi (LiveDNS API) | Personal access token | A personal access token restricted to the domain with "Manage domain name technical configurations" | Yes | ALIAS | TTL 300–2592000 |
| GoDaddy | API token (`key:secret` or a personal access token) | Personal access token scopes `domains.domain:read` and `domains.dns:update` | Yes | — | The account must hold a domain or have a plan with domain management, otherwise 403; TTL at least 600 |
| Porkbun | API key, secret API key | An API key pair, with API access enabled for the domain | Yes | ALIAS | TTL at least 600 |
| NameSilo | API token | The account API key (sub-accounts cannot use it; it can be limited by IP) | Yes | — | TTL at least 3600; one request per key at a time |
| Gcore | API key (a permanent token `<ID>$<secret>`) | A permanent API token | Yes | CNAME flattening | Setting an RRset replaces its GeoDNS pickers |
| Bunny DNS | API access key | The account API key (full access) | Yes | CNAME flattening | — |
| deSEC | Token | A token without token management or domain create/delete permissions; a scoping policy can limit writes to the domain | Yes | — | TTL at least the domain's minimum (3600 by default); write rate limits apply |
| PowerDNS | Server URL, API key, server ID (default `localhost`) | Server settings `api=yes`, `api-key`, and `webserver-allow-from` including the console's egress address; the API key covers the whole server | Yes | — | Self-hosted endpoint, see below; the built-in web server speaks HTTP only, so public addresses need a TLS reverse proxy |
| RFC 2136 (TSIG) | Server (host or `host:port`), TSIG key name, TSIG algorithm, TSIG secret (Base64) | For example in BIND: `update-policy { grant <key name> zonesub A AAAA CNAME TXT; };` and `allow-transfer { key <key name>; };` | No | — | Self-hosted endpoint; TCP only; records are read with AXFR |
| Custom HTTP | URL, signing secret (at least 16 characters) | Implemented by the receiver | Up to the receiver | — | Self-hosted endpoint; see [Custom HTTP protocol](#custom-http-protocol) |

**Apex**: CNAME flattening or an ALIAS record lets the zone apex (`@`) point at a host name (such as a site's CNAME target); with other providers the apex can only use A / AAAA records. For resolution lines see [Resolution lines](#resolution-lines); the carrier or regional lines of other providers (offered by Volcengine, Baidu AI Cloud, West.cn, DNS.LA, Route 53, Google Cloud DNS, Gcore, and Bunny DNS) are not used, and records go to the default line.

Providers not supported:

| Provider | Reason |
| --- | --- |
| Namecheap | The API can only replace all host records with `setHosts`; records missing from the request are deleted, which can remove records written outside the console |
| Hurricane Electric (dns.he.net) | No record management API, only dynamic updates of records that already exist |
| DNSPod international (the dnspod.com token API) | A different protocol from the China site, with no service guarantee for the legacy API; international accounts use the international site of Tencent Cloud DNSPod (API 3.0) |

#### Resolution lines

Resolution lines let one name answer differently by carrier or region. The provider adapters use the line names below and translate them to each provider's own lines:

| Line | Meaning | DNSPod (token) and Tencent Cloud DNSPod | Alibaba Cloud | Huawei Cloud |
| --- | --- | --- | --- | --- |
| `default` | Default (resolvers no other line matches) | `0` | `default` | `default_view` |
| `telecom` | China Telecom | `10=0` | `telecom` | `Dianxin` |
| `unicom` | China Unicom | `10=1` | `unicom` | `Liantong` |
| `mobile` | China Mobile | `10=3` | `mobile` | `Yidong` |
| `edu` | China Education Network | `10=2` | `edu` | `Jiaoyuwang` |
| `overseas` | Outside mainland China | `3=0` | `oversea` | `Abroad` |

- Only these four providers (Tencent Cloud DNSPod on both the China and the international site) support every line; other providers have `default` only and refuse records on other lines. `capabilities.lines` in `GET /dns/catalog` lists each provider's lines.
- Writing a name and type replaces its records on every line: copies on lines missing from the write are deleted.
- When reading, provider lines outside the table (such as province lines) show as `other:<provider line>`; such records can only be deleted. Alibaba Cloud is read line by line for the lines in the table, so records on other lines may not be read.

### Self-hosted endpoints and the outbound policy

The addresses of PowerDNS, RFC 2136, and Custom HTTP are entered by the operator, so every connection goes through the outbound address policy:

| Item | Behavior |
| --- | --- |
| Address check | The address actually connected to is checked when the connection opens (DNS rebinding safe); loopback, link-local, private, and other special-purpose addresses are allowed only inside `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Encryption | Public addresses require HTTPS; cleartext HTTP only reaches allowed internal addresses |
| Redirects | Not followed |
| Availability | DNS steering provider accounts and certificate DNS credentials |

### Custom HTTP protocol

Every operation is one request:

```text
POST <URL>
Content-Type: application/json
User-Agent: edgeweir-certd/1
X-Edgeweir-Timestamp: <Unix seconds>
X-Edgeweir-Signature: v1=<hex>
```

`<hex>` is the lowercase hexadecimal HMAC-SHA256, keyed with the signing secret, of the timestamp, `.`, and the raw request body. Receivers recompute it over the raw body, compare in constant time, and answer 401 to a wrong signature or a timestamp more than 300 seconds away from their clock. Example: secret `example-secret-0123456789`, timestamp `1700000000`, and body `{"action":"zones"}` give `v1=3af007dacbb4d9b54c57bc499f275d13e48a5513e8ecf036d83c1b5a6c0f20f8`.

Body:

```json
{"action":"set","zone":"example.com","records":[{"name":"www","type":"A","data":"192.0.2.1","ttl":600}]}
```

| Field | Description |
| --- | --- |
| `zone` | The zone name without the trailing dot; absent for `zones` |
| `records` | Absent for `list` and `zones`; `name` is relative to the zone (`@` for the apex), `type` upper case, `data` an address, a host name (trailing dot optional), or TXT text without quotes, `ttl` in seconds |

| Action | Behavior |
| --- | --- |
| `list` | Return every record of the zone |
| `append` | Add the records; existing records stay |
| `set` | For each (name, type) in the request, keep only the given records; other RRsets stay |
| `delete` | Delete records matching name, type, and data; empty data deletes the whole (name, type) RRset |
| `zones` | Return the zones the receiver manages |

A success is a 2xx JSON answer (up to 16 MiB): `{"records":[...]}` for `list`, `append`, `set`, and `delete`; `{"zones":["example.com"]}` for `zones`. 401 or 403 means authentication failed, 404 an unknown zone, 501 on `zones` that the receiver cannot list zones; 429 is treated as rate limiting and 5xx as unavailable. Error answers may carry `{"error":"short text"}`. The signature covers only a timestamp, so a request can be replayed within 300 seconds: `set` and `delete` are idempotent, `append` needs deduplication by the receiver.

## Limits

| Item | Description |
| --- | --- |
| Background jobs | DNS reconciliation runs every minute, address reachability and scheduling rules every 10 seconds; they need at least one console process with `ROLE=worker` or `ROLE=all`, see [Deployment overview](../deploy/README.en.md) |
| Resolution lines | Only six resolution lines (default, China Telecom, China Unicom, China Mobile, education network, overseas), and only with DNSPod, Tencent Cloud DNSPod, Alibaba Cloud, and Huawei Cloud; province lines and other providers' geographic resolution are not used |
| Authoritative DNS | Edgeweir runs no authoritative DNS; it manages records through provider APIs |
| One operation | Each provider call takes at most 2 minutes |
| Active probing | Node reachability comes from [regional probes](scheduling.en.md#regional-probes); origin state from the nodes' passive and active health checks |
| Local simulator | **Local simulator** appears only when `EDGEWEIR_DNS_TEST_ENDPOINT` is set and is for testing only |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "CNAME domain is outside the DNS zone" | The cluster domain is not inside the account's zone | Use the zone itself or a subdomain of it |
| "DNS name has an unmanaged record" | The target name already has a manual record | Delete the manual record, then **Repair records** |
| Saving a custom CNAME prefix shows "CNAME prefix … is taken or reserved" | Another object uses or reserves the prefix, or in Automatic mode the zone already has a manual record at `<prefix>.<cluster domain>` (with **Keep per-site line targets** also `<line name>.<prefix>.<cluster domain>`) | Use another prefix, or delete the manual record and save again |
| "… is taken by another cluster's DNS binding or a CNAME prefix" | Two clusters use the same cluster domain and line names in one zone, or a line name equals a site's or L4 app's [CNAME prefix](domains.en.md#cname-prefixes) (old prefixes in their 24-hour transition included) | For two clusters, use a different cluster domain or line name; for a CNAME prefix, use another line name or wait until the old prefix's 24-hour transition ends (changing that object's prefix or the cluster domain does not help: a replaced prefix stays reserved for 24 hours) |
| "DNS provider is still in use" | A cluster binding still selects the account, or it still owns records | Select another account or switch to Not managed, wait for cleanup, then delete |
| "Turn the cluster's DNS off and wait for its records to be removed" | The cluster to delete is still Automatic or still owns records | Switch to Not managed and wait for cleanup |
| "The DNS provider rejected the credentials" | Wrong, expired, or under-privileged credentials; some providers also require the console's egress IP to be allowed | Check the permissions in [Providers and credentials](#providers-and-credentials), then **Test connection** |
| "The server address is private or special-purpose, or a public address without HTTPS" | The outbound policy refused a self-hosted endpoint | Use HTTPS, or allow the internal range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| **CNAME target** shows **No healthy nodes** | No node in the lines meets the address set conditions | Check node heartbeats, data plane state, and applied revision |
| "This DNS provider has no {line} resolution line" | A binding line uses a resolution line the account's provider does not support | Use **Default**, or an account whose provider supports the line |
| "This cluster's DNS is still being synced; try again later" | **Repair records** waited 30 seconds for another reconciliation that is still running, usually behind a slow provider | Try again later and check the DNS revision's status |
| Carrier users get the default line's addresses | The resolver is not on that carrier's network, or no binding line maps to that resolution line | Test with a resolver of that carrier; add a binding line for it |
