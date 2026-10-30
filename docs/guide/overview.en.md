# Overview

The console home at /overview: items needing attention, live tiles, traffic of every site, the edge network globe, nodes and recent lists.

## Page layout

Page: **Overview** (`/overview`), the default page after sign-in. Top to bottom:

| Block | Content | Refresh |
| --- | --- | --- |
| Welcome strip | **Welcome back, {name}**, buttons **New site** (opens the new-site dialog on `/sites`) and **Add node** (opens the add-node dialog on `/clusters`) | — |
| **Needs attention** | Cluster items that need the operator, see [Needs attention](#needs-attention) | 10 s |
| **Right now** | Live tiles, see [Right now](#right-now) | traffic 60 s, nodes 10 s |
| **Analytics** | Traffic of every site over the chosen range, with the **Edge network** card, see [Analytics](#analytics) and [Edge network](#edge-network) | 60 s |
| Lists | **Recent revisions**, **Recents**, **Sites**, **Nodes**, see [Lists](#lists) | sites 30 s, others 10 s |

Every card except the welcome strip can be hidden, see [Customize cards](#customize-cards).

## Needs attention

Lists what needs the operator in each cluster; each row shows the item and its cluster and opens that cluster: DNS items open the **DNS** tab, upgrade and canary items the **Releases** tab, others the **Nodes** tab. Hidden when there is nothing. Rows follow the order of the table.

| Item | Tone | Opens |
| --- | --- | --- |
| **Unhealthy nodes: N** | error | Nodes |
| **DNS revision #N failed** | error | DNS |
| **DNS publication held by mass removal protection** | error | DNS |
| **Upgrade to X failed** | error | Releases |
| **Canary #N rolled back** | error, with time since | Releases |
| **Canary #N awaiting promotion** | warning | Releases |
| **Canary #N under observation** | warning, with a countdown to the window's end | Releases |
| **Lagging nodes: N** | warning | Nodes |
| **Nodes without a public address: N** | warning | Nodes |

The conditions of each item are in [Needs attention](clusters.en.md#needs-attention).

## Right now

| Tile | Value | Sparkline |
| --- | --- | --- |
| **Request rate** | requests of the last full minute / 60, in **/s** | requests per minute over the last hour |
| **Egress** | bytes sent to visitors in the last full minute × 8 / 60, in bps–Tbps | bytes sent per minute over the last hour |
| **Cache hit ratio** | `hits / (hits + misses)` over the last hour, labelled **Last hour** | hit ratio per minute |
| **Nodes online** | nodes online / all nodes, with a ratio bar | — |

| Rule | Description |
| --- | --- |
| Source | The first three tiles read `GET /api/v1/analytics/traffic?range=1h`, the same data as the analytics; the current, still filling minute is left out |
| **Live** marker | Shown beside **Right now** while the traffic tiles show live numbers |
| Online | A node with a heartbeat within the last three heartbeat intervals (45 s by default) |
| Loading and errors | The first load shows a loader, a failure an error with a retry, never zeros |

## Analytics

Traffic of every site over the chosen range; the site **Analytics** tab uses the same component for one site.

### Range and refresh

| Control | Description |
| --- | --- |
| Range | **Last hour**, **Last 6 hours**, **Last 24 hours** (default), **Last 7 days**, **Last 30 days**; a non-default value goes into the URL's `range` parameter (`1h`, `6h`, `7d`, `30d`) |
| **Refresh** | Reloads every card now; data also refreshes every 60 seconds, keeping the old numbers dimmed until the new ones arrive |
| **Customize cards** | See [Customize cards](#customize-cards) |

| Range | Point interval | Source | Retention |
| --- | --- | --- | --- |
| Last hour | 1 minute | per-minute node statistics | 7 days |
| Last 6 hours | 5 minutes | per-minute node statistics | 7 days |
| Last 24 hours | 10 minutes | per-minute node statistics | 7 days |
| Last 7 days | 1 hour | hourly rollup | 90 days |
| Last 30 days | 6 hours | hourly rollup | 90 days |

The statistics are the `ReportStats` counters nodes send every minute (per node and site), stored in PostgreSQL; they do not depend on [access log](access-logs.en.md) sampling.

### Metric cards

| Card | Value | Better when |
| --- | --- | --- |
| **Total requests** | requests in the range | up |
| **Data transferred** | bytes sent to visitors in the range | up |
| **Cache hit ratio** | `hits / (hits + misses)`; uncached requests are left out | up |
| **Peak bandwidth** | egress of the busiest point | up |
| **4xx rate** | 4xx responses / total requests | down |
| **5xx rate** | 5xx responses / total requests | down |

Each card shows **{change} vs. previous period**, against the period of the same length right before; hidden when that period is 0. Clicking a card or its chart opens the **{metric} details** dialog:

| Metric | Detail views |
| --- | --- |
| **Total requests** | **Total requests by site**, **Total requests by node**, **Requests by status code** |
| **Data transferred** | data transferred by site and by node |
| **Cache hit ratio** | **Requests by cache status**: **Hit**, **Miss**, **Not cached** |
| **Peak bandwidth** | bandwidth by site and by node |
| **4xx rate** / **5xx rate** | **Top status codes** of that class |

A detail view plots the leading 10 items and groups the rest as **Other**; a site's Analytics tab has no by-site views.

### Status codes, rankings and countries

| Card | Content |
| --- | --- |
| **Status codes** | requests and share of 2xx, 3xx, 4xx and 5xx; opens **Requests by status code** |
| **Top sites by requests** | the leading 5 sites; opens the site |
| **Top nodes by requests** | the leading 5 nodes; opens the node's cluster |
| **Top countries by traffic** | the leading 5 countries by bytes sent to visitors |
| **Top URLs (approximate)** | frequent URLs pre-aggregated by the nodes, approximate; no row actions on the overview, **Purge URL** in each row's menu on a site's tab |
| **Top IPs (approximate)** | frequent visitor IPs pre-aggregated by the nodes, approximate; each row's menu has **Ban IP** (a platform ban on the overview, a site ban on a site's tab), see [Bans](bans.en.md) |

A card without traffic shows **No traffic**.

## Edge network

Beside the two large charts (below them on narrow screens).

| Part | Content |
| --- | --- |
| Header | **Edge network**, the egress of every online node summed, the **Live** marker |
| Globe | One marker per place, sized by its number of nodes, colored by the worst standing there |
| Location list | One row per region of each cluster: region name (the cluster name for nodes without a region), cluster name, state word, **N/M online**, egress; opens the cluster. **No nodes** when there are none |

Where markers go:

| Rule | Description |
| --- | --- |
| Address located | Named by the console in the heartbeat answer: the node's first public scheduling address, else the public source address of its connection |
| Lookup | The node looks the address up in its own GeoIP databases and reports country, subdivision and coordinates (coordinates need a City database) in its next heartbeat |
| Coordinates | Coordinates when reported; the country's centre when only the country is known; nodes without a known country are left off the globe |
| Grouping | Nodes whose coordinates match to one decimal share a marker, labelled `{place} · {N} nodes` on hover; a single node is labelled `{node name} · {place}` |
| Version | Nodes report their location since v1.6.2; older nodes are left off the globe but stay in the location list |
| Scope | Enabled nodes only |

Standing (marker color and the list's state word):

| Tone | Condition | State word |
| --- | --- | --- |
| good | every node online, data plane healthy, on its target revision | — |
| warning | some nodes' data plane unhealthy | **Data plane unhealthy** |
| warning | some nodes offline | **Offline** |
| warning | an online node not on its target revision | **Behind** |
| error | no node online with a healthy data plane | **Data plane unhealthy** or **Offline** |

Scheduling addresses and the GeoIP databases: [Scheduling addresses and backup IPs](scheduling.en.md#scheduling-addresses-and-backup-ips) and [GeoIP databases](system.en.md#geoip-databases).

## Lists

| List | Content | Opens |
| --- | --- | --- |
| **Recent revisions** | the 5 latest configuration revisions of every cluster: number, reason, time since; **No revisions yet** when there are none | the cluster's **Releases** tab |
| **Recents** | the 5 pages or site tabs last opened in this browser, kept per account in the browser's local storage; **Nothing yet** when empty | the page |
| **Sites** | the number of sites; starred sites first, then sites by creation time, 5 in all; **No sites** and **New site** when there are none | the site; the title opens the **Sites** list |
| **Nodes** | **N/M online**; 5 nodes sorted by state: name, applied revision, state; **No nodes** and **Add node** when there are none | the node's cluster; the title opens **Clusters & nodes** |

States in the **Nodes** list, in sort order:

| State | Condition |
| --- | --- |
| **Offline** | connected to the node channel before, offline now |
| **Apply failed** | the last configuration apply failed |
| **Data plane unhealthy** | online and configured, data plane not healthy |
| **Behind** | applied revision below its target (during a canary the target of non-canary nodes is the stable revision) |
| **Awaiting configuration** | online, no configuration applied yet |
| **Awaiting heartbeat** | enrolled, never connected to the node channel |
| **Disabled** | node disabled |
| **In sync** | on its target revision |

## Customize cards

The **Customize cards** menu in the **Analytics** header lists every overview card by group; unticking hides a card, **Reset to default** shows them all.

| Group | Cards |
| --- | --- |
| **Right now** | **Request rate**, **Egress**, **Cache hit ratio**, **Nodes online** |
| **Analytics** | **Total requests**, **Data transferred**, **Edge network**, **Cache hit ratio**, **Peak bandwidth**, **4xx rate**, **5xx rate**, **Status codes**, **Top sites by requests**, **Top nodes by requests**, **Top countries by traffic**, **Top URLs (approximate)**, **Top IPs (approximate)** |
| **Lists** | **Recent revisions**, **Recents**, **Sites**, **Nodes** |

| Rule | Description |
| --- | --- |
| Storage | Kept with the account in the console, the same in every browser; not audited |
| Scope | One choice for the overview and one for the site **Analytics** tab; the latter applies to every site |
| New cards | Cards added by later versions show by default |
| Hidden cards | Load no data; with every analytics card hidden the section shows **All cards hidden** and **Show all** |

## API

| Data | Endpoint |
| --- | --- |
| Counts, the 10 latest revisions, attention items | `GET /api/v1/overview` |
| Traffic series and totals (with the previous period) | `GET /api/v1/analytics/traffic?range=&siteId=` |
| Top sites / nodes | `GET /api/v1/analytics/top-sites`, `GET /api/v1/analytics/top-nodes` (`range`, `limit` 1–50, default 5) |
| Detail dialog breakdowns | `GET /api/v1/analytics/breakdown` (`by`: `site`, `node`, `status`, `block_reason`; `metric`; `statusClass`; `limit` 1–20, default 10) |
| Top URLs / IPs | `GET /api/v1/analytics/top-requests` (`by`: `url`, `ip`; `limit` 1–50, default 10; results marked `approximate`) |
| Countries and other dimensions | `GET /api/v1/analytics/dimensions` |
| Hidden cards | `GET /api/v1/hidden-cards`, `PATCH /api/v1/hidden-cards` |
| Nodes (with `location`) | `GET /api/v1/nodes` |

`range` is `1h`, `6h`, `24h`, `7d` or `30d`, default `24h`. Fields: [API reference](../reference/api.en.md).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Analytics all 0 or **No traffic** | No requests reach the nodes, or the nodes send no statistics | Check that nodes are **Online** and the site is live; request a node directly with `curl --resolve`, see [Quick start](first-site.en.md#6-verify) |
| **Cache hit ratio** is 0 | No cache rule covers the requests, or the origin's responses are not cacheable (counted as **Not cached**, outside the ratio) | Check the site's cache rules and the origin's `Cache-Control`, see [Origins and cache](origins-and-cache.en.md) |
| A node is missing from the globe | Node older than v1.6.2, no public address, or the GeoIP database does not know the address | Upgrade the node, see [Node upgrades](node-upgrades.en.md); set a public scheduling address; update the GeoIP databases |
| A node is placed far off | Only a country database: the node sits at the country's centre; the GeoIP data is inaccurate | Use a City database with coordinates |
| **Top countries by traffic** is empty while other cards have data | Older nodes do not report dimension statistics | Upgrade the nodes |
| **Recents** is empty | Local storage is disabled, or another browser | — |
