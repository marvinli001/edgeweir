# DNS steering and alerts

DNS steering records (third-party DNS providers bound per cluster), and alert channels, subscriptions, and rules.

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
| Alert channel | A notification target: email, webhook, DingTalk, WeCom, or Telegram. |
| Alert subscription | Sends some alert kinds of a set of sites (or all sites) to one channel; one per channel. |

## Configure DNS steering

DNS steering writes steering records for each cluster; the CNAME targets of sites and [L4 apps](l4.en.md#dns) point at the healthy nodes of their cluster. Edgeweir does not run an authoritative DNS server; it manages records through each provider's API.

### Add a provider account

1. Open **DNS steering** and click **Add provider account**.
2. Fill in **Name**, select **DNS provider**, and fill in the credential fields the form shows (fields and required permissions: [Providers and credentials](#providers-and-credentials)).
3. For providers that can list zones, click **List zones** and pick the **Zone**; otherwise type the **Zone**.
4. Click **Test connection**. Verify: **Connected: N records in the zone** appears.
5. Click **Create**.

An account is one set of credentials and one zone; for several zones under the same credentials, add one account per zone. **Test connection** in the account list reads the zone with the saved credentials. **Edit** renames the account; turn on **Replace credentials** and fill in every field again to rotate secrets. The provider and zone cannot change after creation. Credentials are envelope-encrypted with the master key and are write-only.

### Bind a cluster

1. Open **Clusters & nodes**, select the cluster, and switch to the **DNS** tab.
2. Select **Mode**: **Not managed**, **Manual**, or **Automatic**.
3. Select **Provider account**; **Zone** shows the account's zone. Fill in **Cluster domain** and **TTL (seconds)**.
4. Click **Add line**, fill in **Line name**, and select a **Node group** of this cluster; if needed, select a **Resolution line**, fill in **Minimum healthy IPs**, and use **Add backup group** under **Backup node groups**, ordering the groups. For a node behind NAT or on a private network, enter its public addresses in the node's **node name: target addresses** field, or configure the node's [scheduling addresses](scheduling.en.md#scheduling-addresses-and-backup-ips); leave it empty to use the node's scheduling addresses.
5. Click **Save**. The console shows **DNS revision N created**.
6. Verify: the **Current records** card shows **Published**, and the site's **Domains** tab shows the **CNAME target**.

   ```bash
   dig +short CNAME <site UUID>.<cluster domain>
   dig +short A all.<cluster domain>
   ```

   The first prints `all.<cluster domain>.`, the second the addresses of the cluster's healthy nodes.
7. In each site domain's DNS, CNAME the domain to the **CNAME target**.

Clusters may use different provider accounts and cluster domains. The **Cluster bindings** table on the **DNS steering** page lists each cluster's mode, cluster domain, and publication state; **Open** goes to the cluster's **DNS** tab.

### Binding fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Mode | Not managed / Manual / Automatic | Not managed | Automatic: the console writes the provider; Manual: lists the records to create, the console writes no DNS; Not managed: sites have no CNAME target and written records are removed |
| Provider account | An added account | None | Required for Automatic; optional for Manual, in which case the zone is the cluster domain |
| Zone | The account's zone | — | Read-only |
| Cluster domain | A name inside the zone, up to 180 characters | None | Parent of all of the cluster's records; a site's CNAME target is `<site UUID>.<cluster domain>`, an L4 app's `<app UUID>.<cluster domain>` |
| TTL (seconds) | 30–3600 | 600 | TTL of every record; some providers or plans require a higher minimum, see the provider table |
| Keep per-site line targets | On / Off | Off | Keeps `<line>.<UUID>.<cluster domain>` for every site and enabled L4 app, see [Upgrading from the global DNS configuration](#upgrading-from-the-global-dns-configuration) |
| Line name | Lowercase letters, digits, `-`, 1–32 characters, not `all` | `line-N` | First label of the line's host name |
| Node group | A node group of this cluster; at most one line per group | The first unused group | Nodes in the line |
| Resolution line | Default / China Telecom / China Unicom / China Mobile / Education network / Overseas, only those the account's provider supports | Default | `all.<cluster domain>` answers with this line's addresses on that resolution line, see [Records per resolution line](#records-per-resolution-line) |
| Minimum healthy IPs | 1–64 | 1 | Below this many healthy addresses in the line's node group, the backup node groups answer |
| Backup node groups | Other node groups of this cluster, at most 4, ordered | None | See [Backup node groups](#backup-node-groups) |
| Target addresses | Up to 8 IPs per node, comma-separated | Empty (the node's scheduling addresses) | Replace the node's scheduling addresses on this line, without level switching; may be private, never loopback, link-local, multicast, or other special-purpose addresses |

A binding has at most 128 lines and 10,000 system-managed records. Two bindings with the same cluster domain in the same zone cannot share line names or the all-lines record name (`DNS_BINDING_CONFLICT`).

With a provider that has the default line only, **Resolution line** is unavailable and shows **This provider has only the default line**; selecting an account whose provider lacks a resolution line moves those lines back to default in the form. Saving a resolution line the provider does not support returns `DNS_LINE_UNSUPPORTED` ("This DNS provider has no {line} resolution line"). Manual mode without a provider account can use every resolution line.

### Generated records

| Name | Type | Content |
| --- | --- | --- |
| `all.<cluster domain>` | A / AAAA | Healthy node addresses of the cluster's lines, written per resolution line, see [Records per resolution line](#records-per-resolution-line) |
| `<line name>.<cluster domain>` | A / AAAA | Healthy node addresses of the line's node group (of the backup node groups while they answer); default line only |
| `<site UUID>.<cluster domain>` | CNAME | `all.<cluster domain>`; one per site with at least one domain, disabled sites included; default line only |
| `<app UUID>.<cluster domain>` | CNAME | `all.<cluster domain>`; one per enabled [L4 app](l4.en.md), none for disabled apps; default line only |
| `<line name>.<UUID>.<cluster domain>` | CNAME | `<line name>.<cluster domain>`; one set per site and per enabled L4 app, only with **Keep per-site line targets**; default line only |

Address records are written once per cluster (`all.<cluster domain>` once per resolution line in use): the record count is "sites + enabled L4 apps + cluster addresses", plus "(sites + enabled L4 apps) × lines" with per-site line targets. With per-site line targets off, the line targets on a site's **Domains** tab and on an L4 app's page are `<line name>.<cluster domain>`.

The **Resolution line** column of the **Current records** and **Records to create** tables shows each record's resolution line.

### Records per resolution line

`all.<cluster domain>` has one record set on every resolution line in use; every other record is on the default line only.

| Resolution line | Addresses of `all.<cluster domain>` |
| --- | --- |
| China Telecom, China Unicom, China Mobile, Education network, Overseas | The union of every binding line mapped to that resolution line; not written when no line maps to it |
| Default | The union of the binding lines mapped to **Default**; when there is none, or they have no address, the union of every line |

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
| Concurrency | One console process at a time reconciles a cluster (a 15-minute lease that expires if the process exits) |
| Configuration canary | Each node is compared with its own target revision: during a canary window the non-canary nodes run the stable revision and stay, see [Configuration canary](system.en.md#configuration-canary) |

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

The **Reason** column of the **DNS revisions** table:

| Reason | Trigger |
| --- | --- |
| Binding saved | Saving the DNS binding; changing a node's scheduling addresses |
| Node health changed | A reconciliation found a different address set; a probe-driven address level change; a backup node group switch or recovery |
| Rolled back | **Roll back DNS** |
| Published despite the protection | **Publish anyway** |
| Scheduling: {rule} on {node} | A scheduling rule took effect or recovered; followed by the action and **Activated** or **Recovered** |

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
| Tencent Cloud DNSPod (API 3.0) | SecretId, SecretKey, site (China / international) | CAM: `dnspod:DescribeRecordList`, `dnspod:CreateRecord`, `dnspod:ModifyRecord`, `dnspod:DeleteRecord` on `qcs::dnspod::uin/<main account UIN>:domain/<domain ID>`; `dnspod:DescribeDomainList` for zone listing | Yes | — | The international site uses the international endpoint; free plan TTL at least 600 |
| Volcengine | Access key ID, secret access key | A custom policy allowing `ListZones`, `ListRecords`, `CreateRecord`, `UpdateRecord`, `DeleteRecord` (the preset DNSFullAccess is broader) | Yes | — | Free edition TTL at least 600 |
| Baidu AI Cloud | Access key ID, secret access key | An IAM sub-user with a custom "operations" policy for Intelligent Cloud DNS limited to the zone (or the preset DNSOperatePolicy); the account must be real-name verified | Yes | — | Free edition TTL at least 300 |
| West.cn | Username, API password | The API password covers the whole account | Yes | — | The API is for West.cn resellers; allow the console's egress IP at West.cn (error "ip 授权失败") |
| DNS.LA | API ID, API secret | An API key enabled under My account → API, covering the whole account | Yes | — | Minimum TTL depends on the plan |
| Amazon Route 53 | Access key ID, secret access key, session token (optional), hosted zone ID (optional), partition (`aws` / `aws-cn` / `aws-us-gov`) | `route53:GetHostedZone`, `route53:ListResourceRecordSets`, `route53:ChangeResourceRecordSets` on `arn:aws:route53:::hostedzone/<ID>`; add `route53:ListHostedZonesByName` without a hosted zone ID and `route53:ListHostedZones` for zone listing (both on `*`) | Yes | — | Writes simple records only; alias records can only target AWS resources |
| Google Cloud DNS | Service account key (JSON), project ID (optional), managed zone name (optional) | `dns.changes.create`, `dns.resourceRecordSets.create`, `.update`, `.delete`, `.list`, plus `dns.managedZones.get` (with a managed zone name) or `dns.managedZones.list`; `roles/dns.admin` covers all | Yes | ALIAS | ALIAS works in public zones only and not together with DNSSEC |
| Azure DNS | Tenant ID, client ID, client secret, subscription ID, resource group | "DNS Zone Contributor" on the zone; zone listing also needs `Microsoft.Network/dnszones/read` on the resource group | Yes | — | Azure public cloud only |
| DigitalOcean | API token | Custom scopes `domain:read` and `domain:update`, covering the account or team | Yes | — | TTL at least 30 |
| Vultr | API key | The API key of a user with the `dns` permission | Yes | — | Allow the console's egress IPs (IPv4 and IPv6) in Vultr's API access control |
| Akamai (Linode) | API token | A personal access token with Domains Read/Write; to limit it to one domain, create it as a restricted user granted `read_write` on that domain | Yes | — | TTLs snap to Linode's allowed values, at least 300 |
| Hetzner | API token | A Hetzner Cloud project API token with Read & Write | Yes | — | Uses the Hetzner Cloud API; tokens from the old DNS Console do not work; TTL at least 60 |
| OVHcloud | Endpoint (`ovh-eu` / `ovh-ca` / `ovh-us`), application key, application secret, consumer key | Consumer key access rules: `GET /domain/zone` (zone listing), `GET /domain/zone/<zone>/record`, `GET`, `PUT`, `DELETE /domain/zone/<zone>/record/*`, `POST /domain/zone/<zone>/record`, `POST /domain/zone/<zone>/refresh` | Yes | — | Reading records takes one request per record, slow for large zones |
| Gandi LiveDNS | Personal access token | A personal access token restricted to the domain with "Manage domain name technical configurations" | Yes | ALIAS | TTL 300–2592000 |
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

## Alerts page

Alerts are configured on the **Alerts** page, which has five cards:

| Card | Contents |
| --- | --- |
| Alert channels | Notification targets, which can be added, edited, tested, enabled or disabled, and deleted |
| SMTP | The mail server of email channels, see [SMTP](#smtp) |
| Subscriptions | The sites and alert kinds each channel receives |
| Recent events | The latest 100 alert events, including cluster and DNS alerts |
| Alert rules | The thresholds that raise alerts |

## Configure alert channels

1. Open **Alerts** and click **Add channel** in the **Alert channels** card.
2. Enter **Name**, select **Channel type**, and fill in the fields for that type (see below).
3. Select **Notification language**.
4. Turn on **Receive every alert** as needed.
5. Click **Create**.
6. Verify: click **Send test**; the target receives a test notification and the channel row does not show **Notification delivery failed**.

Email channels use the server in the **SMTP** card, see [SMTP](#smtp).

### Channel fields

| Channel type | Fields | Constraint |
| --- | --- | --- |
| Webhook | Webhook URL, Bearer token (optional) | HTTP POST with JSON; public targets require HTTPS |
| Email | Recipient addresses | 1–20 addresses, separated by commas or spaces |
| DingTalk | Webhook URL, Signing secret (optional) | Host must be `oapi.dingtalk.com`; with a signing secret, timestamp and HMAC-SHA256 signature are added |
| WeCom | Webhook URL | Host must be `qyapi.weixin.qq.com` |
| Telegram | Bot token, Chat ID | Calls the Bot API `sendMessage` with link previews disabled |

| Switch | Default | Effect |
| --- | --- | --- |
| Receive every alert | Off | The channel receives every alert without subscriptions: the alerts of all sites, and cluster and DNS alerts |

Channels without this switch receive only the site alerts subscribed to them, see [Subscribe to alerts](#subscribe-to-alerts).

At most 32 channels. When editing a channel, turn on **Replace channel credentials** to re-enter the type and fields; otherwise the stored credentials are kept. A disabled channel sends no notifications and cannot be chosen for new subscriptions.

### Webhook payload

The request body is JSON with `id` (event ID), `siteId`, `siteName`, `kind`, `status` (`firing` / `resolved`), `occurredAt`, `resourceId` (the object of the alert, such as a node or certificate ID), `text`, and `url` (a console link). For cluster and DNS alerts, `siteId` is `null` and `siteName` is the cluster name; for **Node offline**, `siteId` is `null`, `siteName` is the node name and `resourceId` the node ID; and `url` points to **Clusters & nodes** or **DNS steering**; for `scheduling_action`, `siteName` is "rule · node" and `resourceId` is `<rule ID>:<node ID>`. With a bearer token, the request carries `Authorization: Bearer <token>`. A 2xx response counts as delivered.

### SMTP

The outgoing mail server of email channels, set in the **SMTP** card of the **Alerts** page and saved with **Save**. Until it is set, **Send test** on an email channel answers "SMTP is not configured", and a channel whose deliveries fail for that reason shows the same message.

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

## Set alert rules

1. Open **Alerts** and change the thresholds in the **Alert rules** card.
2. Click **Save**.

| Field | Values | Default | Alert kind | Condition |
| --- | --- | --- | --- | --- |
| Offline threshold (seconds) | 45–3600 | 90 | Node offline | An enabled node has not reported for longer than the threshold, or reports an unhealthy data plane; one alert per node, not one per site it serves |
| Certificate warning (hours) | 1–720 | 72 | Certificate expiring | The site's current certificate expires within the threshold |
| Minimum requests | 1–1000000 | 100 | High server error ratio | Requests in the window reach this value |
| Window (minutes) | 1–60 | 5 | High server error ratio | Time window for the 5xx ratio |
| 5xx threshold (%) | 1–100 | 20 | High server error ratio | The 5xx ratio in the window reaches this value |

**Origin unavailable** has no threshold of its own: it fires when one node reports, within the offline threshold, every origin of the site unavailable. An origin is unavailable on that node when its passive or its active check result (either source) is unhealthy; see [Passive health check](origins-and-cache.en.md#passive-health-check) and [Active health check](origins-and-cache.en.md#active-health-check).

**CC mitigation raised** (`cc_mitigation`) has no threshold of its own: it fires when a node reports that the site left the normal level, at most once per site in 15 minutes (a raise held back fires at the next minute check once the 15 minutes are over, if the site is still above normal), and resolves once no online node reports the site above normal. See [Challenges and CC mitigation](challenges.en.md#cc-mitigation).

Site alerts cover only enabled sites with at least one domain.

### Cluster and DNS alerts

These alerts belong to a cluster, not to a site. They go only to channels with **Receive every alert** and cannot be subscribed to; **Recent events** lists them too.

| Alert | Fires | Resolves |
| --- | --- | --- |
| Configuration canary rolled back | A canary rolled back automatically or was aborted | The next promotion in that cluster |
| No canary node online; configuration published to every node | A publication in a cluster with the canary on found no canary node online | The next publication in that cluster with a canary node online |
| Stored rule no longer valid; its last compiled form is kept | A publication found a stored rule the current validator refuses (see [Rules](rules.en.md)); the name is the rule's | The next publication after the rule is rewritten or deleted |
| DNS mass removal blocked | The [mass removal protection](#mass-removal-protection) held a publication of a cluster back | The cluster's next publication that passes, or a forced one |
| Scheduling rule acting on a node | A [scheduling rule](scheduling.en.md#scheduling-rules) took effect on a node; the name is "rule · node" | The action recovers; at once when the rule is disabled, deleted, or its line, conditions, or action change |

## Subscribe to alerts

1. Open **Alerts** and click **Subscribe** in the **Subscriptions** card.
2. Select **Notification channel**.
3. Turn on **All sites**, or tick sites in the **Sites** list (**Search sites** finds them; ticked sites stay ticked across searches).
4. Turn on the alert kinds to send and click **Save**.
5. Verify: the subscription row shows the channel, the sites (or **All sites**), and the alert kinds; **Recent events** shows these sites' events.

| Item | Behavior |
| --- | --- |
| Channels | One subscription per channel; **Subscribe** lists only enabled channels without a subscription and is unavailable when there is none |
| Sites | **All sites** includes sites created later; otherwise tick at least one site |
| Alert kinds | Node offline, Certificate expiring, Origin unavailable, High server error ratio, CC mitigation raised |
| Changes | Click **Edit** on the subscription row to change its sites, alert kinds, or **Enable**; a subscription with **Enable** off sends nothing and its row shows **Off** |
| Deleted sites | The site leaves the subscription; a subscription left without sites is deleted with it |
| Removal | Click **Unsubscribe** on the subscription row and confirm |
| API | `POST /api/v1/alerts/subscriptions` (`channelId`, `kinds`, `allSites` or `siteIds`) creates the channel's subscription, replacing the one it has; `PUT /api/v1/alerts/subscriptions/{id}` changes it; both return `allSites` and `sites` (`id`, `name`). The former `siteId` field is gone |
| Upgrades | A subscription used to cover one site; on upgrade, the subscriptions of a channel merge into one. If any of them is enabled, the result is enabled with the sites and alert kinds of the enabled ones; if all are paused, it stays paused with all their sites and alert kinds |

## Delivery behavior

| Item | Behavior |
| --- | --- |
| Events | A condition creates one event when it starts and one when it recovers; event IDs are stable |
| Receiving channels | Channels with **Receive every alert** receive every alert; other channels receive only the alerts of the sites their subscription covers, and **Node offline** when the subscription covers any site in the node's cluster (or **All sites**) and includes that kind |
| Retries | After a failure, retries back off 2, 4, 8, and 16 minutes; each channel gets 5 attempts |
| Batches | Checked every minute; at most 200 notifications per check, and deliveries that would start after 40 seconds wait for the next minute |
| Duplicates | A lost receipt can cause duplicate notifications; webhook receivers deduplicate by event ID |
| Checks before delivery | Every delivery rechecks that the channel is enabled, that the event is still the condition's current state, and that the subscription is enabled and still covers the site and the alert kind (except for channels with **Receive every alert**) |
| Outbound policy | Resolves and pins the target IP; refuses special-purpose addresses; webhook-style targets do not follow redirects; internal webhooks or SMTP need their network in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Timeouts and sizes | 10 seconds per delivery; request body up to 32 KiB, response body up to 64 KiB |
| Retention | Alert events are kept for 90 days |
| Sensitive fields | Channel APIs and failure records never return passwords, bot tokens, webhook secrets, or raw provider errors |

## Limits

| Item | Description |
| --- | --- |
| Background jobs | DNS steering sync and alert checks and deliveries run every minute in background jobs, address reachability and scheduling rules every 10 seconds; they need at least one console process with `ROLE=worker` or `ROLE=all`, see [Deployment overview](../deploy/README.en.md) |
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
| "Another cluster's DNS binding uses these names" | Two clusters use the same cluster domain and line names in one zone | Use a different cluster domain or line name |
| "DNS provider is still in use" | A cluster binding still selects the account, or it still owns records | Select another account or switch to Not managed, wait for cleanup, then delete |
| "Turn the cluster's DNS off and wait for its records to be removed" | The cluster to delete is still Automatic or still owns records | Switch to Not managed and wait for cleanup |
| "The DNS provider rejected the credentials" | Wrong, expired, or under-privileged credentials; some providers also require the console's egress IP to be allowed | Check the permissions in [Providers and credentials](#providers-and-credentials), then **Test connection** |
| "The server address is private or special-purpose, or a public address without HTTPS" | The outbound policy refused a self-hosted endpoint | Use HTTPS, or allow the internal range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| **CNAME target** shows **No healthy nodes** | No node in the lines meets the address set conditions | Check node heartbeats, data plane state, and applied revision |
| "This DNS provider has no {line} resolution line" | A binding line uses a resolution line the account's provider does not support | Use **Default**, or an account whose provider supports the line |
| Carrier users get the default line's addresses | The resolver is not on that carrier's network, or no binding line maps to that resolution line | Test with a resolver of that carrier; add a binding line for it |
| Channel shows **Notification delivery failed** | The target refused or timed out, or the outbound policy refused the address | Reproduce with **Send test**; add internal targets to `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| "Notification channel limit reached" | 32 channels exist | Delete unused channels |
| "SMTP is not configured" | An email channel was tested or delivered before the SMTP settings were saved | Fill in and save the **SMTP** card, then **Send test** |
| "Enter a new password when changing the SMTP server or account" | The SMTP destination changed without a password | Enter the password and save |
| "The CA bundle must contain PEM certificates only" | The CA field contains something other than certificates | Paste PEM certificates only |
| **Subscribe** is unavailable | No channel is enabled, or every enabled channel has a subscription | Add or enable a channel; click **Edit** to change an existing subscription |
