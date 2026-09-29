# Quick start

From a running console to a first site served by a node: setup, node enrollment, site, DNS, HTTPS, and verification.

## Prerequisites

| Item | Requirement |
| --- | --- |
| Console | Deployed; browsers reach `EDGEWEIR_PUBLIC_URL`. See [Deployment overview](../deploy/README.en.md) |
| Node host | Linux (systemd), amd64 / arm64; reaches `EDGEWEIR_PUBLIC_URL` and the node channel (TCP 8443 by default); an account with sudo |
| Node inbound ports | TCP 80; TCP 443 once HTTPS is enabled |
| Domain | Its authoritative DNS records can be edited |
| Origin | Reachable from the node; its address is outside special-purpose ranges (private, loopback, and so on) or covered by the [origin allow list](admin.en.md#origin-allow-list) |

## 1. Complete the setup wizard

1. Read the setup token from the console log. Docker Compose:

   ```bash title="Console host"
   docker compose logs console | grep setupToken
   ```

   The log line is JSON: the `setupToken` field holds the token (prefix `ews_`) and the `url` field the setup page. An uninitialized console prints the same token at every start. For log locations of other deployment methods, see [Docker Compose](../deploy/docker.en.md) and [BaoTa Panel and aaPanel](../deploy/baota.en.md).

2. Open `EDGEWEIR_PUBLIC_URL` in a browser. An uninitialized console redirects to `/setup` (**Create administrator**).

3. Fill in the form and click **Finish**.

   | Field | Description |
   | --- | --- |
   | **Setup token** | The token from step 1 |
   | **Name** | Name of the platform administrator, at most 100 characters |
   | **Email** | Sign-in email |
   | **Password** | 12–128 characters |
   | **Organization** | Name of the first organization, default `Default` |

4. Verify: the console signs in and opens **Overview**; the **System** card of **Admin → System** shows **Setup token** as **Used {time}**.

Objects created by setup:

| Object | Value |
| --- | --- |
| Platform administrator | The account from the form; also owner of the first organization |
| Organization | The organization name from the form; slug derived from the name |
| Cluster | `default` with the default node group `default`; revision #1 published |
| Setup token | Spent; `/setup` redirects to the sign-in page from then on |

## 2. Enroll a node

> [!NOTE]
> Until edgeweir-node publishes an official release, the install command cannot download node packages; build the node from source as described in edgeweir-node's [Build and test](https://github.com/marvinli001/edgeweir-node/blob/master/README.en.md#build-and-test).

1. Open **Admin → Clusters & nodes**, select the cluster `default`, and click **Add node**.

2. Fill in the form and click **Generate command**.

   | Field | Description |
   | --- | --- |
   | **Node name** | Optional, at most 64 characters |
   | **Node group** | Defaults to the cluster's default node group |
   | **Valid for** | 15 min, 1 h (default), or 24 h |

3. Copy the **Install command** (shown once) and run it on the node host. Command format:

   ```bash title="Node host"
   export EDGEWEIR_TOKEN='ewt_…'
   curl -fsSL https://console.example.com/install.sh | sudo --preserve-env=EDGEWEIR_TOKEN bash -s -- --server https://console.example.com:8443 --ca-sha256 <CA fingerprint>
   ```

4. Verify: the node appears in the node table of **Admin → Clusters & nodes**, **Status** is **Online**, and **Applied** shows **In sync**.

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
   | **Caching** | On | When on, creates one cache rule: **Path prefix** `/`, **TTL (seconds)** 3600, **Respect origin Cache-Control** off |

3. Click **Create**. The console shows **Created, revision #N**, the site's cluster publishes a new revision, and the site page opens.

| Rule | Description |
| --- | --- |
| Cluster | The organization's default cluster; the oldest cluster when none is set |
| Domain ownership | Domains of a site created by a platform administrator show **Administrator approved**. A site created by an organization member needs the TXT check on its **Domains** tab; unverified domains are not published to nodes. See [Verify domain ownership](dns-and-alerts.en.md#verify-domain-ownership) |
| Origin address | Origins in special-purpose ranges are refused unless the platform allows the range |

For origin pools, cache rules, and cache keys, see [Origins and cache](origins-and-cache.en.md).

## 4. Configure DNS

Add a record for every site domain in the domain's authoritative DNS.

| Platform DNS | Record |
| --- | --- |
| Not configured | `A` / `AAAA` records to the node's public address. The **IP** column of the node table in **Admin → Clusters & nodes** lists the addresses the node reports. One record per node |
| Configured (**Admin → Platform DNS**) | A `CNAME` record to the address in the **CNAME target** card on the site's **Domains** tab (`<site ID>.<CNAME domain>`). The card shows **Published** once the records are written to the provider |

For lines, health-based removal, and TTL of platform DNS, see [Configure platform DNS](dns-and-alerts.en.md#configure-platform-dns).

## 5. Enable HTTPS

1. Open **Certificates** and click **Request certificate** (ACME) or **Upload certificate**. HTTP-01 validation requires the records from step 4 to be live.
2. On the site's **HTTPS** tab, select the certificate under **Certificates**, turn on **Redirect HTTP to HTTPS** if needed, and click **Save**.
3. The cluster publishes a new revision. Once a site in the cluster references a certificate, nodes listen on TCP 443.

For issuance methods, renewal, TLS, and HTTP/3, see [HTTPS and certificates](https.en.md).

## 6. Verify

1. Confirm the configuration is applied: in **Admin → Clusters & nodes**, the node's **Applied** revision equals the cluster's **Latest revision** and shows **In sync**.

2. Send an HTTP request straight to the node, bypassing DNS (replace `203.0.113.10` with the node address):

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

   Expected: `dig` returns the node address (preceded by the CNAME target with platform DNS); `curl` matches step 2.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Setup shows **Invalid setup token** | Wrong token, or already used | Read it from the log again; after setup, use the sign-in page |
| Setup shows **Setup is already in progress. Retry shortly.** | Another setup request is running | Retry shortly |
| Node missing or **Offline** | Enrollment failed, or the node cannot reach the node channel | See [Adding nodes](../deploy/nodes.en.md) and [Ports, reverse proxy, and trusted proxies](../deploy/networking.en.md) |
| **Applied** shows **Apply failed** | The node failed to validate or apply the configuration | Hover the badge for the reason |
| **Applied** shows **Upgrade required** | The node lacks a capability the configuration needs | Upgrade the node; see [Node upgrades](node-upgrades.en.md) |
| 404 with `X-Edgeweir-Error: unknown-host` | The domain is not in the node's configuration: revision not applied, or domain not verified | Check **Applied** and the ownership state on the **Domains** tab |
| 421 with `X-Edgeweir-Error: sni-host-mismatch` | SNI and `Host` of an HTTPS request differ | Use `--resolve` |
| 502 with `X-Edgeweir-Error: no-origin` | No usable origin | Check origin address, port, protocol, and health; see [Origins and cache](origins-and-cache.en.md) |
| 508 with `X-Edgeweir-Error: loop-detected` | The origin points back to a node | Point the origin at the real origin server |
| New site shows **Origin address … is in the special-purpose range …, which the platform does not allow** | The origin is a private, loopback, or similar address | A platform administrator adds the range to the [origin allow list](admin.en.md#origin-allow-list) |
| New site shows **Domain already in use: …** | The domain belongs to another site or organization | Use another domain, or remove it from the other site first |
