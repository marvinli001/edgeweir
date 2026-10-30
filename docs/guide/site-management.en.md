# Site management

The site list, creating sites, the site page and its Overview tab, stars, tags, batch actions, copying settings, cloning and deleting sites.

## Concepts

| Term | Definition |
| --- | --- |
| Site | A set of domains, origins and settings in one cluster. Every save of a site makes its cluster publish a new configuration revision to the nodes, see [revisions](clusters.en.md#revisions). |
| Site tab | A section of the site page (`/sites/<site ID>`), addressed as `?tab=<tab>`, see [site tabs](#site-tabs). |
| Star | An account's mark on a site. Starred sites come first in the overview's "Sites" card and in the command menu. Not shipped to nodes; no configuration revision. |
| Tag | A group name of a site, 1–32 characters, case-insensitive (`Prod` and `prod` are one tag, shown as first written). A site has at most 10. Tags are used by the console only: nodes never receive them and changing tags publishes no configuration revision. |
| Batch action | Turning on, turning off, purging, adding tags, removing tags, copying settings or deleting the sites selected in the site list, up to 100 sites at once. |
| Copy settings | Writing the chosen parts of a source site's settings to target sites, replacing those settings of the targets. Done once: changing the source later does not change the targets. |
| Part | The unit of copying; see [parts that can be copied](#parts-that-can-be-copied). |
| Clone | A new site with every setting and the origins of a source site, under a new name and domains. Done once. |

## Site list

Page: **Sites** (`/sites`). The "Sites | L4 apps" switch at the left of the filter bar moves between the site list and [L4 apps](l4.en.md) (`/l4`).

| Control | Details |
| --- | --- |
| Search box | Placeholder "Search name, domain or tag", at most 100 characters, searches 300 ms after typing stops. Matches the site name, any domain (with the `*.`, `.` and `~` prefixes; internationalized names in Unicode and Punycode, see [internationalized domain names](domains.en.md#internationalized-domain-names)) or any tag name, in any case |
| "Cluster" | Shown with several clusters; "All clusters" or one cluster |
| "Tags" | Shown when tags exist, see [tags](#tags) |
| "Manage tags" | Shown when tags exist, see [tags](#tags) |
| "New site" | Top right of the page, see [creating a site](#creating-a-site) |

| Column | Content |
| --- | --- |
| "Site" | Selection box, star button, the site name (links to the site page; hovering shows "Created …") and its tags. Clicking a tag lists only the sites with it |
| "Status" | "Active", "Disabled", "Not live yet", "Rolling out N/M" or a canary state, see [site enabling](clusters.en.md#site-enabling); "Over usage limit" in addition while [usage protection](usage-protection.en.md) holds its action |
| "Requests (24h)" | The request trend and total of the last 24 hours, refreshed every 60 seconds. Shown only without a search or filter, on page 1 and with at most 20 sites in all |
| "Domains" | The first domain; the others behind "+N" (listed on hover) |
| "Origins" | The first origin as `scheme://address:port`; the others behind "+N"; hidden on narrow screens |
| "Cluster" | Shown with several clusters |

- Sites are ordered by creation time (oldest first), 20 per page; the headers do not sort.
- While a site is not live everywhere the list refreshes every 5 seconds.
- Without sites the page shows "No sites" and "New site"; a search or filter without results shows "No matching sites" and "Clear filters".
- The search, filters and page are kept in the address (`q`, `cluster`, `tags`, `match`, `page`); `/sites?create=true` opens the "New site" dialog.

## Creating a site

1. On **Sites** click "New site" (or choose "New site" in the command menu).
2. Fill in the form and click "Create".
3. The cluster publishes a new configuration revision (reason "Site {site} created") and the page opens the site's "Overview" tab; the notice "Site created" follows the nodes until "Live on every node", see [site enabling](clusters.en.md#site-enabling).

| Field | Values and limits | Default | Details |
| --- | --- | --- | --- |
| "Name" | 1–100 characters | The first domain (cut at 100 characters) | The site's display name; editable on the "Overview" tab |
| "Cluster" | The console's clusters | The cluster the list is filtered by, else the oldest cluster | Shown only with several clusters. Cannot be changed after creation |
| "Domains" | 1–50, at most 10 of them patterns | None | One per line, or separated by spaces or commas (commas inside a pattern do not separate); forms: [domain forms](domains.en.md#domain-forms). A name in one form belongs to one site only |
| "Origin" | IP or host name | None | Pasting a URL (`https://origin.example.com:8443/app`) or `host:port` fills the port and protocol into their fields |
| "Port" | 1–65535 | 80 (HTTP) / 443 (HTTPS) | The origin's port |
| "Protocol" | HTTP, HTTPS | HTTP | The protocol nodes use towards the origin |
| "Origin Host" | Host name or IP, optionally with a port (IPv6 with a port in brackets), at most 259 characters | Empty ("Same as request") | The `Host` sent to the origin; a malformed value shows "Enter a host name or IP, optionally with a port; IPv6 with a port in brackets" |
| "Caching" | On / off | On | On creates one cache rule; off leaves the site without cache rules |
| "Path prefix" | Starts with `/`, at most 1024 characters, no whitespace | `/` | The path prefix the cache rule matches |
| "TTL (seconds)" | 0–31536000 | 3600 | The cache rule's edge TTL |
| "Respect origin Cache-Control" | On / off | On | On caches by the origin's `Cache-Control`; off overrides it with "TTL (seconds)", see [configure cache rules](origins-and-cache.en.md#configure-cache-rules) |

- A new site listens on 80 and 443, gets a random 8-character CNAME prefix (see [CNAME prefixes](domains.en.md#cname-prefixes)) and has no certificate (see [HTTPS and certificates](https.en.md)).
- Suffix domains `.a.com` and pattern domains need `domains-v2` on every active node of the cluster; otherwise the dialog shows "Some nodes in the cluster do not support suffix and pattern domains".
- Created through the API, a site can also get pool settings, cache settings, content settings, ports and tags (`tags`, at most 10), see the [API reference](../reference/api/sites.en.md#sites).
- The whole path to a live site (nodes, DNS, HTTPS, checks) is in the [quick start](first-site.en.md#3-create-a-site).

## The site page

Page: **Sites → (site)** (`/sites/<site ID>`). The header holds the button back to the list ("All sites") on the left, and the star button and **⋯** on the right. **⋯** is available on every tab:

| Item | Details |
| --- | --- |
| "Copy settings" | Copies this site's settings to other sites, see [copying settings](#copying-settings) |
| "Clone" | Creates a site from this one, see [cloning a site](#cloning-a-site) |
| "Purge cache" | The confirmation lists every domain of the site; confirming creates a whole-site purge task (no configuration revision), shows "Whole-site purge submitted", and "View tasks" opens **Purge & prefetch** (`/purge?site=<site ID>`), see [purge a site's cache](origins-and-cache.en.md#purge-a-sites-cache). A disabled site returns "The site is disabled" (`SITE_DISABLED`) |
| "Delete" | See [deleting a site](#deleting-a-site) |

### Site tabs

| Tab | Address | Content | Documentation |
| --- | --- | --- | --- |
| "Overview" | `/sites/<ID>` | Live requests, launch check, name, status, tags, usage protection | [Overview tab](#overview-tab) |
| "Analytics" | `?tab=analytics` | Requests, traffic, cache hit ratio and other analytics cards | [View analytics](access-logs.en.md#view-analytics) |
| "Domains" | `?tab=domains` | CNAME target or edge addresses, domains, ports | [Domains and unknown hosts](domains.en.md) |
| "Origins" | `?tab=origins` | Origin topology, origin quality, origins, pool settings, request body limit | [Origins and caching](origins-and-cache.en.md#configure-origins) |
| "Cache" | `?tab=cache` | Purge, cache rules, cache key, PURGE method, Cache-Tag, X-Cache, compression, image format conversion, charset | [Origins and caching](origins-and-cache.en.md#configure-cache-rules), [compression](https.en.md#compression), [image format conversion](image-convert.en.md) |
| "HTTPS" | `?tab=https` | Certificates, HTTPS options | [HTTPS and certificates](https.en.md#configure-a-sites-https) |
| "Rules" | `?tab=rules` | Site rules, the largest request body rules read | [Rules, IP lists and GeoIP](rules.en.md#edit-site-rules) |
| "Bulk redirects" | `?tab=redirects` | The redirect table | [Bulk redirects](rules.en.md#bulk-redirects) |
| "Access control" | `?tab=access` | Access authentication, site lists, regions, hotlink protection, user agents, CORS, WebSocket, security headers, encoded path exemptions, IP check | [Access control](access-control.en.md) |
| "Security" | `?tab=security` | Under Attack, challenge settings, CC policy, OWASP CRS | [Challenges and CC mitigation](challenges.en.md), [OWASP CRS](waf.en.md) |
| "Attacks" | `?tab=attacks` | Attack statistics, automatic mitigation, security events | [Attacks and automatic mitigation](attack-dashboard.en.md) |
| "Error pages" | `?tab=errors` | Error pages, maintenance mode | [Error pages](error-pages.en.md) |
| "Logs" | `?tab=logs` | Searching, exporting and configuring access logs | [Access logs](access-logs.en.md) |

The time range of the "Analytics", "Origins" and "Attacks" tabs is kept in `?range=`.

### Overview tab

| Block | Content |
| --- | --- |
| "Live requests" | Requests per second over the last hour, minute by minute, refreshed every 60 seconds; the current minute, still being counted, is left out. Shown only while the site is enabled |
| "Launch check" | See [launch check](#launch-check) |
| "Overview" | "Name" and the rows below |
| "Usage protection" | Below the "Overview" card, see [usage protection](usage-protection.en.md) |

| Row | Details |
| --- | --- |
| "Name" | 1–100 characters, not empty. Change it and click "Save": the cluster publishes a new configuration revision (reason "Site {site} updated") and the audit entry "Site updated" is written |
| "Status" | The site's status and the "Disable" / "Enable" button. Disabling asks "Disable {name}?" ("Nodes stop serving these domains; DNS records stay"); enabling asks "Enable {name}?". When the site changed after the page loaded: "It changed since you loaded it; reload and try again" (`UPDATED_AT_MISMATCH`). Behavior: [site enabling](clusters.en.md#site-enabling) |
| "Domains" | Every domain of the site (internationalized names in Unicode, Punycode on hover); changed on the "Domains" tab |
| "Cluster" | The site's cluster |
| "Tags" | The site's tags and the edit button, see [tags](#tags) |
| "Updated" | When the site was last changed |

### Launch check

The "Launch check" card checks every 30 seconds; "Check again" at its top right checks at once. Each row links to the page that fixes it.

| Row | States | Link |
| --- | --- | --- |
| DNS | "DNS pointed {ok}/{total}": of the checkable domains, how many resolve to the cluster's nodes, with the unresolved ones and those pointing elsewhere on the right; "Not checkable" when the site has only suffix and pattern domains. Rules: [pointing states](domains.en.md#pointing-states) | "Domains" tab |
| Certificate | "No certificate", "Certificate covers every domain", "Certificate misses domains" (the missing domains on the right), "Certificate being issued", "Certificate issuance failed" (the reason on the right), "Certificate expired". Suffix and pattern domains are not counted | "HTTPS" tab |
| Nodes | "Live on {current}/{total} nodes"; "Disabled" for a disabled site, "No online nodes" when the cluster has none; during a canary "Canary, all nodes at {time}" or "Canary, awaiting promotion" on the right | **Clusters & nodes** |

## Stars

- Click the star button in the "Site" column of the site list or in the site page's header ("Star" / "Unstar").
- Stars are kept per account. The overview's "Sites" card lists starred sites first (most recently starred first), then the others; the command menu (⌘K / Ctrl+K) lists starred sites first before anything is typed, then recently opened sites.

## Tags

- **Add or change**: open **Sites → (site) → Overview**, click the edit button on the "Tags" row, type a name and press Enter (or a comma; a pasted comma-separated list adds several at once), then click "Save"; the console shows "Tags saved". Existing tags are suggested while typing and keep their spelling. A name over 32 characters shows "A tag is 1–32 characters", an eleventh tag "At most 10 tags". Sites created through the API and clones can get tags too.
- **Filter**: in the **Sites** list click "Tags" in the filter bar, tick one or more tags (at most 10; each shows its number of sites) and choose "Any of them" or "All of them". Clicking a tag next to a site's name shows the sites with that tag. The search box also finds sites by tag name.
- **In the command menu**: press ⌘K (Ctrl+K on Windows and Linux), type a tag name and choose "Tag: …" to open the list filtered by it.
- **Rename and delete**: click "Manage tags" in the filter bar. Renaming a tag to the name of another tag (in any case) merges the two. Deleting asks 'Delete tag "{name}"?' ("Removed from N sites") and takes the tag off every site. A tag no site uses stays listed until deleted.
- Tag changes write the audit entries "Site tags changed" (one per changed site), "Tag renamed" and "Tag deleted"; no configuration revision is published.

## Batch actions

1. Tick sites in the **Sites** list (the box in the header selects the whole page). The selection stays across pages; changing the search or a filter clears it. At most 100 sites can be selected; at the limit the bar shows "At most 100".
2. Choose an action in the bar at the bottom of the page ("N selected"): "Enable", "Disable" and "Purge cache" sit in the bar, "Add tags", "Remove tags", "Copy settings" and "Delete" under "More". "Clear selection" empties the selection.

| Action | Confirmation | Effect |
| --- | --- | --- |
| Enable / Disable | "Enable N sites?" / "Disable N sites?", listing the selected sites | Sites already in that state stay as they are. Each site whose state changes gets an audit entry (the same as enabling or disabling one site); each cluster publishes one new revision, reason "N sites enabled" or "N sites disabled" (the site's own reason when only one site of the cluster changes). The notice "N sites enabled" / "N sites disabled" counts the sites that changed |
| Purge cache | "Purge all cached content of N sites?" | Creates one whole-site purge task for the selected sites; see each node's result under **Purge & prefetch**. If a selected site is disabled the whole action fails ("The site is disabled") |
| Add tags / Remove tags | "Add tags to N sites" / "Remove tags from N sites", with the tags to enter | Adds or removes tags on the selected sites (at most 10 names per action). If a site would get more than 10 tags the whole action fails ("Site {site} can have at most 10 tags"). No configuration revision |
| Copy settings | Choose the source site and the parts | See [copying settings](#copying-settings) |
| Delete | "Delete N sites?", and the number of selected sites typed into "Type N to delete" | Each site gets an audit entry; each cluster publishes once (reason "N sites deleted"). Otherwise as [deleting a site](#deleting-a-site) |

Enabling, disabling, tags and deleting complete for every site or change none (for example when one of the selected sites has been deleted meanwhile, `SITE_NOT_FOUND`).

## Copying settings

1. Click "Copy settings" under **⋯** in the site page's header and choose the "Target sites"; or select the target sites in the site list, click "Copy settings" under "More" in the bar and choose the "Source site".
2. Tick the parts to copy under "Settings to copy" ("Select all" / "Select none") and click "Preview".
3. The preview lists, for each target, how each part changes (list parts show "{before} → {after} items", other parts "N settings change", unchanged parts "No change"), and the targets that would fail with the reason. Previewing saves nothing.
4. Click "Copy to N sites". The console shows "Copied to N sites, M failed"; the result lists the parts each site got, or why it failed.

- 1–100 target sites, not including the source.
- Each target is saved on its own: a target that fails keeps its settings, the others are copied.
- Each target copied publishes a new revision of its cluster (reason "Settings of {source} copied to {site}"; none when the content does not change) and gets the audit entry "Site settings copied" with the source, the parts and the parts that actually changed.
- A copied part replaces that part of the target as a whole: for example the target's own site rules are all replaced by the source's.

### Parts that can be copied

| Part | Copied | Not copied |
| --- | --- | --- |
| Cache rules | Every cache rule | |
| Cache key and slicing | The cache key (query parameters, headers, cookies, device type, host) and Range slicing | |
| Cache-Tag | Whether the origin's Cache-Tag response header reaches visitors | |
| Compression | gzip, Brotli and Zstandard switches, levels, minimum lengths, types and the largest compressed length | |
| HTTPS options (no certificates) | Force HTTPS, HSTS, minimum TLS version, cipher profile, HTTP/2, HTTP/3, OCSP stapling, redirect status and port, client certificates | Certificates, the domains left out of the redirect |
| Site rules | Every rule of the site (all phases) and the largest request body rules read | |
| Bulk redirects | The whole redirect table | |
| Error pages | The error page of each status and "Replace origin error responses" | Maintenance mode |
| OWASP CRS | Mode, paranoia level, anomaly threshold, request body limit and exclusions | |
| CC and challenges | Under Attack, challenge type, pass lifetime, proof-of-work difficulty, CC policy, verified crawlers, challenge page texts, challenge failure bans | Under Attack turned on by automatic mitigation (copied as off) |
| Access control | Site lists, hotlink protection, user agents, CORS, regions, WebSocket origins, security headers, encoded path exemptions | |
| Access authentication | Every authentication rule; password hashes and signing keys are encrypted again for the target | |
| Origin pool settings (no origins) | Load balancing, timeouts, keep-alive, origin protocol, gRPC, active health checks, session affinity, retries, WebSocket | The origins |
| Log settings | The access log sample rate, logging blocked requests, the query string, request headers, the peer address and JA4 | |
| Image format conversion | On or off, formats and qualities, source types, the size range and the most pixels | |
| Markdown for Agents | On or off, include and exclude path prefixes | |

Domains, origins, certificates, ports, X-Cache, the PURGE method and key, charset, the request body limit, maintenance mode, development mode, usage protection, automatic mitigation and tags belong to no part and are never copied.

### Why a copy fails

A target that lacks something the settings use fails:

| Message | Error code | What to do |
| --- | --- | --- |
| Rule "…" chooses origin group …, which the site does not have | `ORIGIN_GROUP_UNKNOWN` | Add an origin group of that name on the target's "Origins" tab first |
| The HTTPS redirect, HSTS and client certificates need a certificate on the site | `HTTPS_REQUIRES_CERTIFICATE` | The target has no certificate: give it one, or leave out "HTTPS options" |
| The site does not serve … / The site has no domain … | `BULK_REDIRECT_HOST_UNKNOWN` / `AUTH_DOMAIN_UNKNOWN` | A bulk redirect source (`domain/path`) or an access authentication rule's domains name a domain the target does not have |
| Redirect port … is not an HTTPS port of the site | `HTTPS_REDIRECT_PORT_INVALID` | Add the port to the target, or use 443 on the source |
| IP list not found | `IP_LIST_NOT_FOUND` | An IP list the settings use was deleted during the copy |

## Cloning a site

1. Click "Clone" under **⋯** in the site page's header; "Clone {name}" opens (note: "Certificates are not copied").
2. Enter the "Name" (empty: the first domain) and the "Domains" (required, the rules of [creating a site](#creating-a-site)), change the "Tags" if needed (the source's by default) and click "Clone".
3. The console shows "Site cloned" and opens the new site.

| Item | New site |
| --- | --- |
| Cluster | The source's |
| Taken from the source | The origins (S3 credentials encrypted again for it), every [part that can be copied](#parts-that-can-be-copied), X-Cache, the PURGE method and key (encrypted again), charset, the request body limit and maintenance mode |
| Certificates | Not copied (they cover the source's domains); force HTTPS, HSTS and client certificates are off, no domains are left out of the redirect |
| Ports | The source's HTTP ports (80 when the source has none); 443 as HTTPS port when the source has 443, otherwise none |
| Development mode | Off |
| CNAME prefix | A new random prefix |
| Revision and audit | Its cluster publishes a new revision (reason "Site {site} cloned from {source}"); audit entry "Site cloned" |

If the source's access authentication domains or bulk redirect sources name a domain the new site does not have (such as the source's domains), or an IP list the settings use does not exist, the clone fails with the reason (`AUTH_DOMAIN_UNKNOWN`, `BULK_REDIRECT_HOST_UNKNOWN`, `IP_LIST_NOT_FOUND`) and no site is created.

## Deleting a site

1. Click "Delete" under **⋯** in the site page's header.
2. Confirm "Delete {name}?". The console shows "Deleted, revision #N" and returns to the site list.

- The cluster publishes a new configuration revision (reason "Site {site} deleted") and the audit entry "Site deleted" is written; nodes stop serving the site's domains.
- The site's statistics, its access logs stored in PostgreSQL, its site-scope bans and its usage protection are deleted with it; alert subscriptions that named only this site are deleted too.
- When the site is the cluster's [default site](domains.en.md#unknown-hosts-and-node-ip-access), the default site is cleared from the setting.
- Certificates are not deleted with the site; manage them on the **Certificates** page.
- Deleting cannot be undone. Deleting several sites: [batch actions](#batch-actions).

## API

| Action | Endpoint |
| --- | --- |
| List sites (search, cluster, tags, pages) | `GET /api/v1/sites?search=&clusterId=&tagIds[]=<id>&tagMatch=all&page=&pageSize=` (`pageSize` 1–100, default 20) |
| Read a site | `GET /api/v1/sites/{id}` |
| Create a site | `POST /api/v1/sites` (201) |
| Change a site (name, domains, origins, caching…) | `PATCH /api/v1/sites/{id}` |
| Delete a site | `DELETE /api/v1/sites/{id}` |
| Enable / disable | `PUT /api/v1/sites/{id}/enabled` |
| Launch check | `GET /api/v1/sites/{id}/launch` |
| Whole-site purge | `POST /api/v1/sites/{id}/purge` |
| List stars, set a star | `GET /api/v1/starred-sites`, `PUT /api/v1/sites/{id}/starred` (`{"starred": true}`) |
| Set a site's tags | `PUT /api/v1/sites/{id}/tags` |
| List, rename, delete tags | `GET /api/v1/site-tags`, `PATCH /api/v1/site-tags/{id}`, `DELETE /api/v1/site-tags/{id}` |
| Batch on/off, tags, delete | `POST /api/v1/sites/batch/enabled`, `/batch/tags`, `/batch/delete` |
| Batch purge | `POST /api/v1/cache-tasks` (`{"type": "site", "siteIds": [...]}`) |
| Preview and copy | `GET`, `POST /api/v1/sites/{id}/copy-settings` |
| Clone | `POST /api/v1/sites/{id}/clone` (201) |

Fields and error codes are in the [API reference](../reference/api/sites.en.md#site-tags-and-batch-operations). A read-only AccessKey can call `GET` only. Service accounts can call only `GET /sites`, `GET /sites/{id}`, `GET /sites/{id}/launch` (`sites:read`) and `PUT /sites/{id}/enabled` (`sites:write`), see [service accounts](system.en.md#service-accounts).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Saving shows "Domain already in use: …" (`DOMAIN_IN_USE`) | A name in that form already belongs to another site | Remove the domain from the other site, or use another form, see [precedence](domains.en.md#precedence) |
| Creating shows "This cluster has reached its limit of 512 published sites" (`CLUSTER_SITE_LIMIT`) | The cluster publishes 512 enabled sites already | Disable or delete sites, or create the site in another cluster |
| Creating shows "Enter a host name or IP, optionally with a port; IPv6 with a port in brackets" | "Origin Host" is malformed | Enter a host name or IP, or leave it empty to keep the request's |
| The origin shows "Origin address … is in the special-purpose range …" (`ORIGIN_ADDRESS_FORBIDDEN`) | The origin is a private, loopback or other special-purpose address | Use a public address, or add the range to the origin allow list in the system settings, see [origin address restrictions](origins-and-cache.en.md#origin-address-restrictions) |
| Enabling or disabling shows "It changed since you loaded it; reload and try again" (`UPDATED_AT_MISMATCH`) | The site changed after the page was opened | Reload the page and try again |
| The "Requests (24h)" column is missing | A search or filter is set, the page is not page 1, or there are more than 20 sites | See the site's "Analytics" tab |
| A batch purge shows "The site is disabled" (`SITE_DISABLED`) | A selected site is disabled | Deselect the disabled sites |
| Adding tags shows "Site {site} can have at most 10 tags" (`SITE_TAG_LIMIT`) | The site would get more than 10 tags | Remove some of that site's tags first, or deselect it |
| Copying settings fails on some sites | A target lacks something the settings use | See [why a copy fails](#why-a-copy-fails) |
| The DNS row of the launch check is not complete | Domains are unresolved or resolve to addresses outside the cluster's nodes | See [pointing states](domains.en.md#pointing-states) |
| The site stays "Not live yet" | The cluster has no online node, or no node has applied a revision with the site | See [site enabling](clusters.en.md#site-enabling) and [nodes](clusters.en.md#nodes) |
