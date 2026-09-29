# HTTPS and certificates

Certificate upload, ACME requests and renewal, and a site's HTTPS, TLS, HTTP/2, HTTP/3, and compression settings.

## Concepts

| Term | Definition |
| --- | --- |
| Certificate | A certificate chain and private key owned by an organization. Only that organization's sites can use it. |
| ACME certificate | A certificate the console requests from Let's Encrypt or ZeroSSL and renews automatically. |
| DNS credential | An organization-level DNS provider credential that DNS-01 validation uses to write TXT records. Separate from the platform DNS provider credentials. |
| HTTPS settings | The certificate choice, redirect, HSTS, TLS, HTTP/2, HTTP/3, and compression options on a site's **HTTPS** tab. |

## Upload a certificate

1. Open **Console → Certificates** and click **Upload certificate**.
2. Enter **Name**.
3. In **Certificate chain (PEM)**, choose a file or paste the content: leaf certificate first, then the intermediates in order.
4. In **Private key (PEM)**, choose a file or paste the content.
5. Click **Upload certificate**.
6. Verify: the certificate card shows **Ready** and "Expires … · … days remaining".

| Requirement | Value |
| --- | --- |
| Chain | 1–10 certificates, up to 128 KiB; each signed by the next |
| Leaf | Not a CA certificate, has DNS SANs, currently valid |
| Private key | Matches the leaf, up to 32 KiB |

Uploaded certificates do not renew automatically (**Automatic renewal disabled**); before expiry, upload a new certificate and select it on the sites.

## Add a DNS credential

DNS-01 validation needs a credential first.

1. Open **Console → Certificates** and click **Add DNS credential**.
2. Enter **Name** and **DNS zone**, select **DNS provider**, and fill in the credential fields.
3. Click **Create**.
4. Verify: the credential appears in the **DNS credentials** card with its zone.

| DNS provider | Fields |
| --- | --- |
| Cloudflare | API token |
| Alibaba Cloud | Access key ID, Access key secret |
| Huawei Cloud | Access key ID, Access key secret, Region |
| DNSPod | API token (the `ID,Token` of the DNSPod classic API) |

Credentials are envelope-encrypted with the master key and are write-only. Grant the credential the minimum DNS edit permission on the zone.

## Request an ACME certificate

Prerequisites:

- Every certificate name is a domain of the organization's sites and has passed [domain ownership](dns-and-alerts.en.md#verify-domain-ownership) verification.
- HTTP-01: the domains resolve to the nodes, and port 80 on the nodes is reachable from the internet.
- DNS-01: a DNS credential exists whose zone covers every certificate name.

1. Open **Console → Certificates** and click **Request certificate**.
2. Enter **Name**, **Domains**, and **Account email**.
3. Select **Certificate authority** and **Validation method**. For DNS-01, select the **DNS credentials** entry; for ZeroSSL, enter **EAB key ID** and **EAB HMAC key**.
4. Click **Request certificate**.
5. Verify: the certificate card moves through **Pending**, **Issuing**, and **Ready**, and shows **Automatic renewal enabled** and "Next renewal: …".

### Request fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Name | 1–100 characters | None | The certificate's name in the console |
| Domains | 1–100 names, separated by commas or spaces, no duplicates; `*.` wildcards allowed | None | Certificate SANs |
| Account email | Email address | None | ACME account contact |
| Certificate authority | Let's Encrypt / ZeroSSL | Let's Encrypt | ACME directory |
| Validation method | HTTP-01 / DNS-01 | HTTP-01 | Domain control validation; wildcards require DNS-01 |
| DNS credentials | A DNS credential of the organization | The first credential | Account DNS-01 writes TXT records with; one zone per certificate |
| EAB key ID / EAB HMAC key | EAB credentials from ZeroSSL | None | Required for ZeroSSL; stored encrypted with the ACME account |

### Validation methods

| Method | Behavior |
| --- | --- |
| HTTP-01 | Each name must be a verified, non-wildcard domain of an enabled site of the organization. The console publishes the challenge to that site's cluster; every online node must support `http01-v1` and apply it within 40 seconds before the CA is asked to validate. The challenge is answered on port 80 without redirect or caching and expires after 10 minutes |
| DNS-01 | Writes TXT records at `_acme-challenge.<domain>` and waits up to 3 minutes for propagation. When issuance ends, times out, or the process is interrupted, the TXT values it wrote are deleted; a certificate with records still to clean up cannot be deleted |

### Renewal

| Item | Behavior |
| --- | --- |
| Automatic renewal | On for certificates requested in the console |
| Renewal time | The CA's ARI (ACME Renewal Information) window when offered; otherwise when two thirds of the certificate lifetime have passed; at the latest 1 minute before expiry. The card shows "Next renewal: …" |
| Check interval | A background job checks due certificates every minute and needs a console process with `ROLE=worker` or `ROLE=all` |
| Effect | After issuance or renewal, a new revision is published for the clusters of the sites that use the certificate |
| Failure | Status changes to **Issuance failed**, the current certificate is kept, and the next attempt is 1 hour later |
| Manual | ACME certificates have **Renew now**, which runs at the next check; unavailable while **Issuing** |
| Interruption | **Issuing** for more than 10 minutes counts as interrupted and runs again at the next check; one issuance run is limited to 5 minutes |

### Deletion

A certificate used by a site, in **Issuing**, or with DNS-01 records still to clean up returns "Certificate or credential is still in use" on delete. A DNS credential referenced by any certificate cannot be deleted.

## Configure a site's HTTPS

1. Open **Console → Sites**, select the site, and open the **HTTPS** tab.
2. Select a certificate in **Certificates**. The list contains the organization's unexpired certificates; **HTTP only** disables HTTPS.
3. Set **Minimum TLS version**, **Cipher profile**, **HSTS lifetime (seconds)**, and the switches.
4. Click **Save**. The console shows **Saved** and publishes a new configuration revision.
5. Verify: after the node applies the revision:

   ```bash
   curl -sI --resolve www.example.com:443:<node IP> https://www.example.com/
   ```

   The response is `HTTP/2 200` (with HTTP/2 on); it contains `strict-transport-security` with HSTS on, and `alt-svc: h3=":443"; ma=86400` with HTTP/3 on.

A configuration is in effect on a node only once the node reports the revision as applied.

### HTTPS fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Certificates | An unexpired certificate of the organization / HTTP only | HTTP only | Must cover every domain of the site; a wildcard site domain `*.example.com` requires the same `*.example.com` SAN |
| Minimum TLS version | TLS 1.2 / TLS 1.3 | TLS 1.2 | Lowest version accepted in the handshake |
| Cipher profile | Modern / Compatible | Modern | TLS 1.2 cipher suites, see below |
| HSTS lifetime (seconds) | 0–63072000 | 0 | Above 0, HTTPS responses carry `Strict-Transport-Security`; needs a certificate |
| Redirect HTTP to HTTPS | On / off | Off | HTTP requests get a 301 to `https://<Host><request URI>` (port 443); needs a certificate; ACME challenge paths are not redirected |
| HTTP/2 | On / off | On | HTTPS connections for the site negotiate HTTP/2 |
| HTTP/3 | On / off | Off | Serves QUIC on UDP 443 and sends `Alt-Svc: h3=":443"; ma=86400` |
| HSTS for subdomains | On / off | Off | Adds `includeSubDomains` to HSTS |
| HSTS preload | On / off | Off | Adds `preload` to HSTS |
| Gzip | On / off | On | Compresses responses and adds `Vary: Accept-Encoding` |
| OCSP stapling | On / off | Off | Staples an OCSP response in the handshake |
| Minimum compression size (bytes) | 1–1048576 | 256 | Shorter responses are not compressed |
| Compressed content types | MIME types, separated by commas or spaces, up to 32 | `text/html`, `text/plain`, `text/css`, `application/javascript`, `application/json`, `image/svg+xml` | Response types to compress; `text/html` is always compressed |
| Brotli / Zstd | Unavailable | Off | The engine is built without these modules; they cannot be turned on |

Selecting **HTTP only** turns off **Redirect HTTP to HTTPS** and resets the HSTS lifetime to 0.

| Cipher profile | TLS 1.2 suites |
| --- | --- |
| Modern | `ECDHE-ECDSA-AES128-GCM-SHA256`, `ECDHE-RSA-AES128-GCM-SHA256`, `ECDHE-ECDSA-CHACHA20-POLY1305`, `ECDHE-RSA-CHACHA20-POLY1305` |
| Compatible | The modern suites plus `ECDHE-ECDSA-AES256-GCM-SHA384` and `ECDHE-RSA-AES256-GCM-SHA384` |

TLS session tickets are off.

### Listening ports

| Port | Protocol | Condition |
| --- | --- | --- |
| 80/TCP | HTTP, HTTP-01 challenges | Always |
| 443/TCP | HTTPS (HTTP/1.1, HTTP/2) | Any enabled site in the cluster has a certificate selected |
| 443/UDP | HTTP/3 (QUIC) | Any site with a certificate in the cluster turns on HTTP/3 |

The ports cannot be changed. The SNI of an HTTPS request must equal its `Host`; otherwise the node returns 421.

### OCSP stapling

| Item | Behavior |
| --- | --- |
| Response checks | Only responses whose signature, certificate identity, and validity check out and whose status is good; the issuer certificate must be in the chain |
| Outbound limits | Refuses private and other special-purpose addresses and redirects; 5-second connect, 8-second request, responses up to 1 MiB |
| Refresh | Checked every 5 minutes and on every configuration apply; refreshed when less than 1 hour of validity remains |
| No OCSP URL | Certificates without an OCSP responder URL get no staple |

## Certificates on nodes

| Item | Behavior |
| --- | --- |
| Delivery | Nodes fetch certificate material separately over mTLS; only certificate IDs and fingerprints referenced by the cluster's current target configuration are released |
| Checks | Nodes verify the fingerprint, the key match, and name coverage |
| Storage | `certificates.json` (0600) in the node state directory; private keys on the node are not encrypted, and the host administrator can read them |
| Hot updates | Certificate content and minimum TLS version changes do not reload nginx |
| Reloads | Changes to HTTP/2, HTTP/3, Gzip, cipher profile, certificate presence, domain lists, or the set of sites are tested first and then reloaded; on failure the previous configuration is restored |
| Applied | A node reports a revision as applied only after persisting it; keys referenced by the current and previous last-known-good configurations are kept |
| Rollback | A configuration rollback uses the current certificate material; it is refused when the certificate is deleted, expired, or does not cover the target domains |

## Key handling

ACME account keys, certificate private keys, and DNS credentials are each envelope-encrypted with the master key, bound to their record ID. The certificate helper `edgeweir-certd` is started by background jobs and receives credentials only over stdin/stdout, never on the command line, in logs, or in the node configuration.

## Node capabilities

| Capability | Needed for |
| --- | --- |
| `tls-v1` | Sites whose **HTTPS** tab has been saved |
| `http01-v1` | HTTP-01 validation |
| `http3-v1` | Any site with HTTP/3 on |

A tenant change that introduces a capability some active node of the cluster lacks is refused ("Cluster nodes need these capabilities first: …") and the configuration stays unchanged. Nodes lacking a capability keep their last-known-good configuration and the admin area shows **Upgrade required**, see [Node upgrades](node-upgrades.en.md).

## Limits

| Item | Description |
| --- | --- |
| Certificate authorities | The UI offers Let's Encrypt and ZeroSSL. `EDGEWEIR_ACME_DIRECTORY` and `EDGEWEIR_ACME_CA_FILE` move every certificate to a private or staging ACME directory, see [Environment variables](../reference/environment.en.md) |
| TLS versions | TLS 1.0 and 1.1 are not supported |
| Cipher suites | Only the **Modern** and **Compatible** profiles; no custom nginx configuration |
| Compression | Gzip only; Brotli and Zstd are unavailable. Compression settings apply after the site's **HTTPS** tab is saved for the first time |
| Node packages | The node Docker image is based on OpenResty 1.31.1.1 with HTTP/2 and HTTP/3; deb/rpm installs use the distribution's `openresty` package |
| Failure reasons | Neither the UI nor the console log shows the reason a CA or DNS provider returned |
| Validation scope | Real DNS provider accounts, ZeroSSL EAB, CA rate limits, DNS propagation, and public firewalls must be verified by the operator |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "Invalid or expired certificate, chain or private key" | Wrong chain order, mismatched key, no DNS SAN, not yet valid, or expired | Order the PEM as leaf then intermediates; check the key |
| "Certificate domains do not match the site or DNS zone" | A requested name is not on the organization's sites; the DNS credential zone does not cover every name; the selected certificate does not cover every site domain | Add the domain to a site first; use a matching DNS credential or certificate |
| "Verify domain ownership first" | The registrable domain of a certificate name is unverified | Complete [domain ownership](dns-and-alerts.en.md#verify-domain-ownership) verification |
| Certificate shows **Issuance failed** | HTTP-01: the domain does not resolve to the nodes, port 80 is blocked, a node did not apply the challenge within 40 seconds or lacks `http01-v1`; DNS-01: insufficient credential permissions or propagation over 3 minutes; CA rate limits | Fix the cause and click **Renew now**; otherwise it retries after 1 hour |
| Certificate stays **Pending** | No console process runs background jobs | Make sure a process with `ROLE=worker` or `ROLE=all` runs |
| "Certificate operation is already in progress" | The certificate is **Issuing** | Wait for issuance to finish |
| "Certificate or credential is still in use" | The certificate is used by a site, issuing, or has DNS records to clean up; the DNS credential is referenced by a certificate | Select another certificate on the sites, or delete the certificates that reference the credential |
| "Cluster nodes need these capabilities first: …" | An active node of the cluster lacks a required capability | Upgrade the nodes; a platform administrator can publish deliberately |
| 421 with `X-Edgeweir-Error: sni-host-mismatch` | TLS SNI differs from `Host`, for example a client reused a connection opened for another domain | The client opens a connection for the requested domain |
| Browsers do not use HTTP/3 | UDP 443 is blocked; the node lacks `http3-v1`; clients read `Alt-Svc` only after a first visit | Open UDP 443 and check node capabilities |
| Responses are not compressed | The **HTTPS** tab was never saved; the content type is not listed; the response is below the minimum size; the client sent no `Accept-Encoding` | Save the **HTTPS** tab and check the compression settings |
