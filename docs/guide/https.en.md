# HTTPS and certificates

Certificate upload, ACME requests and renewal, and a site's HTTPS, several certificates, client certificates, TLS session resumption, HTTP/2, HTTP/3, and compression settings.

## Concepts

| Term | Definition |
| --- | --- |
| Certificate | A certificate chain and private key. A site can select any certificate that covers all of its domains. |
| ACME certificate | A certificate the console requests from Let's Encrypt, ZeroSSL, Google Trust Services or a custom ACME directory and renews automatically. |
| ACME account | An account the console registered with a CA, one per directory, EAB key ID and email, shared by the certificates of that combination. |
| DNS credential | A DNS provider credential that DNS-01 validation uses to write TXT records. Separate from the provider credentials of DNS steering. |
| HTTPS settings | The certificates (up to 4), redirect, HSTS, TLS, HTTP/2, HTTP/3, and client certificate options on a site's **HTTPS** tab; compression is set in the **Compression** card of the **Cache** tab. |
| Client certificate | A certificate a visitor presents in the TLS handshake, issued by a CA the site trusts (mutual TLS). |
| Listener ports | The ports nodes take HTTP and HTTPS traffic on: 80, 443 and the cluster's extra ports; a site chooses some of them in its **Ports** card. |

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
| Key type | The leaf's key is RSA (2048 bits or more) or ECDSA P-256, P-384 or P-521; other curves (secp256k1, Brainpool, SM2, P-224), Ed25519, Ed448, ML-DSA, RSA-PSS and DSA are refused |
| Private key | Matches the leaf, up to 32 KiB |
| EC keys | Certificates and private key use a named curve (the curve's OID); explicit curve parameters are refused |

Only the re-encoded certificates and the PKCS #8 private key are stored; any other text in the pasted content is not. Uploaded certificates do not renew automatically (**Automatic renewal disabled**); before expiry, upload a new certificate and select it on the sites. An expired certificate's card shows **Expired** and "Expired …".

Nodes cannot load certificates with explicit curve parameters uploaded earlier either: no node of a cluster applies a revision that references one. A background job checks the uploaded certificates at every start: such a certificate's card shows **Unusable** with the reason, and the audit log records "Certificate marked unloadable" with the sites that use it. Sites can no longer select it; a site that uses it is not changed automatically: upload a named-curve certificate (see [Troubleshooting](#troubleshooting)), select it on the site's **HTTPS** tab and save, or choose **HTTP only**, then delete the old certificate.

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
3. Select **Certificate authority**, **Key type**, and **Validation method**. For DNS-01, select the **DNS credentials** entry; for ZeroSSL or Google Trust Services, enter **EAB key ID** and **EAB HMAC key**.
4. Click **Request certificate**.
5. Verify: the certificate card moves through **Pending**, **Issuing**, and **Ready**, and shows **Automatic renewal enabled** and "Next renewal: …".

### Request fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Name | 1–100 characters | None | The certificate's name in the console |
| Domains | 1–100 names, separated by commas or spaces, no duplicates; `*.` wildcards allowed | None | Certificate SANs |
| Account email | Email address | None | ACME account contact |
| Certificate authority | Let's Encrypt / ZeroSSL / Google Trust Services / Custom ACME directory | Let's Encrypt; the custom ACME directory while its URL comes from `EDGEWEIR_ACME_DIRECTORY` only | The issuing CA, see [Certificate authorities](#certificate-authorities); **Custom ACME directory** appears once it is configured in [system settings](system.en.md#certificate-authorities), and the form then shows its URL |
| Key type | ECDSA P-256 / RSA 2048 | ECDSA P-256 | The type of the certificate's private key, kept on renewal. To serve old RSA-only clients too, request an RSA certificate as well and add it to the site, see [Several certificates](#several-certificates) |
| Validation method | HTTP-01 / DNS-01 | HTTP-01 | Domain control validation; wildcards require DNS-01, and with HTTP-01 the form shows "Wildcards need DNS-01" under **Domains** |
| DNS credentials | A DNS credential that has been added | The first credential | Account DNS-01 writes TXT records with; one zone per certificate |
| Skip the DNS check | On / off | Off | HTTP-01 only: do not check that the names resolve to the nodes (at the request and before each issuance), for example with a load balancer in front of the nodes |
| EAB key ID / EAB HMAC key | EAB credentials from the CA | None | Required for ZeroSSL and Google Trust Services, both or neither; for the custom directory, empty fields use the system settings' EAB (placeholder "Empty: the system settings' EAB key"). Stored encrypted |

Certificates with the same ACME directory, EAB key ID, and account email share one ACME account: CAs limit the accounts an IP address may register (Let's Encrypt: 10 in 3 hours). Accounts are listed in the **ACME accounts** card, see [ACME accounts](#acme-accounts).

### Certificate authorities

| CA | ACME directory | EAB | CAA issuers |
| --- | --- | --- | --- |
| Let's Encrypt | `https://acme-v02.api.letsencrypt.org/directory` | Not needed | `letsencrypt.org` |
| ZeroSSL | `https://acme.zerossl.com/v2/DV90` | Required (generated in the ZeroSSL dashboard) | `sectigo.com`, `trust-provider.com`, `usertrust.com` |
| Google Trust Services | `https://dv.acme-v02.api.pki.goog/directory` | Required (`gcloud publicca external-account-keys create`; use within 7 days, registers once) | `pki.goog` |
| Custom ACME directory | The URL in **System settings → Certificate authorities**, or `EDGEWEIR_ACME_DIRECTORY` | When the directory requires it; empty request fields use the system settings' EAB | The names in the directory's `meta.caaIdentities`; without them CAA is not checked |

The custom directory's URL, EAB and CA certificates: [system settings](system.en.md#certificate-authorities); a value saved there wins over `EDGEWEIR_ACME_DIRECTORY` and `EDGEWEIR_ACME_CA_FILE`. An API request without a CA uses the custom directory while its URL comes from the environment variable only, Let's Encrypt otherwise: deployments that only used the environment variable behave the same after upgrading, and certificates issued that way are recorded as **Custom ACME directory** when background jobs start, so they renew from that directory. Once the custom directory's configuration is removed, certificates that chose it fail to renew ("No custom ACME directory is configured any more").

### ACME accounts

The **ACME accounts** card of the **Certificates** page lists the accounts the console registered: email, CA, directory URL, EAB key ID, creation time and **Certificates using it**. An account no certificate uses can be deleted (confirm "Delete the ACME account {email}?"): only the account and key the console stores are deleted, the account is not deactivated at the CA. While certificates use it the delete button is disabled and the API answers "Certificates use the ACME account: …". Deletion is audited as `acme_account.delete`. A later request with the same directory, EAB and email registers a new account.

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
| Expiry | When renewals keep failing until the certificate expires, its status shows **Expired** and the card still shows the reason; while a retry runs the status is **Pending** or **Issuing** and the card shows "Expired …" |
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
| Certificate name, names | The site's name; the site's exact and wildcard domains, `*.a.com` for a suffix domain `.a.com`, no names for pattern domains ([domains and unknown hosts](domains.en.md#limits-of-suffix-and-pattern-domains)) |
| Validation | HTTP-01; DNS-01 with the first DNS credential whose zone covers every name when the site has a wildcard or suffix domain |
| Account email | The email of the last ACME account or request, else the console account's email; editable under **Customize** |
| Certificate authority | The default of **Request certificate**; another under **Customize** (ZeroSSL and Google Trust Services need EAB credentials) |
| Key type | ECDSA P-256 |
| Once issued | The certificate is bound to the site (**Redirect HTTP to HTTPS** and the other settings stay as they are), the site's cluster is published, and the audit log records `site.https_update` (actor system); domains added to the site since the request are reissued right away. A site that has another usable certificate by then is left unchanged |

| Check | Cause |
| --- | --- |
| "Cluster … has no online node" | HTTP-01: the site's cluster has no online active node |
| "These nodes need an upgrade to answer HTTP-01: …" | HTTP-01: online nodes lack `http01-v1` |
| "… has no DNS record yet", "… does not point to the nodes" | HTTP-01: the name has no A/AAAA record, or resolves to addresses that are not the cluster's nodes; nothing is reported when lookups time out or no node address is known. When the console resolves names differently from the CA (split-horizon DNS, a load balancer in front), turn on **Skip the DNS check** under **Customize**: these two no longer stop the request, and the issuance does not check them either |
| "Wildcards need a DNS credential whose zone covers …" | DNS-01: there is no such DNS credential; click **Add DNS credential** |
| "DNS credential …: …" | DNS-01: the credential's connection test failed |
| "The site has only pattern domains: no name to issue for" | Every domain of the site is a pattern domain |
| "CAA records of … do not allow …" | CAA records of the name or a parent domain do not allow the chosen CA (issuers: [Certificate authorities](#certificate-authorities)), `issuewild` and `validationmethods` included; not checked for a custom directory without `meta.caaIdentities` |

While the certificate is issued, the tab refreshes its status every 3 seconds. A failure shows the classified reason (as on the certificate card) with **Retry** and **Cancel** (which deletes this certificate). When usable certificates already cover every domain of the site, the tab lists them under **Existing certificate**; **Use** selects one. When the site's ACME certificate is reissued or fails, the same status shows above the HTTPS settings.

## Configure a site's HTTPS

1. Open **Sites**, select the site, and open the **HTTPS** tab (for a site without a certificate see [Enable HTTPS with one click](#enable-https-with-one-click)).
2. Select a certificate in **Certificates**. The list contains every issued, unexpired certificate nodes can load; **HTTP only** disables HTTPS. For more certificates click **Add certificate**, see [Several certificates](#several-certificates).
3. Set **Minimum TLS version**, **Cipher profile**, **HSTS lifetime (seconds)**, and the switches.
4. Click **Save**. The console shows **Saved** and publishes a new configuration revision.
5. Verify: after the node applies the revision:

   ```bash
   curl -sI --resolve www.example.com:443:<node IP> https://www.example.com/
   ```

   The response is `HTTP/2 200` (with HTTP/2 on); it contains `strict-transport-security` with HSTS on, and `alt-svc: h3=":443"; ma=86400` with HTTP/3 on.

A configuration is in effect on a node only once the node reports the revision as applied.

### HTTPS redirect options

With **Force HTTPS** on, the redirect options appear below the switches:

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Redirect status | 301, 302, 303, 307, 308 | 301 | Status of the redirect |
| Redirect port | 443 or an HTTPS port the site is bound to | 443 | Port of the target URL; with 443 the URL has no port ("Redirect port {port} is not an HTTPS port of the site") |
| Domains not redirected | Exact and wildcard domains of the site, at most 50 | None | These domains are not redirected by **Force HTTPS**; a wildcard is written `*.example.com`, and an exact domain of the site is not covered by it. Hosts of suffix and pattern domains the certificate does not name are never redirected |

A [config rule](rules.en.md)'s `forceHttps` still turns the redirect on or off per request: when a rule turns it on, the status and port above apply and excluded domains are redirected too. Removing the HTTPS port the redirect goes to is refused; choosing no certificate sets the redirect port back to 443, and removing a domain from the site also removes it from the excluded domains. Configurations with values other than the defaults need `edge-ports-v1`.

Verify:

```bash
curl -sI -H 'Host: www.example.com' http://<node IP>:8081/a
```

The chosen status returns with `location: https://www.example.com:9443/a` (redirect port 9443).

### Adding domains to an HTTPS site

When new domains are saved on the site's **Domains** tab:

| The site's certificate | Behavior |
| --- | --- |
| One of the site's certificates covers the new domains (including a wildcard `*.example.com` one label up) | Saved |
| The first certificate was requested in the console with automatic renewal on | Saved; the certificate's names grow by the new domains and it is reissued right away ("Certificate … is being reissued for the new domains", audit `certificate.names_extended`). Until then the new domains are served over HTTP only: no TLS handshake, no HTTPS redirect, no HSTS, while the other domains keep the current certificate; once the new certificate is issued they get HTTPS too. While an active node of the cluster lacks `tls-pending-domains-v1`, the new domains take effect only once the new certificate is issued. HTTP-01 challenges are answered meanwhile. When the certificate is issuing, it is issued once more right after that attempt |
| Uploaded, or automatic renewal off | Refused with "Certificate domains do not match the site or DNS zone: …", naming the uncovered domains |

An HTTP-01 certificate cannot grow by wildcards, and a DNS-01 certificate only by names inside its DNS credential's zone; a certificate has at most 100 names. `.` suffix and pattern domains do not grow a certificate: nodes complete handshakes only for the host names it covers (the same name or `*.` one label up) and abort the others, see [limits of suffix and pattern domains](domains.en.md#limits-of-suffix-and-pattern-domains).

### HTTPS fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Certificates | An unexpired certificate / HTTP only | HTTP only | The site's first certificate. Every domain of the site must be covered by one of the site's certificates; a wildcard site domain `*.example.com` requires the same `*.example.com` SAN. For domains added later see [Adding domains](#adding-domains-to-an-https-site) |
| Certificate 2–4 | An unexpired certificate | None | Further certificates added with **Add certificate**, each once, see [Several certificates](#several-certificates) |
| Minimum TLS version | TLS 1.2 / TLS 1.3 | TLS 1.2 | Lowest version accepted in the handshake |
| Cipher profile | Modern / Compatible | Modern | TLS 1.2 cipher suites, see below |
| HSTS lifetime (seconds) | 0–63072000 | 0 | Above 0, HTTPS responses carry `Strict-Transport-Security`; needs a certificate |
| Redirect HTTP to HTTPS | On / off | Off | HTTP requests get a 301 to `https://<Host><request URI>` (port 443); needs a certificate; ACME challenge paths are not redirected |
| HTTP/2 | On / off | On | HTTPS connections for the site negotiate HTTP/2 |
| HTTP/3 | On / off | Off | Serves QUIC on UDP 443 and sends `Alt-Svc: h3=":443"; ma=86400` |
| HSTS for subdomains | On / off | Off | Adds `includeSubDomains` to HSTS |
| HSTS preload | On / off | Off | Adds `preload` to HSTS |
| OCSP stapling | On / off | Off | Staples an OCSP response in the handshake |

Selecting **HTTP only** turns off **Redirect HTTP to HTTPS**, resets the HSTS lifetime to 0, and drops the further certificates and client certificates.

| Cipher profile | TLS 1.2 suites |
| --- | --- |
| Modern | `ECDHE-ECDSA-AES128-GCM-SHA256`, `ECDHE-RSA-AES128-GCM-SHA256`, `ECDHE-ECDSA-CHACHA20-POLY1305`, `ECDHE-RSA-CHACHA20-POLY1305` |
| Compatible | The modern suites plus `ECDHE-ECDSA-AES256-GCM-SHA384` and `ECDHE-RSA-AES256-GCM-SHA384` |

### Several certificates

A site has up to 4 certificates: **Certificates** is the first, **Add certificate** adds up to 3 more (**Certificate 2** … **Certificate 4**), and the remove button next to each drops it.

| Item | Behavior |
| --- | --- |
| Coverage | Every domain must be covered by at least one of them; each need not cover all. Otherwise saving is refused with the uncovered domains ("Certificate domains do not match the site or DNS zone: …"). For example one certificate for `a.example.com` and one for `b.example.com` |
| Choice per handshake | Each handshake presents one: among the certificates covering the SNI, only key types the client can use count (ECDSA needs the scheme of the certificate's curve among its signature algorithms, and TLS 1.3 or an `ECDHE-ECDSA-*` suite of the profile; all of them when it can use none); of those an exact name wins over a wildcard, then ECDSA, then the site's order. Without a certificate covering the SNI, the first one |
| ECDSA and RSA | With an ECDSA and an RSA certificate for the same names, modern clients get the ECDSA one and old RSA-only clients the RSA one |
| OCSP stapling | Staples the chosen certificate's own OCSP response |
| Adding domains | New domains only grow the first certificate (when the console requested it with automatic renewal), see [Adding domains](#adding-domains-to-an-https-site) |
| Deleting a certificate | Any of a site's certificates counts as used: deletion answers "The certificate is used by sites: …" |
| Node capability | More than one certificate needs `multi-certificate-v1`; while an active node of the cluster lacks it, **Add certificate** is disabled with "Some nodes of the site's cluster do not support it yet" |

Check (after the nodes apply the revision):

```bash
openssl s_client -connect <node IP>:443 -servername a.example.com </dev/null 2>/dev/null | grep -E 'subject=|Server public key'
openssl s_client -connect <node IP>:443 -servername a.example.com -tls1_2 -cipher ECDHE-RSA-AES128-GCM-SHA256 -sigalgs 'rsa_pss_rsae_sha256:RSA+SHA256' </dev/null 2>/dev/null | grep 'Server public key'
```

The first shows the certificate covering `a.example.com` (`256 bit` for ECDSA); the second acts as an RSA-only client and shows `2048 bit`.

### Client certificates

**Client certificates** on the **HTTPS** tab asks visitors for a certificate issued by a CA the site trusts (mutual TLS), for example for a site only internal systems or partners use.

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Client certificates | Off / Optional / Required | Off | Optional: the handshake asks for a certificate, requests without one or with one that fails verification go on and rules can read the outcome; Required: 403 without a verified certificate |
| CA certificates (PEM) | 1–10 current CA certificates, at most 64 KiB | None | The CAs issuing client certificates; only the re-encoded certificates are stored |
| Verification depth | 1–5 | 2 | Maximum depth of the client's certificate chain |
| Send certificate details to the origin | On / off | Off | Sends the request headers below to the origin |

| Item | Behavior |
| --- | --- |
| Required | Without a certificate, with one the CA did not issue or with an expired one: the 403 error page with `X-Edgeweir-Error: client-cert-required`, before the rest of the site's logic. The handshake itself is not aborted, so browsers show the error page |
| Plain HTTP | Requests reaching a Required site over HTTP are redirected when **Redirect HTTP to HTTPS** is on, and get the same 403 otherwise; HTTP-01 challenges are answered |
| Request headers | `X-Client-Verify` (`SUCCESS`, `FAILED` or `NONE`) always; `X-Client-Cert-SHA256` (SHA-256 of the DER, lowercase hex), `X-Client-Cert-Subject` (the subject, RFC 2253) and `X-Client-Cert-Serial` (serial number, uppercase hex) only for a verified certificate |
| Visitors' own headers | Every site removes these four headers from visitors' requests, so the values origins see only come from the node |
| Rule fields | `tls.client.verified` (boolean), `tls.client.cert_sha256`, `tls.client.subject` (strings); `false` and empty without a verified certificate, see [rule fields](rules.en.md) |
| Session resumption | A resumed session keeps the first handshake's verification outcome |
| HTTP/3 | Cannot be on together with HTTP/3 ("Client certificates and HTTP/3 cannot be on together"): with client certificates on, the HTTP/3 switch is disabled |
| Node capability | `client-cert-v1`; while an active node of the cluster lacks it the setting is disabled |

Check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' --resolve m.example.com:443:<node IP> https://m.example.com/
curl -s --cert client.pem --key client.key --resolve m.example.com:443:<node IP> https://m.example.com/
```

With Required the first answers 403 and the second the origin's content; with the details sent, the origin sees `X-Client-Verify: SUCCESS`.

### TLS session resumption

| Item | Behavior |
| --- | --- |
| Session cache | 16 MiB of shared memory per node (about 64,000 sessions), sessions last 1 hour; TLS 1.2 session IDs resume on the same node only |
| Session tickets | TLS 1.2 and TLS 1.3 tickets are encrypted with keys the cluster shares, so any node of the cluster resumes them; the keys rotate every 12 hours (revision reason "TLS session ticket keys rotated", audit `cluster.session_ticket_keys_rotate`), and tickets issued before a rotation still resume until the next one |
| Per site | A session resumes on the site that created it only: with site A's session and site B's SNI the handshake is a full one |
| 0-RTT | TLS 1.3 early data is never accepted: tickets allow none and the node configuration turns it off explicitly |
| Ticket keys | Generated by the console and stored envelope-encrypted; nodes fetch them over mTLS into their state directory (0600). Older nodes ignore them and do not resume sessions |

Check:

```bash
openssl s_client -connect <node IP>:443 -servername www.example.com -sess_out sess.pem </dev/null
openssl s_client -connect <node IP>:443 -servername www.example.com -sess_in sess.pem </dev/null | grep -E '^(New|Reused)'
```

The second prints `Reused, TLSv1.3` (`TLSv1.2` with `-tls1_2`).

### Compression

The **Compression** card on a site's **Cache** tab has a group of settings each for Zstandard, Brotli, and Gzip, saved on their own (unsaved changes on the **HTTPS** tab stay):

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| On | On / off | Gzip on, Brotli and Zstandard off | Compresses responses with the algorithm |
| Level | Brotli 1–11, Zstandard 1–19, Gzip 1–9 | Brotli 6, Zstandard 3, Gzip empty (the node default 1) | Higher levels compress more and use more CPU; a Gzip level other than the default needs the node capability `site-content-v1` |
| Minimum compression size (bytes) | 1–1048576 | 256 | Shorter responses are not compressed |
| Compressed content types | MIME types, separated by commas or spaces, up to 32 | `text/html`, `text/plain`, `text/css`, `application/javascript`, `application/json`, `image/svg+xml` | Response types to compress; `text/html` is always compressed |
| Largest compressed (bytes) | 0 or more, shared by the three algorithms | Empty (no limit) | Responses whose `Content-Length` exceeds it are not compressed; responses of unknown length (chunked) are compressed as usual. Needs `site-content-v1` |

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
| 80/TCP | HTTP, HTTP-01 challenges | Always; HTTP-01 challenges are always answered on 80, whatever ports a site chose |
| 443/TCP | HTTPS (HTTP/1.1, HTTP/2) | An enabled site with a certificate is bound to 443 |
| The cluster's extra HTTP ports | HTTP | Always, see [The cluster's listener ports](#the-clusters-listener-ports) |
| The cluster's extra HTTPS ports | HTTPS (HTTP/1.1, HTTP/2) | Always |
| UDP of the same number as an HTTPS port | HTTP/3 (QUIC) | A site on that port turns on HTTP/3 |

The SNI of an HTTPS request must equal its `Host`; otherwise the node returns 421 (except requests handed to the [default site](domains.en.md#unknown-hosts-and-node-ip-access)). `Alt-Svc` names the port of the request's `Host` (443 without one). Adding or removing ports is structural: the node renders `nginx.conf` again and reloads, old workers keep serving open connections.

### The cluster's listener ports

1. Open **Clusters & nodes**, select the cluster and switch to the **Network** tab (`/clusters?tab=network`).
2. In the **Listener ports** card fill in **Extra HTTP ports** and **Extra HTTPS ports**, separated by commas or spaces.
3. Click **Save**. The console shows **Saved** and publishes a new configuration revision.
4. Open the ports in the node hosts' firewalls and cloud security groups (UDP too for an HTTPS port with HTTP/3 sites), see [Ports and firewalls](../deploy/nodes.en.md#ports-and-firewalls).

| Item | Rule |
| --- | --- |
| Ports | 1–65535 except 80 and 443; at most 16 extra HTTP and 16 extra HTTPS ports; a port is HTTP or HTTPS, not both ("Port {port} cannot be both HTTP and HTTPS") |
| Port pools | Never inside one of the cluster's [L4 port pools](l4.en.md) ("Port {port} is inside port pools: …"); port pools never hold listener ports either |
| Removing | A port sites are bound to stays ("Port {port} is still used by sites: …") |
| Audit | `cluster.listen_ports_update`, with the ports before and after |
| Node capability | Configurations with extra ports need `edge-ports-v1`; while an active node of the cluster lacks it, the card shows "Some nodes of the site's cluster do not support it yet" and ports can only be removed |

### Site ports

The **Ports** card on a site's **Domains** tab chooses where the site is served: HTTP on 80 and the cluster's extra HTTP ports, HTTPS on 443 and its extra HTTPS ports. Default: 80 and 443.

| Item | Rule |
| --- | --- |
| At least one | The site is served on at least one usable port ("The site needs at least one usable port"); without a certificate HTTPS ports are unusable |
| HTTPS ports | Need a certificate: without one only the default 443 may stay ("HTTPS port {port} needs a certificate"); a site losing its certificate must keep an HTTP port |
| Other ports | A request on a port the site is not bound to is treated like one for an [unknown host](domains.en.md#unknown-hosts-and-node-ip-access): by default 404 with the platform page over HTTP (`X-Edgeweir-Error: unknown-host`), the TLS handshake is aborted over HTTPS |
| ACME | HTTP-01 challenges are always answered on 80; the origin's own HTTP-01 tokens still reach it on 80 |
| Cache | The cache key holds no port: every port of a site shares its cached objects |
| No extra ports | A site on the default ports compiles byte for byte as before and needs no `edge-ports-v1` |

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
| Checks | Nodes verify the fingerprint, the key match, and name coverage (except for domains served over HTTP until a new certificate covers them); when one certificate cannot be loaded, the whole revision is not applied, the node keeps its previous configuration and retries at every sync |
| Storage | `certificates.json` (0600) in the node state directory; private keys on the node are not encrypted, and the host administrator can read them |
| Hot updates | Certificate content and minimum TLS version changes do not reload nginx |
| Ticket keys | On rotation nodes write the new key files and reload nginx |
| Reloads | Changes to HTTP/2, HTTP/3, compression, cipher profile, certificate presence, domain lists, or the set of sites are tested first and then reloaded; on failure the previous configuration is restored |
| Applied | A node reports a revision as applied only after persisting it; keys referenced by the current and previous last-known-good configurations are kept |
| Rollback | A configuration rollback uses the current certificate material; it is refused when the certificate is deleted, expired, unloadable by nodes, or does not cover the target domains |

## Key handling

ACME account keys, certificate private keys, EAB HMAC keys (of certificates and of the custom directory in system settings), DNS credentials, and TLS session ticket keys are each envelope-encrypted with the master key, bound to their record ID. The certificate helper `edgeweir-certd` is started by background jobs and receives credentials only over stdin/stdout, never on the command line, in logs, or in the node configuration.

## Node capabilities

| Capability | Needed for |
| --- | --- |
| `tls-v1` | Sites whose **HTTPS** tab has been saved |
| `http01-v1` | HTTP-01 validation |
| `http3-v1` | Any site with HTTP/3 on |
| `brotli-v1` | Any site with Brotli on |
| `zstd-v1` | Any site with Zstandard on |
| `tls-pending-domains-v1` | New domains of an HTTPS site are served over HTTP until the certificate covers them; without it they take effect once the new certificate is issued, and nothing is refused |
| `edge-ports-v1` | The cluster has extra listener ports, a site is bound to ports other than the defaults, or the HTTPS redirect uses a status, port or excluded domains other than the defaults |
| `multi-certificate-v1` | A site has more than one certificate |
| `client-cert-v1` | A site has client certificates on, or a rule reads a `tls.client.*` field |

A change saved in the console or with an AccessKey is published even when it needs a capability some active nodes of the cluster lack; those nodes keep their last-known-good configuration and **Clusters & nodes** shows **Upgrade required**, see [Node upgrades](node-upgrades.en.md). A configuration published by a service account or a background job that introduces a capability an active node lacks is refused (`NODE_CAPABILITY_REQUIRED`) and the configuration stays unchanged.

## Limits

| Item | Description |
| --- | --- |
| Certificate authorities | Let's Encrypt, ZeroSSL and Google Trust Services are built in; other CAs through one custom ACME directory, see [system settings](system.en.md#certificate-authorities) |
| Certificates | At most 4 per site; ACME key types are ECDSA P-256 and RSA 2048 only |
| Client certificates | Not together with HTTP/3; revocation (CRL, OCSP) is not checked |
| Session resumption | Resuming a TLS 1.2 session under another domain of the same site answers 421 (`sni-host-mismatch`); browsers keep sessions per host name and are not affected. TLS termination of L4 apps does not resume sessions |
| 0-RTT | TLS 1.3 early data is not supported |
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
| "The EC private key uses explicit curve parameters; convert it to a named curve" | The key spells out the curve's parameters instead of naming the curve, which nodes cannot load; when saving a site's HTTPS, the selected certificate was uploaded with such a key earlier. LibreSSL, the `openssl` shipped with macOS, does this by default for `openssl req -newkey ec` and `openssl genpkey` | Convert it with OpenSSL 3 and upload the result: `openssl pkey -in key.pem -ec_param_enc named_curve -out key-named.pem` (LibreSSL cannot convert it); add `-pkeyopt ec_param_enc:named_curve` when generating keys |
| "A certificate's EC key uses explicit curve parameters; reissue it with a named-curve key" | The certificate was issued for such a key, for example a self-signed certificate made with LibreSSL; when saving a site's HTTPS, the selected certificate was uploaded earlier | Reissue it with the converted key, or create a new one: `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve …` |
| Certificate status **Unusable**, reason "Nodes cannot load it: a certificate's EC key uses explicit curve parameters" or "Nodes cannot load it: the EC private key uses explicit curve parameters" | The certificate was uploaded earlier with explicit curve parameters | Convert or reissue it as in the two rows above and upload it, select it on the sites that use the old one, then delete the old one |
| A node shows **Apply failed** with `invalid certificate material` (such as `x509: invalid ECDSA parameters` or `unknown elliptic curve`) | The cluster's configuration references a certificate nodes cannot load, so the whole revision is not applied | Find the **Unusable** certificate in the list and proceed as in the row above; the revision published once another certificate is selected applies |
| "Wrong chain order: the leaf certificate first, then each issuer" | An intermediate comes before the leaf, or a certificate is not issued by the next one | Order the PEM as leaf then intermediates |
| "The certificate is not valid now (valid from … to …)" | Not yet valid or expired (times in UTC) | Check the server clock, or use a valid certificate |
| "The certificate has no DNS names (subject alternative names)" | The certificate has only IP addresses or only a CN | Use a certificate with DNS SANs |
| "The certificate's key type is not supported; use RSA (2048 bits or more) or ECDSA P-256, P-384 or P-521" | Nodes cannot load the leaf's key (curves such as secp256k1, Brainpool or SM2; Ed448, RSA-PSS, DSA; RSA with a public exponent above 2³¹−1), or browsers cannot use it (P-224, Ed25519, ML-DSA, RSA under 2048 bits); a key the nodes cannot load would fail the revision on every node of the cluster | The "Public Key Algorithm" part of `openssl x509 -in cert.pem -noout -text` shows the key type and size; reissue the certificate with an RSA 2048-bit or ECDSA P-256 key, for example `openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -pkeyopt ec_param_enc:named_curve -out key.pem` |
| "The certificate is not issued yet or has expired" | The certificate selected for a site is still pending, or has expired | Wait for issuance, or renew it first |
| "These names do not resolve to the nodes: …" | HTTP-01 names have no records, or resolve to the origin, another proxy, or other addresses that are not the cluster's nodes | Point the names to the nodes; with a load balancer in front of the nodes or a DNS change in progress, turn on **Skip the DNS check** |
| "No online node can answer HTTP-01 in cluster …" | The cluster serving the names has no online active node | Check the nodes, or use DNS-01 |
| "Some nodes don't support http01-v1 yet: …" | The listed online nodes lack `http01-v1` | Upgrade them, see [Node upgrades](node-upgrades.en.md) |
| "Certificate domains do not match the site or DNS zone: …" | The listed names: an HTTP-01 name is not a domain of any site; the DNS credential zone does not cover them; the selected certificate does not cover these site domains; a domain added to the site is not in its uploaded certificate, or is a wildcard an HTTP-01 certificate cannot get or a name outside a DNS-01 certificate's credential zone | Add the domain to a site first, or use DNS-01; use a matching DNS credential or certificate |
| Certificate shows **Issuance failed** | The reason on the card, see the rows below | Fix it and click **Renew now**; otherwise it retries after the [retry interval](#renewal) |
| "The CA did not accept the domain validation", "The CA received a wrong challenge answer", "The CA could not connect to the domain" | HTTP-01: the domain does not resolve to the nodes, port 80 is blocked, or another proxy is in front; DNS-01: the TXT record went to another zone | Check the DNS records and port 80 |
| "The CA could not resolve the domain" | The domain has no records, or its authoritative DNS fails | Add the records |
| "A CAA record does not allow this CA" | The domain's CAA records do not list the chosen CA | Add the CA's issuer (see [Certificate authorities](#certificate-authorities)) to CAA, or remove CAA |
| "CA rate limit reached" | Too many orders for the domain or account | Wait for the CA's limit window |
| "The CA requires EAB credentials" | ZeroSSL, Google Trust Services or the custom directory need EAB | Request again with the EAB key ID and HMAC key; for the custom directory they can be saved in system settings |
| "The TXT record did not propagate within 3 minutes" | The DNS provider syncs slowly, or the credential's zone is not the domain's authoritative zone | Retry later; check the credential's zone |
| "Provider authentication failed" and other DNS provider reasons | The DNS provider refused the DNS-01 TXT record | Edit the DNS credential; certificates retry right after new credentials are saved |
| "No online node can answer HTTP-01 (http01-v1)", "Nodes did not apply the challenge within 40 seconds" | The cluster serving the domain has no online node, a node lacks `http01-v1`, or nodes apply configurations slowly | Check the cluster's nodes and upgrade them if needed |
| "A domain belongs to no site" | No certificate name is a site domain any more | Add the domain to a site, or use DNS-01 |
| "A domain does not resolve to the nodes" | The check before the issuance found a name that does not resolve to the cluster's nodes; the CA was not contacted | Fix the DNS records; it is retried within 5 minutes, or click **Renew now** |
| "Issuance failed; see the console log" | An unclassified error | Find `certificate operation failed` in the log of the console process that runs background jobs and follow its `reason` |
| Certificate stays **Pending** | No console process runs background jobs | Make sure a process with `ROLE=worker` or `ROLE=all` runs |
| "Certificate operation is already in progress" | The certificate is **Issuing**; or a request for the site is already waiting to be bound | Wait for issuance to finish; retry or cancel that request on the site's **HTTPS** tab |
| "The certificate is used by sites: …" | The listed sites selected the certificate (first or further) | Select or remove another certificate on their **HTTPS** tab first |
| 403, `X-Edgeweir-Error: client-cert-required` | The site requires client certificates and the request presented no valid certificate of the CA, or came over plain HTTP | Present one with `curl --cert … --key …`; check the CA certificates and the depth; for HTTP turn on **Redirect HTTP to HTTPS** |
| "The client CA must be 1 to 10 current CA certificates in PEM" | The CA field is empty, not a CA certificate (`CA:TRUE`), expired, or has more than 10 | Paste the CA issuing the client certificates |
| "Client certificates and HTTP/3 cannot be on together" | The site has HTTP/3 on | Turn HTTP/3 off first |
| "Configure a custom ACME directory in the system settings first", "No custom ACME directory is configured any more" | The custom ACME directory was chosen, but neither system settings nor the environment have its URL | Enter it in **System settings → Certificate authorities**, or choose another CA |
| "The URL does not answer with an ACME directory" | The console cannot read an ACME directory there: wrong URL, untrusted TLS certificate (no CA certificates entered), a timeout, or not a directory | Check the URL with `curl`; for a private CA paste its issuer into **CA certificates (PEM)** |
| "Enter the EAB HMAC key with its key ID" | Only the EAB key ID was entered and no key for that ID is saved | Enter both, or neither |
| "Certificates use the ACME account: …" | The listed certificates were issued with the account | Delete those certificates first |
| `openssl s_client -sess_in` always prints `New` | Another site's SNI; a node from before session resumption; a session older than 1 hour; a TLS 1.2 session ID (`-no_ticket`) on another node | Use the same SNI and check the node version |
| "The DNS credential is used by certificates: …" | The listed certificates use the credential for DNS-01 | Delete those certificates first |
| A node shows **Upgrade required** | The node lacks a capability the configuration needs (such as `http3-v1`) and keeps its last-known-good configuration | Upgrade the node, see [Node upgrades](node-upgrades.en.md) |
| 404 with `X-Edgeweir-Error: unknown-host` for a configured site | The request reached a port the site is not bound to | Bind the port in the **Ports** card of the **Domains** tab, or use the site's ports |
| TLS handshake fails on an extra HTTPS port | The site is not bound to that port, or has no certificate | Bind the port and choose a certificate |
| Connections to an extra port time out | The node's firewall or security group does not allow it; a container node does not publish it | Open it as described in [Ports and firewalls](../deploy/nodes.en.md#ports-and-firewalls) |
| 421 with `X-Edgeweir-Error: sni-host-mismatch` | TLS SNI differs from `Host`, for example a client reused a connection opened for another domain | The client opens a connection for the requested domain |
| Browsers do not use HTTP/3 | UDP of the site's HTTPS port (UDP 443, UDP 9443…) is blocked; the node lacks `http3-v1`; clients read `Alt-Svc` only after a first visit | Open UDP 443 and check node capabilities |
| Responses are not compressed | The content type is not listed; the response is below the minimum size; the client sent no `Accept-Encoding`; the origin response already has a `Content-Encoding` | Check the **Compression** settings on the **Cache** tab |
| gzip instead of br or zstd | The client's `Accept-Encoding` lacks the algorithm or gives it a lower q-value; the algorithm is off | Check the request header and the **Compression** settings |
| The Brotli or Zstandard switch is unavailable | An active node of the cluster lacks `brotli-v1` / `zstd-v1` | Upgrade the nodes |
