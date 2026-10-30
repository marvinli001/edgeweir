# API: Certificates

The 28 procedures of certificates, ACME accounts, DNS credentials, the origin client CA, the Origin CA and origin certificates.

Access levels, authentication, idempotency keys and the error format: [API overview](../api.en.md).

## Certificates

- Behaviour: [HTTPS and certificates](../../guide/https.en.md): [Upload a certificate](../../guide/https.en.md#upload-a-certificate), [Request an ACME certificate](../../guide/https.en.md#request-an-acme-certificate), [Renewal](../../guide/https.en.md#renewal), [Deletion](../../guide/https.en.md#deletion).
- ACME certificates are issued by the background worker (a console process with `ROLE=worker` or `ROLE=all`); `certificates.request` and `certificates.renew` only set the certificate to `pending`.
- Which certificates a site uses is set with `https.update` (`PUT /sites/{id}/https`), not on this page.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`certificates.list`](#certificateslist) | `GET /certificates` | read |
| [`certificates.settings`](#certificatessettings) | `GET /certificates/settings` | read |
| [`certificates.upload`](#certificatesupload) | `POST /certificates/upload` | write |
| [`certificates.request`](#certificatesrequest) | `POST /certificates/request` | write |
| [`certificates.renew`](#certificatesrenew) | `POST /certificates/{id}/renew` | write |
| [`certificates.delete`](#certificatesdelete) | `DELETE /certificates/{id}` | write |

### `certificates.list`

`GET /certificates` · read

No parameters.

Response: [Certificate](#certificate-object)`[]`, unsorted.

### `certificates.settings`

`GET /certificates/settings` · read

No parameters.

Response:

| Field | Type | Description |
| --- | --- | --- |
| `acmeDirectory` | string | The custom ACME directory in effect (saved in the system settings, else `EDGEWEIR_ACME_DIRECTORY`), or `null`: `ca` `custom` cannot be chosen |
| `acmeDirectoryEab` | boolean | The custom directory saved in the system settings has an EAB key: requests with `ca` `custom` may omit EAB |
| `defaultCa` | enum | `letsencrypt` / `custom`. The CA of a request without `ca`: `custom` when no directory is saved in the system settings and `EDGEWEIR_ACME_DIRECTORY` is set, else `letsencrypt` |

### `certificates.upload`

`POST /certificates/upload` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–100 characters after trimming | Certificate name |
| `chainPem` | body | string | yes | 32–131072 characters | PEM chain: 1–10 certificates, the leaf first, each issued by the next; no other PEM blocks |
| `privateKeyPem` | body | string | yes | 32–32768 characters | The leaf's PEM private key, unencrypted |

Only the chain and the key in PKCS #8 are stored; anything else is dropped. `names` are the leaf's DNS subject alternative names; the status is `ready`. Audited as `certificate.upload`.

Response: [Certificate](#certificate-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CERTIFICATE_CHAIN_FOREIGN_BLOCK` | 400 | The chain holds PEM blocks other than `CERTIFICATE` |
| `CERTIFICATE_CHAIN_UNREADABLE` | 400 | The chain is not 1–10 readable PEM certificates |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE` | 400 | An EC public key of the chain spells out the curve's parameters instead of naming the curve |
| `CERTIFICATE_KEY_UNREADABLE` | 400 | The private key cannot be read or is encrypted |
| `CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | The EC private key spells out the curve's parameters instead of naming the curve |
| `CERTIFICATE_CHAIN_ORDER` | 400 | The first certificate is a CA certificate, or a certificate is not issued by the next CA certificate |
| `CERTIFICATE_KEY_TYPE_UNSUPPORTED` | 400 | The leaf key is not RSA (2048 bits or more) or ECDSA P-256 / P-384 / P-521 |
| `CERTIFICATE_KEY_MISMATCH` | 400 | The private key does not belong to the leaf |
| `CERTIFICATE_NOT_CURRENTLY_VALID` | 400 | The leaf is not valid yet or has expired; `data.notBefore`, `data.notAfter` |
| `CERTIFICATE_NO_DNS_NAMES` | 400 | The leaf has no DNS subject alternative names, or a name has invalid characters |
| `CERTIFICATE_ORIGIN_CA` | 400 | The certificate was issued by the Origin CA |

### `certificates.request`

`POST /certificates/request` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–100 characters after trimming | Certificate name |
| `names` | body | `array<string>` | yes | 1–100 domain names, distinct; a `*.` prefix makes a wildcard; lowercased | Names of the certificate |
| `email` | body | string | yes | e-mail address | ACME account e-mail |
| `ca` | body | enum | no | `letsencrypt` / `zerossl` / `google` / `custom`; omitted: `defaultCa` of `certificates.settings` | Certificate authority; `custom` is the custom directory of the system settings |
| `keyType` | body | enum | no | `ec256` / `rsa2048`, default `ec256` | Certificate key: ECDSA P-256 or RSA 2048 |
| `challenge` | body | enum | no | `http01` / `dns01`, default `http01` | Validation method; `http01` allows no wildcards |
| `dnsCredentialId` | body | uuid | no | required when `challenge` is `dns01` | DNS credential; every name must be inside its zone |
| `eabKid` | body | string | no | at most 256 characters; together with `eabHmacKey` or neither; required when `ca` is `zerossl` / `google` | EAB key id |
| `eabHmacKey` | body | string | no | at most 1024 characters; required when `ca` is `zerossl` / `google` | EAB HMAC key |
| `autoRenew` | body | boolean | no | default `true` | Automatic renewal |
| `skipDnsCheck` | body | boolean | no | default `false` | `http01` only: at the request and before each issuance, do not check that every name resolves only to the nodes of the cluster serving it |
| `bindSiteId` | body | uuid | no | — | Once issued, the certificate becomes the site's first certificate; `forceHttps` and the other HTTPS settings stay as they are (audited as `site.https_update`, actor system). `names` must cover every exact and wildcard domain of the site. A site that has another issued, unexpired first certificate nodes can load by then keeps it |

With `http01`, every name must be an exact domain of a site; the clusters serving the names need an online active node, and every online active node there `http01-v1`. The new certificate's status is `pending`. Audited as `certificate.request`.

Response: [Certificate](#certificate-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ACME_DIRECTORY_NOT_CONFIGURED` | 409 | The CA is `custom` and no custom directory is in effect |
| `SITE_NOT_FOUND` | 404 | The site of `bindSiteId` does not exist |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | `bindSiteId`: `names` leave domains of the site uncovered; `http01`: names are not exact domains of a site; `dnsCredentialId`: names are outside the credential's zone. `data.domains` lists at most 5 |
| `CERTIFICATE_BUSY` | 409 | Another certificate waits to be bound to the site once issued |
| `NODE_CAPABILITY_REQUIRED` | 409 | `http01`: online active nodes lack `http01-v1`; `data.features`, `data.nodes` |
| `CERTIFICATE_NODES_OFFLINE` | 409 | `http01`: a cluster serving the names has no online active node; `data.clusters` |
| `CERTIFICATE_DNS_NOT_POINTING` | 409 | `http01` without `skipDnsCheck`: names resolve to no node, or to other addresses too; `data.names` |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | The credential of `dnsCredentialId` does not exist |

### `certificates.renew`

`POST /certificates/{id}/renew` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Certificate id |

Sets an ACME certificate to `pending` and clears `lastError`; the worker's next check renews it. Audited as `certificate.renew`.

Response: [Certificate](#certificate-object).

| Error | Status | Condition |
| --- | --- | --- |
| `CERTIFICATE_NOT_FOUND` | 404 | The certificate does not exist |
| `CERTIFICATE_BUSY` | 409 | The certificate was uploaded, or its status is `issuing` |

### `certificates.delete`

`DELETE /certificates/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Certificate id |

DNS-01 TXT records still to clean up are given up; `leftDnsRecords` of the `certificate.delete` audit entry lists them.

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `CERTIFICATE_NOT_FOUND` | 404 | The certificate does not exist |
| `CERTIFICATE_IN_USE` | 409 | Sites use the certificate (first or further); `data.sites` lists at most 5 |
| `CERTIFICATE_IN_USE_BY_L4` | 409 | Layer-4 applications use the certificate; `data.apps` lists at most 5 |
| `CERTIFICATE_BUSY` | 409 | The certificate's status is `issuing` |

## ACME accounts

Accounts the console registered for ACME requests. Behaviour: [ACME accounts](../../guide/https.en.md#acme-accounts).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`acmeAccounts.list`](#acmeaccountslist) | `GET /acme-accounts` | read |
| [`acmeAccounts.delete`](#acmeaccountsdelete) | `DELETE /acme-accounts/{id}` | write |

### `acmeAccounts.list`

`GET /acme-accounts` · read

No parameters.

Response: [ACME account](#acme-account-object)`[]`, newest first.

### `acmeAccounts.delete`

`DELETE /acme-accounts/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Account id |

Deletes only the console's copy; the account stays registered with the CA. Audited as `acme_account.delete`.

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `ACME_ACCOUNT_NOT_FOUND` | 404 | The account does not exist |
| `ACME_ACCOUNT_IN_USE` | 409 | Certificates use the account; `data.certificates` lists at most 5 |

## DNS credentials

Provider credentials for DNS-01 validation. Credentials are stored encrypted and no procedure returns them. Behaviour: [Add a DNS credential](../../guide/https.en.md#add-a-dns-credential); each provider's credential fields: [Providers and credentials](../../guide/dns.en.md#providers-and-credentials).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`dnsCredentials.list`](#dnscredentialslist) | `GET /dns-credentials` | read |
| [`dnsCredentials.create`](#dnscredentialscreate) | `POST /dns-credentials` | write |
| [`dnsCredentials.update`](#dnscredentialsupdate) | `PUT /dns-credentials/{id}` | write |
| [`dnsCredentials.delete`](#dnscredentialsdelete) | `DELETE /dns-credentials/{id}` | write |
| [`dnsCredentials.zones`](#dnscredentialszones) | `POST /dns-credentials/zones` | write |
| [`dnsCredentials.test`](#dnscredentialstest) | `POST /dns-credentials/test` | write |

### `dnsCredentials.list`

`GET /dns-credentials` · read

No parameters.

Response: [DNS credential](#dns-credential-object)`[]`, sorted by name.

### `dnsCredentials.create`

`POST /dns-credentials` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `name` | body | string | yes | 1–100 characters after trimming | Credential name |
| `provider` | body | enum | yes | `cloudflare` / `alidns` / `huaweicloud` / `dnspod` / `tencentcloud` / `volcengine` / `baiducloud` / `westcn` / `dnsla` / `route53` / `googleclouddns` / `azure` / `digitalocean` / `vultr` / `linode` / `hetzner` / `ovh` / `gandi` / `godaddy` / `porkbun` / `namesilo` / `gcore` / `bunny` / `desec` / `powerdns` / `rfc2136` / `webhook` | DNS provider |
| `zone` | body | string | yes | domain name, no wildcard; lowercased | DNS zone |
| `credentials` | body | object | yes | 1–10 fields; names at most 64 characters, values at most 16384 characters; must match the provider's field definitions | Credential fields |

The credentials are not tested before saving. Audited as `dns_credential.create`.

Response: [DNS credential](#dns-credential-object).

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` do not match the provider's field definitions |

### `dnsCredentials.update`

`PUT /dns-credentials/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Credential id |
| `name` | body | string | no | 1–100 characters after trimming; omitted: unchanged | Credential name |
| `credentials` | body | object | no | as in `dnsCredentials.create`, every field again; omitted: unchanged | New credentials |

`provider` and `zone` cannot be changed. With `credentials`, certificates using the credential whose status is `error` and TXT records whose cleanup failed are retried at once. Audited as `dns_credential.update`.

Response: [DNS credential](#dns-credential-object).

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | The credential does not exist |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` do not match the provider's field definitions |

### `dnsCredentials.delete`

`DELETE /dns-credentials/{id}` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Credential id |

Audited as `dns_credential.delete`.

Response: `{ ok: true }`.

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | The credential does not exist |
| `DNS_CREDENTIAL_IN_USE` | 409 | Certificates use the credential; `data.certificates` lists at most 5 |

### `dnsCredentials.zones`

`POST /dns-credentials/zones` · write

The body is one of:

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | yes | — | A saved credential |

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `provider` | body | enum | yes | as in `dnsCredentials.create` | DNS provider |
| `credentials` | body | object | yes | as in `dnsCredentials.create` | Unsaved credential fields |

Only for providers that can list zones. Not audited.

Response: `{ zones: string[] }`: zone names, lowercased, without a trailing dot, distinct, sorted, at most 1000.

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | The credential of `id` does not exist |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` do not match the provider's field definitions |
| `DNS_ZONES_UNSUPPORTED` | 400 | The provider cannot list zones |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | The provider refused the credentials |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | The provider has no such zone |
| `DNS_ADDRESS_REFUSED` | 400 | The outbound policy refused the provider's address |
| `DNS_PROVIDER_UNREACHABLE` | 502 | The provider cannot be reached |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | The provider rate-limited the request, or the console process already runs 4 provider checks |
| `DNS_PROVIDER_FAILED` | 502 | Any other failure of the provider request |

### `dnsCredentials.test`

`POST /dns-credentials/test` · write

The body is one of:

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | body | uuid | yes | — | A saved credential; its zone is tested |

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `provider` | body | enum | yes | as in `dnsCredentials.create` | DNS provider |
| `credentials` | body | object | yes | as in `dnsCredentials.create` | Unsaved credential fields |
| `zone` | body | string | yes | domain name, no wildcard; lowercased | DNS zone |

Reads the zone's records with the credentials; writes nothing. Not audited.

Response: `{ ok: true, records }`: `records` is the number of records read (integer).

| Error | Status | Condition |
| --- | --- | --- |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | The credential of `id` does not exist |
| `DNS_CREDENTIAL_INVALID` | 400 | `credentials` do not match the provider's field definitions |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | The provider refused the credentials |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | The provider has no such zone |
| `DNS_ADDRESS_REFUSED` | 400 | The outbound policy refused the provider's address |
| `DNS_ZONES_UNSUPPORTED` | 400 | The provider does not support the operation |
| `DNS_PROVIDER_UNREACHABLE` | 502 | The provider cannot be reached |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | The provider rate-limited the request, or the console process already runs 4 provider checks |
| `DNS_PROVIDER_FAILED` | 502 | Any other failure of the provider request |

## Origin client CA (origin mutual TLS)

The origin client CA signs the client certificates nodes present to origins. Behaviour: [Origin client certificates](../../guide/https.en.md#origin-client-certificates) and [Rotating the CAs](../../guide/https.en.md#rotating-the-cas).

- The CA is ECDSA P-256, valid for 10 years; a CA created by a rotation has its generation in its name (e.g. `Edgeweir Origin Client CA G2`).
- Every cluster with a site presenting a client certificate holds one certificate, valid for 90 days and replaced 30 days before it expires by the hourly job.
- Rotation: `rotate` (the new CA is `next`, trusted only, not signing) → `activate` (the new CA signs, the old one is `previous`) → `retire`; `cancel` before `activate`.
- Every procedure returns the [Origin client CA](#origin-client-ca-object); except `get` and `create`, they return 409 `ORIGIN_CLIENT_CA_NOT_FOUND` while the CA has not been created.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`originClientCa.get`](#originclientcaget) | `GET /origin-client-ca` | read |
| [`originClientCa.create`](#originclientcacreate) | `POST /origin-client-ca` | write |
| [`originClientCa.rotate`](#originclientcarotate) | `POST /origin-client-ca/rotation` | write |
| [`originClientCa.activate`](#originclientcaactivate) | `POST /origin-client-ca/rotation/activate` | write |
| [`originClientCa.retire`](#originclientcaretire) | `POST /origin-client-ca/rotation/retire` | write |
| [`originClientCa.cancel`](#originclientcacancel) | `DELETE /origin-client-ca/rotation` | write |

### `originClientCa.get`

`GET /origin-client-ca` · read

No parameters.

Response: [Origin client CA](#origin-client-ca-object).

### `originClientCa.create`

`POST /origin-client-ca` · write

No parameters.

Creates the CA; when it exists already, returns it unchanged. Audited as `origin_client_ca.create` when created.

Response: [Origin client CA](#origin-client-ca-object).

### `originClientCa.rotate`

`POST /origin-client-ca/rotation` · write

No parameters.

Creates a new CA as `next`, which does not sign yet; origins should trust it first (`trustBundlePem`). Audited as `origin_client_ca.rotation_start`.

Response: [Origin client CA](#origin-client-ca-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | The CA has not been created |
| `CA_ROTATION_IN_PROGRESS` | 409 | A `next` or `previous` CA exists |

### `originClientCa.activate`

`POST /origin-client-ca/rotation/activate` · write

No parameters.

`next` becomes the active CA and the active one `previous`; then every cluster with a site presenting a client certificate gets a certificate of the new CA, clusters whose latest revision carries origin client certificates get a new revision (reason `origin_client_certificate_rotated`), and each cluster is audited as `origin_client_certificate.rotate`. Clusters that fail keep their certificate and are retried by the hourly job. Audited as `origin_client_ca.activate`.

Response: [Origin client CA](#origin-client-ca-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | The CA has not been created |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | There is no `next` CA |

### `originClientCa.retire`

`POST /origin-client-ca/rotation/retire` · write

No parameters.

Deletes `previous`. Audited as `origin_client_ca.retire`.

Response: [Origin client CA](#origin-client-ca-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | The CA has not been created |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | There is no `previous` CA |
| `CA_ROTATION_INCOMPLETE` | 409 | Clusters still present certificates `previous` signed; `data.clusters` lists at most 5, the rest as `+N` |

### `originClientCa.cancel`

`DELETE /origin-client-ca/rotation` · write

No parameters.

Deletes `next`. Audited as `origin_client_ca.rotation_cancel`.

Response: [Origin client CA](#origin-client-ca-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | The CA has not been created |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | There is no `next` CA |

## Origin CA

The Origin CA signs origin server certificates only the edge nodes trust. Behaviour: [Origin CA](../../guide/https.en.md#origin-ca) and [Rotating the CAs](../../guide/https.en.md#rotating-the-cas).

- The CA is ECDSA P-256, valid for 20 years.
- Rotation: `rotate` (the new CA signs at once, the old one is `previous`, nodes trust both) → `retire`; `cancel` while every certificate of the new CA is revoked or expired.
- `rotate`, `retire` and `cancel` publish a revision to every cluster with a site trusting the Origin CA, with the reasons `origin_ca_rotation_started`, `origin_ca_retired` and `origin_ca_rotation_cancelled`.
- Every procedure returns the [Origin CA](#origin-ca-object); except `get` and `create`, they return 409 `ORIGIN_CA_NOT_FOUND` while the CA has not been created.

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`originCa.get`](#origincaget) | `GET /origin-ca` | read |
| [`originCa.create`](#origincacreate) | `POST /origin-ca` | write |
| [`originCa.rotate`](#origincarotate) | `POST /origin-ca/rotation` | write |
| [`originCa.retire`](#origincaretire) | `POST /origin-ca/rotation/retire` | write |
| [`originCa.cancel`](#origincacancel) | `DELETE /origin-ca/rotation` | write |

### `originCa.get`

`GET /origin-ca` · read

No parameters.

Response: [Origin CA](#origin-ca-object).

### `originCa.create`

`POST /origin-ca` · write

No parameters.

Creates the CA; when it exists already, returns it unchanged. Audited as `origin_ca.create` when created.

Response: [Origin CA](#origin-ca-object).

### `originCa.rotate`

`POST /origin-ca/rotation` · write

No parameters.

Creates a new CA that issues from now on; the active one becomes `previous`. Audited as `origin_ca.rotation_start`.

Response: [Origin CA](#origin-ca-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | The CA has not been created |
| `CA_ROTATION_IN_PROGRESS` | 409 | A `previous` CA exists |
| `NODE_CAPABILITY_REQUIRED` | 409 | Active nodes of a cluster with a site trusting the Origin CA lack `origin-ca-rotation-v1`; `data.features`, `data.nodes` |

### `originCa.retire`

`POST /origin-ca/rotation/retire` · write

No parameters.

Deletes `previous`; nodes stop trusting the certificates it issued, valid ones included (`previousCertificates`). Audited as `origin_ca.retire` (`validCertificates`).

Response: [Origin CA](#origin-ca-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | The CA has not been created |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | There is no `previous` CA |

### `originCa.cancel`

`DELETE /origin-ca/rotation` · write

No parameters.

Deletes the new CA with the certificates it issued; `previous` is active again. Audited as `origin_ca.rotation_cancel`.

Response: [Origin CA](#origin-ca-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | The CA has not been created |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | There is no `previous` CA |
| `CA_ROTATION_IN_USE` | 409 | Certificates of the new CA are neither revoked nor expired; `data.count` |

## Origin certificates

Origin server certificates the Origin CA issued. Behaviour: [Origin CA](../../guide/https.en.md#origin-ca).

| Procedure | Method and path | Access |
| --- | --- | --- |
| [`originCertificates.list`](#origincertificateslist) | `GET /origin-certificates` | read |
| [`originCertificates.issue`](#origincertificatesissue) | `POST /origin-certificates` | write |
| [`originCertificates.revoke`](#origincertificatesrevoke) | `POST /origin-certificates/{id}/revoke` | write |

### `originCertificates.list`

`GET /origin-certificates` · read

No parameters.

Response: [Origin certificate](#origin-certificate-object)`[]`, newest first.

### `originCertificates.issue`

`POST /origin-certificates` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `hostnames` | body | `array<string>` | yes | 1–50 items, deduplicated; each a host name (single labels allowed, optionally `*.`-prefixed) or an IP address, at most 253 characters, lowercased | Names of the certificate; the first is the CN |
| `validityYears` | body | integer | no | `1` / `3` / `5` / `10` / `15`, default `15` | Validity in years of 365 days, ending at the Origin CA's expiry if that comes first |
| `keyType` | body | enum | no | `ec256` / `rsa2048`, default `ec256` | Type of the key the console generates; ignored with `csrPem` |
| `csrPem` | body | string | no | at most 16384 characters after trimming; an empty string counts as omitted | PEM certificate signing request: its signature is checked and only its public key is used (RSA 2048 / 3072 / 4096 or ECDSA P-256 / P-384) |

Without `csrPem` the console generates the private key and returns it in this response only. Audited as `origin_certificate.issue` (without the key).

Response: [Origin certificate](#origin-certificate-object) plus `privateKeyPem` (string): the generated key as PKCS #8 PEM; an empty string for a CSR.

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | The Origin CA has not been created |
| `ORIGIN_CERTIFICATE_CSR_INVALID` | 400 | The CSR cannot be read, its key type is not supported or its signature is invalid |

### `originCertificates.revoke`

`POST /origin-certificates/{id}/revoke` · write

| Parameter | In | Type | Required | Constraints and default | Description |
| --- | --- | --- | --- | --- | --- |
| `id` | path | uuid | yes | — | Origin certificate id |

The issuing CA's CRL is rebuilt and every cluster with a site trusting the Origin CA gets a revision (reason `origin_certificate_revoked`), from which on its nodes refuse the certificate. A certificate of a retired CA is only marked; nothing is published. Audited as `origin_certificate.revoke`.

Response: [Origin certificate](#origin-certificate-object).

| Error | Status | Condition |
| --- | --- | --- |
| `ORIGIN_CERTIFICATE_NOT_FOUND` | 404 | The certificate does not exist |
| `ORIGIN_CERTIFICATE_REVOKED` | 409 | The certificate is revoked already |

## Objects

### Certificate object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Certificate id |
| `name` | string | Name |
| `names` | `array<string>` | Names of the certificate |
| `source` | enum | `upload` (uploaded) / `acme` (requested by the console) |
| `status` | enum | `pending` (waiting for issuance) / `issuing` / `ready` (issued) / `error` (issuance failed, or nodes cannot load the uploaded certificate) |
| `fingerprint` | string | SHA-256 fingerprint of the leaf, lowercase hex; an empty string until issued |
| `notBefore` | datetime | Start of validity, or `null` (not issued) |
| `notAfter` | datetime | Expiry, or `null` (not issued) |
| `autoRenew` | boolean | Automatic renewal |
| `renewAt` | datetime | Next renewal, or `null` |
| `lastError` | string | Code of the last failed issuance or renewal (e.g. `acme_rate_limited`; provider failures of DNS-01 keep DNS codes such as `dns_auth_failed`), or an empty string; for an uploaded certificate nodes cannot load, `certificate_chain_explicit_curve` or `certificate_key_explicit_curve`. See [Troubleshooting](../../guide/https.en.md#troubleshooting) |
| `bindSiteId` | uuid | The site the certificate is bound to once issued (`bindSiteId` of `certificates.request`), or `null`; `null` once issued |
| `nodeFailures` | `array<object>` | Nodes that report they cannot load the certificate (requires `certificate-isolation-v1`): `nodeId` (uuid), `nodeName` (string), `reason` (enum: `invalid_material` / `fingerprint_mismatch` / `unavailable`), `servingEarlier` (boolean: the node keeps serving the earlier certificate, else it refuses those TLS handshakes). Filled by `certificates.list` only; the other procedures return `[]` |

### ACME account object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Account id |
| `directoryUrl` | string | ACME directory URL |
| `ca` | enum | The directory's CA: `letsencrypt` / `zerossl` / `google`, `custom` (the custom directory in effect), or `null` (another directory) |
| `email` | string | Account e-mail |
| `eabKid` | string | EAB key id, an empty string without EAB |
| `createdAt` | datetime | Creation time |
| `certificates` | integer | Number of certificates using the account |

### DNS credential object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Credential id |
| `name` | string | Name |
| `provider` | string | DNS provider (a `provider` value of `dnsCredentials.create`) |
| `zone` | string | DNS zone |

### Origin client CA object

| Field | Type | Description |
| --- | --- | --- |
| `authority` | [Authority](#authority-object) | The active CA (signs the clusters' certificates), or `null` (not created) |
| `next` | [Authority](#authority-object) | A rotation's new CA before activation, or `null` |
| `previous` | [Authority](#authority-object) | The CA a rotation replaced, until it is retired, or `null` |
| `trustBundlePem` | string | Every CA certificate origins should trust now (PEM): the active one first, then `next` or `previous` during a rotation; an empty string before the CA is created |
| `certificates` | array<[Origin client certificate](#origin-client-certificate-object)> | The current certificate of every cluster, sorted by cluster name; `[]` before the CA is created |
| `pendingClusters` | `array<object>` | With a `previous` CA: clusters with a site presenting a client certificate whose current certificate the active CA did not sign: `clusterId` (uuid), `clusterName` (string), sorted by name; otherwise `[]` |

### Authority object

| Field | Type | Description |
| --- | --- | --- |
| `certificatePem` | string | CA certificate (PEM) |
| `fingerprint` | string | SHA-256 of the DER certificate, lowercase hex |
| `notBefore` | datetime | Start of validity |
| `notAfter` | datetime | Expiry |

### Origin client certificate object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Certificate id |
| `clusterId` | uuid | Cluster id |
| `clusterName` | string | Cluster name |
| `serial` | string | Serial number |
| `fingerprint` | string | SHA-256 fingerprint |
| `notBefore` | datetime | Start of validity |
| `notAfter` | datetime | Expiry |
| `authority` | enum | The issuing CA: `active` / `previous` (the old CA of a rotation) / `retired` |

The private key is not included.

### Origin CA object

| Field | Type | Description |
| --- | --- | --- |
| `authority` | [Authority](#authority-object) | The active CA (issues origin certificates), or `null` (not created) |
| `previous` | [Authority](#authority-object) | The CA a rotation replaced, which nodes trust until it is retired; usually `null` |
| `previousCertificates` | integer | Certificates of `previous` that are neither revoked nor expired, which retiring it ends; `0` without `previous` |

### Origin certificate object

| Field | Type | Description |
| --- | --- | --- |
| `id` | uuid | Certificate id |
| `hostnames` | `array<string>` | Names of the certificate (host names or IP addresses) |
| `keyType` | string | Key type: `ec256` / `ec384` / `rsa2048` / `rsa3072` / `rsa4096` (the CSR's key) |
| `source` | enum | `generated` (the console generated the key) / `csr` (a CSR was submitted) |
| `serial` | string | Serial number |
| `fingerprint` | string | SHA-256 fingerprint |
| `certificatePem` | string | Certificate (PEM) |
| `notBefore` | datetime | Start of validity |
| `notAfter` | datetime | Expiry |
| `revokedAt` | datetime | Revocation time, or `null` |
| `createdAt` | datetime | Issuance time |
| `authority` | enum | The issuing CA: `active` / `previous` (the old CA of a rotation) / `retired` |
