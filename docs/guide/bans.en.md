# Bans

Block clients by IP address or CIDR for a limited time. Bans travel over the node channel directly, take effect within seconds and create no configuration revision.

## Concepts

| Term | Definition |
| --- | --- |
| Ban | An IP address or CIDR whose requests are blocked until it expires. |
| Scope | **Site**: one site only. **Global**: every site of every cluster, also dropped in the kernel by the nodes (see [Kernel bans](#kernel-bans)). In the API these are `site` and `platform`. |
| Source | **Manual**: created on the **Bans** page or through the API. **Automatic**: created by a node on a trigger and reported to the console. |
| Expiry | 1 minute to 7 days. Block for longer with [IP lists](rules.en.md#ip-lists). |

## Ban an address

1. Open **Bans** and click "New ban".
2. Pick the "Scope": "Site" or "Global".
3. For a site ban, pick the site under "Site"; with many sites, type a name or domain into "Search sites" first.
4. Fill in "IP or CIDR", e.g. `203.0.113.7` or `198.51.100.0/24`.
5. Pick a "Reason" and a "Duration" (1 h, 6 h, 1 d, 3 d, 7 d) and click "Ban".
6. Verify: request the site from the banned address:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/
   ```

   The response is 403 with `X-Edgeweir-Error: ip-banned`. With a site ban, other sites still answer the same address.

Unban: click "Unban" in the row and confirm. The nodes drop the ban within seconds. Manual and automatic bans can both be lifted.

The list shows active bans only (neither expired nor lifted), newest first, and filters by scope, site and source:

| Column | Content |
| --- | --- |
| Address | Canonical CIDR; "Not applied on N nodes" when nodes could not hold the ban |
| Site | Site name; "Global" for global bans |
| Reason | Why the address is banned |
| Source | "Manual" and the operator; "Automatic" and the node and trigger (metric, observed / threshold, window in seconds); automatic bans that are not sent to other nodes are marked "Not shared" |
| Expires | Time left; hover for the expiry time |

## Rules

| Item | Behavior |
| --- | --- |
| Address | IPv4 / IPv6 address or CIDR; a single address means `/32` or `/128`; host bits are cleared, IPv6 is lowercased and compressed; `::ffff:a.b.c.d` counts as the IPv4 address; leading zeros and zone IDs are refused |
| Shortest prefix | IPv4 `/16`, IPv6 `/48` |
| Expiry | 1 minute to 7 days (the UI offers 1 hour to 7 days); nodes drop a ban when it expires, the console deletes it an hour later |
| Reason | Manual: abuse, attack, scanning, spam, other. Automatic: per-IP request rate |
| Banning again | One active manual ban per address for global bans, and per site and address for site bans; banning it again sets the new reason and expiry and does not add a ban |
| Protected addresses | A ban may not cover any node address, loopback (`127.0.0.0/8`, `::1`) or unspecified addresses (`0.0.0.0/8`, `::`), nor overlap an allow list |
| Where it applies | At the edge layer once the site is known, before rules: global bans first, then site bans; addresses on an allow list are never banned |
| Delivery | No configuration revision, no configuration canary, no reload on the nodes |
| Audit | `ban.create`, `ban.update` (banned again), `ban.delete`; automatic bans are not audited |

## Limits

| Limit | Counts | Where |
| --- | --- | --- |
| Limit of manual bans | Active manual bans, global and site bans together | **System → Bans → Limit of manual bans**; 10000 by default, 100–100000 |
| Automatic bans | Active automatic bans per cluster | Fixed at 10000; the oldest automatic bans lapse first |

Automatic bans do not count toward the limit of manual bans. Once the limit is reached, a new ban gets `BAN_PLATFORM_LIMIT` ("At most N manual bans can be active"); banning an address that is still banned is not limited.

## Automatic bans

A node bans a single address on a trigger (the per-IP QPS of CC mitigation, see [Challenges and CC mitigation](challenges.en.md#cc-mitigation)). The ban applies on that node at once and is reported to the console in batches every 5 seconds.

| Item | Behavior |
| --- | --- |
| Sharing | **System → Bans → Share automatic bans in the cluster**, on by default: on, the ban goes to every node of the cluster; off, it is kept for viewing only and marked "Not shared". A change applies to automatic bans added afterwards |
| Merging | One entry per node, site and address; a repeated report extends the expiry |
| Checks | The site must belong to the node's cluster; single addresses only; at most 7 days after creation; protected addresses are not stored |
| Unban | Like a manual ban: click "Unban" in the row |

## Nodes

| Item | Behavior |
| --- | --- |
| Capability | Bans need `bans-v1`; older nodes without it keep serving and do not enforce bans |
| Sync | A node receives the bans of its cluster and the global bans. It keeps the sequence it applied and fetches only later changes; on its first connection or after a console database restore it gets a full snapshot. Nodes store bans on disk and load them before connecting after a restart |
| Capacity | Node options `--ban-capacity` (100000 entries by default) and `--ban-dict-mb` (32 MiB by default). Short of room, the oldest automatic bans go first |
| Not applied | Manual bans never lapse silently: a node that cannot hold one reports it, the list shows "Not applied on N nodes" (online nodes only), and the node retries every minute |
| Status | Every heartbeat reports the node's ban state: applied sequence, entries, capacity, unapplied bans, kernel entries and evicted automatic bans. Read it as `banStatus` of `GET /api/v1/nodes/{id}` |

## Kernel bans

The node agent also writes global bans into nftables, which drops the banned addresses' packets in the kernel: a banned client cannot even complete the TCP and TLS handshakes. Site bans apply at the HTTP layer only.

| Item | Behavior |
| --- | --- |
| Requirements | The agent has `CAP_NET_ADMIN` and the host has `nft`. The agent tries to create its table at start and reports the capability `kernel-ban-v1` only when that works; otherwise it bans at the HTTP layer only and logs why |
| Table | The agent manages only its own table `inet edgeweir` (sets `ban4`, `ban6`, `allow4`, `allow6`, an input chain), removes leftovers at start and deletes the table on exit |
| Never banned | Console addresses, the node's own addresses, loopback, allow lists |
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

1. Build the node image with the build argument `NFT_CAPABILITY=true`. The image gives `nft` a file capability; the agent still runs as a non-root user:

   ```bash title="edgeweir-node source directory"
   docker build --build-arg NFT_CAPABILITY=true -t edgeweir-node:nft .
   ```

2. Run the container with `--cap-add NET_ADMIN` (Compose: `cap_add: [NET_ADMIN]`).
3. Verify: `docker exec <container> nft list table inet edgeweir` lists the sets `ban4` and `ban6`; `supportedFeatures` of `GET /api/v1/nodes/{id}` contains `kernel-ban-v1`.

### PROXY protocol

With the PROXY protocol on the node's listeners (a layer-4 load balancer in front of the nodes):

| Layer | Address matched |
| --- | --- |
| Kernel bans | The TCP peer, i.e. the load balancer |
| HTTP-layer bans | The real client address passed by the PROXY protocol |

In such deployments the HTTP layer still blocks global bans by the real client. Add the load balancers' addresses to an allow list: they can then never be banned or dropped in the kernel.

## API

Paths are under `/api/v1`.

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `bans.list` | `GET /bans` | Active bans; query parameters `scope` (`site` / `platform`), `siteId`, `source` (`manual` / `auto`), `page`, `pageSize` |
| `bans.create` | `POST /bans` | `siteId` is required when `scope` is `site` and not allowed when it is `platform`; also `cidr`, `reason`, `durationSeconds` |
| `bans.delete` | `DELETE /bans/{id}` | Lifts a manual or automatic ban |

Read-only AccessKeys can call only `bans.list`; service accounts cannot call the ban procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`). Fields and examples: [API and endpoints](../reference/api.en.md#bans).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "Invalid IP address or CIDR" | Not an IP address or CIDR, or it has leading zeros or a zone ID | Use the standard notation |
| "The prefix is too short; the shortest allowed is /16" (or `/48`) | The prefix is shorter than the minimum | Split it into longer prefixes, or use an IP list |
| "A ban lasts from 1 minute to 7 days" | Expiry out of range | Use an IP list to block for longer |
| "The ban covers the protected address …" | The ban covers a node address, loopback or an unspecified address, or overlaps an allow list | Narrow it |
| "At most N manual bans can be active" | Limit of manual bans reached | Unban addresses no longer needed, or raise **System → Bans → Limit of manual bans** |
| "Choose a site" | The scope is "Site" but no site is picked | Pick a site, or set the scope to "Global" |
| "Ban not found or no longer active" | The ban expired or was lifted | Refresh the list |
| The list shows "Not applied on N nodes" | Node ban capacity or memory exhausted | Raise the node's `--ban-capacity` and `--ban-dict-mb`, or ban less |
| A banned client still gets through | The node lacks `bans-v1`; the address is on an allow list | Upgrade the node; check the allow lists |
| Global bans do not apply in the kernel | The node lacks `kernel-ban-v1` | Grant `CAP_NET_ADMIN` and install nftables as in [Kernel bans](#kernel-bans) |
