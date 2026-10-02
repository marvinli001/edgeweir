# Quick start

From console setup to a first site served over HTTP and HTTPS by an edge node.

## Steps

1. **Complete the setup wizard**: create the only account and the default cluster.
2. **Enroll a node**: generate the install command in the console and run it on the node host; once enrolled, the node connects to the node channel over mTLS.
3. **Create a site**: enter its domains, origin, and cache setting; the cluster publishes a new configuration revision.
4. **Configure DNS**: point the site's domains at the edge addresses or the CNAME target listed on the site's **Domains** tab in the authoritative DNS and wait for the records to take effect.
5. **Enable HTTPS**: request or upload a certificate and select it on the site's HTTPS tab; see [HTTPS and certificates](https.en.md).
6. **Verify**: every item of the **Launch check** on the site's **Overview** tab passes; check origin fetch and caching with curl.

Node installation, DNS propagation, and certificate issuance each take time that depends on the network and the providers.

## Prerequisites

| Item | Requirement |
| --- | --- |
| Console | Deployed; browsers reach `EDGEWEIR_PUBLIC_URL`. See [Deployment overview](../deploy/README.en.md) |
| Node host | Linux (systemd), amd64 / arm64; reaches `EDGEWEIR_PUBLIC_URL` and the node channel (TCP 8443 by default); an account with sudo |
| Node inbound ports | TCP 80; TCP 443 once HTTPS is enabled |
| Domain | Its authoritative DNS records can be edited |
| Origin | Reachable from the node; its address is outside special-purpose ranges (private, loopback, and so on) or covered by the [origin allow list](system.en.md#origin-allow-list) |

## 1. Complete the setup wizard

1. Read the setup token from the console log. Docker Compose:

   ```bash title="Console host"
   docker compose logs console | grep setupToken
   ```

   The log line is JSON: the `setupToken` field holds the token (prefix `ews_`) and the `url` field the setup page. An uninitialized console prints the same token at every start. For log locations of other deployment methods, see [Docker Compose](../deploy/docker.en.md) and [BaoTa Panel and aaPanel](../deploy/baota.en.md).

2. Open `EDGEWEIR_PUBLIC_URL` in a browser. An uninitialized console redirects to `/setup` (**Create your account**).

3. Fill in the form and click **Finish**.

   | Field | Description |
   | --- | --- |
   | **Setup token** | The token from step 1 |
   | **Name** | 1–100 characters |
   | **Email** | Sign-in email |
   | **Password** | 12–128 characters |

4. Verify: the console signs in and opens **Clusters & nodes** with the **Add node** dialog of the cluster `default` (the next step); on **System**, the **System** card shows **Setup token** as **Used {time}**.

Objects created by setup:

| Object | Value |
| --- | --- |
| Account | The account from the form, and the console's only account; for sign-in methods see [Account and sign-in](account.en.md) |
| Cluster | `default` with the default node group `default`; revision #1 published |
| Setup token | Spent; `/setup` redirects to the sign-in page from then on |

## 2. Enroll a node

1. Open **Clusters & nodes**, select the cluster `default`, and click **Add node** (open already after setup; while there is no node, the button at the top of the sidebar is **Add node** too).

2. Fill in the form and click **Generate command**.

   | Field | Description |
   | --- | --- |
   | **Node name** | Optional, at most 64 characters |
   | **Node group** | Defaults to the cluster's default node group |
   | **Valid for** | 15 minutes, 1 hour (default), or 24 hours |

3. Copy the **Install command** (shown once) and run it on the node host. Command format:

   ```bash title="Node host"
   export EDGEWEIR_TOKEN='ewt_…'
   curl -fsSL https://console.example.com/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server https://console.example.com:8443 --ca-sha256 <CA fingerprint>
   ```

4. Verify: the node appears in the node table of **Clusters & nodes**, **Status** is **Online**, and **Applied** shows **In sync**.

The token is single-use. For the installer's checks, the download mirror, and failure handling, see [Adding nodes](../deploy/nodes.en.md).

## 3. Create a site

1. Open **Sites** and click **New site**.

2. Fill in the form.

   | Field | Default | Description |
   | --- | --- | --- |
   | **Name** | None | At most 100 characters |
   | **Domains** | None | One per line or comma-separated; wildcards as `*.example.com`; 1–50 domains |
   | **Origin** | None | IP address or host name |
   | **Port** | 80 (HTTP) / 443 (HTTPS) | Origin port |
   | **Protocol** | HTTP | HTTP or HTTPS |
   | **Origin Host** | Same as request | `Host` sent to the origin |
   | **Caching** | On | When on, creates one cache rule: **Path prefix** `/`, **TTL (seconds)** 3600, **Respect origin Cache-Control** on (3600 seconds when the origin sends neither `Cache-Control` nor `Expires`) |

3. Click **Create**. The site's cluster publishes a new revision and the site page opens. The notice **Site created** follows the nodes: **Rolling out N/M** → **Live on every node** (**Canary N/M, all nodes at HH:MM** during a [configuration canary](system.en.md#configuration-canary)).

| Rule | Description |
| --- | --- |
| Cluster | With several clusters, **Cluster** in the form (default: the oldest); through the API, `clusterId`. A site cannot change clusters later |
| Domains | Domains are published to the nodes as soon as the site is saved. A domain (name and wildcard flag) belongs to at most one site |
| Origin address | Origins in special-purpose ranges are refused unless the origin allow list covers the range |
| Disabling | **Disable** on the site's **Overview** tab: the site is no longer sent to the nodes, which answer 404 for its domains; DNS records stay. **Enable** restores it, see [Site enabling](system.en.md#site-enabling) |

For origin pools, cache rules, and cache keys, see [Origins and cache](origins-and-cache.en.md).

## 4. Configure DNS

Add a record for every site domain in the domain's authoritative DNS.

| DNS steering | Record |
| --- | --- |
| Not configured (the cluster's DNS is **Not managed**) | `A` / `AAAA` records to the addresses in the **Edge addresses** card on the site's **Domains** tab (the scheduling addresses of the cluster's online nodes, copyable), one record per address |
| Configured (the **DNS** tab of **Clusters & nodes**) | A `CNAME` record to the address in the **CNAME target** card on the site's **Domains** tab (`<site ID>.<cluster domain>`). In Automatic mode the card shows **Published** once the records are written to the provider; in Manual mode create the cluster's records listed on that tab first |

The card lists where each domain resolves now: **Points here** (every address belongs to a node of the cluster), **Points elsewhere**, **Not resolved**, **Not checked** (the lookup failed, or the nodes have no known address). A wildcard is resolved as `edgeweir-check.<domain>`. The card resolves again every 30 seconds; DNS caches affect the result.

For lines, health-based removal, and TTL of DNS steering, see [Configure DNS steering](dns-and-alerts.en.md#configure-dns-steering).

## 5. Enable HTTPS

1. Open **Certificates** and click **Request certificate** (ACME) or **Upload certificate**. HTTP-01 validation requires every certificate name to be a domain of a site and the records from step 4 to be live.
2. On the site's **HTTPS** tab, select the certificate under **Certificates**, turn on **Redirect HTTP to HTTPS** if needed, and click **Save**.
3. The cluster publishes a new revision. Once an enabled site in the cluster references a certificate, nodes listen on TCP 443.

For issuance methods, renewal, TLS, and HTTP/3, see [HTTPS and certificates](https.en.md).

## 6. Verify

1. Check the **Launch check** on the site's **Overview** tab; each item leads to its settings:

   | Item | Passes | Otherwise |
   | --- | --- | --- |
   | **DNS pointed N/M** | Every domain **Points here** | Lists the domains that do not; opens the **Domains** tab |
   | Certificate | **Certificate covers every domain**, or **No certificate** (HTTP only) | **Certificate misses domains** (listed), **Certificate being issued**, **Certificate issuance failed** (with the reason), **Certificate expired**; opens the **HTTPS** tab |
   | **Live on N/M nodes** | N equals M | Shows the window's end during a canary; with **No online nodes**, enroll a node first; opens the cluster |

2. Send an HTTP request straight to the node, bypassing DNS. Without DNS steering, the **Edge addresses** card gives a copyable command per domain (HTTPS when the site's certificate covers the domain); otherwise replace `203.0.113.10` below:

   ```bash
   curl -sI --resolve www.example.com:80:203.0.113.10 http://www.example.com/
   ```

   Expected: the status code matches the origin; the response carries an `X-Cache` header, `MISS` on the first request for a path covered by a cache rule.

3. Repeat step 2. When the origin response is cacheable, the node answers `X-Cache: HIT`.

4. With HTTPS enabled:

   ```bash
   curl -sI --resolve www.example.com:443:203.0.113.10 https://www.example.com/
   ```

   Use `--resolve` for HTTPS, not `-H 'Host: …'`: the node requires SNI to match `Host`.

5. Once DNS is live:

   ```bash
   dig +short www.example.com
   curl -sI http://www.example.com/
   ```

   Expected: `dig` returns the node address (preceded by the CNAME target with DNS steering); `curl` matches step 2.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Setup shows **Invalid setup token** | Wrong token, or already used | Read it from the log again; after setup, use the sign-in page |
| Setup shows **Setup is already in progress. Retry shortly.** | Another setup request is running | Retry shortly |
| Node missing or **Offline** | Enrollment failed, or the node cannot reach the node channel | See [Adding nodes](../deploy/nodes.en.md) and [Ports, reverse proxy, and trusted proxies](../deploy/networking.en.md) |
| **Applied** shows **Apply failed** | The node failed to validate or apply the configuration | Hover the badge for the reason |
| **Applied** shows **Upgrade required** | The node lacks a capability the configuration needs | Upgrade the node; see [Node upgrades](node-upgrades.en.md) |
| 404 with `X-Edgeweir-Error: unknown-host` | The domain is not in the node's configuration: revision not applied, or the site is disabled | Check **Applied** and the **Status** on the site's **Overview** tab |
| A domain in the **Launch check** **Points elsewhere** | Its records point at an old server or another CDN, or also hold other addresses | Keep only records for the edge addresses (or the CNAME target) and wait for the old records' TTL |
| A domain in the **Launch check** is **Not checked** | The lookup timed out, or the cluster's nodes have no known address yet | Check that the nodes are online and report a public address, or configure scheduling addresses on the node |
| 421 with `X-Edgeweir-Error: sni-host-mismatch` | SNI and `Host` of an HTTPS request differ | Use `--resolve` |
| 502 with `X-Edgeweir-Error: no-origin` | No usable origin | Check origin address, port, protocol, and health; see [Origins and cache](origins-and-cache.en.md) |
| 508 with `X-Edgeweir-Error: loop-detected` | The origin points back to a node | Point the origin at the real origin server |
| New site shows **Origin address … is in the special-purpose range …, which the origin allow list does not include** | The origin is a private, loopback, or similar address | Use a public address, or add the range to the [origin allow list](system.en.md#origin-allow-list) |
| New site shows **Domain already in use: …** | The domain belongs to another site | Use another domain, or remove it from the other site first |
