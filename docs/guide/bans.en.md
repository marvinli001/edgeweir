# Bans

Block or restrict clients by IP address or CIDR for a limited time: manual, automatic and rule bans, the greylist, kernel bans and connection limits.

## Concepts

| Term | Definition |
| --- | --- |
| Ban | An IP address or CIDR whose requests are refused (403) until it expires. Sent over the node channel directly, applied within seconds, no configuration revision. |
| Scope | "Site": one site only. "Global": every site of every cluster, also dropped in the kernel by the nodes (see [Kernel bans](#kernel-bans)). In the API these are `site` and `platform`. |
| Source | "Manual": created on the **Bans** tab or through the API. "Automatic": created by a node on a trigger and reported to the console. "Rule": created by a node running a rule's **Ban** action or a rate limit's **Ban when exceeded**, and reported. |
| Greylist | Requests are challenged or rate-limited instead of refused until the entry expires, see [Greylist](#greylist). |
| Expiry | 1 minute to 7 days. Block for longer with [IP lists](rules.en.md#ip-lists). |

Pages: sidebar **Access control → IP lists & bans**; the "IP lists | Bans | Greylist" switch at the top leads to `/ip-lists`, `/bans` and `/greylist`. Settings are the "Bans" and "Connection limits" cards of **Access control → Protection settings** (`/protection`).

## Ban an address

1. Open **IP lists & bans → Bans** and click "New ban".
2. Pick the "Scope": "Site" (default) or "Global".
3. For a site ban, pick the site under "Site"; with many sites, type a name or domain into "Search sites" first.
4. Fill in "IP or CIDR", e.g. `203.0.113.7` or `198.51.100.0/24`.
5. Pick a "Reason" (default "Abuse") and a "Duration" (1 h, 6 h, 1 d (default), 3 d, 7 d) and click "Ban".
6. Verify: request the site from the banned address:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/
   ```

   The response is 403 with `X-Edgeweir-Error: ip-banned`. With a site ban, other sites still answer the same address.

The toast after a ban links to the list ("View bans"). Unban: click "Unban" in the row and confirm; the nodes drop the ban within seconds. Manual, automatic and rule bans can all be lifted.

The list shows active bans only (neither expired nor lifted), newest first, 50 per page, refreshed every 30 seconds; it filters by scope, site and source:

| Column | Content |
| --- | --- |
| Address | Canonical CIDR; "Not applied on N nodes" when online nodes could not hold the ban |
| Site | Site name; "Global" for global bans |
| Reason | Why the address is banned |
| Source | "Manual" and the operator; "Automatic" and the node and trigger (metric, observed / threshold, window in seconds); "Rule" and the rule's name (global rules marked "(global)", "Deleted rule" once it is deleted, the rule id on hover) and the node, with the trigger for rate limits; automatic and rule bans not sent to other nodes are marked "Not shared" |
| Expires | A status light and the time left; hover for the expiry time. A ban that expired since the list was last refreshed shows "Expired" |

When a cluster's [client IP](../deploy/nodes.en.md#client-ip) is not "Direct", the list shows "Clusters {clusters} take client addresses from proxies: kernel bans match the TCP peer only", see [Load balancers in front of the nodes](#load-balancers-in-front-of-the-nodes).

### Ban from other pages

| Entry | Result |
| --- | --- |
| A site's "Logs" tab, row **⋯** → "Ban IP" | The ban dialog with the site and address filled in |
| "Top IPs (approximate)" of the analytics, row **⋯** → "Ban IP" | On a site's "Analytics" tab the site and address; on **Overview** "Global" and the address |
| A site's "Attacks" tab, "Top addresses and paths", address row **⋯** → "Ban IP" | The site and address |
| A site's "Attacks" tab, "Events", automatic ban row **⋯** → "Ban on all sites" | "Global" and the address |
| A site's "Attacks" tab, "Events", automatic ban row **⋯** → "Unban" | After confirmation, lifts the site's bans of exactly that address (a covering range stays); "This address has no active ban" when there is none |
| ⌘K / Ctrl+K → "Ban an IP…" | The ban dialog; on a site's pages with the site filled in |
| `/bans?site=<site ID>&ip=<address>` | The dialog with the site and address; the list shows only that site's bans overlapping the address, × beside the address clears it |

The "Scope" can be changed in the dialog every time.

## Rules

| Item | Behavior |
| --- | --- |
| Address | IPv4 / IPv6 address or CIDR, at most 64 characters; a single address means `/32` or `/128`; host bits are cleared, IPv6 is lowercased and compressed; `::ffff:a.b.c.d` counts as the IPv4 address; leading zeros and zone IDs are refused |
| Shortest prefix | IPv4 `/16`, IPv6 `/48` |
| Expiry | 60–604800 seconds (the UI offers 1 hour to 7 days); nodes drop a ban when it expires, and every 10 minutes the console deletes bans that expired more than an hour ago |
| Reason | Manual: "Abuse", "Attack", "Scanning", "Spam", "Other"; automatic: "Per-IP request rate", "Unknown host scan", "Too many failed challenges"; rule: "Banned by a rule", "Over a rate limit" |
| Banning again | One active manual ban per address for global bans, and per site and address for site bans; banning it again sets the new reason and expiry and does not add a ban. A manual global ban of the same CIDR as an active automatic or rule global ban takes it over, counted, audited and sent to every node as a new ban; if that global ban was not shared it is lifted (each node deletes its own) and the manual ban is a new entry |
| Protected addresses | A site ban may not cover an address of a node in the site's cluster, a global ban no node address at all; neither may cover loopback (`127.0.0.0/8`, `::1`) or unspecified addresses (`0.0.0.0/8`, `::`), nor overlap a global allow list |
| Where it applies | At the edge layer once the site is known, before rules: global bans first, then site bans. Addresses on a global allow list and the cluster's trusted proxies are never banned; addresses on a site's [allow lists](access-control.en.md#site-lists) are not banned on that site (CC bans of single clients included), global bans still apply |
| Delivery | No configuration revision, no configuration canary, no reload on the nodes |
| Audit | `ban.create`, `ban.update` (banned again), `ban.delete`; automatic and rule bans are not audited when they are made |

## Limits

| Limit | Counts | Where |
| --- | --- | --- |
| Limit of manual bans | Active manual bans and greylist entries, global and site scope together | **Protection settings → Bans → Limit of manual bans**; 10000 by default, 100–100000 |
| Automatic bans | Active site-scope automatic and rule bans per cluster; global automatic and rule bans count separately | 10000 each, fixed; the oldest lapse first |

Automatic and rule bans do not count toward the limit of manual bans. Once the limit is reached, a new ban or greylist entry gets 409 `BAN_PLATFORM_LIMIT` ("At most N manual bans can be active"); banning an address again while its manual ban is active, or greylisting it again while its entry is active, is not limited. Changing the settings is audited as `system.bans_update`.

## Automatic bans

A node bans on its own on a trigger:

| Trigger | Scope | Reason | Notes |
| --- | --- | --- | --- |
| "Per-IP QPS" of CC mitigation | Site | "Per-IP request rate" | See [Challenges and CC mitigation](challenges.en.md#cc-mitigation) |
| The cluster's scan protection | Global | "Unknown host scan" | See [Scan protection](domains.en.md#scan-protection); needs `unknown-host-v1` |
| Challenge failure bans | Site | "Too many failed challenges" | An address fails the site's challenges the set number of times within 10 minutes, see [Challenge failure bans](challenges.en.md#challenge-failure-bans); needs `challenge-v2` |

A single IPv4 address, or the IPv6 `/64`; loopback addresses are never banned. The ban applies on that node at once and is reported to the console in batches every 5 seconds.

| Item | Behavior |
| --- | --- |
| Sharing | **Protection settings → Bans → Share automatic bans in the cluster**, on by default: on, a site-scope ban goes to every node of the cluster and a global one to every node; off, it is kept for viewing only and marked "Not shared". A change applies to bans added afterwards |
| Merging | Site scope: one entry per node, site, address and source; global scope: one entry per address (none while an active manual global ban holds it, which stays as it is); a repeated report only extends the expiry |
| Checks | A site-scope ban's site must belong to the node's cluster; global ones come from scan protection and global rules' **Ban** action only; a single IPv4 address or an IPv6 `/64` only (`/128` from older nodes); at most 7 days after creation; a site-scope ban covering a protected address (the addresses of the cluster's nodes, the global allow lists) is not stored |
| Protected addresses, global scope | A ban covering an address of another cluster's node or any cluster's trusted proxy is stored but never shared: listed as "Not shared" and liftable. One covering an address of a node of the reporting node's cluster or a global allow list is stored as lifted, not listed, and the nodes of that cluster delete their own bans of it within seconds; other clusters' nodes keep theirs |
| Unban | Like a manual ban: click "Unban" in the row; a ban that was not shared is deleted within seconds by the nodes that hold it (older nodes without support keep it until it expires). A global scan ban goes to every node with scan protection, as several may have banned the address, and each node deletes its own bans expiring no later than the unban plus the longest scan ban time its cluster has had; a ban of the same address a node makes after it got the unban is not affected. After a site-scope ban is lifted the nodes count the client afresh: it is banned again when it exceeds the threshold again |

## Rule bans

A rule's **Ban** action and a rate limit's **Ban when exceeded** are written and reported by the node through the same channel as automatic bans; the list shows source "Rule" with the rule's name. See [WAF actions](rules.en.md#waf-actions). Needs the node capability `waf-v2`.

| Item | Behavior |
| --- | --- |
| Scope | **Ban**: site scope from site rules; global rules choose site or global scope. **Ban when exceeded**: site scope |
| Prefix | **Ban**: IPv4 /16–/32 (default /32), IPv6 /48–/64 (default /64); **Ban when exceeded**: IPv4 /32, IPv6 /64 |
| Duration | **Ban** 60–604800 seconds (default 3600); **Ban when exceeded** 60–86400 seconds, 0 is off |
| Not written twice | A node writes nothing while the network has an active ban (of any source); banned requests are refused before the rules run |
| Never written | Addresses on global allow lists, the cluster's trusted proxies and the node's own prefetches; site-scope bans are not written for addresses on the site's allow lists |
| Merging | Site scope: one rule ban per node, site and network (kept apart from an automatic ban of the same address); global scope: one per network; a repeated report only extends the expiry |
| Checks | The rule must exist: global bans come from global rules, site bans from the site's rules or global rules; a rule deleted before the report drops its bans (the node's own ban expires as usual) |
| Sharing and unban | As for automatic bans; they count toward the 10000 automatic bans, not toward the limit of manual bans; not audited |

## Greylist

Greylisted addresses are not refused: they are challenged or rate-limited until the entry expires. Entries travel with the bans over the node channel, apply within seconds and make no configuration revision (except for challenge keys, see below).

1. Open **IP lists & bans → Greylist** and click "Add to greylist".
2. Pick the "Scope" ("Site" or "Global"); for a site entry, pick the site.
3. Fill in "IP or CIDR".
4. Pick the "Action":
   - "Challenge" (default): pick the "Challenge" ("Cookie redirect", "JavaScript" (default), "Non-interactive challenge", "Interactive challenge"). Requests without a pass of that level get the challenge first.
   - "Rate limit": fill in "Requests" (default 60) and "Window (seconds)" (default 60). Each client (an IPv4 address, the IPv6 `/64`) may send that many requests per window on each node; above it the node answers 429 with `Retry-After` and `X-Edgeweir-Error: ip-greylisted`.
5. Pick the "Reason" and "Duration" and click "Add".

The list has the columns "Address", "Site", "Action", "Reason" and "Expires" and filters by scope and site. To lift an entry, click "Remove" in its row and confirm. The link `/greylist?ip=<address>` lists only the entries that overlap the address.

| Item | Behavior |
| --- | --- |
| Address, expiry, reason | As for manual bans: prefixes from IPv4 `/16` and IPv6 `/48`, 1 minute to 7 days, the manual ban reasons, the same protected addresses |
| Rate limit bounds | 1–100000 requests per 1–3600 seconds |
| Adding again | One active entry per scope, site and address; adding it again sets the new action, reason and expiry |
| Bans | An address can have a ban and a greylist entry at once; while both last the ban wins. Removing the greylist entry leaves the ban |
| Order | Entries are looked up after the bans; the rate limit runs after the rules, whose own outcome comes first; a challenge merges with Under Attack, CC and rule challenges at the highest level. Verified crawlers skip Under Attack and CC challenges but not greylist challenges |
| Exemptions | Addresses on global allow lists and the cluster's trusted proxies are exempt from every entry; HTTP-01 validation requests are exempt. A rule's **Allow** exempts from challenges and rate limits; a skip of challenges exempts from challenges; a skip of rate limits exempts from the rate limits of entries of its scope. Addresses on a site's allow lists are exempt from that site's site-scope entries and from the challenges of global entries, not from their rate limits |
| Kernel | Greylist entries are never written to nftables |
| Challenge keys | Challenges need the cluster's challenge keys: when a cluster's configuration has none yet, adding a "Challenge" entry publishes a revision for the clusters it applies to (every cluster for a global entry), reason "Challenge keys for the greylist"; until it is applied the nodes answer those requests with 503 (`X-Edgeweir-Error: challenge-unavailable`) |
| Limit | Counts toward **Protection settings → Bans → Limit of manual bans** |
| Nodes | Needs `greylist-v1`; older nodes ignore the greylist, and the list shows "N nodes run an older version and ignore the greylist". Entries nodes could not hold show "Not applied on N nodes" |
| Audit | `greylist.create`, `greylist.update` (added again), `greylist.delete` |

## Nodes

| Item | Behavior |
| --- | --- |
| Capability | Bans need `bans-v1`; rule bans also need `waf-v2`, challenge failure bans `challenge-v2`, scan protection `unknown-host-v1`, the greylist `greylist-v1`; older nodes without a capability keep serving and do not enforce that feature |
| Sync | A node receives the bans of its cluster and the shared global bans. It keeps the sequence it applied and fetches only later changes; on its first connection or after a console database restore it gets a full snapshot. Nodes store bans on disk and load them before connecting after a restart |
| Capacity | Node options `--ban-capacity` (100000 entries by default, at most 10000000) and `--ban-dict-mb` (32 MiB by default). Short of room, the oldest automatic bans go first |
| Not applied | Manual bans never lapse silently: a node that cannot hold one reports it, the list shows "Not applied on N nodes" (online nodes only), and the node retries every minute |
| Status | Every heartbeat reports the node's ban state: applied sequence, entries, capacity, unapplied bans, kernel entries and evicted automatic bans. Read it as `banStatus` of `GET /api/v1/nodes/{id}` (`appliedSequence`, `entries`, `capacity`, `unapplied`, `unappliedIds`, `kernelEntries`, `autoEvicted`) |

## Kernel bans

The node agent also writes global bans into nftables, which drops the banned addresses' packets in the kernel: a banned client cannot even complete the TCP and TLS handshakes. Site bans apply at the HTTP layer only. [L4 apps](l4.en.md#ip-lists-and-connection-limits) are subject to kernel bans only: site bans and HTTP-layer bans do not reach layer-4 traffic.

| Item | Behavior |
| --- | --- |
| Requirements | The agent has `CAP_NET_ADMIN`, the host has `nft`, and the node option `--kernel-bans` is `auto` (default; `off` turns it off). The agent creates its table at start and reports the capability `kernel-ban-v1` only when that works; otherwise it bans at the HTTP layer only and logs why |
| Table | The agent manages only its own table `inet edgeweir` (sets `ban4`, `ban6`, `allow4`, `allow6`, an input chain), removes leftovers at start and deletes the table on exit; every change is one `nft -f -` transaction |
| Never banned | Console addresses, the node's own addresses, loopback, global allow lists |
| Outbound connections | Every inbound packet from a banned address is dropped, so the node cannot connect to that address either (for example if it happens to be an origin) |

The default systemd unit and node image do not grant `CAP_NET_ADMIN`. Enable it as follows when needed.

### systemd nodes

1. Install nftables:

   ```bash title="Node"
   sudo apt-get install -y nftables    # Debian, Ubuntu
   sudo dnf install -y nftables        # RHEL family
   ```

2. Add a drop-in that grants `CAP_NET_ADMIN` next to the existing `CAP_NET_BIND_SERVICE`:

   ```ini title="/etc/systemd/system/edgeweir-node.service.d/kernel-ban.conf"
   [Service]
   AmbientCapabilities=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
   CapabilityBoundingSet=CAP_NET_BIND_SERVICE CAP_NET_ADMIN
   ```

3. Reload and restart:

   ```bash title="Node"
   sudo systemctl daemon-reload
   sudo systemctl restart edgeweir-node
   ```

4. Verify: `sudo nft list table inet edgeweir` lists the sets `ban4` and `ban6`; `supportedFeatures` of `GET /api/v1/nodes/{id}` contains `kernel-ban-v1`.

> [!NOTE]
> OpenResty, started by the agent, inherits the ambient capabilities as well.

### Container nodes

1. Build the node image with the build argument `NFT_CAPABILITY=true`. The image gives `nft` the file capability `cap_net_admin+ep`; the agent still runs as a non-root user:

   ```bash title="edgeweir-node source directory"
   docker build --build-arg NFT_CAPABILITY=true -t edgeweir-node:nft .
   ```

2. Run the container with `--cap-add NET_ADMIN` (Compose: `cap_add: [NET_ADMIN]`).
3. Verify: `docker exec <container> nft list table inet edgeweir` lists the sets `ban4` and `ban6`; `supportedFeatures` of `GET /api/v1/nodes/{id}` contains `kernel-ban-v1`.

### Load balancers in front of the nodes

The cluster's [client IP](../deploy/nodes.en.md#client-ip) setting decides the visitor address (`ip.src`) of the HTTP and HTTPS listeners:

| Client IP | HTTP-layer bans, CC, rules, logs | Kernel bans and connection limits |
| --- | --- | --- |
| Direct (default) | The TCP peer; behind a load balancer that is the balancer, and an automatic ban blocks all of it | The TCP peer |
| PROXY protocol | The visitor address from the PROXY header | Still the TCP peer only (the balancer): bans of visitor addresses do not take effect in the kernel |
| Trusted proxy header | The visitor address the trusted proxies' header names; addresses inside the trusted CIDRs are never banned and not counted per address by CC | Likewise the TCP peer only |

With the last two, the **Bans** tab shows "Clusters {clusters} take client addresses from proxies: kernel bans match the TCP peer only". In direct mode behind a load balancer, add the balancers' addresses to a global allow list: they can then never be banned or dropped in the kernel.

[L4 apps](l4.en.md) accept the PROXY protocol on their own listeners, independently of the client IP setting of the HTTP and HTTPS listeners.

## Connection limits

Limits TCP connections per client in the kernel, against connection floods and slow connections from a single address. Set them per cluster in **Protection settings → Connection limits** (with several clusters, pick one under "Cluster" first); they travel in configuration revisions (rollback applies, and a restarted node restores them from its latest configuration).

| Setting | Default | Behavior |
| --- | --- | --- |
| Enabled | Off | Off keeps the values entered |
| Concurrent connections per IP | 256 | Connections one client holds at once; new connections above it are dropped; 0–100000, 0 is no limit |
| New connections per IP per second | 50 | Connections one client opens per second; those above it are dropped; 0–100000, 0 is no limit. When enabled, not both 0 ("Set at least one limit") |
| Burst | 100 | Connections a client may open at once before the rate applies; 0–1000000, 0 is the rate; not below the rate ("Burst cannot be below the new connection rate"), and only 0 while the rate is 0 |
| Ports | Cluster listener ports | "Cluster listener ports": the cluster's HTTP / HTTPS listeners and TCP [L4 app](l4.en.md) ports, following their changes, with "Limited ports" showing what the nodes limit; "Custom ports": ports or ranges separated by commas in "Port list" (`80, 443, 10000-10999`), 1–64 ranges, not overlapping |

| Item | Behavior |
| --- | --- |
| Client | An IPv4 address, or the IPv6 `/64` |
| Order | After the allow and ban sets of the `inet edgeweir` table: global allow lists, the console's and the nodes' own addresses and loopback are never limited |
| Protocol | TCP only; UDP is not limited |
| Requirements | As for [kernel bans](#kernel-bans) (`CAP_NET_ADMIN` and nftables), node capability `conn-limit-v1`. Without them the node still applies the configuration and the card shows "{node} does not enforce it: {error}"; if nftables refuses the limit rules (for example a kernel without `nft_connlimit`), bans are written as usual |
| State | When enabled, the card shows "N of M nodes enforce it", and "Nodes on an older version: {nodes}" for older nodes; `banStatus.connectionLimitsActive` and `connectionLimitsError` of `GET /api/v1/nodes/{id}` |
| Load balancers | Only the TCP peer is matched: put a load balancer in front of the nodes on a global allow list, or every visitor shares its quota |
| Audit | `cluster.connection_limits_update`; revision reason "Connection limits updated" |

## API

Paths are under `/api/v1`.

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `bans.list` | `GET /bans` | Active bans; query parameters `scope` (`site` / `platform`), `siteId`, `source` (`manual` / `auto` / `rule`), `address` (an IP or CIDR: the bans that cover it or lie inside it), `page`, `pageSize` (50 by default, at most 100) |
| `bans.create` | `POST /bans` | `siteId` is required when `scope` is `site` and not allowed when it is `platform`; also `cidr`, `reason` (`abuse` / `attack` / `scanner` / `spam` / `other`), `durationSeconds` |
| `bans.delete` | `DELETE /bans/{id}` | Lifts a manual, automatic or rule ban |
| `greylist.list` | `GET /greylist` | Active greylist entries and `unsupportedNodes`; query parameters `scope`, `siteId`, `address`, `page`, `pageSize` |
| `greylist.create` | `POST /greylist` | As `bans.create`, plus `action`: `{"kind":"challenge","challenge":"js"}` (`cookie302` / `js` / `pow` / `captcha`) or `{"kind":"rate_limit","requests":60,"windowSeconds":60}` |
| `greylist.delete` | `DELETE /greylist/{id}` | Removes an entry |
| `settings.bans`, `settings.setBans` | `GET`, `PUT /settings/bans` | `maxTotal`, `shareAutoBans` |
| `clusters.connectionLimits` | `GET /clusters/{clusterId}/connection-limits` | The cluster's connection limits, limited ports and node states |
| `clusters.setConnectionLimits` | `PUT /clusters/{clusterId}/connection-limits` | `settings`: `enabled`, `perIp`, `newPerSecond`, `burst`, `ports` (`[{"start":80,"end":80}]`; `null`: the cluster's listener ports) |

Read-only AccessKeys and the demo account can call `GET` procedures only; the others answer 403 `ACCESS_KEY_READ_ONLY` / `DEMO_READ_ONLY`. Service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`). Fields and examples: [API and endpoints](../reference/api/security.en.md#bans).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Invalid IP address or CIDR" | Not an IP address or CIDR, or it has leading zeros or a zone ID | Use the standard notation |
| "Prefix too short; the shortest is /16" (or `/48`) | The prefix is shorter than the minimum | Split it into longer prefixes, or use an IP list |
| "A ban lasts from 1 minute to 7 days" | Expiry out of range | Use an IP list to block for longer |
| "The ban covers the protected address …" | The ban covers a node address, loopback or an unspecified address, or overlaps a global allow list | Narrow it |
| "At most N manual bans can be active" | Active manual bans and greylist entries reached the limit | Unban addresses no longer needed, or raise **Protection settings → Bans → Limit of manual bans** |
| "Choose a site" | The scope is "Site" but no site is picked | Pick a site, or set the scope to "Global" |
| "Ban not found or no longer active" | The ban expired or was lifted | Refresh the list |
| The list shows "Not applied on N nodes" | Node ban capacity or memory exhausted | Raise the node's `--ban-capacity` and `--ban-dict-mb`, or ban less |
| A banned client still gets through | The node lacks `bans-v1`; the address is on a global allow list or among the cluster's trusted proxies; a site ban's address is on that site's allow lists | Upgrade the node; use [IP check](access-control.en.md#ip-check) to see the lists and active bans the address matches |
| Global bans do not apply in the kernel | The node lacks `kernel-ban-v1`; the client IP is not "Direct" | Grant `CAP_NET_ADMIN` and install nftables as in [Kernel bans](#kernel-bans); see [Load balancers in front of the nodes](#load-balancers-in-front-of-the-nodes) |
| A greylisted address is neither challenged nor limited | The node lacks `greylist-v1`; the address is on an allow list; the address is also banned (the ban wins); a rule allows it or skips the action | Upgrade the node; check the allow lists and rules |
| Greylist challenges answer 503 | The revision with the challenge keys is not applied yet | Wait for it; check the cluster's revision state |
| Connection limits "do not enforce it" | The node lacks `CAP_NET_ADMIN` or nftables, or the kernel refused the rules (reason in the note) | Enable as in [Kernel bans](#kernel-bans); check the node logs |
