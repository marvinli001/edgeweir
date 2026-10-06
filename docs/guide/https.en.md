# HTTPS and certificates

Certificate upload, ACME requests and renewal, and a site's HTTPS, TLS, HTTP/2, HTTP/3, and compression settings.

## Concepts

| Term | Definition |
| --- | --- |
| Certificate | A certificate chain and private key. A site can select any certificate that covers all of its domains. |
| ACME certificate | A certificate the console requests from Let's Encrypt or ZeroSSL and renews automatically. |
| DNS credential | A DNS provider credential that DNS-01 validation uses to write TXT records. Separate from the provider credentials of DNS steering. |
| HTTPS settings | The certificate choice, redirect, HSTS, TLS, HTTP/2, and HTTP/3 options on a site's **HTTPS** tab; compression is set in the **Compression** card of the **Cache** tab. |

## Upload a certificate

1. Open **Certificates** and click **Upload certificate**.
2. Enter **Name**.
3. In **Certificate chain (PEM)**, choose a file or paste the content: leaf certificate first, then the intermediates in order.
4. In **Private key (PEM)**, choose a file or paste the content.
5. Click **Upload certificate**.
6. Verify: the certificate card shows **Ready** and "Expires … · … days remaining".

| Requirement | Value |
| --- | --- |
| Chain | 1–10 certificates, up to 128 KiB; each signed by the next; certificates only: PEM with a private key in it is refused ("The chain may contain only certificates; put the private key in its own field") |
| Leaf | Not a CA certificate, has DNS SANs, currently valid |
| Private key | Matches the leaf, up to 32 KiB |

Only the re-encoded certificates and the PKCS #8 private key are stored; any other text in the pasted content is not. Uploaded certificates do not renew automatically (**Automatic renewal disabled**); before expiry, upload a new certificate and select it on the sites.

## Add a DNS credential

DNS-01 validation needs a credential first.

1. Open **Certificates** and click **Add DNS credential**.
2. Enter **Name**, select **DNS provider**, and fill in the credential fields the form shows.
3. For providers that can list zones, click **List zones** and pick the **Zone**; otherwise type the **Zone**.
4. Click **Test connection** and check that **Connected** appears.
5. Click **Create**. Saving first runs the same test as **Test connection**; when it fails, the dialog shows the error and the button becomes **Save anyway**.
6. Verify: the credential appears in the **DNS credentials** card with its zone and provider.

The fields and least permissions of every provider are in [Providers and credentials](dns-and-alerts.en.md#providers-and-credentials); DNS steering uses the same provider catalog. Credentials are envelope-encrypted with the master key and are write-only; **Edit** renames the credential or rotates the secrets with **Replace credentials**; new secrets are tested before saving too, a rename alone is not, and after a failed test changing any field makes the next save test again. After a rotation, certificates using the credential that show **Issuance failed** and TXT records still to clean up are retried at once.

## Request an ACME certificate

Prerequisites:

- HTTP-01: every certificate name is a domain of a site (not a wildcard), resolves to the nodes, and port 80 on the nodes is reachable from the internet; the clusters serving the names have online nodes, all of them supporting `http01-v1`.
- DNS-01: a DNS credential exists whose zone covers every certificate name; the names need not be on a site.

1. Open **Certificates** and click **Request certificate**.
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
| Certificate authority | Let's Encrypt / ZeroSSL | Let's Encrypt | ACME directory; read-only **ACME directory (EDGEWEIR_ACME_DIRECTORY)** when that variable is set |
| Validation method | HTTP-01 / DNS-01 | HTTP-01 | Domain control validation; wildcards require DNS-01, and with HTTP-01 the form shows "Wildcards need DNS-01" under **Domains** |
| DNS credentials | A DNS credential that has been added | The first credential | Account DNS-01 writes TXT records with; one zone per certificate |
| Skip the DNS check | On / off | Off | HTTP-01 only: do not check that the names resolve to the nodes (at the request and before each issuance), for example with a load balancer in front of the nodes |
| EAB key ID / EAB HMAC key | EAB credentials from ZeroSSL | None | Required for ZeroSSL; stored encrypted |

Certificates with the same certificate authority, EAB key ID, and account email share one ACME account: CAs limit the accounts an IP address may register (Let's Encrypt: 10 in 3 hours).

### Validation methods

| Method | Behavior |
| --- | --- |
| HTTP-01 | Each name must be a non-wildcard domain of a site, or the request is refused ("Certificate domains do not match the site or DNS zone"): only the clusters serving a name answer its challenge. The console publishes all challenges of a certificate to those clusters at once (one revision per cluster, also when the site is disabled); every online node there must support `http01-v1` and apply it within 40 seconds before the CA is asked to validate, four names at a time. At the request and before each issuance the console resolves every name with the system's DNS (3 seconds a try, 2 tries): a name without A/AAAA records, or resolving to an address that is not one of the cluster's active nodes' (their configured scheduling addresses or reported public addresses), refuses the request ("These names do not resolve to the nodes: …") and fails the issuance without contacting the CA ("A domain does not resolve to the nodes"); lookups that time out and nodes without a known public address never stop it. Challenges are answered on port 80 without redirect or caching and expire after 10 minutes or when the issuance ends (other HTTP-01 tokens go to the origin, uncached and unchallenged, so that it can obtain certificates of its own); challenge revisions do not count toward the kept configuration revisions |
| DNS-01 | Each name must be inside the DNS credential's zone (the zone itself or a name below it), or the request is refused. Writes TXT records at `_acme-challenge.<domain>` and waits up to 3 minutes for propagation. When issuance ends, times out, or the process is interrupted, the TXT values it wrote are deleted; a failed deletion is retried after 1 minute, doubling up to 6 hours, and a zone the provider no longer has counts as deleted |

### Renewal

| Item | Behavior |
| --- | --- |
| Automatic renewal | On for certificates requested in the console |
| Renewal time | The CA's ARI (ACME Renewal Information) window when offered; otherwise when two thirds of the certificate lifetime have passed; at the latest 1 minute before expiry. The card shows "Next renewal: …" |
| Window changes | After issuance, the ARI window is read again at the CA's suggested interval (1–24 hours, 6 by default); when the window moves before the next renewal (for example, the CA is going to revoke certificates early), the renewal moves into the new window and the audit log records `certificate.renewal_rescheduled` |
| Check interval | A background job checks due certificates every minute, up to 10 at a time: new requests and **Renew now** first, then by renewal time, three issuances at once; it needs a console process with `ROLE=worker` or `ROLE=all` |
| Renewed names | An HTTP-01 renewal drops the names no site uses any more, as long as at least one name is left; every domain of a site that uses the certificate is kept, so the site stays covered. After a successful renewal the certificate's name list is updated. For a site's new domains see [Adding domains](#adding-domains-to-an-https-site) |
| Effect | After issuance or renewal, a new revision is published for the clusters of the sites that use the certificate |
| Failure | Status changes to **Issuance failed**, the card shows the reason, and the current certificate is kept; the next attempt waits a tenth of the certificate's remaining validity (10 minutes to 12 hours), 1 hour for a first issuance, see [Troubleshooting](#troubleshooting). An HTTP-01 certificate that failed because names did not resolve to the nodes ("A domain does not resolve to the nodes") has its names looked up again every 5 minutes and is retried as soon as they all point to the nodes |
| Manual | ACME certificates have **Renew now**, which runs at the next check; unavailable while **Issuing** |
| Interruption | **Issuing** for more than 10 minutes counts as interrupted and runs again at the next check; one issuance run is limited to 8 minutes |

### Deletion

Deleting a certificate used by sites returns "The certificate is used by sites: …" (up to 5 sites); while it is **Issuing**, "Certificate operation is already in progress". A certificate with DNS-01 TXT records still to clean up is deleted, and those records are no longer cleaned up: `leftDnsRecords` of the `certificate.delete` audit entry lists them for removal at the DNS provider. A DNS credential referenced by any certificate cannot be deleted ("The DNS credential is used by certificates: …").

## Enable HTTPS with one click

While a site has no usable certificate, its **HTTPS** tab shows only **Enable HTTPS**.

1. Open **Sites**, select the site, and open the **HTTPS** tab.
2. The console first checks whether a certificate can be issued; anything in the way is listed line by line and the button is unavailable. After fixing it, click **Check again**.
3. Click **Enable HTTPS**.
4. Verify: the tab shows **Requesting a certificate**; once issued it switches to the HTTPS settings, with the new certificate under **Certificates**. **Redirect HTTP to HTTPS** stays off; turn it on in the HTTPS settings when wanted.

| Item | Value |
| --- | --- |
| Certificate name, names | The site's name and all of its domains |
| Validation | HTTP-01; DNS-01 with the first DNS credential whose zone covers every name when the site has a wildcard domain |
| Account email | The email of the last ACME account or request, else the console account's email; editable under **Customize** |
| Certificate authority | Let's Encrypt; ZeroSSL under **Customize** (needs EAB credentials) |
| Once issued | The certificate is bound to the site (**Redirect HTTP to HTTPS** and the other settings stay as they are), the site's cluster is published, and the audit log records `site.https_update` (actor system); domains added to the site since the request are reissued right away. A site that has another usable certificate by then is left unchanged |

| Check | Cause |
| --- | --- |
| "Cluster … has no online node" | HTTP-01: the site's cluster has no online active node |
| "These nodes need an upgrade to answer HTTP-01: …" | HTTP-01: online nodes lack `http01-v1` |
| "… has no DNS record yet", "… does not point to the nodes" | HTTP-01: the name has no A/AAAA record, or resolves to addresses that are not the cluster's nodes; nothing is reported when lookups time out or no node address is known. When the console resolves names differently from the CA (split-horizon DNS, a load balancer in front), turn on **Skip the DNS check** under **Customize**: these two no longer stop the request, and the issuance does not check them either |
| "Wildcards need a DNS credential whose zone covers …" | DNS-01: there is no such DNS credential; click **Add DNS credential** |
| "DNS credential …: …" | DNS-01: the credential's connection test failed |
| "CAA records of … do not allow …" | CAA records of the name or a parent domain do not allow the chosen CA (Let's Encrypt: `letsencrypt.org`; ZeroSSL: `sectigo.com`, `trust-provider.com`, `usertrust.com`), `issuewild` and `validationmethods` included; not checked when `EDGEWEIR_ACME_DIRECTORY` is set |

While the certificate is issued, the tab refreshes its status every 3 seconds. A failure shows the classified reason (as on the certificate card) with **Retry** and **Cancel** (which deletes this certificate). When usable certificates already cover every domain of the site, the tab lists them under **Existing certificate**; **Use** selects one. When the site's ACME certificate is reissued or fails, the same status shows above the HTTPS settings.

## Configure a site's HTTPS

1. Open **Sites**, select the site, and open the **HTTPS** tab (for a site without a certificate see [Enable HTTPS with one click](#enable-https-with-one-click)).
2. Select a certificate in **Certificates**. The list contains every issued, unexpired certificate; **HTTP only** disables HTTPS.
3. Set **Minimum TLS version**, **Cipher profile**, **HSTS lifetime (seconds)**, and the switches.
4. Click **Save**. The console shows **Saved** and publishes a new configuration revision.
5. Verify: after the node applies the revision:

   ```bash
   curl -sI --resolve www.example.com:443:<node IP> https://www.example.com/
   ```

   The response is `HTTP/2 200` (with HTTP/2 on); it contains `strict-transport-security` with HSTS on, and `alt-svc: h3=":443"; ma=86400` with HTTP/3 on.

A configuration is in effect on a node only once the node reports the revision as applied.

### Adding domains to an HTTPS site

When new domains are saved on the site's **Domains** tab:

| The site's certificate | Behavior |
| --- | --- |
| Covers the new domains (including a wildcard `*.example.com` one label up) | Saved |
| Requested in the console with automatic renewal on | Saved; the certificate's names grow by the new domains and it is reissued right away ("Certificate … is being reissued for the new domains", audit `certificate.names_extended`). Until then the new domains are served over HTTP only: no TLS handshake, no HTTPS redirect, no HSTS, while the other domains keep the current certificate; once the new certificate is issued they get HTTPS too. While an active node of the cluster lacks `tls-pending-domains-v1`, the new domains take effect only once the new certificate is issued. HTTP-01 challenges are answered meanwhile. When the certificate is issuing, it is issued once more right after that attempt |
| Uploaded, or automatic renewal off | Refused with "Certificate domains do not match the site or DNS zone: …", naming the uncovered domains |

An HTTP-01 certificate cannot grow by wildcards, and a DNS-01 certificate only by names inside its DNS credential's zone; a certificate has at most 100 names.

### HTTPS fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Certificates | An unexpired certificate / HTTP only | HTTP only | Must cover every domain of the site; a wildcard site domain `*.example.com` requires the same `*.example.com` SAN. For domains added later see [Adding domains](#adding-domains-to-an-https-site) |
| Minimum TLS version | TLS 1.2 / TLS 1.3 | TLS 1.2 | Lowest version accepted in the handshake |
| Cipher profile | Modern / Compatible | Modern | TLS 1.2 cipher suites, see below |
| HSTS lifetime (seconds) | 0–63072000 | 0 | Above 0, HTTPS responses carry `Strict-Transport-Security`; needs a certificate |
| Redirect HTTP to HTTPS | On / off | Off | HTTP requests get a 301 to `https://<Host><request URI>` (port 443); needs a certificate; ACME challenge paths are not redirected |
| HTTP/2 | On / off | On | HTTPS connections for the site negotiate HTTP/2 |
| HTTP/3 | On / off | Off | Serves QUIC on UDP 443 and sends `Alt-Svc: h3=":443"; ma=86400` |
| HSTS for subdomains | On / off | Off | Adds `includeSubDomains` to HSTS |
| HSTS preload | On / off | Off | Adds `preload` to HSTS |
| OCSP stapling | On / off | Off | Staples an OCSP response in the handshake |

Selecting **HTTP only** turns off **Redirect HTTP to HTTPS** and resets the HSTS lifetime to 0.

| Cipher profile | TLS 1.2 suites |
| --- | --- |
| Modern | `ECDHE-ECDSA-AES128-GCM-SHA256`, `ECDHE-RSA-AES128-GCM-SHA256`, `ECDHE-ECDSA-CHACHA20-POLY1305`, `ECDHE-RSA-CHACHA20-POLY1305` |
| Compatible | The modern suites plus `ECDHE-ECDSA-AES256-GCM-SHA384` and `ECDHE-RSA-AES256-GCM-SHA384` |

TLS session resumption is off: nodes keep no session cache (TLS 1.2) and send no session tickets (TLS 1.2 and TLS 1.3), so every connection does a full handshake.

### Compression

The **Compression** card on a site's **Cache** tab has a group of settings each for Zstandard, Brotli, and Gzip, saved on their own (unsaved changes on the **HTTPS** tab stay):

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| On | On / off | Gzip on, Brotli and Zstandard off | Compresses responses with the algorithm |
| Level | Brotli 1–11, Zstandard 1–19 | Brotli 6, Zstandard 3 | Higher levels compress more and use more CPU; Gzip has no level |
| Minimum compression size (bytes) | 1–1048576 | 256 | Shorter responses are not compressed |
| Compressed content types | MIME types, separated by commas or spaces, up to 32 | `text/html`, `text/plain`, `text/css`, `application/javascript`, `application/json`, `image/svg+xml` | Response types to compress; `text/html` is always compressed |

| Behavior | Description |
| --- | --- |
| Negotiation | One enabled algorithm is chosen by the q-values of the request's `Accept-Encoding`; at equal q-values the order is zstd > br > gzip, and `q=0` means not acceptable. Each response is compressed by one algorithm only |
| `Vary` | Compressed responses carry `Vary: Accept-Encoding` |
| No double compression | Responses that already have a `Content-Encoding` (for example compressed by the origin) are passed through |
| Cache | The cache keeps uncompressed or origin-encoded content and each response is compressed for its request; cache hits negotiate the encoding the same way |
| Rules | Override settings turn an algorithm off or back on per request, and compression rules limit the algorithms of a response and their order at equal q-values; both choose only among the algorithms that are on and never bypass the cache, see [Rules](rules.en.md#override-settings) |
| Capabilities | Brotli needs `brotli-v1` on every active node of the cluster, Zstandard needs `zstd-v1`. While a node lacks it, the switch is unavailable with "Some nodes of the site's cluster do not support it yet"; an algorithm already on can still be turned off |

Verify after the node applies the revision:

```bash
curl -s -o /dev/null -D - -H 'Accept-Encoding: zstd' --resolve www.example.com:443:<node IP> https://www.example.com/
curl -s -o /dev/null -D - -H 'Accept-Encoding: br' --resolve www.example.com:443:<node IP> https://www.example.com/
```

They return `content-encoding: zstd` and `content-encoding: br`, with `vary: Accept-Encoding`.

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
| Checks | Nodes verify the fingerprint, the key match, and name coverage (except for domains served over HTTP until a new certificate covers them) |
| Storage | `certificates.json` (0600) in the node state directory; private keys on the node are not encrypted, and the host administrator can read them |
| Hot updates | Certificate content and minimum TLS version changes do not reload nginx |
| Reloads | Changes to HTTP/2, HTTP/3, compression, cipher profile, certificate presence, domain lists, or the set of sites are tested first and then reloaded; on failure the previous configuration is restored |
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
| `brotli-v1` | Any site with Brotli on |
| `zstd-v1` | Any site with Zstandard on |
| `tls-pending-domains-v1` | New domains of an HTTPS site are served over HTTP until the certificate covers them; without it they take effect once the new certificate is issued, and nothing is refused |

A change saved in the console or with an AccessKey is published even when it needs a capability some active nodes of the cluster lack; those nodes keep their last-known-good configuration and **Clusters & nodes** shows **Upgrade required**, see [Node upgrades](node-upgrades.en.md). A configuration published by a service account or a background job that introduces a capability an active node lacks is refused (`NODE_CAPABILITY_REQUIRED`) and the configuration stays unchanged.

## Limits

| Item | Description |
| --- | --- |
| Certificate authorities | The UI offers Let's Encrypt and ZeroSSL. `EDGEWEIR_ACME_DIRECTORY` and `EDGEWEIR_ACME_CA_FILE` move every certificate to a private or staging ACME directory; **Request certificate** then shows that directory instead of the CA and EAB fields, see [Environment variables](../reference/environment.en.md) |
| TLS versions | TLS 1.0 and 1.1 are not supported |
| Cipher suites | Only the **Modern** and **Compatible** profiles; no custom nginx configuration |
| Compression | Gzip, Brotli, and Zstandard |
| Node packages | Nodes use OpenResty 1.31.1.1 built for Edgeweir (`edgeweir-openresty`) with HTTP/2, HTTP/3, Brotli, and Zstandard, see [Adding nodes](../deploy/nodes.en.md) |
| Failure reasons | The card shows a classified reason: the CA's problem type (RFC 8555), a DNS provider error, or the console's own reason. The text a CA or DNS provider returned is neither stored nor logged; `certificate operation failed` in the console log records the certificate ID, the `code`, and the console's own reason |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "The chain must hold 1 to 10 readable PEM certificates" | The chain is empty, has more than 10 certificates, or is damaged | Export the chain as PEM again |
| "The private key cannot be read; encrypted keys are not supported" | The key is damaged or protected by a passphrase | Remove the passphrase with `openssl pkey -in key.pem -out plain.pem` and upload that |
| "The private key does not belong to the certificate" | The key belongs to another certificate | Upload the key of the leaf certificate |
| "Wrong chain order: the leaf certificate first, then each issuer" | An intermediate comes before the leaf, or a certificate is not issued by the next one | Order the PEM as leaf then intermediates |
| "The certificate is not valid now (valid from … to …)" | Not yet valid or expired (times in UTC) | Check the server clock, or use a valid certificate |
| "The certificate has no DNS names (subject alternative names)" | The certificate has only IP addresses or only a CN | Use a certificate with DNS SANs |
| "The certificate is not issued yet or has expired" | The certificate selected for a site is still pending, or has expired | Wait for issuance, or renew it first |
| "These names do not resolve to the nodes: …" | HTTP-01 names have no records, or resolve to the origin, another proxy, or other addresses that are not the cluster's nodes | Point the names to the nodes; with a load balancer in front of the nodes or a DNS change in progress, turn on **Skip the DNS check** |
| "No online node can answer HTTP-01 in cluster …" | The cluster serving the names has no online active node | Check the nodes, or use DNS-01 |
| "Some nodes don't support http01-v1 yet: …" | The listed online nodes lack `http01-v1` | Upgrade them, see [Node upgrades](node-upgrades.en.md) |
| "Certificate domains do not match the site or DNS zone: …" | The listed names: an HTTP-01 name is not a domain of any site; the DNS credential zone does not cover them; the selected certificate does not cover these site domains; a domain added to the site is not in its uploaded certificate, or is a wildcard an HTTP-01 certificate cannot get or a name outside a DNS-01 certificate's credential zone | Add the domain to a site first, or use DNS-01; use a matching DNS credential or certificate |
| Certificate shows **Issuance failed** | The reason on the card, see the rows below | Fix it and click **Renew now**; otherwise it retries after the [retry interval](#renewal) |
| "The CA did not accept the domain validation", "The CA received a wrong challenge answer", "The CA could not connect to the domain" | HTTP-01: the domain does not resolve to the nodes, port 80 is blocked, or another proxy is in front; DNS-01: the TXT record went to another zone | Check the DNS records and port 80 |
| "The CA could not resolve the domain" | The domain has no records, or its authoritative DNS fails | Add the records |
| "A CAA record does not allow this CA" | The domain's CAA records do not list the chosen CA | Add `letsencrypt.org` or `sectigo.com` (ZeroSSL) to CAA, or remove CAA |
| "CA rate limit reached" | Too many orders for the domain or account | Wait for the CA's limit window |
| "The CA requires EAB credentials" | CAs such as ZeroSSL need EAB | Request again with the EAB key ID and HMAC key |
| "The TXT record did not propagate within 3 minutes" | The DNS provider syncs slowly, or the credential's zone is not the domain's authoritative zone | Retry later; check the credential's zone |
| "Provider authentication failed" and other DNS provider reasons | The DNS provider refused the DNS-01 TXT record | Edit the DNS credential; certificates retry right after new credentials are saved |
| "No online node can answer HTTP-01 (http01-v1)", "Nodes did not apply the challenge within 40 seconds" | The cluster serving the domain has no online node, a node lacks `http01-v1`, or nodes apply configurations slowly | Check the cluster's nodes and upgrade them if needed |
| "A domain belongs to no site" | No certificate name is a site domain any more | Add the domain to a site, or use DNS-01 |
| "A domain does not resolve to the nodes" | The check before the issuance found a name that does not resolve to the cluster's nodes; the CA was not contacted | Fix the DNS records; it is retried within 5 minutes, or click **Renew now** |
| "Issuance failed; see the console log" | An unclassified error | Find `certificate operation failed` in the log of the console process that runs background jobs and follow its `reason` |
| Certificate stays **Pending** | No console process runs background jobs | Make sure a process with `ROLE=worker` or `ROLE=all` runs |
| "Certificate operation is already in progress" | The certificate is **Issuing**; or a request for the site is already waiting to be bound | Wait for issuance to finish; retry or cancel that request on the site's **HTTPS** tab |
| "The certificate is used by sites: …" | The listed sites selected the certificate | Select another certificate on their **HTTPS** tab first |
| "The DNS credential is used by certificates: …" | The listed certificates use the credential for DNS-01 | Delete those certificates first |
| A node shows **Upgrade required** | The node lacks a capability the configuration needs (such as `http3-v1`) and keeps its last-known-good configuration | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| 421 with `X-Edgeweir-Error: sni-host-mismatch` | TLS SNI differs from `Host`, for example a client reused a connection opened for another domain | The client opens a connection for the requested domain |
| Browsers do not use HTTP/3 | UDP 443 is blocked; the node lacks `http3-v1`; clients read `Alt-Svc` only after a first visit | Open UDP 443 and check node capabilities |
| Responses are not compressed | The content type is not listed; the response is below the minimum size; the client sent no `Accept-Encoding`; the origin response already has a `Content-Encoding` | Check the **Compression** settings on the **Cache** tab |
| gzip instead of br or zstd | The client's `Accept-Encoding` lacks the algorithm or gives it a lower q-value; the algorithm is off | Check the request header and the **Compression** settings |
| The Brotli or Zstandard switch is unavailable | An active node of the cluster lacks `brotli-v1` / `zstd-v1` | Upgrade the nodes |
