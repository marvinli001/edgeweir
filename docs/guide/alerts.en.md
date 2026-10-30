# Alerts

Alert channels, SMTP, alert rules, cluster and DNS alerts, subscriptions and delivery.

## Concepts

| Term | Definition |
| --- | --- |
| Alert channel | A notification target: email, webhook, DingTalk, WeCom, Telegram, Alibaba Cloud SMS, or Tencent Cloud SMS. |
| Alert subscription | Sends some alert kinds of a set of sites (or all sites) to one channel; one per channel. |

## Alerts page

Page: **Alerts** (`/alerts`), under **System** in the sidebar. Cards in page order:

| Card | Contents |
| --- | --- |
| Alert channels | Notification targets, which can be added, edited, tested, enabled or disabled, and deleted |
| SMTP | The mail server of email channels, see [SMTP](#smtp) |
| Subscriptions | The sites and alert kinds each channel receives |
| Recent events | The latest 100 alert events (fired or resolved), including cluster and DNS alerts |
| Alert rules | The thresholds that raise alerts |

## Configure alert channels

1. Open **Alerts** and click **Add channel** in the **Alert channels** card.
2. Enter **Name**, select **Channel type**, and fill in the fields for that type (see below).
3. Select **Notification language**.
4. Turn on **Receive every alert** as needed.
5. Click **Create**.
6. Verify: click **Send test** under **⋯** at the end of the channel row; the target receives a test notification and the channel row does not show **Notification delivery failed**.

Email channels use the server in the **SMTP** card, see [SMTP](#smtp).

### Channel fields

| Channel type | Fields | Constraint |
| --- | --- | --- |
| Webhook | Webhook URL, Bearer token (optional) | HTTP POST with JSON; public targets require HTTPS |
| Email | Recipient addresses | 1–20 addresses, separated by commas or spaces |
| DingTalk | Webhook URL, Signing secret (optional) | Host must be `oapi.dingtalk.com`; with a signing secret, timestamp and HMAC-SHA256 signature are added |
| WeCom | Webhook URL | Host must be `qyapi.weixin.qq.com` |
| Telegram | Bot token, Chat ID | Calls the Bot API `sendMessage` with link previews disabled |
| Alibaba Cloud SMS | AccessKey ID, AccessKey Secret, Signature name, Template code, Phone numbers, Variable length limit (1–100, default 35), Sends per hour / day (1–100 / 1–1000, default 10 / 50) | Calls `SendSms` on `dysmsapi.aliyuncs.com` (2017-05-25, signature V3 ACS3-HMAC-SHA256) |
| Tencent Cloud SMS | Region (Guangzhou, Beijing, Nanjing), SecretId, SecretKey, SDK AppID, Signature name, Template ID, Phone numbers, Variable length limit (1–100, default 6), Sends per hour / day (1–100 / 1–1000, default 10 / 50) | Calls `SendSms` on `sms.tencentcloudapi.com` (2021-01-11, TC3-HMAC-SHA256 signature) |

| Switch | Default | Effect |
| --- | --- | --- |
| Receive every alert | Off | The channel receives every alert without subscriptions: the alerts of all sites, and cluster and DNS alerts |

Channels without this switch receive only the site alerts subscribed to them, see [Subscribe to alerts](#subscribe-to-alerts).

At most 32 channels. A click on a channel's row opens the edit dialog; **⋯** at the end of the row holds **Send test**, **Enable** or **Disable**, and **Delete**. When editing a channel, turn on **Replace channel credentials** to re-enter the type and fields; otherwise the stored credentials are kept. A disabled channel sends no notifications and cannot be chosen for new subscriptions.

### SMS channels

An SMS carries three template variables and no link or time. Apply for a signature and a notification template in the provider's console first; the template uses the variables below:

| Variable | Alibaba Cloud | Tencent Cloud | Content |
| --- | --- | --- | --- |
| Object | `${site}` | `{1}` | The site name; the cluster name for cluster alerts, the node name for node alerts, `Edgeweir` for tests |
| Alert | `${alert}` | `{2}` | The alert kind, such as **Node offline**; usage alerts add the metric |
| Status | `${status}` | `{3}` | **Active** or **Recovered** |

Template examples: Alibaba Cloud `Edgeweir alert: ${site} ${alert}, ${status}`; Tencent Cloud `Edgeweir alert: {1} {2}, {3}`. A Tencent Cloud template must have exactly these three variables.

| Item | Behavior |
| --- | --- |
| Phone numbers | 1–20, separated by commas or spaces; E.164 (`+8613800000000`), mainland China numbers may leave out `+86`; the console checks the format only (5–15 digits, optional `+`). Tencent Cloud rejects a request whose numbers are not all domestic or all international |
| Variable length | Each variable is cut to **Variable length limit** characters; link prefixes, brackets, control characters and emoji are removed. Alibaba Cloud notification template variables take at most 35 characters; Tencent Cloud depends on the account (6 by default for accounts opened after 2024-01-25), see the provider's console |
| Names that look like links | When the provider refuses a variable as a link (Alibaba Cloud `isv.PARAM_NOT_SUPPORT_URL`, Tencent Cloud `InvalidParameterValue.ProhibitedUseUrlInTemplateParameter`), the object is sent once more with its `.` replaced by spaces |
| Send rate | Each channel counts sends over a sliding hour and 24 hours, **Send test** included. At the limit, **Send test** reports **Send limit reached**; alerts wait until the window has room, without using one of the 5 attempts, and an alert that recovers meanwhile is not sent |
| Provider rate limits | Alibaba Cloud `isv.BUSINESS_LIMIT_CONTROL` and similar, Tencent Cloud `LimitExceeded.*`, use an attempt and retry after an hour |
| Partial success | On Tencent Cloud, any number answered `Ok` counts as sent; nothing is sent again |
| Failures | The channel row and **Send test** show **SMS provider refused** with the provider's error code, such as `isv.SMS_TEMPLATE_ILLEGAL` or `AuthFailure.SignatureFailure` |

AccessKey Secret and SecretKey are encrypted like other channel credentials and never returned. Use a RAM / CAM sub-account key that can only send SMS.

### Webhook payload

The request body is JSON with `id` (event ID), `siteId`, `siteName`, `kind`, `status` (`firing` / `resolved`), `occurredAt`, `resourceId` (the object of the alert, such as a node or certificate ID), `text`, and `url` (a console link). For cluster and DNS alerts, `siteId` is `null` and `siteName` is the cluster name; for **Node offline**, `siteId` is `null`, `siteName` is the node name and `resourceId` the node ID; and `url` points to **Clusters & nodes** or **DNS steering**; for `scheduling_action`, `siteName` is "rule · node" and `resourceId` is `<rule ID>:<node ID>`. With a bearer token, the request carries `Authorization: Bearer <token>`. A 2xx response counts as delivered.

### SMTP

The outgoing mail server of email channels, set in the **SMTP** card of the **Alerts** page and saved with **Save**. Until it is set, **Send test** on an email channel answers "SMTP is not configured", and a channel whose deliveries fail for that reason shows the same message.

| Field | Default | Description |
| --- | --- | --- |
| **SMTP host** | None | At most 253 characters |
| **SMTP port** | 465 | 1–65535 |
| **Implicit TLS (off: STARTTLS)** | On | Off requires STARTTLS; certificate verification is always on |
| **From address** | None | Email address |
| **SMTP username** | None | Required |
| **SMTP password** | None | Envelope-encrypted with the master key before storage; leave blank to keep the current password |
| **CA certificates (PEM)** | Empty | PEM certificates only; when set, replaces the system trust store for this server. When empty, `EDGEWEIR_SMTP_CA_FILE` applies (the placeholder shows the variable), and without it the system trust store |

| Constraint | Description |
| --- | --- |
| Changing the destination | Changing host, port, TLS mode, username, or CA certificates requires the password again |
| Outbound policy | The address is resolved and pinned for each delivery; private addresses must be allowed by `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |

## Set alert rules

1. Open **Alerts** and change the thresholds in the **Alert rules** card.
2. Click **Save**.

| Field | Values | Default | Alert kind | Condition |
| --- | --- | --- | --- | --- |
| Offline threshold (seconds) | 45–3600 | 90 | Node offline | An enabled node enrolled longer ago than the threshold has not reported for longer than the threshold, or reports an unhealthy data plane; one alert per node, not one per site it serves |
| Certificate warning (hours) | 1–720 | 72 | Certificate expiring | The site's current certificate expires within the threshold |
| Minimum requests | 1–1000000 | 100 | High server error ratio | Requests in the window reach this value |
| Window (minutes) | 1–60 | 5 | High server error ratio | Time window for the 5xx ratio |
| 5xx threshold (%) | 1–100 | 20 | High server error ratio | The 5xx ratio in the window reaches this value |
| Clock skew (seconds) | 5–3600 | 30 | Node clock skewed | The clock offset (ahead or behind) a node reported within the offline threshold reaches this value; one alert per node, like Node offline. Nodes report it since v1.5.0; **Clock offset** on the node's details shows the last value |

**Origin unavailable** has no threshold of its own: it fires when one node reports, within the offline threshold, every origin of the site unavailable. An origin is unavailable on that node when its passive or its active check result (either source) is unhealthy; see [Passive health check](origins-and-cache.en.md#passive-health-check) and [Active health check](origins-and-cache.en.md#active-health-check).

**CC mitigation raised** (`cc_mitigation`) has no threshold of its own: it fires when a node reports that the site left the normal level, at most once per site in 15 minutes (a raise held back fires at the next minute check once the 15 minutes are over, if the site is still above normal), and resolves once no online node reports the site above normal. See [Challenges and CC mitigation](challenges.en.md#cc-mitigation).

**Usage near its limit** (`usage_warning`) and **Usage limit reached** (`usage_limit`) come from a site's usage protection, whose thresholds are set in the site's **Usage protection** card; each metric alerts at most once per period and level, see [Usage protection](usage-protection.en.md#alerts).

Site alerts cover only enabled sites with at least one domain; the two usage protection alerts also cover disabled sites.

### Cluster and DNS alerts

These alerts belong to a cluster, not to a site. They go only to channels with **Receive every alert** and cannot be subscribed to; **Recent events** lists them too.

| Alert | Fires | Resolves |
| --- | --- | --- |
| Configuration canary rolled back | A canary rolled back automatically or was aborted | The next promotion in that cluster |
| No canary node online; configuration published to every node | A publication in a cluster with the canary on found no canary node online | The next publication in that cluster with a canary node online |
| Stored rule no longer valid; its last compiled form is kept | A publication found a stored rule the current validator refuses (see [Rules](rules.en.md)); the name is the rule's | The next publication after the rule is rewritten or deleted |
| DNS mass removal blocked | The [mass removal protection](dns.en.md#mass-removal-protection) held a publication of a cluster back | The cluster's next publication that passes, or a forced one |
| Scheduling rule acting on a node | A [scheduling rule](scheduling.en.md#scheduling-rules) took effect on a node; the name is "rule · node" | The action recovers; at once when the rule is disabled, deleted, or its line, conditions, or action change |
| A node cannot load a certificate | A node reports it cannot load a certificate (see [HTTPS](https.en.md)); the name is the certificate's, `resourceId` its ID, the link points to **Certificates** | No node reports it any more |
| DNS reconciliation failing | A cluster's DNS reconciliation has failed for 5 minutes in a row (provider unreachable, credentials no longer valid, a name conflict, …; the cause is the error of the cluster's DNS revision); the name is the cluster's, the link points to **DNS** | The cluster's next successful reconciliation, or the binding switched to manual / off with no records left to clean up |

Deleting a cluster resolves its cluster alerts that are still firing.

## Subscribe to alerts

1. Open **Alerts** and click **Subscribe** in the **Subscriptions** card.
2. Select **Alert channel**.
3. Turn on **All sites**, or tick sites in the **Sites** list (**Search sites** finds them; ticked sites stay ticked across searches).
4. Turn on the alert kinds to send and click **Save**.
5. Verify: the subscription row shows the channel, the sites (or **All sites**), and the alert kinds; **Recent events** shows these sites' events.

| Item | Behavior |
| --- | --- |
| Channels | One subscription per channel; **Subscribe** lists only enabled channels without a subscription and is unavailable when there is none |
| Sites | **All sites** includes sites created later; otherwise tick at least one site |
| Alert kinds | In dialog order: Node offline, Certificate expiring, Origin unavailable, High server error ratio, CC mitigation raised, Usage near its limit, Usage limit reached, Node clock skewed |
| Changes | Click the subscription's row to change its sites, alert kinds, or **Enable**; a subscription with **Enable** off sends nothing and its row shows **Off** |
| Deleted sites | The site leaves the subscription; a subscription left without sites is deleted with it |
| Removal | **Unsubscribe** under **⋯** at the end of the subscription row, confirmed |
| API | `POST /api/v1/alerts/subscriptions` (`channelId`, `kinds`, `allSites` or `siteIds`) creates the channel's subscription, replacing the one it has; `PUT /api/v1/alerts/subscriptions/{id}` changes it; both return `allSites` and `sites` (`id`, `name`). The former `siteId` field is gone |
| Upgrades | A subscription used to cover one site; on upgrade, the subscriptions of a channel merge into one. If any of them is enabled, the result is enabled with the sites and alert kinds of the enabled ones; if all are paused, it stays paused with all their sites and alert kinds |

## Delivery behavior

| Item | Behavior |
| --- | --- |
| Events | A condition creates one event when it starts and one when it recovers; event IDs are stable |
| Receiving channels | Channels with **Receive every alert** receive every alert; other channels receive only the alerts of the sites their subscription covers, and **Node offline** and **Node clock skewed** when the subscription covers any site in the node's cluster (or **All sites**) and includes that kind |
| Retries | After a failure, retries back off 2, 4, 8, and 16 minutes; each channel gets 5 attempts |
| Batches | Checked every minute; at most 200 notifications per check, and deliveries that would start after 40 seconds wait for the next minute |
| Duplicates | A lost receipt can cause duplicate notifications; webhook receivers deduplicate by event ID |
| Checks before delivery | Every delivery rechecks that the channel is enabled, that the event is still the condition's current state and less than 24 hours old, and that the subscription is enabled and still covers the site and the alert kind (except for channels with **Receive every alert**) |
| Outbound policy | Resolves and pins the target IP; refuses special-purpose addresses; webhook-style targets and SMS APIs do not follow redirects; internal webhooks or SMTP need their network in `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| Timeouts and sizes | 10 seconds per delivery; request body up to 32 KiB, response body up to 64 KiB |
| Retention | Alert events are kept for 90 days |
| Sensitive fields | Channel APIs and failure records never return passwords, bot tokens, webhook secrets, SMS keys, or raw provider errors; SMS channels record only the provider's error code |

## Limits

| Item | Description |
| --- | --- |
| Background jobs | Alert checks and deliveries run every minute and need at least one console process with `ROLE=worker` or `ROLE=all`, see [Deployment overview](../deploy/README.en.md) |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| Channel shows **Notification delivery failed** | The target refused or timed out, or the outbound policy refused the address | Reproduce with **Send test**; add internal targets to `EDGEWEIR_OUTBOUND_ALLOW_CIDRS` |
| "Alert channel limit reached" | 32 channels exist | Delete unused channels |
| "SMTP is not configured" | An email channel was tested or delivered before the SMTP settings were saved | Fill in and save the **SMTP** card, then **Send test** |
| "Enter a new password when changing the SMTP server or account" | The SMTP destination changed without a password | Enter the password and save |
| "The CA bundle must contain PEM certificates only" | The CA field contains something other than certificates | Paste PEM certificates only |
| **Subscribe** is unavailable | No channel is enabled, or every enabled channel has a subscription | Add or enable a channel; click an existing subscription's row to change it |
