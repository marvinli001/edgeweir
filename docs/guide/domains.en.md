# Domains and unknown hosts

The Domains tab, domain forms and precedence, internationalized names, DNS checks, unknown hosts and node IP access, scan protection, CNAME prefixes.

## Concepts

| Term | Definition |
| --- | --- |
| Exact domain | `a.com`, `www.a.com`: this host name only. |
| Wildcard domain | `*.a.com`: any host name one label below `a.com` (`x.a.com`), not deeper ones (`y.x.a.com`) and not `a.com` itself. |
| Suffix domain | `.a.com`: host names at any depth below `a.com` (`x.a.com`, `y.x.a.com`), not `a.com` itself. |
| Pattern domain | `~` and a regular expression matched against the whole lowercase Host (without port). |
| Internationalized domain name | A domain with non-ASCII characters (`bücher.example`, `中国.example`), stored and matched as Punycode (`xn--…`). |
| Unknown host | The request's Host belongs to no site of the cluster, or its site is not bound to the port the request arrived on. |
| Node IP access | A request whose Host is an IP address (`203.0.113.5`, `[2001:db8::1]`) or empty. |
| Default site | An enabled site of the cluster that unknown hosts or node IP access can be handed to. |
| CNAME prefix | The first label of the CNAME target `<prefix>.<cluster domain>` of a site or L4 app. |
| Edge addresses | The primary scheduling addresses of the cluster's online active nodes (configured scheduling addresses, else the public addresses the nodes report): the addresses the domains' A / AAAA records should point to. |
| Pointing state | How the console's lookup of a site domain compares with the addresses of the cluster's nodes, see [pointing states](#pointing-states). |

## The Domains tab

Page: **Sites → (site) → Domains** (`/sites/<site ID>?tab=domains`), three cards from top to bottom:

| Card | Content |
| --- | --- |
| **CNAME target** or **Edge addresses** | **CNAME target** when the cluster has [DNS steering](dns.en.md), else **Edge addresses**; below it the [pointing state](#pointing-states) of every domain, see [CNAME target and edge addresses](#cname-target-and-edge-addresses) |
| **Domains** | The site's domain list and the input to add domains |
| **Ports** | The HTTP and HTTPS listener ports the site is bound to, see [site ports](https.en.md#site-ports) |

### Editing domains

1. In the **Domains** card, type one or more domains into the input (separated by spaces or commas; commas inside a pattern do not separate) and press Enter or click **Add domain** to add them to the list. Forms: [domain forms](#domain-forms).
2. Click the delete button (**Remove**) next to a domain to take it off the list; the last domain cannot be removed.
3. Click **Save**. Domains still in the input and not added yet are saved too.

- Saving is `PATCH /api/v1/sites/{id}` (`domains` replaced as a whole): the cluster publishes a new configuration revision (reason "Site {site} updated") and the audit entry "Site updated" is written; the notice "Saved" follows the nodes, see [site enabling](clusters.en.md#site-enabling).
- The browser checks the form before adding a domain to the list and shows "Invalid domain: …" for a malformed one. A domain the list already holds (compared in the stored form: Unicode and Punycode count as the same) is not added again.
- On a site with a certificate, new domains must be covered by one of the site's certificates. When the first certificate is one the console requested with automatic renewal on, it takes the new domains and is reissued ("Certificate … is being reissued for the new domains"); otherwise saving fails with "Certificate domains do not match the site or DNS zone: …" (`CERTIFICATE_DOMAIN_MISMATCH`). See [adding domains to an HTTPS site](https.en.md#adding-domains-to-an-https-site).
- Removed domains also leave the HTTPS **Domains not redirected**.

### CNAME target and edge addresses

| State | Card | Content |
| --- | --- | --- |
| The cluster has a DNS binding (Automatic or Manual mode) | **CNAME target** | `<CNAME prefix>.<cluster domain>` with a copy button; a status badge (table below); with resolution lines in the binding, one row per line: the line name and its target (`<line name>.<CNAME prefix>.<cluster domain>` with **Keep per-site line targets**, else `<line name>.<cluster domain>`); **Regenerate**, **Customize** and the old names in their transition, see [CNAME prefixes](#cname-prefixes) |
| The cluster has no DNS binding | **Edge addresses** | The cluster's edge addresses, each marked `A` or `AAAA`, with copy buttons. "No public address" when online nodes report no public address, "No online nodes" when no node is online |

| **CNAME target** badge | Condition |
| --- | --- |
| **Published** | Automatic mode; the cluster's latest DNS revision is applied at the DNS provider and holds the site's CNAME record |
| **No healthy nodes** | Automatic mode, published, but the cluster's all-lines record holds no A / AAAA record (every node removed by health checks, see [health removal and repair](dns.en.md#health-removal-and-repair)) |
| **Pending** | Automatic mode; the DNS revision is not applied yet, or [mass removal protection](dns.en.md#mass-removal-protection) holds the CNAME record back |
| **Manual** | Manual mode: the console writes no records; create the records listed on the **DNS** tab of **Clusters & nodes**, see [manual mode](dns.en.md#manual-mode) |

- **CNAME target** refreshes every 15 seconds and the pointing states are checked every 30 seconds; **Check again** at the card's top right checks both at once.
- In the **Edge addresses** card each checkable domain also gets a command that bypasses DNS and asks the first edge address directly, for example `curl -sI --resolve www.example.com:443:203.0.113.5 https://www.example.com/`. It uses 443 and `https` when the site's certificate covers the domain, else 80 and `http`; a wildcard domain uses the fixed name `edgeweir-check.<domain>` below it.

### Pointing states

The console looks up the A and AAAA records of every domain with the system DNS resolvers of its host (3 seconds a try, 2 tries) when asked, and compares them with the addresses of the cluster's active nodes (configured scheduling addresses or reported public addresses, backup addresses and offline nodes included):

| State | Meaning | Counted in **DNS pointed** |
| --- | --- | --- |
| **Points here** | Every address it resolves to belongs to an active node of the cluster | Yes (pointed) |
| **Points elsewhere** | At least one address belongs to no active node of the cluster (say it still points to the origin or a former CDN) | Yes (not pointed) |
| **Not resolved** | No A or AAAA record (a name that does not exist included) | Yes (not pointed) |
| **Not checked** | The lookup failed (a timeout or the like), or no node address of the cluster is known | Yes (not pointed, not listed as failing) |
| **Not checkable** | A `.` suffix or pattern domain: it names no single host | No |

- A wildcard domain `*.example.com` is looked up as the fixed name `edgeweir-check.example.com`.
- Behind a CNAME, the addresses the chain finally resolves to must belong to the cluster's nodes as well.
- A resolver's cached answer (also "no such name") holds until its TTL ends: right after a DNS change **Check again** may still show the old result.
- Pointing states are advisory: they do not decide whether nodes serve a domain.

## Domain forms

| Form | Example | Matches | Does not match |
| --- | --- | --- | --- |
| Exact | `shop.example.com` | `shop.example.com` | `www.shop.example.com` |
| `*.` | `*.example.com` | `img.example.com` | `a.img.example.com`, `example.com` |
| `.` | `.example.com` | `img.example.com`, `a.img.example.com` | `example.com` |
| `~pattern` | `~(www\|m)\.example\.com` | `www.example.com`, `m.example.com` | `wwwx.example.com`, `www.example.com.evil` |

- Domains are entered on the site's **Domains** tab (see [editing domains](#editing-domains)) or in the **New site** dialog; when creating a site, one per line or separated by spaces or commas (commas inside a pattern do not separate).
- Host names are case-insensitive and stored in lowercase; a trailing `.`, a port, and the scheme and path of a pasted URL are removed.
- A site has 1–50 domains, at most 10 of them patterns. A name in one form belongs to one site only (`*.a.com` and `.a.com` are different forms and may belong to different sites); a taken one shows "Domain already in use: …" (`DOMAIN_IN_USE`).
- In the list, wildcard, suffix and pattern domains carry the badges **Wildcard**, **All subdomains** and **Pattern**.

### Internationalized domain names

- Unicode domains can be entered as they are. The console converts them to Punycode by UTS #46 (nontransitional processing: `ß` and `ς` stay as they are) and stores that, for example `bücher.example` as `xn--bcher-kva.example`; Punycode can be entered directly too.
- The list and the site list show Unicode, with the Punycode on hover. Only labels in one script (or Latin with Han, kana, Bopomofo or Hangul) are shown in Unicode; labels that mix scripts (say a look-alike with Cyrillic letters among Latin ones) stay in Punycode.
- The site search finds both forms, and part of a Unicode name too (`büch`).
- Names UTS #46 refuses (for example breaking the bidi rules, holding disallowed characters, or labels that start or end with `-` once decoded) show "Invalid domain: …" (`DOMAIN_INVALID`).
- Browsers send the Host in Punycode: patterns match the Punycode form.

### Pattern domains

| Item | Rule |
| --- | --- |
| Match | The whole lowercase Host, as `^(?:pattern)$`: no `^` or `$` needed |
| Syntax | The subset of [the `matches` operator of rule expressions](rules.en.md): printable ASCII, at most 256 characters; `.` matches any one character |
| Letters | Lowercase only (escapes such as `\d`, `\W`, `\x2A` aside): the Host is lowercased |
| Repetition | At most two repeating quantifiers: `*`, `+`, `{n,}` and `{n,m}` with m above 1 (a fixed count `{n}` does not count) |
| Branches | The alternatives of each group (and of the whole pattern) and the optional parts (`?`, `{0,1}`, 2 each) multiply to at most 16; `(a\|b)(c\|d)e?` makes 2 × 2 × 2 = 8 (groups take no quantifier) |
| Not allowed | `"`, `\\`, whitespace, a comma outside `{n,m}` (a Host holds none) |

### Precedence

A Host goes to one site only, found in this order (the first hit wins):

1. An exact domain.
2. A `*.` wildcard (the Host without its leftmost label).
3. A `.` suffix: from the Host without its leftmost label, dropping one more label each time, so the longer suffix matches first.
4. A pattern: by site creation time, within a site in the order its domains were saved, the first pattern that matches.

Example: site A has `.example.com`, site B `.img.example.com`, site C `*.example.com`. `x.example.com` goes to C (`*.` comes before `.`), `a.img.example.com` to B (the longer suffix), `a.b.example.com` to A.

A Host that is an IP address or empty (node IP access) matches exact domains only; a Host longer than 253 characters matches no pattern domain.

Purges find sites by Host as nodes do: among each cluster's enabled sites, with the same precedence; when several clusters serve the host, each one's site is purged. Prefetches and sitemap prefetches go to one cluster only: that of the site the same precedence picks among the sites of every cluster, disabled ones included (say an exact domain in one cluster over a suffix or pattern domain in another). Its nodes fetch from the origin of the site they route the Host to. When only a disabled site's domain matches (for prefetches: in that cluster), the console says the site is disabled.

### Limits of suffix and pattern domains

| Item | Behavior |
| --- | --- |
| Launch check | The **Domains** tab and the launch check show **Not checkable**; they do not count towards **DNS pointed N/M** |
| Certificates | Not counted for "The certificate covers every domain". One-click HTTPS asks for `*.a.com` for `.a.com` (DNS-01 only, covering one level); patterns get no name, and a site with patterns only shows "The site has only pattern domains: no name to issue for" |
| HTTP-01 | Answered for exact domains only: hosts matched by a suffix or pattern cannot be issued for by HTTP-01 |
| HTTPS | Handshakes complete only for host names the certificate covers (the same name, or `*.` one label up); other names abort the handshake |
| Bulk redirects | A source's host must be an exact domain or one label below a `*.` domain; hosts only a suffix or pattern matches are refused with `BULK_REDIRECT_HOST_UNKNOWN` |
| HTTPS redirect | **Domains not redirected** lists exact and `*.` domains only; Force HTTPS does not redirect suffix or pattern hosts the certificate does not name (their handshake would fail) |
| Ports | A site not bound to the port a request arrived on handles it as an unknown host. In a cluster with suffix or pattern domains or a default site, such a request gets the server-level settings (HTTP/2, compression, ciphers) of the default site (when unknown hosts are handed to it and it listens on that port) or the node's defaults; otherwise it may get those of another site on that port whose `*.` domain matches the host |
| Purge paths | A path alone expands to URLs on the exact domains only |

## Unknown hosts and node IP access

1. Open **Clusters & nodes**, pick the cluster and switch to the **Settings** tab.
2. In the **Unknown hosts** card, choose the handling of **Unknown domains** and of **Node IP or no Host**.
3. With **Hand to the default site**, choose an enabled site of this cluster in **Default site**; turn on **Default site's certificate for unknown SNI** if needed.
4. Click **Save**. The console publishes a configuration revision of the cluster (reason "Unknown host settings updated").

| Handling | HTTP | HTTPS |
| --- | --- | --- |
| Unknown host page (404, default) | The platform's "unknown host" error page, `X-Edgeweir-Error: unknown-host` | Unknown SNI aborts the handshake; connections without SNI complete with the node's health certificate, and a Host that is an IP or empty gets 421 |
| Close the connection (444) | Nothing is returned: the connection is closed (`curl` shows `Empty reply from server`) | The same (the handshake still follows the SNI) |
| Hand to the default site | The request is served with the default site's settings (origins, cache, rules), Host unchanged | Unknown SNI aborts the handshake unless **Default site's certificate for unknown SNI** is on, which completes it with the default site's certificate; connections without SNI complete with the health certificate and go to the default site |

- Domains of disabled sites still get the disabled page (503), never the default site; when an enabled site's `*.`, suffix or pattern domain also matches the host, that site serves it.
- A request without a Host (HTTP/1.0) is node IP access, even though the default site takes the listener's default server.
- While the default site is disabled, requests handed to it get the unknown host page and the card shows "Default site disabled; the unknown host page is used"; deleting the default site clears it from the setting.
- When the default site is not bound to the port the request arrived on ([site ports](https.en.md#site-ports)), the unknown host page answers.
- The default site must be an enabled site of this cluster (`DEFAULT_SITE_INVALID`); **Default site's certificate for unknown SNI** needs a default site with a certificate (`DEFAULT_SITE_CERTIFICATE_REQUIRED`).
- With **Hand to the default site**, nodes answer the requests handed to it with the default site's HTTP/2, compression and cipher settings (requests without a Host with the node's defaults).
- Requests handed to the default site keep their Host, and their cache key always holds it (also where the site's cache key leaves the host out): no Host can write into the cache the default site's visitors read.
- With Force HTTPS on the default site, handed requests get 503 while it has no certificate; they are redirected to HTTPS only with **Default site's certificate for unknown SNI** on and a certificate that names the host, and otherwise answered over HTTP.
- **Default site** can be searched by name or domain.

### Scan protection

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Scan protection | On / off | Off | Counts every client's requests to unknown hosts and by node IP |
| Requests in 60 seconds over | 10–10000 | 100 | More than this within 60 seconds of the first request: the next one bans |
| Ban seconds | 60–86400 | 3600 | How long the ban lasts |

- Counted whatever the handling (handing to the default site included), per client IP (IPv4 by address, IPv6 by /64); where the client IP comes from: [client IP](../deploy/nodes.en.md#client-ip).
- Behind a load balancer or proxy, first set **Client IP** to **PROXY protocol**, or to **Trusted proxy header** with the proxies' addresses in **Trusted CIDRs**; otherwise the load balancer's address is counted and banned, and every client behind it is refused.
- The ban is global (scope `platform`): every site of the node answers 403 (`X-Edgeweir-Error: ip-banned`). It is listed under **IP lists & bans → Bans** with the reason "Unknown host scan" and the trigger "Unknown host requests", and shared with the other nodes by the "share automatic bans" setting, see [bans](bans.en.md).
- Addresses of allow entries in platform IP lists and the cluster's trusted proxies are not counted; loopback addresses are never banned; nodes' kernel bans never drop their cluster's trusted proxies.
- A ban that covers another cluster's trusted proxy applies on the node that made it only: it is not shared with other nodes.
- A client whose ban was lifted is banned again if it keeps scanning.
- Connections aborted during the TLS handshake (unknown SNI) are not counted.

## CNAME prefixes

Once the cluster has [DNS steering](dns.en.md), the CNAME target of a site or L4 app is `<CNAME prefix>.<cluster domain>`.

| Object | Prefix |
| --- | --- |
| New sites and L4 apps | 8 random characters: a lowercase letter, then lowercase letters or digits |
| Sites and L4 apps from before the upgrade | Their UUID: their CNAME target does not change |

### Regenerate and customize

1. Open the **CNAME target** card on the site's **Domains** tab, or **CNAME target** on the L4 app's page.
2. Click **Regenerate** and confirm ("Regenerate the CNAME prefix?", "The old name keeps resolving for 24 hours") to get a new random prefix, or click **Customize**, fill in **CNAME prefix** and click **Save**.
3. The console shows "CNAME prefix changed". In Automatic mode it publishes a DNS revision of the cluster at once (reason "CNAME prefix of … changed"); in Manual mode it writes no records: create the new name from the records the DNS tab lists.
4. Point the CNAME records of the domains at the new target. The old name is shown struck through with "Resolves until …".

| Rule | Details |
| --- | --- |
| Format | 1–30 lowercase letters, digits or `-`, not starting or ending with `-` (uppercase is lowered) |
| Unique | Unique across all sites and L4 apps; an old prefix of another object still in its transition is taken too |
| Reserved | `all`, `all-<digits>`, and every all-lines record name and line name of the clusters' DNS bindings |
| Conflict | `CNAME_PREFIX_CONFLICT` ("CNAME prefix … is taken or reserved"); a malformed prefix shows "1–30 lowercase letters, digits or -, not starting or ending with -" under the input, and the API returns a 400 validation error; a UUID is accepted only as the object's own prefix from before the upgrade (its current prefix or an old one in its transition), any other UUID is `CNAME_PREFIX_INVALID` ("Invalid CNAME prefix …") |
| Records already in the zone | In Automatic mode a custom prefix whose `<prefix>.<cluster domain>` (with **Keep per-site line targets** also `<line name>.<prefix>.<cluster domain>`) already holds a record in the DNS provider's zone that the cluster does not manage is `CNAME_PREFIX_CONFLICT` too; not checked when the zone cannot be read within 15 seconds |
| Transition | The old prefix keeps resolving for 24 hours: the DNS plan keeps both CNAMEs (and the old name's line targets with **Keep per-site line targets**); afterwards the per-minute DNS job deletes the old name, and in Automatic mode publishes a DNS revision (reason "Replaced CNAME prefixes expired"); in Manual mode delete the old record yourself |
| Names never published | In Automatic mode a prefix never written to the DNS provider (say the zone could not be read when it was saved, and syncing then failed on a record already there) is not kept when replaced: it leaves the plan at once |
| Taking back | The object can take its old prefix back during the transition: click **Take back** next to the old name, or fill it in under **Customize**; the UUID prefix from before the upgrade can be taken back with **Take back** too |
| Audit | `site.cname_update`, `l4.cname_update` (`from`, `to`) |

Saving a DNS binding whose line name equals a prefix (old prefixes in their transition included) returns `DNS_BINDING_CONFLICT`.

## Node requirements

| Capability | Settings that need it |
| --- | --- |
| `domains-v2` | A site (disabled ones included) has suffix or pattern domains |
| `unknown-host-v1` | The unknown host settings are not the defaults (a handling other than the unknown host page, or scan protection on) |

While an active node of the cluster lacks `domains-v2`, the **Domains** tab and the **New site** dialog show "Some nodes in the cluster do not support suffix and pattern domains"; while one lacks `unknown-host-v1`, the **Unknown hosts** card shows "Some nodes in the cluster do not support it". Service accounts and background tasks get `NODE_CAPABILITY_REQUIRED`. Upgrading nodes: [node upgrades](node-upgrades.en.md).

| Change | How it applies |
| --- | --- |
| Domains, unknown host settings other than the default site, scan protection | Hot update |
| Every pattern domain added or removed (disabled sites' too), the first suffix domain added or the last removed, domains of sites with TLS settings, turning **Hand to the default site** on or off, the default site | nginx reload (`server_name`, `default_server` or the size of the regex cache change); open connections are kept |

## API

| Operation | Method and path |
| --- | --- |
| Change a site's domains | `PATCH /api/v1/sites/{id}` (`{"domains": ["a.com", "*.a.com"]}`, replaced as a whole) |
| Read the CNAME target | `GET /api/v1/sites/{siteId}/cname` (`target`, `mode`, `published`, `healthy`, `lines`, `retired`; `target` is `null` without a DNS binding) |
| Launch check (edge addresses, pointing states, certificate coverage) | `GET /api/v1/sites/{id}/launch` |
| Whether nodes support suffix and pattern domains | `GET /api/v1/sites/{id}/features` (`domainsV2`) |
| Read the unknown host settings | `GET /api/v1/clusters/{clusterId}/unknown-hosts` |
| Save the unknown host settings | `PUT /api/v1/clusters/{clusterId}/unknown-hosts` |
| Change a site's CNAME prefix | `PUT /api/v1/sites/{id}/cname-prefix` (`{"prefix": "shop"}`; without `prefix` a new random one) |
| Change an L4 app's CNAME prefix | `PUT /api/v1/l4-apps/{id}/cname-prefix` |

Fields: [API reference](../reference/api/sites.en.md#sites). A read-only AccessKey can call `GET` only. Service accounts can call only `GET /sites/{siteId}/cname` and `GET /sites/{id}/launch` (`sites:read`).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Saving domains shows "Invalid domain: …" (`DOMAIN_INVALID`) | A Unicode name UTS #46 refuses, or a pattern with uppercase letters, `"`, whitespace or a comma, more than two repeating quantifiers, branches multiplying to more than 16, or outside the syntax subset | Correct the name; write the letters of patterns in lowercase; enter several domains separately; use fewer `*` or `+` quantifiers and `\|` or `?` branches, or a suffix domain |
| Force HTTPS does not redirect a suffix or pattern host | The site's certificate does not name the host | Use a certificate that names it |
| `x.a.com` goes to another site | Another site has `x.a.com`, `*.a.com` or a longer suffix | Check the sites' domains against the [precedence](#precedence) |
| HTTPS handshakes fail below a suffix domain | The certificate covers one level (`*.a.com`); deeper host names are not in it | Use a certificate covering the deeper host names that need HTTPS, or exact domains |
| Unknown domains get no response at all | **Unknown domains** is **Close the connection (444)** | Switch to **Unknown host page (404)** |
| A client suddenly gets 403 `ip-banned` | Scan protection banned the address | Lift it under **IP lists & bans → Bans**, or add the address to a platform allow list |
| The old name stopped resolving after a prefix change | The 24-hour transition is over | Point the domains' CNAME records at the new target |
| Saving domains shows "Domain already in use: …" (`DOMAIN_IN_USE`) | A name in that form already belongs to another site | Remove it from that site, or use another form (`*.a.com` and `.a.com` may belong to different sites) |
| Saving domains shows "Certificate domains do not match the site or DNS zone: …" (`CERTIFICATE_DOMAIN_MISMATCH`) | The site's certificate does not cover the new domains and cannot grow by them (an uploaded certificate, automatic renewal off, a wildcard for an HTTP-01 certificate, a name outside a DNS-01 certificate's zone, or more than 100 names) | Upload or request a certificate covering the new domains first, see [adding domains to an HTTPS site](https.en.md#adding-domains-to-an-https-site) |
| Saving suffix or pattern domains shows "Some nodes in the cluster do not support suffix and pattern domains" | An active node of the cluster lacks `domains-v2` | Upgrade the nodes, see [node upgrades](node-upgrades.en.md) |
| A domain shows **Points elsewhere** | It still resolves to the origin, a former CDN or another address outside the cluster | Point its A / AAAA records at the **Edge addresses**, or its CNAME at the **CNAME target** |
| A domain shows **Not resolved** | It has no A or AAAA record | Add the records; right after adding them, wait for resolver caches to expire and click **Check again** |
| A domain shows **Not checked** | DNS lookups on the console's host time out or fail, or no node address of the cluster is known | Check DNS resolution on the console's host; make sure nodes are online and report public addresses, or configure scheduling addresses |
| **CNAME target** stays **Pending** | The DNS revision could not be applied at the provider, or mass removal protection holds it back | See the DNS revisions on the **DNS** tab of **Clusters & nodes**, see [DNS revisions and rollback](dns.en.md#dns-revisions-and-rollback) |
| **CNAME target** shows **No healthy nodes** | Every node of the cluster is removed by health checks | Check the nodes, see [health removal and repair](dns.en.md#health-removal-and-repair) |
| **Edge addresses** shows "No public address" | Online nodes report no public address and have no scheduling addresses | Configure scheduling addresses for the nodes, see [scheduling addresses and backup IPs](scheduling.en.md#scheduling-addresses-and-backup-ips) |
| Saving the unknown host settings shows "The default site must be an enabled site of this cluster" (`DEFAULT_SITE_INVALID`) | The default site is in another cluster or disabled | Choose an enabled site of this cluster |
| Saving the unknown host settings shows "The default site has no certificate" (`DEFAULT_SITE_CERTIFICATE_REQUIRED`) | **Default site's certificate for unknown SNI** is on and the default site has no certificate | Give the default site a certificate first, or turn the switch off |
