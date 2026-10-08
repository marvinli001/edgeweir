# Domains and unknown hosts

The four forms of site domains, internationalized domain names, how unknown hosts and requests by node IP are handled, scan protection, and CNAME prefixes.

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
| CNAME prefix | The first label of the CNAME target `<prefix>.<cluster domain>` of a site or L4 application. |

## Domain forms

| Form | Example | Matches | Does not match |
| --- | --- | --- | --- |
| Exact | `shop.example.com` | `shop.example.com` | `www.shop.example.com` |
| `*.` | `*.example.com` | `img.example.com` | `a.img.example.com`, `example.com` |
| `.` | `.example.com` | `img.example.com`, `a.img.example.com` | `example.com` |
| `~pattern` | `~(www\|m)\.example\.com` | `www.example.com`, `m.example.com` | `wwwx.example.com`, `www.example.com.evil` |

- In the input of the site's **Domains** tab, enter one per line or separate them with spaces or commas (commas inside a pattern do not separate), click **Add domain**, then **Save**. The same applies when creating a site.
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
| Repetition | At most two repeating quantifiers (`*`, `+`, `{n,}`, `{n,m}` with m above 1): the console matches patterns with a backtracking engine when it finds a site by Host, and more quantifiers can take seconds on a long host name |
| Not allowed | `"`, `\\`, whitespace, a comma outside `{n,m}` (a Host holds none) |

### Precedence

A Host goes to one site only, found in this order (the first hit wins):

1. An exact domain.
2. A `*.` wildcard (the Host without its leftmost label).
3. A `.` suffix: from the Host without its leftmost label, dropping one more label each time, so the longer suffix matches first.
4. A pattern: by site creation time, within a site in the order its domains were saved, the first pattern that matches.

Example: site A has `.example.com`, site B `.img.example.com`, site C `*.example.com`. `x.example.com` goes to C (`*.` comes before `.`), `a.img.example.com` to B (the longer suffix), `a.b.example.com` to A.

Purges and prefetches find sites by Host as nodes do: among each cluster's enabled sites, with the same precedence; when several clusters serve the host, each one's site is purged; when only a disabled site's domain matches, the console says the site is disabled.

### Limits of suffix and pattern domains

| Item | Behavior |
| --- | --- |
| Launch check | The **Domains** tab and the launch check show **Not checkable**; they do not count towards **DNS pointed N/M** |
| Certificates | Not counted for "The certificate covers every domain". One-click HTTPS asks for `*.a.com` for `.a.com` (DNS-01 only, covering one level); patterns get no name, and a site with patterns only shows "The site has only pattern domains: no name to issue for" |
| HTTP-01 | Answered for exact domains only: hosts matched by a suffix or pattern cannot be issued for by HTTP-01 |
| HTTPS | Handshakes complete only for host names the certificate covers (the same name, or `*.` one label up); other names abort the handshake |
| Bulk redirects | A source's host must be an exact domain or one label below a `*.` domain; hosts only a suffix or pattern matches are refused with `BULK_REDIRECT_HOST_UNKNOWN` |
| HTTPS redirect | **Excluded domains** lists exact and `*.` domains only; Force HTTPS does not redirect suffix or pattern hosts the certificate does not name (their handshake would fail) |
| Ports | A site not bound to the port a request arrived on handles it as an unknown host; in clusters with suffix or pattern domains, such a request may get the server-level settings (HTTP/2, compression, ciphers) of another site on that port whose domain also matches the host |
| Purge paths | A path alone expands to URLs on the exact domains only |

## Unknown hosts and node IP access

1. Open **Clusters & nodes**, pick the cluster and switch to the **Network** tab.
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
- While the default site is disabled, requests handed to it get the unknown host page and the card shows "The default site is disabled: the unknown host page is shown meanwhile"; deleting the default site clears it from the setting.
- When the default site is not bound to the port the request arrived on ([site ports](https.en.md#site-ports)), the unknown host page answers.
- The default site must be an enabled site of this cluster (`DEFAULT_SITE_INVALID`); **Default site's certificate for unknown SNI** needs a default site with a certificate (`DEFAULT_SITE_CERTIFICATE_REQUIRED`).
- With **Hand to the default site**, nodes answer these requests with the default site's HTTP/2, compression and cipher settings.
- Requests handed to the default site keep their Host, and their cache key always holds it (also where the site's cache key leaves the host out): no Host can write into the cache the default site's visitors read. Force HTTPS redirects them only where the default site's certificate names the host.
- **Default site** can be searched by name or domain.

### Scan protection

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Scan protection | On / off | Off | Counts every client's requests to unknown hosts and by node IP |
| Requests in 60 seconds over | 10–10000 | 100 | More than this within 60 seconds of the first request: the next one bans |
| Ban seconds | 60–86400 | 3600 | How long the ban lasts |

- Counted whatever the handling (handing to the default site included), per client IP (IPv4 by address, IPv6 by /64); where the client IP comes from: [client IP](../deploy/nodes.en.md#client-ip).
- The ban is global (scope `platform`): every site of the node answers 403 (`X-Edgeweir-Error: ip-banned`). It is listed under **IP lists & bans → Bans** with the reason "Unknown host scan" and the trigger "Unknown host requests", and shared with the other nodes by the "share automatic bans" setting, see [bans](bans.en.md).
- Addresses of allow entries in platform IP lists and the cluster's trusted proxies are not counted; a global scan ban never covers any cluster's trusted proxies, allow entries or node addresses, and nodes' kernel bans never drop their cluster's trusted proxies; loopback addresses are never banned.
- A client whose ban was lifted is banned again if it keeps scanning.
- Connections aborted during the TLS handshake (unknown SNI) are not counted.

## CNAME prefixes

Once the cluster has [DNS scheduling](dns-and-alerts.en.md), the CNAME target of a site or L4 application is `<CNAME prefix>.<cluster domain>`.

| Object | Prefix |
| --- | --- |
| New sites and L4 applications | 8 random characters: a lowercase letter, then lowercase letters or digits |
| Sites and L4 applications from before the upgrade | Their UUID: their CNAME target does not change |

### Regenerate and customize

1. Open the **CNAME target** card on the site's **Domains** tab, or **CNAME target** on the L4 application's page.
2. Click **Regenerate** and confirm to get a new random prefix, or click **Customize**, fill in **CNAME prefix** and click **Save**.
3. The console shows "CNAME prefix changed". In Automatic mode it publishes a DNS revision of the cluster at once (reason "CNAME prefix of … changed"); in Manual mode it writes no records: create the new name from the records the DNS tab lists.
4. Point the CNAME records of the domains at the new target. The old name is shown struck through with "Resolves until …".

| Rule | Details |
| --- | --- |
| Format | 1–30 lowercase letters, digits or `-`, not starting or ending with `-` (uppercase is lowered) |
| Unique | Unique across all sites and L4 applications; an old prefix of another object still in its transition is taken too |
| Reserved | `all`, `all-<digits>`, and every all-lines record name and line name of the clusters' DNS bindings |
| Conflict | `CNAME_PREFIX_CONFLICT` ("CNAME prefix … is taken or reserved"); a malformed prefix is a validation error |
| Transition | The old prefix keeps resolving for 24 hours: the DNS plan keeps both CNAMEs (and the old name's line targets with **Keep per-site line targets**); afterwards the per-minute DNS job deletes the old name, and in Automatic mode publishes a DNS revision (reason "Replaced CNAME prefixes expired"); in Manual mode delete the old record yourself |
| Names never published | In Automatic mode a prefix never written to the DNS provider (say it collided with a record already in the zone) is not kept when replaced: it leaves the plan at once |
| Taking back | The object can take its old prefix back during the transition: click **Take back** next to the old name, or fill it in under **Customize**; the UUID prefix from before the upgrade can be taken back with **Take back** too |
| Audit | `site.cname_update`, `l4.cname_update` (`from`, `to`) |

Saving a DNS binding whose line name equals a prefix (old prefixes in their transition included) returns `DNS_BINDING_CONFLICT`.

## Node requirements

| Capability | Settings that need it |
| --- | --- |
| `domains-v2` | A site (disabled ones included) has suffix or pattern domains |
| `unknown-host-v1` | The unknown host settings are not the defaults (a handling other than the unknown host page, or scan protection on) |

While an active node of the cluster lacks `domains-v2`, the **Domains** tab and new sites show "Some nodes of the site's cluster do not support suffix and pattern domains yet"; while one lacks `unknown-host-v1`, the **Unknown hosts** card shows "Some nodes of the site's cluster do not support it yet". Service accounts and background tasks get `NODE_CAPABILITY_REQUIRED`. Upgrading nodes: [node upgrades](node-upgrades.en.md).

| Change | How it applies |
| --- | --- |
| Domains, unknown host settings other than the default site, scan protection | Hot update |
| Every pattern domain added or removed (disabled sites' too), the first suffix domain added or the last removed, domains of sites with TLS settings, turning **Hand to the default site** on or off, the default site | nginx reload (`server_name`, `default_server` or the size of the regex cache change); open connections are kept |

## API

| Operation | Method and path |
| --- | --- |
| Read the unknown host settings | `GET /api/v1/clusters/{clusterId}/unknown-hosts` |
| Save the unknown host settings | `PUT /api/v1/clusters/{clusterId}/unknown-hosts` |
| Change a site's CNAME prefix | `PUT /api/v1/sites/{id}/cname-prefix` (`{"prefix": "shop"}`; without `prefix` a new random one) |
| Change an L4 application's CNAME prefix | `PUT /api/v1/l4-apps/{id}/cname-prefix` |

Fields: [API reference](../reference/api.en.md).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Saving domains shows "Invalid domain: …" | A Unicode name UTS #46 refuses, or a pattern with uppercase letters, `"`, whitespace or a comma, more than two repeating quantifiers, or outside the syntax subset | Correct the name; write the letters of patterns in lowercase; enter several domains separately; use fewer `*` or `+` quantifiers, or a suffix domain |
| Force HTTPS does not redirect a suffix or pattern host | The site's certificate does not name the host | Use a certificate that names it |
| `x.a.com` goes to another site | Another site has `x.a.com`, `*.a.com` or a longer suffix | Check the sites' domains against the [precedence](#precedence) |
| HTTPS handshakes fail below a suffix domain | The certificate covers one level (`*.a.com`); deeper host names are not in it | Use a certificate covering the deeper host names that need HTTPS, or exact domains |
| Unknown domains get no response at all | **Unknown domains** is **Close the connection (444)** | Switch to **Unknown host page (404)** |
| A client suddenly gets 403 `ip-banned` | Scan protection banned the address | Lift it under **IP lists & bans → Bans**, or add the address to a platform allow list |
| The old name stopped resolving after a prefix change | The 24-hour transition is over | Point the domains' CNAME records at the new target |
