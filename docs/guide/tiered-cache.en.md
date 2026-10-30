# Tiered Cache

With Tiered Cache a node (lower tier) that misses its cache first fetches from another node of the cluster (upper tier), which fetches from the origin only when it misses too. An object is fetched from the origin once; the other nodes fetch it from the upper tier. When no upper tier answers, the lower tier fetches from the origin.

## Concepts

| Term | Definition |
| --- | --- |
| Lower tier | The node that received the visitor's request and missed its cache. |
| Upper tier | The node a lower tier fetches from. It caches the object under the lower tier's cache key and fetches from the origin when it misses. |
| Regional tier | In the Regional topology, a node between the lower tiers and the upper tier (one per other region). |
| Measured origin | The first primary origin of the site's default origin group (`host:port`). Nodes that take part measure their TCP round trip time to it every minute. |
| Region | The region of the node's node group; nodes without one form a group of their own. |

## Topologies

| Topology | Upper tiers |
| --- | --- |
| Off | No tiers; every node fetches from the origin. The default. |
| Smart | The node with the lowest round trip time to the measured origin is the upper tier of every other node; the fastest node of another region is the fallback. |
| Generic | In each region the node with the lowest round trip time (the lowest id without measurements) is the upper tier of the region's other nodes; a region without one uses the fastest region's. |
| Regional | The upper tier of Smart; in every other region the fastest node is a regional tier, through which the region's nodes reach the upper tier (two hops at most). |
| Custom | The selected nodes and the nodes of the selected node groups are upper tiers of every other node, at most 3 each: those of the node's region first, then by round trip time. |

- A chosen upper tier stays while its round trip time is at most 120% of the fastest node's plus 5 ms, so measurement noise does not move it.
- The console chooses again every minute and publishes a revision when upper tiers change (reason "Upper tiers of N sites changed").

## Turning it on

1. Open **System** and choose the topology in the "Tiered Cache" card; change the "Upper tier port" (default 8444) if needed. Saving publishes the clusters of the sites that follow it.
2. For one site: open **Sites** → the site → the "Cache" tab and choose "Global" or a topology in the "Tiered Cache" card.
3. The "Upper tiers" card lists each node of the cluster with its upper tiers, why they were chosen and their round trip times, or why there are none.
4. The "Tiered Cache" card of the "Analytics" tab shows the upper tier hit ratio, upper tier fetches, origin fallbacks and requests served to lower tiers.

## Node requirements

| Requirement | Notes |
| --- | --- |
| `tiered-cache-v1` | The node takes part. Nodes without it fetch from the origin and count as unsupported in the "Upper tiers" card. |
| `tier-upper-v1` | The node can be an upper tier: its node certificate serves TLS. Nodes with an older certificate renew it once within a day. |
| Scheduling address | An upper tier accepts lower tiers on its first primary scheduling address (IPv4 first); nodes without one are not upper tiers. |
| Port | Lower tiers must reach the upper tiers on the "Upper tier port" (TCP). It cannot be a listener port. |
| Online | Only nodes with a heartbeat in the last 10 minutes take part; measurements older than 10 minutes do not count. |

## Behaviour

| Case | Result |
| --- | --- |
| The request is not cached (no cache rule matches, bypass, not GET / HEAD, WebSocket, gRPC) | Not sent to upper tiers, as when off |
| Image format conversion | Not sent to upper tiers |
| Between lower and upper tiers | Mutual TLS 1.3: both present their node certificates, verified against the node CA and the node id; an upper tier accepts only the lower tiers the plan names |
| Requests at the upper tier | The lower tier applied rules, bans, challenges and the WAF; the upper tier does not again. The visitor's address travels in `X-Real-IP` / `X-Forwarded-For` |
| Connections the origin sees | From the upper tier |
| An upper tier fails to connect, times out or answers 502 / 504 | The next upper tier is tried, then the origin; an upper tier with 2 consecutive failures is skipped for 15 seconds |
| The upper tier's origin fails (5xx) and the lower tier has a stale copy | The stale copy, as the cache rules allow |
| The request passed a node already (`CDN-Loop`) | That node is skipped: no loops |
| Range (slice) requests | Each slice goes through the upper tier, which caches it as a slice too |
| Purging a URL, prefix, Cache-Tag or the site | Every node purges on its own; an upper tier uses the later of the two purge times and the newer cache generation, so it never hands a lower tier an object a purge removed |
| Access logs | The "Tiered Cache" field names the upper tier that answered and its cache status, or "Origin" |

## Statistics

| Metric | Definition |
| --- | --- |
| Upper tier hit ratio | Of the fetches an upper tier answered, the share it answered from its cache (HIT, STALE, UPDATING, REVALIDATED) |
| Upper tier fetches | Fetches from upper tiers that were answered |
| Origin fallbacks | Fetches no upper tier answered, sent to the origin |
| Served to lower tiers | Requests of this site the nodes answered as upper tiers |

Cache sharing among the nodes of one group (consistent-hash sharding, cache index nodes) is not part of Tiered Cache.
