# Error codes

The API error format, generic codes, all 207 API error codes and the configuration revision reason codes.

## Error response

Error body of `/api/v1`:

```json
{
  "defined": false,
  "code": "SITE_NOT_FOUND",
  "status": 404,
  "message": "site not found",
  "data": {}
}
```

| Field | Description |
| --- | --- |
| `code` | Stable error code |
| `status` | HTTP status, the same as the response's |
| `message` | English text for clients that do not know the code; the wording is not stable |
| `data` | Message parameters, keys in the `data` column below; `{}` without parameters |
| `defined` | Always `false` |

| Surface | Format |
| --- | --- |
| `/api/v1/*` | The object above |
| `/rpc/*` | The object above inside a `json` field: `{ "json": { … } }` |
| `/api/auth/*` | better-auth's `{ code, message }`; refusals by the login allow list and the demo account are `{ "code": "LOGIN_IP_NOT_ALLOWED" \| "DEMO_READ_ONLY", "message" }`; rate limiting answers 429 without a code (`NODE_ENV=production`) |
| Unmatched `/api/*`, `/rpc/*`, `/downloads/*`, `/install.sh`, `/healthz`, `/node-channel` | 404, `{ "error": "not found" }` |

The console shows the `error_<lower-case code>` message (`apps/console/messages/zh-CN.json`, `en.json`) with `{parameter}` replaced from `data`; for an unknown code it shows `message`.

## Generic codes

Codes of oRPC and the HTTP layer, not in the API error code table.

| Code | Status | Message | Condition |
| --- | --- | --- | --- |
| `BAD_REQUEST` | 400 | Invalid input | Input validation failed; `data.issues` holds the zod issues (`path`, `message`, …); the console names the field of the first issue |
| `UNAUTHORIZED` | 401 | Please sign in | No session or `x-api-key`, an invalid or revoked key, or a disabled service account |
| `CSRF_TOKEN_MISMATCH` | 403 | — | `/rpc` without the `x-csrf-token: orpc` header |
| `PAYLOAD_TOO_LARGE` | 413 | — | Request body over the limit: 1 MiB without valid credentials, 16 MiB with them, 64 KiB on `/api/auth` |
| `INTERNAL_SERVER_ERROR` | 500 | Server error | An unhandled server error; the console logs `rpc error` |

The sign-in and account endpoints of `/api/auth` also return better-auth codes, which the console maps as follows:

| Code | Message |
| --- | --- |
| `INVALID_EMAIL_OR_PASSWORD` | Wrong email or password |
| `INVALID_PASSWORD` | Incorrect password |
| `PASSWORD_TOO_SHORT`, `PASSWORD_TOO_LONG` | Password must be at least 12 characters; Password must be at most 128 characters |
| `SESSION_EXPIRED` | Session expired, sign in again |
| `SESSION_NOT_FRESH` | Sign in again before changing this |
| `INVALID_CODE`, `INVALID_BACKUP_CODE` | Invalid code |
| `INVALID_TWO_FACTOR_COOKIE` | Verification expired, sign in again |
| `TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE`, `ACCOUNT_TEMPORARILY_LOCKED` | Too many requests; try again later |
| `PREVIOUSLY_REGISTERED` | This device already has a passkey for this account |
| `AUTHENTICATION_FAILED`, `PASSKEY_NOT_FOUND`, `CHALLENGE_NOT_FOUND`, `FAILED_TO_VERIFY_REGISTRATION` | Passkey verification failed |

## API error codes

Defined in `packages/contract/src/errors.ts`; thrown by `fail(code, message, data)` with the status from the definition. Access codes (`ACCESS_KEY_READ_ONLY`, `SCOPE_REQUIRED`, `SERVICE_ACCOUNT_FORBIDDEN`, `DEMO_READ_ONLY`): [API overview](api.en.md#access).

### Authentication, keys and setup

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `ACCESS_KEY_NOT_FOUND` | 404 | — | Access key not found | The AccessKey to change or revoke does not exist |
| `ACCESS_KEY_READ_ONLY` | 403 | — | This access key is read only | A read-only AccessKey calls a procedure other than `GET` ones and `rules.validate` |
| `ACCESS_KEY_REVOKED` | 409 | — | This access key is revoked | Changing a revoked AccessKey |
| `ACCESS_KEY_SESSION_REQUIRED` | 403 | — | Sign in to create or change an access key | `accessKeys.create` or `accessKeys.update` called with `x-api-key`; they need the signed-in session |
| `DEMO_READ_ONLY` | 403 | — | The demo account is read only | The demo account calls a write procedure, or changes the account through `/api/auth` |
| `LOGIN_IP_NOT_ALLOWED` | 403 | — | This IP is not on the login allow list | The client IP of a session request or an `/api/auth` sign-in request is outside the login allow list (AccessKeys are not limited) |
| `LOGIN_ALLOW_LIST_EXCLUDES_CURRENT_IP` | 400 | `ip` | The list excludes your current IP {ip}; saving would lock you out | The saved login allow list leaves out the caller's current IP |
| `DEMO_EMAIL_TAKEN` | 409 | — | The operator account uses the demo email | Turning on the demo account while the operator's account uses its e-mail |
| `SCOPE_REQUIRED` | 403 | `scope` | Missing scope: {scope} | The service account lacks the scope the procedure needs |
| `SERVICE_ACCOUNT_FORBIDDEN` | 403 | — | Service accounts cannot call this | A service account calls a procedure outside its allowed list |
| `SERVICE_ACCOUNT_NOT_FOUND` | 404 | — | Service account not found | The service account does not exist |
| `SERVICE_ACCOUNT_KEY_NOT_FOUND` | 404 | — | Key not found | The service account key to revoke does not exist or belongs to another account |
| `SERVICE_ACCOUNT_NAME_TAKEN` | 409 | `name` | A service account named {name} exists | The service account name is taken |
| `IDEMPOTENCY_KEY_INVALID` | 400 | — | Invalid Idempotency-Key | `Idempotency-Key` is not 1–255 printable ASCII characters |
| `IDEMPOTENCY_KEY_MISMATCH` | 422 | — | This Idempotency-Key was used for another request | The same `Idempotency-Key` with another method, path or body |
| `IDEMPOTENCY_IN_PROGRESS` | 409 | — | A request with this Idempotency-Key is still in progress | The first request with the same `Idempotency-Key` is still running |
| `IDEMPOTENCY_KEY_UNSUPPORTED` | 400 | — | This request returns a credential once and does not take an Idempotency-Key | `Idempotency-Key` on a procedure that returns a credential once |
| `SETUP_DONE` | 403 | — | Setup has already been completed | `system.setup` after setup has completed |
| `SETUP_IN_PROGRESS` | 409 | — | Setup is in progress; try again shortly | Another `system.setup` request is running |
| `SETUP_TOKEN_INVALID` | 403 | — | Invalid setup token | Wrong setup token in `system.setup`; audited as `system.setup_rejected` |
| `API_KEY_RATE_LIMITED` | 429 | `retryAfterSeconds` | Too many requests with this access key; try again in {retryAfterSeconds} s | The AccessKey exceeded its requests per minute |

### Alerts

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `ALERT_CHANNEL_NOT_FOUND` | 404 | — | Alert channel not found | The alert channel does not exist |
| `ALERT_CHANNEL_LIMIT` | 409 | — | Alert channel limit reached | 32 alert channels exist already |
| `ALERT_SEND_FAILED` | 502 | — | Notification delivery failed | A test send failed (the webhook, mail server or SMS provider failed or was unreachable) |
| `ALERT_SMTP_NOT_CONFIGURED` | 412 | — | SMTP is not configured | An e-mail channel is tested or used without saved SMTP settings |
| `ALERT_RATE_LIMITED` | 429 | `retryAt` | Send limit reached | An SMS channel used up its sends of the hour or day; `data.retryAt` is when the next send fits |
| `ALERT_SMS_REJECTED` | 502 | `code` | SMS provider refused: {code} | The SMS provider refused the message; `data.code` is the provider's error code |
| `ALERT_SUBSCRIPTION_NOT_FOUND` | 404 | — | Alert subscription not found | The alert subscription does not exist |
| `SMTP_PASSWORD_REQUIRED` | 400 | — | Enter a new password when changing the SMTP server or account | The SMTP server or user name changes without a new password |
| `SMTP_CA_INVALID` | 400 | — | The CA bundle must contain PEM certificates only | The SMTP CA certificates are not PEM |

### DNS

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `DNS_ZONE_MISMATCH` | 400 | — | CNAME domain is outside the DNS zone | The DNS name is outside the bound zone |
| `DNS_PROVIDER_NOT_FOUND` | 404 | — | DNS provider not found | The DNS provider does not exist |
| `DNS_TEST_DISABLED` | 400 | — | DNS test provider is disabled | The `test` provider is used without `EDGEWEIR_DNS_TEST_ENDPOINT` |
| `DNS_PROVIDER_IN_USE` | 409 | — | DNS provider is still in use | Deleting a provider that still owns DNS records; reconcile first |
| `DNS_POLICY_INVALID` | 400 | — | Check DNS lines and target addresses | The DNS binding's lines or targets are invalid, or the provider's credential fields are |
| `DNS_REVISION_NOT_FOUND` | 404 | — | DNS revision not found | The cluster has no such DNS revision |
| `DNS_NOT_BLOCKED` | 409 | — | This DNS revision is not held back | The DNS revision to release is not held back |
| `DNS_RECORD_CONFLICT` | 409 | `name` | DNS name {name} has an unmanaged record | The DNS name has records the console does not manage |
| `DNS_BINDING_CONFLICT` | 409 | `name` | {name} is taken by another cluster's DNS binding or a CNAME prefix | Another cluster's binding or a CNAME prefix uses the DNS name |
| `DNS_BINDING_IN_USE` | 409 | — | Turn the cluster's DNS off and wait for its records to be removed | The cluster's DNS is automatic or records it wrote remain: turn DNS off and wait for the cleanup before deleting the cluster or binding |
| `DNS_PROVIDER_AUTH_FAILED` | 400 | — | The DNS provider rejected the credentials | The provider refused the credentials |
| `DNS_PROVIDER_ZONE_NOT_FOUND` | 400 | — | The DNS provider has no such zone | The provider account has no such zone |
| `DNS_PROVIDER_UNREACHABLE` | 502 | — | The DNS provider is unreachable | The provider's API was unreachable or timed out |
| `DNS_PROVIDER_RATE_LIMITED` | 429 | — | Too many DNS provider requests; try again later | The provider's API rate-limited the request |
| `DNS_PROVIDER_FAILED` | 502 | — | The DNS provider request failed | The provider's API failed otherwise |
| `DNS_ADDRESS_REFUSED` | 400 | — | The server address is private or special-purpose, or a public address without HTTPS | The provider's server address (such as a self-hosted PowerDNS) is private or special-purpose, or a public one without HTTPS |
| `DNS_ZONES_UNSUPPORTED` | 400 | — | This provider cannot list zones; enter the zone | The provider cannot list zones |
| `DNS_LINE_UNSUPPORTED` | 400 | `line` | This DNS provider has no {line} resolution line | A binding line uses a resolution line the provider does not implement |
| `DNS_RECONCILE_BUSY` | 409 | — | This cluster's DNS is still being synced; try again later | A requested reconciliation waited in vain for the one in progress |

### Rules, IP lists and WAF

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `RULE_INVALID` | 400 | — | Invalid rule | The rule's expression, action or reference is invalid, or a rule ID repeats; the reason is in `message` |
| `RULE_VERSION_NOT_FOUND` | 404 | — | Rule version not found | The rule keeps no such version (pruned, or another site's rule) |
| `RULE_LIMIT_REACHED` | 400 | `limit` | Rule limit of {limit} reached | Restoring a deleted rule would exceed the limit: 64 per site, 32 platform rules |
| `WAF_RULE_NOT_EXCLUDABLE` | 400 | `ids` | {ids} set up or evaluate the CRS and cannot be excluded; to stop blocking, use Detect only | Excluded CRS rules set up or evaluate the others (first 5) |
| `BULK_REDIRECT_HOST_UNKNOWN` | 400 | `hosts` | The site does not serve {hosts} | A `host/path` bulk redirect source whose host is none of the site's domains |
| `IP_LIST_NOT_FOUND` | 404 | — | IP list not found | The IP list does not exist |
| `IP_LIST_REFERENCE_UNKNOWN` | 404 | `lists` | No such IP list: {lists} | A rule or cache rule condition references lists (`$name`) that do not exist |
| `IP_LIST_NAME_TAKEN` | 409 | — | IP list name already exists | The IP list name is taken |
| `IP_LIST_LIMIT` | 409 | — | IP list limit reached (128 lists, 50,000 entries) | More than 128 lists or 50,000 entries |
| `IP_LIST_IN_USE` | 409 | `users` | The IP list is used by {users} | Deleting a list that rules, cache rules or L4 apps still use (first 5) |

### Bans, greylist and protection

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `BAN_INVALID_CIDR` | 400 | — | Invalid IP address or CIDR | Not an IP address or CIDR |
| `BAN_PREFIX_TOO_SHORT` | 400 | `min` | Prefix too short; the shortest is /{min} | The prefix is shorter than the minimum (IPv4 `/16`, IPv6 `/48`) |
| `BAN_EXPIRY_OUT_OF_RANGE` | 400 | — | A ban lasts from 1 minute to 7 days | The duration is outside 60–604800 seconds |
| `BAN_PROTECTED_ADDRESS` | 400 | `address` | The ban covers the protected address {address} | The range holds a node address, loopback or the unspecified address, or overlaps an allow-type IP list |
| `BAN_PLATFORM_LIMIT` | 409 | `limit` | At most {limit} manual bans can be active | Active manual bans reached `maxTotal` |
| `BAN_NOT_FOUND` | 404 | — | Ban not found or no longer active | The ban or greylist entry does not exist, expired or was lifted |
| `PROTECTION_POW_DIFFICULTY` | 400 | `min` | The high proof-of-work difficulty must be at least {min} | The high proof-of-work difficulty is below the normal difficulty |

### Certificates and ACME

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `CERTIFICATE_NOT_FOUND` | 404 | — | Certificate not found | The certificate does not exist |
| `CERTIFICATE_INVALID` | 400 | — | The stored certificate cannot be read | A stored certificate cannot be read |
| `CERTIFICATE_CHAIN_FOREIGN_BLOCK` | 400 | — | The chain may contain only certificates; put the private key in its own field | The chain holds PEM blocks other than certificates (such as a private key) |
| `CERTIFICATE_CHAIN_UNREADABLE` | 400 | — | The chain must hold 1 to 10 readable PEM certificates | No PEM certificate, more than 10, or one that cannot be parsed |
| `CERTIFICATE_KEY_UNREADABLE` | 400 | — | The private key cannot be read; encrypted keys are not supported | The private key cannot be read, such as an encrypted one |
| `CERTIFICATE_KEY_MISMATCH` | 400 | — | The private key does not belong to the certificate | The private key does not match the leaf certificate |
| `CERTIFICATE_KEY_EXPLICIT_CURVE` | 400 | — | The EC private key uses explicit curve parameters; convert it to a named curve | An EC private key with explicit curve parameters instead of the curve's OID |
| `CERTIFICATE_CHAIN_EXPLICIT_CURVE` | 400 | — | A certificate's EC key uses explicit curve parameters; reissue it with a named-curve key | A chain certificate whose EC key has explicit curve parameters |
| `CERTIFICATE_CHAIN_ORDER` | 400 | — | Wrong chain order: the leaf certificate first, then each issuer | The first certificate is a CA, or one is not issued by the next |
| `CERTIFICATE_NOT_CURRENTLY_VALID` | 400 | `notBefore`, `notAfter` | The certificate is not valid now (valid from {notBefore} to {notAfter}) | Not yet valid or expired; `data` is the validity in UTC, such as `2026-10-02 12:00 UTC` |
| `CERTIFICATE_NO_DNS_NAMES` | 400 | — | The certificate has no DNS names (subject alternative names) | The certificate has no DNS SAN |
| `CERTIFICATE_KEY_TYPE_UNSUPPORTED` | 400 | — | Unsupported key type; use RSA (2048 bits or more) or ECDSA P-256, P-384 or P-521 | The leaf key is not RSA (2048 bits or more) or ECDSA P-256, P-384 or P-521 |
| `CERTIFICATE_UNAVAILABLE` | 409 | — | The certificate is not issued yet or has expired | The certificate chosen for a site is not issued yet or has expired |
| `CERTIFICATE_DOMAIN_MISMATCH` | 400 | `domains` | Certificate domains do not match the site or DNS zone: {domains} | Names a certificate or DNS zone does not cover, or HTTP-01 names no site has (first 5) |
| `CERTIFICATE_BUSY` | 409 | — | Certificate operation is already in progress | Deleting a certificate that is issuing; renewing an uploaded or issuing certificate; a request bound to a site that already has one waiting |
| `CERTIFICATE_IN_USE` | 409 | `sites` | The certificate is used by sites: {sites} | Deleting a certificate sites use (first 5) |
| `CERTIFICATE_IN_USE_BY_L4` | 409 | `apps` | The certificate is still used by L4 apps: {apps} | Deleting a certificate L4 apps terminate TLS with (first 5) |
| `DNS_CREDENTIAL_NOT_FOUND` | 404 | — | DNS credential not found | The DNS credential does not exist |
| `DNS_CREDENTIAL_INVALID` | 400 | — | Invalid DNS credential fields | The DNS credential's fields do not fit the provider |
| `DNS_CREDENTIAL_IN_USE` | 409 | `certificates` | The DNS credential is used by certificates: {certificates} | Deleting a DNS credential certificates use (first 5) |
| `CERTIFICATE_DNS_NOT_POINTING` | 409 | `names` | These names do not resolve to the nodes: {names} | HTTP-01 names resolve to no node, or to other addresses too (first 5) |
| `CERTIFICATE_NODES_OFFLINE` | 409 | `clusters` | No online node can answer HTTP-01 in cluster {clusters} | Clusters serving the HTTP-01 names have no online node (first 5) |
| `CLIENT_CA_INVALID` | 400 | — | The client CA must be 1 to 10 current CA certificates in PEM | The site's client CA bundle is not 1–10 current CA certificates in PEM |
| `CLIENT_CERTIFICATE_HTTP3` | 400 | — | Client certificates and HTTP/3 cannot be on together | Client certificates and HTTP/3 turned on together |
| `ACME_DIRECTORY_INVALID` | 400 | — | The URL does not answer with an ACME directory | The custom ACME directory cannot be read or is not an ACME directory |
| `ACME_DIRECTORY_CA_INVALID` | 400 | — | The CA certificates must be 1 to 10 PEM certificates | The custom ACME directory's CA certificates are not 1–10 PEM certificates |
| `ACME_DIRECTORY_EAB_INCOMPLETE` | 400 | — | Enter the EAB HMAC key with its key ID | An EAB key ID without an HMAC key (none saved for it) |
| `ACME_DIRECTORY_NOT_CONFIGURED` | 409 | — | Configure a custom ACME directory in the system settings first | A certificate requests the custom CA while no custom ACME directory is configured |
| `ACME_ACCOUNT_NOT_FOUND` | 404 | — | ACME account not found | The ACME account does not exist |
| `ACME_ACCOUNT_IN_USE` | 409 | `certificates` | The ACME account is used by certificates: {certificates} | Deleting an ACME account certificates use (first 5) |
| `CERTIFICATE_ORIGIN_CA` | 400 | — | Origin CA certificates are for origins only | Uploading a certificate the Origin CA issued as a visitor certificate |

### Origin PKI

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `ORIGIN_CA_NOT_FOUND` | 409 | — | Create the Origin CA first (Certificates → Origin certificates) | The Origin CA has not been created (issuing origin certificates, or a site trusting it) |
| `ORIGIN_CLIENT_CA_NOT_FOUND` | 409 | — | Create the origin client CA first (Certificates → Origin client) | The origin client CA has not been created |
| `CA_ROTATION_IN_PROGRESS` | 409 | — | A rotation is already under way | Starting a rotation while one is under way |
| `CA_ROTATION_STEP_UNAVAILABLE` | 409 | — | This step does not apply to the rotation's current stage | The rotation step does not apply to the rotation's current state |
| `CA_ROTATION_INCOMPLETE` | 409 | `clusters` | These clusters still present certificates of the previous CA: {clusters} | Retiring the previous origin client CA while clusters still present its certificates (first 5, then `+N`) |
| `CA_ROTATION_IN_USE` | 409 | `count` | The new CA has issued valid certificates ({count}); the rotation cannot be cancelled | Cancelling an Origin CA rotation after the new CA issued certificates that are still valid |
| `ORIGIN_CERTIFICATE_NOT_FOUND` | 404 | — | Origin certificate not found | The origin certificate does not exist |
| `ORIGIN_CERTIFICATE_REVOKED` | 409 | — | The certificate is already revoked | Revoking an origin certificate that is revoked already |
| `ORIGIN_CERTIFICATE_CSR_INVALID` | 400 | — | The CSR cannot be read, its signature fails, or its key is not RSA 2048–4096 or ECDSA P-256 / P-384 | The CSR cannot be read, its signature fails, or its key is not RSA 2048–4096 or ECDSA P-256 / P-384 |

### Clusters, nodes and regions

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `CLUSTER_NOT_FOUND` | 404 | — | Cluster not found | The cluster does not exist |
| `CLUSTER_SITE_LIMIT` | 409 | `limit` | This cluster has reached its limit of {limit} published sites | The cluster would publish more than 512 enabled sites |
| `NODE_CAPABILITY_REQUIRED` | 409 | `features`, `nodes` | Nodes do not support {features} yet: {nodes} | Configuration published by a service account or an automatic job needs features active nodes lack; `data.features` lists them (comma-separated), `data.nodes` the first 5 nodes |
| `CLUSTER_NAME_TAKEN` | 409 | `name` | Cluster name already exists: {name} | The cluster name is taken |
| `CLUSTER_NOT_EMPTY` | 409 | `nodes`, `sites` | The cluster still has {nodes} nodes and {sites} sites | Deleting a cluster that still has nodes or sites |
| `NO_CLUSTER` | 412 | — | No cluster exists yet | A site is created without `clusterId` before any cluster exists |
| `NODE_GROUP_NOT_FOUND` | 404 | — | Node group not found | The node group does not exist |
| `NODE_GROUP_NAME_TAKEN` | 409 | `name` | Node group already exists: {name} | The node group name is taken in the cluster |
| `NODE_GROUP_IS_DEFAULT` | 409 | — | The default node group cannot be deleted | Deleting the default node group |
| `NODE_GROUP_CLUSTER_MISMATCH` | 400 | — | The node group belongs to another cluster | An enrollment token or a node names a node group of another cluster |
| `REGION_NOT_FOUND` | 404 | — | Region not found | The region does not exist |
| `REGION_CODE_TAKEN` | 409 | `code` | Region code already exists: {code} | The region code is taken |
| `REGION_IN_USE` | 409 | `probes` | {probes} probes still belong to this region | Deleting a region that probes are bound to |
| `PROBE_NOT_FOUND` | 404 | — | Probe not found | The probe does not exist |
| `NODE_REGION_REQUIRED` | 409 | — | Set a region on the node's group first | Making a node probe while its node group has no region |
| `NODE_ADDRESS_INVALID` | 400 | `address` | Not a single unicast IP address: {address} | A scheduling address that is not a single unicast IP literal |
| `SCHEDULING_RULE_NOT_FOUND` | 404 | — | Scheduling rule not found | The scheduling rule does not exist |
| `SCHEDULING_RULE_INVALID` | 400 | — | The rule needs a line of the cluster's DNS binding | A rule the cluster cannot evaluate (such as `backup_group` without a line, or a line not in the cluster's DNS binding) |
| `NODE_NOT_FOUND` | 404 | — | Node not found | The node does not exist |
| `NODE_CHANNEL_NAME_NOT_FOUND` | 404 | — | The certificate has no such earlier name | The name is not one an earlier node channel URL left in the certificate |
| `NODE_CHANNEL_NAME_IN_USE` | 409 | `nodes`, `probes` | Nodes ({nodes}) and probes ({probes}) may still use this name | Nodes or probes may still connect with the name |
| `NODE_CHANNEL_WEBSOCKET_IN_USE` | 409 | `nodes`, `probes` | Nodes ({nodes}) and probes ({probes}) may still use the WebSocket entry | Closing the WebSocket entry while nodes or probes may still use it |
| `NODE_CHANNEL_WEBSOCKET_REQUIRED` | 409 | — | The WebSocket entry stays open (current URL or EDGEWEIR_NODE_API_WEBSOCKET) | The current node channel URL or `EDGEWEIR_NODE_API_WEBSOCKET` needs the WebSocket entry |
| `ENROLLMENT_TOKEN_NOT_FOUND` | 404 | — | Enrollment token not found | The enrollment token does not exist |
| `DEFAULT_SITE_INVALID` | 400 | — | The default site must be an enabled site of this cluster | The default site for unknown hosts is not an enabled site of the cluster |
| `DEFAULT_SITE_CERTIFICATE_REQUIRED` | 409 | — | The default site has no certificate | Unknown SNI gets the default site's certificate while it has none |
| `REVISION_NOT_FOUND` | 404 | — | Revision not found | The cluster has no such revision |
| `ROLLOUT_NOT_ACTIVE` | 409 | — | No canary rollout is running | Promoting or aborting a canary while none is running |
| `ROLLBACK_RESOURCE_UNAVAILABLE` | 409 | — | The rollback references resources that are gone or unavailable | The revision to roll back to references sites, domains, certificates, IP lists or CAs that are gone, moved or unavailable, or an expired certificate |

### Node upgrades

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `UPGRADE_RELEASE_UNAVAILABLE` | 502 | — | This release manifest is unavailable | The release manifest cannot be read, or the release has no archive for a supported architecture |
| `RELEASE_SOURCE_REFUSED` | 400 | — | The release source must use HTTPS and resolve to an allowed address | The node release source resolves to a refused address, or a public one without HTTPS |
| `UPGRADE_NOT_FOUND` | 404 | — | Upgrade job not found | The upgrade does not exist |
| `UPGRADE_BUSY` | 409 | `nodes` | These nodes already have an unfinished upgrade: {nodes} | Nodes already take part in an unfinished upgrade (first 10, then `+N`) |
| `UPGRADE_FINISHED` | 409 | — | The upgrade has already finished | Cancelling an upgrade that has ended |
| `UPGRADE_NODES_UNAVAILABLE` | 409 | `nodes` | These nodes must be online, healthy, in sync and support signed upgrades: {nodes} | Active nodes are offline, unhealthy, out of sync or cannot self-upgrade (first 10, then `+N`) |
| `UPGRADE_CANARY_EMPTY` | 409 | — | The canary node group has no enabled nodes | The canary node group has no active nodes |
| `UPGRADE_TOO_MANY_NODES` | 409 | `limit` | An upgrade covers at most {limit} nodes | An upgrade covers more than 1000 nodes |
| `UPGRADE_NOT_READY` | 409 | — | Canary nodes have not passed the health window | Promoting while the canary nodes have not stayed healthy yet |

### Sites

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `SITE_NOT_FOUND` | 404 | — | Site not found | The site does not exist |
| `CACHE_RULE_PRIORITY_DUPLICATE` | 400 | `priority` | Two cache rules have priority {priority} | Two cache rules share a priority |
| `SITE_DISABLED` | 409 | — | The site is disabled | Purging or prefetching a disabled site |
| `UPDATED_AT_MISMATCH` | 409 | `updatedAt` | It changed since you loaded it; reload and try again | `expectedUpdatedAt` differs from the resource's `updatedAt`; `data.updatedAt` is the current value (empty while there is none) |
| `DOMAIN_IN_USE` | 409 | `domains` | Domain already in use: {domains} | Another site uses the domains |
| `DOMAIN_INVALID` | 400 | `domain` | Invalid domain: {domain} | A Unicode or `xn--` host name that UTS #46 or the LDH rules refuse |
| `CNAME_PREFIX_CONFLICT` | 409 | `prefix` | CNAME prefix {prefix} is taken or reserved | The CNAME prefix is taken, still resolving for another site or L4 app, or a DNS record name |
| `CNAME_PREFIX_INVALID` | 400 | `prefix` | Invalid CNAME prefix {prefix} | The prefix does not match `^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?$` (except the object's current prefix or a replaced one still resolving) |
| `PURGE_KEY_REQUIRED` | 400 | — | The PURGE method needs a key | Turning on the PURGE method without `cacheSettings.purgeMethod.key` |
| `SITE_TAG_LIMIT` | 400 | `site`, `limit` | Site {site} can have at most {limit} tags | A site would carry more than 10 tags |
| `SITE_TAG_NOT_FOUND` | 404 | — | Tag not found | The tag does not exist |
| `ORIGIN_GROUP_UNKNOWN` | 400 | `group`, `rule` | Rule "{rule}" chooses origin group {group}, which the site does not have | Copied or cloned settings: a rule chooses an origin group the site does not have |
| `HTTPS_REQUIRES_CERTIFICATE` | 400 | — | The HTTPS redirect, HSTS and client certificates need a certificate on the site | Copied settings: the HTTPS redirect, HSTS or client certificates on a site without a certificate |

### Origins

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `S3_SECRET_REQUIRED` | 400 | `accessKeyId` | Enter the secret key for {accessKeyId} | A new S3 origin, or one with a new access key, without a secret key |
| `ORIGIN_ADDRESS_FORBIDDEN` | 400 | `address`, `range` | Origin address {address} is in the special-purpose range {range}, outside the origin allow list | An origin or authentication service address in a special-purpose range not on the origin allow list |
| `ORIGIN_GRPC_REQUIRES_HTTP2` | 400 | — | gRPC requires HTTP/2 towards the origins | `originSettings.grpc` on a pool whose protocol towards the origins is not `http2` |
| `ORIGIN_TLS_TRUST_REQUIRES_VERIFY` | 400 | — | Trusting the Origin CA requires verifying origin certificates | `originSettings.tlsTrust` `originCa` with `tlsVerify` off |
| `ORIGIN_CA_S3` | 400 | — | S3 origins cannot be verified against the Origin CA | `tlsTrust: originCa` on a site with S3 origins |
| `ORIGIN_PROXY_PROTOCOL_S3` | 400 | — | S3 origins do not read PROXY protocol | `proxyProtocolVersion` on an S3 origin |
| `ORIGIN_HOST_HEADER_INVALID` | 400 | `hostHeader` | Invalid origin Host: {hostHeader} | The Host header of an origin or origin rule is not a host name or IP literal with an optional port |

### Ports and HTTPS redirect

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `LISTEN_PORT_CONFLICT` | 400 | `port` | Port {port} cannot be both HTTP and HTTPS | A port in both the extra HTTP and the extra HTTPS ports |
| `LISTEN_PORT_IN_POOL` | 400 | `port`, `pools` | Port {port} is inside port pools: {pools} | An extra listener port inside a port pool of the cluster |
| `LISTEN_PORT_IN_USE` | 409 | `port`, `sites` | Port {port} is still used by sites: {sites} | Removing a listener port sites still use (first 5) |
| `SITE_PORT_UNAVAILABLE` | 400 | `port` | Port {port} is not a listener port of the cluster | A site port that is not an HTTP or HTTPS listener port of its cluster |
| `SITE_PORTS_EMPTY` | 400 | — | The site needs at least one usable port | The site would be served on no port |
| `SITE_HTTPS_PORT_NEEDS_CERTIFICATE` | 400 | `port` | HTTPS port {port} needs a certificate | An HTTPS port other than 443 for a site without a certificate |
| `HTTPS_REDIRECT_PORT_INVALID` | 400 | `port` | Redirect port {port} is not an HTTPS port of the site | The HTTPS redirect's port is neither 443 nor an HTTPS port of the site |
| `HTTPS_REDIRECT_DOMAIN_INVALID` | 400 | `domains` | The site has no such domains: {domains} | Domains excluded from the HTTPS redirect that the site does not have |

### Cache tasks and error pages

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `CACHE_TASK_NOT_FOUND` | 404 | — | Task not found | The cache task does not exist |
| `CACHE_TASK_URL_INVALID` | 400 | `urls` | Invalid URL: {urls} | URLs or prefixes that do not parse for the task type (first 5) |
| `CACHE_TASK_HOST_UNKNOWN` | 400 | `hosts` | No site serves {hosts} | No site uses the hosts |
| `CACHE_TASK_HOST_INVALID` | 400 | `hosts` | Invalid host: {hosts} | Invalid host names |
| `CACHE_TASK_TAG_INVALID` | 400 | `tags` | Invalid cache tag: {tags} | Invalid cache tags |
| `ERROR_PAGE_TOO_LARGE` | 400 | `status`, `limit` | The {status} error page is larger than {limit} bytes | An error page template over 65536 bytes; `data.status` names the page (404 / 503 for platform pages) |

### Access authentication and access control

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `AUTH_DOMAIN_UNKNOWN` | 400 | `domain` | The site has no domain {domain} | An access authentication rule's scope names a domain the site does not have |
| `AUTH_PASSWORD_REQUIRED` | 400 | `user` | User {user} needs a password | A new Basic user (or one of a rule that had no users stored) without a password |
| `AUTH_KEY_REQUIRED` | 400 | — | A signing key is required | A URL authentication rule without a stored primary key and none given |
| `AUTH_RULE_NOT_FOUND` | 404 | — | The authentication rule no longer exists; reload and try again | The access authentication rule does not exist |
| `AUTH_RULE_NOT_URL` | 400 | — | Only URL authentication rules sign URLs | Signing a URL with a rule other than URL authentication (kinds A–D) |
| `AUTH_SIGN_URL_INVALID` | 400 | — | Enter a path starting with / or an http(s) URL of this site | The URL to sign is neither a path nor an `http(s)` URL of the site's domains |
| `AUTH_SIGN_VALIDITY` | 400 | `max` | Validity cannot exceed the rule's {max} seconds | The signed URL's validity exceeds the rule's validity (seconds) |
| `SITE_LIST_CONFLICT` | 400 | `lists` | A list cannot be both a site block and allow list: {lists} | An IP list chosen as both a site block list and a site allow list |
| `CORS_CREDENTIALS_WILDCARD` | 400 | — | With credentials, origins cannot be * | CORS with credentials allows every origin (`*`) |
| `IP_ADDRESS_INVALID` | 400 | — | Invalid IP address | The address given to `ipCheck.check` is not IPv4 or IPv6 |

### Usage, automatic mitigation and node logs

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `USAGE_RANGE_INVALID` | 400 | — | The range must be aligned to 5 minutes and end after it starts | The range is not aligned to 5 minutes, or its end is not after its start |
| `USAGE_CURSOR_INVALID` | 400 | — | Invalid page cursor | Invalid usage page cursor |
| `USAGE_GUARD_NOT_HELD` | 409 | — | Usage protection holds no action | Restoring a site whose usage protection holds no action |
| `AUTO_MITIGATION_NOT_ACTIVE` | 409 | — | Automatic mitigation holds no Under Attack | Ending the automatic mitigation of a site that holds no Under Attack |
| `NODE_LOG_CURSOR_INVALID` | 400 | — | Invalid page cursor | Invalid node log page cursor |
| `NODE_DEBUG_LOGS_BUSY` | 409 | — | A pull of this node is still open | The node has a debug log pull that has not finished |
| `NODE_DEBUG_LOG_NOT_FOUND` | 404 | — | Pull not found | The debug log pull does not exist |

### L4 apps

| Code | Status | `data` | Message | Condition |
| --- | --- | --- | --- | --- |
| `L4_APP_NOT_FOUND` | 404 | — | L4 app not found | The L4 app does not exist |
| `L4_APP_LIMIT` | 409 | `limit` | A cluster can have at most {limit} L4 apps | The cluster has 256 L4 apps already |
| `L4_PORT_OUTSIDE_POOL` | 400 | `port` | Port {port} is outside the cluster's port pools for this protocol | An app port outside every port pool of its cluster for its protocol |
| `L4_PORT_IN_USE` | 409 | `apps` | Ports in use by {apps} | Other apps of the cluster use the ports, or a pool change would leave app ports outside the pools; `data.apps` lists `name (port/protocol)` |
| `L4_PORT_RESERVED` | 400 | `port` | Port {port} is used by the cluster's HTTP listeners | A pool or app uses a port of the cluster's HTTP(S) listeners |
| `L4_PORT_POOL_OVERLAP` | 400 | `pools` | Port pools overlap: {pools} | Port pools share ports of a protocol (`from-to/protocol`) |
| `L4_PROXY_PROTOCOL_UNSUPPORTED` | 400 | — | PROXY protocol is for TCP apps only | PROXY protocol (accepted or sent) on a UDP app |
| `L4_PORT_LIMIT` | 409 | `limit` | A cluster's L4 apps use at most {limit} ports | The ports of the cluster's L4 apps (ranges counted in full) exceed 2048 |
| `L4_PORT_RANGE_INVALID` | 400 | `max` | The last port must be above the first, at most {max} ports | A port range whose last port is not above the first or that holds more than 1000 ports |
| `L4_ORIGIN_PORT_REQUIRED` | 400 | — | Every origin needs a port while the origin port is fixed | An origin without a port while `originPortMode` is fixed |
| `L4_TLS_UNSUPPORTED` | 400 | — | TLS termination is for TCP apps only | TLS termination on a UDP app |
| `L4_CERTIFICATE_UNAVAILABLE` | 400 | — | The certificate is not issued yet or has expired | The chosen certificate is not issued yet or has expired |

## Revision reason codes

Why a configuration revision (`GET /clusters/{id}/revisions`) was published, stored as `reason_code` with parameters. The console shows the `revision_reason_<code>` message; the API also returns the English text (`reasonText`). 49 codes.

| Code | Parameters | Message | API text (`reasonText`) |
| --- | --- | --- | --- |
| `rules_updated` | — | Rules and IP lists updated | rules and IP lists updated |
| `certificate_updated` | `site` | Certificate policy for {site} updated | certificate policy for {site} updated |
| `acme_challenge_updated` | — | ACME challenge updated | ACME challenge updated |
| `cluster_created` | `cluster` | Cluster {cluster} created | cluster {cluster} created |
| `site_created` | `site` | Site {site} created | site {site} created |
| `site_updated` | `site` | Site {site} updated | site {site} updated |
| `site_deleted` | `site` | Site {site} deleted | site {site} deleted |
| `site_purged` | `site` | Site {site} purged | site {site} purged |
| `site_enabled` | `site` | Site {site} enabled | site {site} enabled |
| `site_disabled` | `site` | Site {site} disabled | site {site} disabled |
| `rollback` | `revision` | Rolled back to #{revision} | rollback to revision {revision} |
| `rollout_rollback` | `revision` | Canary of revision {revision} rolled back | canary of revision {revision} rolled back |
| `origin_allow_list_updated` | — | Origin allow list updated | origin allow list updated |
| `site_protection_updated` | `site` | Protection of {site} updated | protection of {site} updated |
| `platform_protection_updated` | — | Global Under Attack updated | global Under Attack updated |
| `cc_template_updated` | — | CC template updated | CC template updated |
| `challenge_keys_rotated` | — | Challenge keys rotated | challenge keys rotated |
| `session_ticket_keys_rotated` | — | TLS session ticket keys rotated | TLS session ticket keys rotated |
| `site_waf_updated` | `site` | OWASP CRS of {site} updated | OWASP CRS of {site} updated |
| `site_error_pages_updated` | `site` | Error pages of {site} updated | error pages of {site} updated |
| `site_maintenance_updated` | `site` | Maintenance of {site} updated | maintenance of {site} updated |
| `site_auth_updated` | `site` | Access authentication of {site} updated | access authentication of {site} updated |
| `site_access_control_updated` | `site` | Access control of {site} updated | access control of {site} updated |
| `cluster_cache_updated` | — | Cache zone updated | cache zone updated |
| `node_cache_updated` | `node` | Cache size of node {node} updated | cache size of node {node} updated |
| `error_pages_updated` | — | Platform error pages updated | platform error pages updated |
| `recompiled` | — | Configuration recompiled after an upgrade | configuration recompiled after an upgrade |
| `l4_app_created` | `app` | L4 app {app} created | L4 application {app} created |
| `l4_app_updated` | `app` | L4 app {app} updated | L4 application {app} updated |
| `l4_app_deleted` | `app` | L4 app {app} deleted | L4 application {app} deleted |
| `listen_ports_updated` | — | Listener ports updated | listener ports updated |
| `client_ip_updated` | — | Client IP setting updated | client address setting updated |
| `unknown_hosts_updated` | — | Unknown host settings updated | unknown host settings updated |
| `connection_limits_updated` | — | Connection limits updated | connection limits updated |
| `greylist_challenge` | — | Challenge keys for the greylist | challenge keys for the greylist |
| `sites_enabled` | `count` | {count} sites enabled | {count} sites enabled |
| `sites_disabled` | `count` | {count} sites disabled | {count} sites disabled |
| `sites_deleted` | `count` | {count} sites deleted | {count} sites deleted |
| `site_settings_copied` | `site`, `source` | Settings of {source} copied to {site} | settings of {source} copied to {site} |
| `site_cloned` | `site`, `source` | Site {site} cloned from {source} | site {site} cloned from {source} |
| `usage_limit_reached` | `site` | Usage limit of {site} reached | usage limit of {site} reached |
| `usage_limit_released` | `site` | Usage protection of {site} lifted | usage protection of {site} lifted |
| `auto_mitigation_started` | `site` | Automatic mitigation turned on Under Attack for {site} | automatic mitigation turned on Under Attack for {site} |
| `auto_mitigation_ended` | `site` | Automatic mitigation turned off Under Attack for {site} | automatic mitigation turned off Under Attack for {site} |
| `origin_certificate_revoked` | — | Origin certificate revoked | origin certificate revoked |
| `origin_client_certificate_rotated` | — | Origin client certificate replaced | origin client certificate replaced |
| `origin_ca_rotation_started` | — | Origin CA rotation started | Origin CA rotation started |
| `origin_ca_rotation_cancelled` | — | Origin CA rotation cancelled | Origin CA rotation cancelled |
| `origin_ca_retired` | — | Previous Origin CA retired | previous Origin CA retired |
