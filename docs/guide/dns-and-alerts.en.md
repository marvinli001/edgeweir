# Domains, DNS, and alerts

Domain ownership checks, platform DNS steering records (third-party DNS providers bound per cluster), automatic records in organizations' zones, and alert channels, rules, and subscriptions.

## Concepts

| Term | Definition |
| --- | --- |
| Registrable domain | The first label below a public suffix (including the private section), for example `example.com`, `example.co.uk`, `alice.github.io`. Ownership is checked per registrable domain. |
| Domain ownership | An organization's right to route a registrable domain. Unverified domains stay in the console and are not published to nodes. |
| Provider account | One set of DNS provider credentials and its zone, used by platform DNS. |
| DNS binding | A cluster's platform DNS settings: mode, provider account, cluster domain, TTL, and lines. |
| Cluster domain | The parent domain of a cluster's steering records; it must lie inside the provider account's zone. |
| Line | The A/AAAA records of one node group in platform DNS. |
| DNS revision | A snapshot of a cluster's DNS binding and its records, separate from node configuration revisions. |
| Alert channel | A notification target configured by a platform administrator: email, webhook, DingTalk, WeCom, or Telegram. |

## Verify domain ownership

1. Open **Console → Sites**, select the site, and open the **Domains** tab.
2. In the **Domain ownership** card, click **Create verification record** for a domain marked **Verification required**.
3. Copy the **TXT name** and **TXT value** and add the TXT record at the registrable domain's authoritative DNS:

   ```text
   _edgeweir-verification.example.com.  TXT  "edgeweir=<token>"
   ```

4. Confirm the record resolves:

   ```bash
   dig +short TXT _edgeweir-verification.example.com
   ```

   The output contains `"edgeweir=<token>"`.
5. Click **Verify TXT record**.
6. Verify: the status changes to **Verified**, the console publishes a new configuration revision, and the domains under that registrable domain enter the node configuration.

### Ownership rules

| Item | Behavior |
| --- | --- |
| Scope | One TXT record verifies the whole registrable domain; every host name and wildcard under it across the organization's sites takes effect |
| Uniqueness | On one platform a registrable domain belongs to one organization. Several organizations may hold pending claims; once one verifies, the others can no longer use the root, its subdomains, or wildcards (`DOMAIN_IN_USE`) |
| Platform administrators | When a platform administrator creates a site or saves its domains, unverified registrable domains are marked **Administrator approved**. A platform administrator can also click **Approve without TXT** on an existing pending domain. Both write the audit action `domain.bypass` |
| Revocation | **Revoke verification** stops routing for that registrable domain on all of the organization's sites. A configuration rollback does not restore unverified domains |
| Release | Removing the last site reference to a registrable domain deletes its ownership record |
| Transfer | To move a domain to another organization, a platform administrator revokes the old organization's verification and the new organization completes the TXT check |
| Certificates | An uploaded certificate does not replace domain ownership. ACME requests require every certificate name to be verified, see [HTTPS and certificates](https.en.md) |
| Existing deployments | When the console first enables domain ownership, it withdraws existing routes without proof; complete the TXT check for each domain or have a platform administrator approve it |

### TXT lookups

| Item | Value |
| --- | --- |
| Recursive servers | The servers saved in **Admin → System → Ownership check DNS**; otherwise `EDGEWEIR_DNS_RESOLVERS`, then the system resolver, see [Platform administration](admin.en.md) |
| Single lookup | 2.5-second timeout, at most 2 tries |
| Concurrency | At most 16 verification lookups at a time per console process |
| Rate | At least 5 seconds between two checks of the same registrable domain (`DOMAIN_VERIFY_BUSY`) |
| Resolver choice | Tenants and verification requests cannot choose a resolver |

## Configure platform DNS

Platform DNS writes steering records for each cluster; a site's CNAME target points at the healthy nodes of its cluster. Platform administrators only. Edgeweir does not run an authoritative DNS server; it manages records through each provider's API.

### Add a provider account

1. Open **Admin → Platform DNS** and click **Add provider account**.
2. Fill in **Name**, select **DNS provider**, and fill in the credential fields the form shows (fields and required permissions: [Providers and credentials](#providers-and-credentials)).
3. For providers that can list zones, click **List zones** and pick the **Zone**; otherwise type the **Zone**.
4. Click **Test connection**. Verify: **Connected: N records in the zone** appears.
5. Click **Create**.

An account is one set of credentials and one zone; for several zones under the same credentials, add one account per zone. **Test connection** in the account list reads the zone with the saved credentials. **Edit** renames the account; turn on **Replace credentials** and fill in every field again to rotate secrets. The provider and zone cannot change after creation. Credentials are envelope-encrypted with the master key and are write-only.

### Bind a cluster

1. Open **Admin → Clusters**, select the cluster, and switch to the **DNS** tab.
2. Select **Mode**: **Not managed**, **Manual**, or **Automatic**.
3. Select **Provider account**; **Zone** shows the account's zone. Fill in **Cluster domain** and **TTL (seconds)**.
4. Click **Add line**, fill in **Line name**, and select a **Node group** of this cluster. For a node behind NAT or on a private network, enter its public address in the node's **<node>: target address** field; leave it empty to use the reported public IP.
5. Click **Save**. The console shows **DNS revision N generated**.
6. Verify: the **Current records** card shows **Published**, and the site's **Domains** tab shows the **CNAME target**.

   ```bash
   dig +short CNAME <site UUID>.<cluster domain>
   dig +short A all.<cluster domain>
   ```

   The first prints `all.<cluster domain>.`, the second the addresses of the cluster's healthy nodes.
7. In each site domain's DNS, CNAME the domain to the **CNAME target**.

Clusters may use different provider accounts and cluster domains. The **Cluster bindings** table on **Admin → Platform DNS** lists each cluster's mode, cluster domain, and publication state; **Open** goes to the cluster's **DNS** tab.

### Binding fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Mode | Not managed / Manual / Automatic | Not managed | Automatic: the console writes the provider; Manual: lists the records to create, the console writes no DNS; Not managed: sites have no CNAME target and written records are removed |
| Provider account | An added account | None | Required for Automatic; optional for Manual, in which case the zone is the cluster domain |
| Zone | The account's zone | — | Read-only |
| Cluster domain | A name inside the zone, up to 180 characters | None | Parent of all of the cluster's records; a site's CNAME target is `<site UUID>.<cluster domain>` |
| TTL (seconds) | 30–3600 | 600 | TTL of every record; some providers or plans require a higher minimum, see the provider table |
| Keep per-site line targets | On / Off | Off | Keeps `<line>.<site UUID>.<cluster domain>` for every site, see [Upgrading from the global DNS configuration](#upgrading-from-the-global-dns-configuration) |
| Line name | Lowercase letters, digits, `-`, 1–32 characters, not `all` | `line-N` | First label of the line's host name |
| Node group | A node group of this cluster; at most one line per group | The first unused group | Nodes in the line |
| Target address | Up to 8 IPs per node, comma-separated | Empty (reported public IPs) | Replaces the reported addresses; may be private, not loopback, link-local, multicast, or other special-purpose addresses |

A binding has at most 128 lines and 10000 managed records. Two bindings with the same cluster domain in the same zone cannot share line names or the all-lines record name (`DNS_BINDING_CONFLICT`).

### Generated records

| Name | Type | Content |
| --- | --- | --- |
| `all.<cluster domain>` | A / AAAA | Healthy node addresses of every line of the cluster |
| `<line name>.<cluster domain>` | A / AAAA | Healthy node addresses of the line's node group |
| `<site UUID>.<cluster domain>` | CNAME | `all.<cluster domain>`; one per site with at least one verified domain, also for disabled or suspended sites |
| `<line name>.<site UUID>.<cluster domain>` | CNAME | `<line name>.<cluster domain>`; only with **Keep per-site line targets** |

Address records are written once per cluster: the record count is "sites + cluster addresses", plus "sites × lines" with per-site line targets. With per-site line targets off, the line targets on a site's **Domains** tab are `<line name>.<cluster domain>`.

Lines are explicit node-group host names; provider-specific carrier or geographic resolution is not used.

### Manual mode

The console writes no DNS. The cluster's **DNS** tab lists the records to create (absolute names) and a BIND zone file; **Download** saves it as `<zone>.zone`.

| Item | Behavior |
| --- | --- |
| Addresses | Every enabled node's addresses, regardless of health: manual records do not follow node health |
| Sites | One CNAME per site; a single `*.<cluster domain> CNAME all.<cluster domain>` can replace the per-site records |
| CNAME target | Shown on the site's **Domains** tab as usual, with the state **Manual** |
| Switching modes | From Automatic to Manual, written records stay and the console stops changing them; only **Not managed** removes them |

### Upgrading from the global DNS configuration

Earlier versions had one global platform DNS configuration. On upgrade it becomes one binding per cluster, and tenants change nothing:

- Every cluster's cluster domain is the former CNAME domain, so each site's CNAME target keeps its name and resolves to the same addresses as before.
- A configuration that was on becomes Automatic with **Keep per-site line targets** on, so the line targets tenants were shown, `<line>.<site UUID>.<CNAME domain>`, keep resolving; one that was off becomes Not managed, with account, domain, and lines kept in the form.
- When several clusters share the former CNAME domain, their all-lines records are named `all`, `all-2`, … (clusters with sites first) and each site's CNAME points at its cluster's record.
- The former per-site address records `all.<site UUID>.<CNAME domain>` are removed by the next reconciliation, which deletes only names the console registered.
- If the first publication after the upgrade would leave only CNAMEs and no address records (for example before any node has reconnected), the cluster keeps its previous records and the revision shows **Held back**, as in [Mass removal protection](#mass-removal-protection); it continues once nodes are back, or with **Publish anyway**.
- Earlier DNS revisions stay in the database and are no longer shown.

### Health removal and repair

| Item | Behavior |
| --- | --- |
| Joining the address set | The node is enabled, sent a heartbeat within 45 seconds, reports a healthy data plane, and has applied its cluster's current configuration revision |
| Check interval | A background job recomputes every automatic binding each minute, up to 4 clusters at a time; offline, disabled, or lagging nodes are removed and added back after recovery |
| Failure isolation | Each binding publishes and reconciles on its own; an unavailable provider fails only the DNS revisions of the clusters that use it |
| Propagation | Subject to TTL and resolver caches; not an instant switch |
| Drift repair | Managed names deleted or changed outside the console are restored by the next check; **Repair records** runs one for the cluster immediately |
| Takeover scope | Only names this cluster registered are changed; a new name that already has unmanaged records is refused (`DNS_RECORD_CONFLICT`), as is a name managed by another cluster (`DNS_BINDING_CONFLICT`) |
| Write order | Names are registered first; a name that changes record type loses its old records first; changed address RRsets are replaced as a whole, then CNAMEs, in batches of at most 100 records; records no longer needed are deleted; the result is read back; on failure the registration stays and the next cycle retries |
| TTL | A provider raising the TTL to its own minimum is not drift; after the binding's TTL changes, the next reconciliation rewrites the records with the new TTL |
| Concurrency | One console process at a time reconciles a cluster (a 15-minute lease that expires if the process exits) |
| Configuration canary | Each node is compared with its own target revision: during a canary window, non-canary nodes run the stable revision and are not removed, see [Configuration canary](admin.en.md#configuration-canary) |

A failed DNS revision shows its reason: provider authentication failed, zone not found at the provider, provider unreachable, provider rate limit, a name has unmanaged records, a name belongs to another cluster, server address refused by the outbound policy, and so on.

### Mass removal protection

When a publication would empty a cluster's previously non-empty `all.` or line record set, or remove more address records than the threshold allows, the cluster's previous records stay and nothing is written to the provider. The same applies when the console loses its connection to the nodes and all of them look offline.

| Item | Behavior |
| --- | --- |
| Threshold | Share of the cluster's previous address records one publication may remove; 50% by default, adjustable under **Admin → Platform DNS → Mass removal protection** (5%–100%) for all clusters |
| Not counted | Names no longer managed (deleted sites, removed lines); a change of provider account, cluster domain, or all-lines record name; modes other than Automatic |
| While held | The top of the cluster's **DNS** tab shows the blocked change (address records it would delete); the revision list shows **Held back**, and the **Cluster bindings** table shows the cluster as **Held back**; the platform alert **DNS mass removal blocked** fires for the cluster |
| Recovery | The hold ends when a later publication passes, and the alert resolves |
| Force publish | An administrator clicks **Force publish** on the cluster's **DNS** tab and confirms; the current state is published; audited as `dns.force_publish` |

### DNS revisions and rollback

Each cluster has its own DNS revisions, which do not add node configuration revisions. **Roll back DNS** restores the binding settings of the chosen revision (mode, account, cluster domain, TTL, lines); addresses still follow current routing rights and node health, and nodes that went offline are not restored. Manual-mode revisions are **Published** as soon as they are saved.

Before deleting a provider account, point the clusters that use it at another account or switch them to Not managed and wait for cleanup (the account no longer owns managed records); otherwise the console returns `DNS_PROVIDER_IN_USE`. Likewise, before deleting a cluster, switch its DNS to Not managed and wait for cleanup (`DNS_BINDING_IN_USE`).

### Providers and credentials

Platform DNS accounts and organization DNS credentials (certificate DNS-01 and [automatic records](#write-records-in-your-own-zone)) use the same provider catalog and forms. Give credentials the least permission the zone needs.

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

**Apex**: CNAME flattening or an ALIAS record lets the zone apex (`@`) point at a host name; [automatic records](#write-records-in-your-own-zone) write the apex only in those cases, other providers need the apex set by hand. Provider carrier or regional resolution (offered by Alibaba Cloud, Huawei Cloud, DNSPod, Tencent Cloud, Volcengine, Baidu AI Cloud, West.cn, DNS.LA, Route 53, Google Cloud DNS, Gcore, and Bunny DNS) is not used yet.

Providers not supported:

| Provider | Reason |
| --- | --- |
| Namecheap | The API can only replace all host records with `setHosts`; records missing from the request are deleted, which can remove records written by others |
| Hurricane Electric (dns.he.net) | No record management API, only dynamic updates of records that already exist |
| DNSPod international (the dnspod.com token API) | A different protocol from the China site, with no service guarantee for the legacy API; international accounts use the international site of Tencent Cloud DNSPod (API 3.0) |

### Self-hosted endpoints and the outbound policy

The addresses of PowerDNS, RFC 2136, and Custom HTTP are entered by users, so every connection goes through the outbound address policy:

| Item | Behavior |
| --- | --- |
| Address check | The address actually connected to is checked when the connection opens (DNS rebinding safe); loopback, link-local, private, and other special-purpose addresses are allowed only inside `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Encryption | Public addresses require HTTPS; cleartext HTTP only reaches allowed internal addresses |
| Redirects | Not followed |
| Availability | Platform DNS accounts and organization DNS credentials |

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

## Write records in your own zone

An organization can link its own DNS credential to a zone and turn on **Write records automatically**; the console then writes the ownership TXT and CNAMEs for the organization's site domains in that zone.

1. Open **Console → Certificates** and click **Add DNS credential** (or **Edit** on an existing one).
2. Select the provider, fill in the credentials, click **List zones** and pick the zone (or type it), and click **Test connection**.
3. Turn on **Write records automatically** and click **Create** or **Save**.
4. Add domains in that zone to a site. Verify: the **Write records automatically** card on the site's **Domains** tab shows the records as **Written**; once the ownership TXT resolves, the domain becomes **Verified** by itself.

| Record | Written when |
| --- | --- |
| `_edgeweir-verification.<registrable domain>` TXT `edgeweir=<token>` | The registrable domain is not verified yet; removed after verification. Other TXT values at the name stay |
| `<site domain>` CNAME `<the site's CNAME target>` | The DNS mode of the site's cluster is not Not managed; wildcards are written as `*.<domain>` |
| Zone apex | A CNAME where the provider flattens CNAMEs, an ALIAS where it supports ALIAS; for other providers the card shows **Set the apex by hand** and nothing is written |

| Item | Behavior |
| --- | --- |
| Conflicts | A CNAME cannot share its name with other records: a name that already has any other record is not overwritten; the record shows **Conflict** with those records; after an organization owner or admin clicks **Replace** and confirms, they are deleted and the CNAME is written, audited as `dns_record.overwrite`. If the records at the name change after the confirmation, it has to be confirmed again |
| Existing identical records | A record that existed before and matches exactly shows **Written**; the console never deletes it |
| Removal | Deleting a site or domain, or turning automatic records off, deletes only records the console created (matched by name, type, and value) |
| Drift | A written record deleted outside the console is written again by the next sync |
| Sync | A background job syncs every minute; **Sync** on the card runs it immediately. One sync or certificate DNS-01 challenge runs per credential at a time, in batches of at most 100 records |
| One credential per zone | Only one credential of the organization can have automatic records on for a zone; another is refused with `DNS_AUTO_RECORDS_EXISTS` |
| Target changes | After the cluster domain changes, the CNAME follows the new target |
| Isolation | Records are written only for the organization's own sites; another organization's credential for the same zone never writes this organization's domains |
| Audit | `dns_record.create`, `dns_record.update`, `dns_record.delete`, `dns_record.conflict`, `dns_record.confirm`, `dns_record.overwrite`, with the organization |
| Deleting the credential | Refused with `DNS_CREDENTIAL_IN_USE` while automatic records remain: turn automatic records off and wait for cleanup |

## Configure alert channels

Platform administrators only.

1. Open **Admin → Alert channels** and click **Add channel**.
2. Enter **Name**, select **Channel type**, and fill in the fields for that type (see below).
3. Select **Notification language**.
4. Turn on **Receive alerts for all sites** and **Allow tenant subscriptions** as needed.
5. Click **Create**.
6. Verify: click **Send test**; the target receives a test notification and the channel row does not show **Notification delivery failed**.

Email channels use the server configured in **Admin → System → SMTP**, see [Platform administration](admin.en.md).

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
| Receive alerts for all sites | Off | The channel receives alerts for every site on the platform without subscriptions |
| Allow tenant subscriptions | Off | Tenants can subscribe to the channel on the **Alerts** page |

The platform holds at most 32 channels. When editing a channel, turn on **Replace channel credentials** to re-enter the type and fields; otherwise the stored credentials are kept.

### Webhook payload

The request body is JSON with `id` (event ID), `siteId`, `siteName`, `kind`, `status` (`firing` / `resolved`), `occurredAt`, `text`, and `url` (the site's console link). With a bearer token, the request carries `Authorization: Bearer <token>`. A 2xx response counts as delivered.

## Set alert rules

1. Open **Admin → Alert channels** and change the thresholds in the **Alert rules** card.
2. Click **Save**.

| Field | Values | Default | Alert kind | Condition |
| --- | --- | --- | --- | --- |
| Offline threshold (seconds) | 45–3600 | 90 | Node offline | An enabled node of the site's cluster has not reported for longer than the threshold, or reports an unhealthy data plane |
| Certificate warning (hours) | 1–720 | 72 | Certificate expiring | The site's current certificate expires within the threshold |
| Minimum requests | 1–1000000 | 100 | High server error ratio | Requests in the window reach this value |
| Window (minutes) | 1–60 | 5 | High server error ratio | Time window for the 5xx ratio |
| 5xx threshold (%) | 1–100 | 20 | High server error ratio | The 5xx ratio in the window reaches this value |

**Origin unavailable** has no threshold of its own: it fires when one node reports every origin of the site unhealthy within the offline threshold. Origin state comes from passive health checks, see [Origins and cache](origins-and-cache.en.md#passive-health-check).

Site alerts cover only enabled, unsuspended sites with at least one verified domain.

### Platform alerts

These alerts belong to the platform, not to a site. They go only to channels with "Receive alerts of all sites", cannot be subscribed to, and **Console → Alerts** shows them to platform administrators only.

| Alert | Fires | Resolves |
| --- | --- | --- |
| Configuration canary rolled back | A canary rolled back automatically or an administrator aborted it | The next promotion in that cluster |
| No canary node online; configuration published to every node | A publication in a cluster with the canary on found no canary node online | The next publication in that cluster with a canary node online |
| DNS mass removal blocked | The [mass removal protection](#mass-removal-protection) held back a publication of a cluster; the alert is named after the cluster | The cluster's next publication that passes, or a forced one |

## Subscribe to alerts

1. Open **Console → Alerts** and click **Subscribe**.
2. Find and select the site in **Search sites**, select **Notification channel**, and check the alert kinds.
3. Click **Save**.
4. Verify: the subscription appears in the list; **Recent events** shows the site's events.

Tenants can subscribe only to sites they can see and to channels with **Allow tenant subscriptions**.

## Delivery behavior

| Item | Behavior |
| --- | --- |
| Events | A condition creates one event when it starts and one when it recovers; event IDs are stable |
| Retries | After a failure, retries back off 2, 4, 8, and 16 minutes; each channel gets 5 attempts |
| Duplicates | A lost receipt can cause duplicate notifications; webhook receivers deduplicate by event ID |
| Checks before delivery | Every delivery rechecks the subscriber's organization membership, account status, the organization's two-factor requirement, and channel visibility |
| Outbound policy | Resolves and pins the target IP; refuses special-purpose addresses; webhook-style targets do not follow redirects; internal webhooks or SMTP need their network in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Timeouts and sizes | 10 seconds per delivery; request body up to 32 KiB, response body up to 64 KiB |
| Retention | Alert events are kept for 90 days |
| Sensitive fields | Channel APIs and failure records never return passwords, bot tokens, webhook secrets, or raw provider errors |

## Limits

| Item | Description |
| --- | --- |
| Background jobs | Platform DNS sync, automatic records, and alert checks and deliveries run every minute in background jobs and need at least one console process with `ROLE=worker` or `ROLE=all`, see [Deployment overview](../deploy/README.en.md) |
| Smart resolution | No carrier or geographic resolution from the provider; a line is a node group |
| Authoritative DNS | Edgeweir runs no authoritative DNS; it manages records through provider APIs |
| One operation | Each provider call takes at most 2 minutes |
| Active probing | No active reachability probes; origin state comes only from real traffic |
| Local simulator | **Local simulator** appears only when `EDGEWEIR_DNS_TEST_ENDPOINT` is set and is for testing only |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "TXT record not found" | The record has not propagated, or the recursive server cached an old answer | Check with `dig`; check **Admin → System → Ownership check DNS** |
| "Try verification again shortly" | A repeat check within 5 seconds, or all lookup slots are busy | Retry after a moment |
| "Use a registrable domain" | The name is not below a public suffix, for example a bare public suffix | Use a registrable domain or a subdomain of it |
| "Domain already in use" | Another organization verified the registrable domain | A platform administrator revokes the other organization's verification |
| "CNAME domain is outside the DNS zone" | The cluster domain is not inside the account's zone | Use the zone itself or a subdomain of it |
| "DNS name has an unmanaged record" | The target name already has a manual record | Delete the manual record, then **Repair records** |
| "Another cluster's DNS binding uses these names" | Two clusters use the same cluster domain and line names in one zone | Use a different cluster domain or line name |
| "DNS provider is still in use" | A cluster binding still selects the account, or it still owns records | Select another account or switch to Not managed, wait for cleanup, then delete |
| "Turn the cluster's DNS off and wait for its records to be removed" | The cluster to delete is still Automatic or still owns records | Switch to Not managed and wait for cleanup |
| "The DNS provider rejected the credentials" | Wrong, expired, or under-privileged credentials; some providers also require the console's egress IP to be allowed | Check the permissions in [Providers and credentials](#providers-and-credentials), then **Test connection** |
| "The server address is private or special-purpose, or a public address without HTTPS" | The outbound policy refused a self-hosted endpoint | Use HTTPS, or allow the internal range in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| An automatic record shows **Conflict** | The name already has other records | An organization owner or admin confirms with **Replace**, or fix it by hand and **Sync** |
| "Another DNS credential of the organization already writes records in this zone" | Another credential has automatic records on for the zone | Use that credential, or turn its automatic records off first |
| **CNAME target** shows **No healthy nodes** | No node in the lines meets the address set conditions | Check node heartbeats, data plane state, and applied revision |
| Channel shows **Notification delivery failed** | The target refused or timed out, or the outbound policy refused the address | Reproduce with **Send test**; add internal targets to `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| "Notification channel limit reached" | 32 channels exist | Delete unused channels |
