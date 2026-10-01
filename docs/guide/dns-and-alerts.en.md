# DNS steering and alerts

DNS steering records, and alert channels, subscriptions, and rules.

## Concepts

| Term | Definition |
| --- | --- |
| CNAME domain | The parent domain of the records DNS steering creates; it must lie inside the selected DNS provider's zone. |
| Line | The A/AAAA records of one node group in DNS steering. |
| DNS revision | A snapshot of the DNS steering policy and its records, separate from node configuration revisions. |
| Alert channel | A notification target: email, webhook, DingTalk, WeCom, or Telegram. |
| Alert subscription | Sends some alert kinds of one site to one channel. |

## Configure DNS steering

DNS steering creates a CNAME target for every site and steers traffic to healthy nodes.

1. Open **DNS steering** and click **Add DNS provider**.
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

Credentials are envelope-encrypted with the master key and are write-only. Grant the API credential the minimum DNS edit permission on the target zone. DNS steering providers are separate from the DNS credentials used for ACME DNS-01, see [HTTPS and certificates](https.en.md).

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

Every site with at least one domain gets these records (disabled sites keep them):

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
| Configuration canary | Each node is compared with its own target revision: during a canary window the non-canary nodes run the stable revision and stay, see [Configuration canary](system.en.md#configuration-canary) |

### Mass removal protection

A publication that would empty a non-empty `all.` or line record set, or remove more address records than the threshold allows, keeps the previous records and does not write the provider. The same applies when the console loses its node channel and every node looks offline.

| Item | Behavior |
| --- | --- |
| Threshold | Share of the previous address records one publication may remove: 50% by default, adjustable in **DNS steering → Mass removal protection** (5%–100%) |
| Not counted | Names no longer managed (deleted sites, removed lines); a changed provider or CNAME domain; turning DNS off |
| When held back | The DNS steering page shows the held-back change (address records it would remove), the DNS revision list shows it as **Held back**, and the alert "DNS mass removal blocked" fires |
| Recovery | The hold ends by itself once a publication passes; the alert resolves |
| Force | Click **Publish anyway** on the DNS steering page and confirm; the current state is published and `dns.force_publish` is audited |

### DNS revisions and rollback

DNS revisions do not advance the node configuration revision. **Roll back DNS** restores the selected revision's DNS policy; addresses are still computed from the current sites and node health, so offline nodes are not restored.

Before deleting a provider, deselect it or turn off **Enabled** in **DNS configuration**, save, and wait until the provider holds no system-managed records; otherwise the console returns `DNS_PROVIDER_IN_USE`.

## Alerts page

Alerts are configured on the **Alerts** page, which has four cards:

| Card | Contents |
| --- | --- |
| Alert channels | Notification targets, which can be added, edited, tested, enabled or disabled, and deleted |
| Subscriptions | The alert kinds of a site and the channels that receive them |
| Recent events | The latest 100 alert events, including cluster and DNS alerts |
| Alert rules | The thresholds that raise alerts |

## Configure alert channels

1. Open **Alerts** and click **Add channel** in the **Alert channels** card.
2. Enter **Name**, select **Channel type**, and fill in the fields for that type (see below).
3. Select **Notification language**.
4. Turn on **Receive every alert** as needed.
5. Click **Create**.
6. Verify: click **Send test**; the target receives a test notification and the channel row does not show **Notification delivery failed**.

Email channels use the server configured in **System → SMTP**, see [SMTP](system.en.md#smtp).

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
| Receive every alert | Off | The channel receives every alert without subscriptions: the alerts of all sites, and cluster and DNS alerts |

Channels without this switch receive only the site alerts subscribed to them, see [Subscribe to alerts](#subscribe-to-alerts).

At most 32 channels. When editing a channel, turn on **Replace channel credentials** to re-enter the type and fields; otherwise the stored credentials are kept. A disabled channel sends no notifications and cannot be chosen for new subscriptions.

### Webhook payload

The request body is JSON with `id` (event ID), `siteId`, `siteName`, `kind`, `status` (`firing` / `resolved`), `occurredAt`, `resourceId` (the object of the alert, such as a node or certificate ID), `text`, and `url` (a console link). For cluster and DNS alerts, `siteId` is `null`, `siteName` is the cluster name or `DNS`, and `url` points to **Clusters & nodes** or **DNS steering**. With a bearer token, the request carries `Authorization: Bearer <token>`. A 2xx response counts as delivered.

## Set alert rules

1. Open **Alerts** and change the thresholds in the **Alert rules** card.
2. Click **Save**.

| Field | Values | Default | Alert kind | Condition |
| --- | --- | --- | --- | --- |
| Offline threshold (seconds) | 45–3600 | 90 | Node offline | An enabled node of the site's cluster has not reported for longer than the threshold, or reports an unhealthy data plane |
| Certificate warning (hours) | 1–720 | 72 | Certificate expiring | The site's current certificate expires within the threshold |
| Minimum requests | 1–1000000 | 100 | High server error ratio | Requests in the window reach this value |
| Window (minutes) | 1–60 | 5 | High server error ratio | Time window for the 5xx ratio |
| 5xx threshold (%) | 1–100 | 20 | High server error ratio | The 5xx ratio in the window reaches this value |

**Origin unavailable** has no threshold of its own: it fires when one node reports, within the offline threshold, every origin of the site unavailable. An origin is unavailable on that node when its passive or its active check result (either source) is unhealthy; see [Passive health check](origins-and-cache.en.md#passive-health-check) and [Active health check](origins-and-cache.en.md#active-health-check).

**CC mitigation raised** (`cc_mitigation`) has no threshold of its own: it fires when a node reports that the site left the normal level, at most once per site in 15 minutes, and resolves once no online node reports the site above normal. See [Challenges and CC mitigation](challenges.en.md#cc-mitigation).

Site alerts cover only enabled sites with at least one domain.

### Cluster and DNS alerts

These alerts belong to a cluster or to DNS steering, not to a site. They go only to channels with **Receive every alert** and cannot be subscribed to; **Recent events** lists them too.

| Alert | Fires | Resolves |
| --- | --- | --- |
| Configuration canary rolled back | A canary rolled back automatically or was aborted | The next promotion in that cluster |
| No canary node online; configuration published to every node | A publication in a cluster with the canary on found no canary node online | The next publication in that cluster with a canary node online |
| DNS mass removal blocked | The [mass removal protection](#mass-removal-protection) held a publication back | The next publication that passes, or a forced one |

## Subscribe to alerts

1. Open **Alerts** and click **Subscribe** in the **Subscriptions** card.
2. Find the site with **Search sites** and select it under **Sites**, select **Notification channel**, and turn on the alert kinds to send.
3. Click **Save**.
4. Verify: the subscription appears under **Subscriptions**; **Recent events** shows the site's events.

| Item | Behavior |
| --- | --- |
| Channels | Only enabled channels can be chosen; without one, **Subscribe** is unavailable |
| Alert kinds | Node offline, Certificate expiring, Origin unavailable, High server error ratio, CC mitigation raised |
| Repeated subscriptions | A site and a channel have one subscription; saving again replaces its alert kinds |
| Removal | Click **Unsubscribe** on the subscription row and confirm |

## Delivery behavior

| Item | Behavior |
| --- | --- |
| Events | A condition creates one event when it starts and one when it recovers; event IDs are stable |
| Receiving channels | Channels with **Receive every alert** receive every alert; other channels receive only the site alerts subscribed to them |
| Retries | After a failure, retries back off 2, 4, 8, and 16 minutes; each channel gets 5 attempts |
| Duplicates | A lost receipt can cause duplicate notifications; webhook receivers deduplicate by event ID |
| Checks before delivery | Every delivery rechecks that the channel is enabled, that the event is still the condition's current state, and that a subscription still includes the alert kind (except for channels with **Receive every alert**) |
| Outbound policy | Resolves and pins the target IP; refuses special-purpose addresses; webhook-style targets do not follow redirects; internal webhooks or SMTP need their network in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Timeouts and sizes | 10 seconds per delivery; request body up to 32 KiB, response body up to 64 KiB |
| Retention | Alert events are kept for 90 days |
| Sensitive fields | Channel APIs and failure records never return passwords, bot tokens, webhook secrets, or raw provider errors |

## Limits

| Item | Description |
| --- | --- |
| Background jobs | DNS steering sync and alert checks and deliveries run every minute in background jobs and need at least one console process with `ROLE=worker` or `ROLE=all`, see [Deployment overview](../deploy/README.en.md) |
| Smart resolution | No carrier or geographic resolution from the provider; a line is a node group |
| Active probing | No active reachability probes; origin state comes only from real traffic |
| Local simulator | **Local simulator** appears only when `EDGEWEIR_DNS_TEST_ENDPOINT` is set and is for testing only |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "CNAME domain is outside the DNS zone" | The CNAME domain is not inside the provider zone | Use the zone itself or a subdomain of it |
| "DNS name has an unmanaged record" | The target name already has a manual record | Delete the manual record, then **Repair records** |
| "DNS provider is still in use" | The provider is still selected or still owns records | Turn off or change the provider, wait for cleanup, then delete |
| **CNAME target** shows **No healthy nodes** | No node in the lines meets the address set conditions | Check node heartbeats, data plane state, and applied revision |
| Channel shows **Notification delivery failed** | The target refused or timed out, or the outbound policy refused the address | Reproduce with **Send test**; add internal targets to `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| "Notification channel limit reached" | 32 channels exist | Delete unused channels |
| **Subscribe** is unavailable | No channel is enabled | Add or enable a channel |
