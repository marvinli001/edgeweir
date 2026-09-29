# Domains, DNS, and alerts

Domain ownership checks, platform DNS steering records, and alert channels, rules, and subscriptions.

## Concepts

| Term | Definition |
| --- | --- |
| Registrable domain | The first label below a public suffix (including the private section), for example `example.com`, `example.co.uk`, `alice.github.io`. Ownership is checked per registrable domain. |
| Domain ownership | An organization's right to route a registrable domain. Unverified domains stay in the console and are not published to nodes. |
| CNAME domain | The parent domain of the steering records platform DNS creates; it must lie inside the selected DNS provider's zone. |
| Line | The A/AAAA records of one node group in platform DNS. |
| DNS revision | A snapshot of the platform DNS policy and its records, separate from node configuration revisions. |
| Alert channel | A notification target configured by a platform administrator: email, webhook, DingTalk, WeCom, or Telegram. |

## Verify domain ownership

1. Open **Console → Sites**, select the site, and open the **Domains** tab.
2. In the **Domain ownership** card, click **Create verification record** for a domain marked **Verification required**.
3. Copy the **TXT name** and **TXT value** and add the TXT record at the registrable domain's authoritative DNS:

   ```text
   _edgeweir-verification.example.com.  TXT  "edgeweir=<token>"
   ```

4. Confirm the record resolves:

   ```bash
   dig +short TXT _edgeweir-verification.example.com
   ```

   The output contains `"edgeweir=<token>"`.
5. Click **Verify TXT record**.
6. Verify: the status changes to **Verified**, the console publishes a new configuration revision, and the domains under that registrable domain enter the node configuration.

### Ownership rules

| Item | Behavior |
| --- | --- |
| Scope | One TXT record verifies the whole registrable domain; every host name and wildcard under it across the organization's sites takes effect |
| Uniqueness | On one platform a registrable domain belongs to one organization. Several organizations may hold pending claims; once one verifies, the others can no longer use the root, its subdomains, or wildcards (`DOMAIN_IN_USE`) |
| Platform administrators | When a platform administrator creates a site or saves its domains, unverified registrable domains are marked **Administrator approved**. A platform administrator can also click **Approve without TXT** on an existing pending domain. Both write the audit action `domain.bypass` |
| Revocation | **Revoke verification** stops routing for that registrable domain on all of the organization's sites. A configuration rollback does not restore unverified domains |
| Release | Removing the last site reference to a registrable domain deletes its ownership record |
| Transfer | To move a domain to another organization, a platform administrator revokes the old organization's verification and the new organization completes the TXT check |
| Certificates | An uploaded certificate does not replace domain ownership. ACME requests require every certificate name to be verified, see [HTTPS and certificates](https.en.md) |
| Existing deployments | When the console first enables domain ownership, it withdraws existing routes without proof; complete the TXT check for each domain or have a platform administrator approve it |

### TXT lookups

| Item | Value |
| --- | --- |
| Recursive servers | The servers saved in **Admin → System → Ownership check DNS**; otherwise `EDGEWEIR_DNS_RESOLVERS`, then the system resolver, see [Platform administration](admin.en.md) |
| Single lookup | 2.5-second timeout, at most 2 tries |
| Concurrency | At most 16 verification lookups at a time per console process |
| Rate | At least 5 seconds between two checks of the same registrable domain (`DOMAIN_VERIFY_BUSY`) |
| Resolver choice | Tenants and verification requests cannot choose a resolver |

## Configure platform DNS

Platform DNS creates a CNAME target for every site and steers traffic to healthy nodes. Platform administrators only.

1. Open **Admin → Platform DNS** and click **Add DNS provider**.
2. Enter **Name** and **DNS zone**, select **DNS provider**, fill in the credential fields (see below), and click **Create**.
3. In the **DNS configuration** card, turn on **Enabled**, select **DNS provider**, and enter **CNAME domain** and **TTL (seconds)**.
4. Click **Add line**, enter **Line name**, and select **Node group**. For nodes behind NAT or on a private network, enter the public addresses in the node's **node name: target addresses** field; leave it empty to use the reported public IPs.
5. Click **Save**. The console shows **DNS revision N created**.
6. Verify: the revision's status in **DNS revisions** is **Published**, and the site's **Domains** tab shows **CNAME target**.

   ```bash
   dig +short CNAME <site UUID>.<CNAME domain>
   ```

   The output is `all.<site UUID>.<CNAME domain>.`.
7. In each site domain's DNS, point the domain to the **CNAME target** with a CNAME record.

### Provider credentials

Credentials are envelope-encrypted with the master key and are write-only. Grant the API credential the minimum DNS edit permission on the target zone.

| Provider | Fields |
| --- | --- |
| Cloudflare | API token |
| Alibaba Cloud | Access key ID, Access key secret |
| Huawei Cloud | Access key ID, Access key secret, Region |
| DNSPod | API token (the `ID,Token` of the DNSPod classic API) |

**Edit** re-enters the credentials to rotate them; **DNS zone** and **DNS provider** cannot change after creation.

### DNS configuration fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Enabled | On / off | Off | Off removes every system-managed record |
| DNS provider | An added provider | None | Account and zone the records are written to |
| CNAME domain | A domain inside the provider zone, up to 180 characters | None | Parent of the generated records |
| TTL (seconds) | 30–3600 | 600 | TTL of every record; a provider or plan may enforce a higher minimum |
| Line name | Lowercase letters, digits, `-`, 1–32 characters, not `all` | `line-N` | First label of the line host name |
| Node group | At most one line per node group | First unused node group | Nodes the line contains |
| Target addresses | Up to 8 IPs per node, comma-separated | Empty (reported public IPs) | Replaces the reported addresses; may be private, never loopback, link-local, multicast, or other special-purpose addresses |

One configuration holds at most 128 lines and 10,000 system-managed records.

### Generated records

Every enabled site with at least one verified domain gets these records:

| Name | Type | Content |
| --- | --- | --- |
| `<site UUID>.<CNAME domain>` | CNAME | `all.<site UUID>.<CNAME domain>` |
| `all.<site UUID>.<CNAME domain>` | A / AAAA | Healthy node addresses of all lines in the site's cluster |
| `<line name>.<site UUID>.<CNAME domain>` | A / AAAA | Healthy node addresses of that line's node group |

Lines are explicit node group host names; provider-specific carrier or geographic resolution is not used.

### Health removal and repair

| Item | Behavior |
| --- | --- |
| Address set | Nodes that are enabled, sent a heartbeat within 45 seconds, report a healthy data plane, and applied their cluster's current revision |
| Check interval | A background job recomputes every minute; offline, disabled, or lagging nodes are removed and added back after recovery |
| Propagation | Bound by TTL and resolver caches; not an instant switch |
| Drift repair | System-managed names deleted or changed outside the console are restored at the next check; **Repair records** runs a check immediately |
| Ownership | Only names registered as system-managed are changed; a new name that already has an unmanaged record is refused (`DNS_RECORD_CONFLICT`) |
| Write order | Registers managed names first, then removes extra records, adds missing ones, and reads back; on failure the registration stays and the next cycle retries |

### DNS revisions and rollback

DNS revisions do not advance the node configuration revision. **Roll back DNS** restores the selected revision's DNS policy; addresses are still computed from current site authorization and node health, so offline nodes are not restored.

Before deleting a provider, deselect it or turn off **Enabled** in **DNS configuration**, save, and wait until the provider holds no system-managed records; otherwise the console returns `DNS_PROVIDER_IN_USE`.

## Configure alert channels

Platform administrators only.

1. Open **Admin → Alert channels** and click **Add channel**.
2. Enter **Name**, select **Channel type**, and fill in the fields for that type (see below).
3. Select **Notification language**.
4. Turn on **Receive alerts for all sites** and **Allow tenant subscriptions** as needed.
5. Click **Create**.
6. Verify: click **Send test**; the target receives a test notification and the channel row does not show **Notification delivery failed**.

Email channels use the server configured in **Admin → System → SMTP**, see [Platform administration](admin.en.md).

### Channel fields

| Channel type | Fields | Constraint |
| --- | --- | --- |
| Webhook | Webhook URL, Bearer token (optional) | HTTP POST with JSON; public targets require HTTPS |
| Email | Recipient addresses | 1–20 addresses, separated by commas or spaces |
| DingTalk | Webhook URL, Signing secret (optional) | Host must be `oapi.dingtalk.com`; with a signing secret, timestamp and HMAC-SHA256 signature are added |
| WeCom | Webhook URL | Host must be `qyapi.weixin.qq.com` |
| Telegram | Bot token, Chat ID | Calls the Bot API `sendMessage` with link previews disabled |

| Switch | Default | Effect |
| --- | --- | --- |
| Receive alerts for all sites | Off | The channel receives alerts for every site on the platform without subscriptions |
| Allow tenant subscriptions | Off | Tenants can subscribe to the channel on the **Alerts** page |

The platform holds at most 32 channels. When editing a channel, turn on **Replace channel credentials** to re-enter the type and fields; otherwise the stored credentials are kept.

### Webhook payload

The request body is JSON with `id` (event ID), `siteId`, `siteName`, `kind`, `status` (`firing` / `resolved`), `occurredAt`, `text`, and `url` (the site's console link). With a bearer token, the request carries `Authorization: Bearer <token>`. A 2xx response counts as delivered.

## Set alert rules

1. Open **Admin → Alert channels** and change the thresholds in the **Alert rules** card.
2. Click **Save**.

| Field | Values | Default | Alert kind | Condition |
| --- | --- | --- | --- | --- |
| Offline threshold (seconds) | 45–3600 | 90 | Node offline | An enabled node of the site's cluster has not reported for longer than the threshold, or reports an unhealthy data plane |
| Certificate warning (hours) | 1–720 | 72 | Certificate expiring | The site's current certificate expires within the threshold |
| Minimum requests | 1–1000000 | 100 | High server error ratio | Requests in the window reach this value |
| Window (minutes) | 1–60 | 5 | High server error ratio | Time window for the 5xx ratio |
| 5xx threshold (%) | 1–100 | 20 | High server error ratio | The 5xx ratio in the window reaches this value |

**Origin unavailable** has no threshold of its own: it fires when one node reports every origin of the site unhealthy within the offline threshold. Origin state comes from passive health checks, see [Origins and cache](origins-and-cache.en.md#passive-health-check).

Alerts cover only enabled sites with at least one verified domain.

## Subscribe to alerts

1. Open **Console → Alerts** and click **Subscribe**.
2. Find and select the site in **Search sites**, select **Notification channel**, and check the alert kinds.
3. Click **Save**.
4. Verify: the subscription appears in the list; **Recent events** shows the site's events.

Tenants can subscribe only to sites they can see and to channels with **Allow tenant subscriptions**.

## Delivery behavior

| Item | Behavior |
| --- | --- |
| Events | A condition creates one event when it starts and one when it recovers; event IDs are stable |
| Retries | After a failure, retries back off 2, 4, 8, and 16 minutes; each channel gets 5 attempts |
| Duplicates | A lost receipt can cause duplicate notifications; webhook receivers deduplicate by event ID |
| Checks before delivery | Every delivery rechecks the subscriber's organization membership, account status, the organization's two-factor requirement, and channel visibility |
| Outbound policy | Resolves and pins the target IP; refuses special-purpose addresses; webhook-style targets do not follow redirects; internal webhooks or SMTP need their network in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Timeouts and sizes | 10 seconds per delivery; request body up to 32 KiB, response body up to 64 KiB |
| Retention | Alert events are kept for 90 days |
| Sensitive fields | Channel APIs and failure records never return passwords, bot tokens, webhook secrets, or raw provider errors |

## Limits

| Item | Description |
| --- | --- |
| Background jobs | Platform DNS sync and alert checks and deliveries run every minute in background jobs and need at least one console process with `ROLE=worker` or `ROLE=all`, see [Deployment overview](../deploy/README.en.md) |
| Smart resolution | No carrier or geographic resolution from the provider; a line is a node group |
| Active probing | No active reachability probes; origin state comes only from real traffic |
| Local simulator | **Local simulator** appears only when `EDGEWEIR_DNS_TEST_ENDPOINT` is set and is for testing only |
| Validation scope | Delivery through real DNS provider, DingTalk, WeCom, Telegram, and external SMTP accounts must be verified by the operator |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "TXT record not found" | The record has not propagated, or the recursive server cached an old answer | Check with `dig`; check **Admin → System → Ownership check DNS** |
| "Try verification again shortly" | A repeat check within 5 seconds, or all lookup slots are busy | Retry after a moment |
| "Use a registrable domain" | The name is not below a public suffix, for example a bare public suffix | Use a registrable domain or a subdomain of it |
| "Domain already in use" | Another organization verified the registrable domain | A platform administrator revokes the other organization's verification |
| "CNAME domain is outside the DNS zone" | The CNAME domain is not inside the provider zone | Use the zone itself or a subdomain of it |
| "DNS name has an unmanaged record" | The target name already has a manual record | Delete the manual record, then **Repair records** |
| "DNS provider is still in use" | The provider is still selected or still owns records | Turn off or change the provider, wait for cleanup, then delete |
| **CNAME target** shows **No healthy nodes** | No node in the lines meets the address set conditions | Check node heartbeats, data plane state, and applied revision |
| Channel shows **Notification delivery failed** | The target refused or timed out, or the outbound policy refused the address | Reproduce with **Send test**; add internal targets to `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| "Notification channel limit reached" | 32 channels exist | Delete unused channels |
