# Usage protection

Limits on a site's bytes sent, requests and bandwidth, with alerts at a warning threshold and at the limit, and maintenance mode or disabling at the limit.

## Concepts

| Term | Definition |
| --- | --- |
| Period | The calendar day or month in the chosen time zone, from local midnight. The day of a daylight saving transition counts 23 or 25 hours. |
| Bytes sent | The bytes nodes sent to visitors in the period (headers included), every node added up; the same as `bytesSent` of `usage.list`. |
| Requests | The requests nodes handled in the period, every node added up. |
| Bandwidth | The average rate at which all of the site's nodes sent bytes over the last 5 complete minutes (leaving out the minute being counted and the one just ended), in decimal units (1 Mbps = 10⁶ bit/s), computed again every minute. |
| Bandwidth peak | The highest bandwidth seen in the period; the bandwidth warning and limit go by the peak. |
| Warning threshold | A percentage of the limit (1–99, 80 by default) that sends "Usage near its limit"; can be off. |
| Action | At the limit: **Alert only**, **Turn on maintenance** or **Disable the site**. |
| Recovery | **Automatic** or **Manual**, see [Recovery](#recovery). |
| Check | The console's background job checks every site with usage protection once a minute, after the usage rollup. |

## Setting it up

Page: **Sites** → the site → the **Overview** tab (`/sites/<site ID>`) → the **Usage protection** card.

1. Without settings the card shows "No usage protection"; click **Set up**. With settings, click the edit button (**Edit**) on the right of the card title.
2. In the dialog, choose **Period** and **Time zone**, fill in at least one limit, and set **Warning**, **At the limit** and **Recovery**.
3. Click **Save**; the console shows "Usage protection saved". The settings apply at the next check (within a minute); no configuration revision is published.

| Field | Values | Default | Notes |
| --- | --- | --- | --- |
| Period | **Daily**, **Monthly** | **Monthly** | |
| Time zone | An IANA time zone name (`UTC` and every zone the browser knows), at most 64 characters | The browser's | The period starts at midnight there |
| Bytes sent (GB) | A number above 0, decimals allowed; 1 GB = 10⁹ bytes, at least 1 byte once converted | Empty (**No limit**) | In the API, a decimal string of bytes (`bytesLimit`, at most 38 digits) |
| Requests | A positive whole number of at most 38 digits | Empty (**No limit**) | In the API, a decimal string (`requestsLimit`) |
| Bandwidth (Mbps) | 0.001–10000000 | Empty (**No limit**) | In the API, an integer of bit/s (`bandwidthBps`, 1000–10¹³) |
| Warning | On / off | On | Off sends no "Usage near its limit" (`warnPercent: null`) |
| Warning threshold (%) | A whole number of 1–99 | 80 | Not editable while **Warning** is off |
| At the limit | **Alert only**, **Turn on maintenance**, **Disable the site** | **Turn on maintenance** | See [At the limit](#at-the-limit) |
| Recovery | **Automatic**, **Manual** | **Automatic** | Not selectable with **Alert only** |
| Hold after bandwidth is over (minutes) | A whole number of 5–1440 | 30 | Shown only when the action is not **Alert only**, recovery is **Automatic** and a bandwidth limit is set |

With all three limits empty the dialog shows "Set at least one limit" and **Save** is unavailable. Changes are audited as `site.usage_guard_update` ("Usage protection updated", with the settings before and after).

### Card

| Content | Description |
| --- | --- |
| Metric rows | One row per metric with a limit: **Bytes sent**, **Requests**, **Bandwidth** as "{used} / {limit}" with the percentage and a meter below; the bandwidth row shows the current bandwidth and, on a line of its own, "Peak this period {value}" |
| Meter colors | The warning color at the warning threshold, the error color at the limit; with the warning off, the color changes only at the limit |
| Period | "Today, until {end}" or "This month, until {end}", followed by the action |
| Action in force | A red notice "{metric} reached its limit: maintenance is on" or "{metric} reached its limit: the site is disabled", with a **Restore** button |
| After a manual restore | "Restored by hand: no action until {time}" |
| Publishing failed | "The action could not be published; retried every minute" |
| Refresh | The card reloads every minute |
| Delete | **Delete** on the right of the card title, confirmed with "Delete usage protection?" ("The action it holds is lifted too"); the console shows "Usage protection deleted" |

While usage protection holds an action, the status column of the sites list and the status on the **Overview** tab show an "Over usage limit" badge.

## At the limit

| Action | Effect |
| --- | --- |
| Alert only | Sends the alerts only. |
| Turn on maintenance | Turns on **Enabled** of the site's maintenance mode only, with the saved maintenance page, Retry-After, allowed addresses and allowed path prefixes (see [Maintenance mode](error-pages.en.md#maintenance-mode)): visitors get the 503 maintenance page, allowed addresses and paths pass. The site stays in the nodes' configuration and DNS is unchanged. |
| Disable the site | Like disabling the site on its overview: nodes answer its domains with the disabled page (503 `site-disabled`, see [Platform error pages](error-pages.en.md#platform-error-pages)); DNS records stay. |

| Item | Behavior |
| --- | --- |
| When | Bytes sent and requests: once the period's total reaches the limit; bandwidth: while it is over, then for "Hold after bandwidth is over" after the last time it was over with automatic recovery, or until the period ends with manual recovery. When several metrics are over, the first in the order bytes sent, requests, bandwidth is recorded |
| Publishing | The action publishes a new configuration revision of the site's cluster with the reason "Usage limit of {site} reached" |
| Audit | `site.usage_guard_apply` ("Usage protection applied its action") by the system, with `metric`, `period`, `usage`, `limits`, `action` and `revision` |
| Already in that state | A site already in maintenance or disabled by you is left alone, and recovery does not touch it; a disabled site is not put into maintenance |
| Canary releases | In a cluster with canary releases, the action reaches the canary nodes first, like any configuration, and goes on by the release policy |
| Publishing fails | For example when nodes lack `site-content-v1`, which maintenance needs: the alerts are still sent, the card shows "The action could not be published; retried every minute", `lastError` of the API holds the error code (such as `NODE_CAPABILITY_REQUIRED`), and the next check retries |

## Recovery

| Case | Automatic | Manual |
| --- | --- | --- |
| A new period starts | Lifted | Held |
| A higher (or no) limit is no longer reached | Lifted | Held |
| Bandwidth falls | Held for "Hold after bandwidth is over" after the last time it was over, then lifted; applied again when it is over again | Held until the period ends |
| **Restore** on the card, confirmed ("Restore {name}?", "No action until {time}; alerts continue") | Lifted; no action until the period ends | Same |
| You enable the site or turn maintenance off on its overview, or enable sites in a batch | Same as **Restore** | Same |
| **At the limit** changes (for example to **Alert only**) | The old action is lifted first, the new one applied when called for | Same |
| Usage protection deleted | Lifted | Lifted |

| Item | Behavior |
| --- | --- |
| Scope | Only the action usage protection applied itself is lifted |
| Publishing | Lifting publishes a new configuration revision with the reason "Usage protection of {site} lifted" |
| Audit | Lifted automatically: `site.usage_guard_release` ("Usage protection lifted its action", by the system); **Restore**: `site.usage_guard_restore` ("Usage protection action restored", by you); deletion: `site.usage_guard_release` (by you) and `site.usage_guard_delete` ("Usage protection deleted") |
| Pause | After a manual restore no action is applied until the period ends; alerts continue. Saving the settings again ends the pause |

## Alerts

| Alert | Fires | Resolves |
| --- | --- | --- |
| Usage near its limit (`usage_warning`) | A usage of the period reaches the warning threshold | A new period, or a higher limit no longer reached |
| Usage limit reached (`usage_limit`) | A usage of the period reaches its limit; for bandwidth, the period's peak reaches it | Same |

Each metric (`resourceId` `bytes`, `requests` or `bandwidth`) alerts at most once per period and level, and the notification names it, such as "Usage limit reached: Bytes sent". The alerts hold for a disabled site too. Turn these two kinds on in a subscription of the **Subscriptions** card on **Alerts**, or use a channel that receives every alert, see [Alerts](alerts.en.md#subscribe-to-alerts).

## Delay and overshoot

| Item | Behaviour |
| --- | --- |
| Delay | Nodes report statistics every minute and the console checks every minute; from a request to the alert and the action in force at the nodes usually takes 1–3 minutes, of which the release to the nodes takes seconds, longer with canary releases |
| Overshoot | Traffic during the delay is served, so usage ends above the limit, more with higher traffic; leave room in the limits. To limit requests at once, combine with [rate limiting rules](rules.en.md) by IP or key or with [CC mitigation](challenges.en.md#cc-mitigation) |
| Late reports | Statistics of a node that was offline arrive when it is back and count in the period they belong to; a period's usage can grow later and fire an alert or the action |

| Data source | Description |
| --- | --- |
| Bytes sent, requests | The rolled-up 5-minute usage windows (the same as `usage.list`), plus minute statistics not yet rolled up or waiting for a recompute |
| Bandwidth | Minute statistics |
| Usage record retention | **Retention (days)** in the **Usage** card on the **General** tab of **System settings** (35–400, 100 by default), see [System settings](system.en.md#usage); the minimum covers a calendar month |

## API

| Operation | Procedure | Method and path (`/api/v1`) |
| --- | --- | --- |
| Settings, the period's usage and state | `usageGuard.get` | `GET /sites/{id}/usage-guard` |
| Create or replace the settings | `usageGuard.update` | `PUT /sites/{id}/usage-guard` |
| Delete | `usageGuard.delete` | `DELETE /sites/{id}/usage-guard` |
| Restore | `usageGuard.restore` | `POST /sites/{id}/usage-guard/restore` |

| Request / response | Fields |
| --- | --- |
| `PUT` request | `period` (`day` / `month`, default `month`), `timeZone` (required), `bytesLimit`, `requestsLimit` (decimal strings or `null`), `bandwidthBps` (integer or `null`), `warnPercent` (1–99 or `null`, default 80), `action` (`alert` / `maintenance` / `disable`, default `maintenance`), `recovery` (`auto` / `manual`, default `auto`), `bandwidthHoldMinutes` (5–1440, default 30), optional `expectedUpdatedAt` |
| Response | `settings` (`null` when not set), `updatedAt`, `period { start, end }`, `usage { bytes, requests, bandwidthBps, bandwidthPeakBps }`, `held { action, metric, since }`, `pausedUntil`, `lastError` |

A read-only access key can call `GET` only; service accounts cannot call these endpoints (403 `SERVICE_ACCOUNT_FORBIDDEN`). Copying settings and cloning leave usage protection out. Field details: [API reference](../reference/api/sites.en.md#usage-protection).

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **Save** unavailable, "Set at least one limit" | All three limits are empty | Fill in at least one limit |
| A field turns red, **Save** unavailable | Bytes sent not a positive number, requests not a positive whole number, bandwidth outside 0.001–10000000, warning threshold outside 1–99 or hold time outside 5–1440 | Fix the value |
| "Invalid input" (`BAD_REQUEST`, 400) | An API request with all three limits `null`, an unknown time zone or a field out of range | Fix the request as in [API](#api) |
| "It changed since you loaded it; reload and try again" (`UPDATED_AT_MISMATCH`, 409) | The settings changed in another session after they were read | Reload and edit again |
| "Usage protection holds no action" (`USAGE_GUARD_NOT_HELD`, 409) | **Restore** was called with no action in force | Nothing to restore |
| The card shows "The action could not be published; retried every minute" | Publishing failed; `lastError` holds the code, for example `NODE_CAPABILITY_REQUIRED` (an active node of the cluster lacks `site-content-v1`, which maintenance needs) | Upgrade the nodes, see [Node upgrades](node-upgrades.en.md), or change the action to **Disable the site** |
| A limit is reached but no action is applied | The action is **Alert only**; the period was restored by hand (the card shows "Restored by hand: …"); the site is already disabled or in maintenance | Check the settings and the card's notes |
| Usage ends well above the limit | Statistics and checks lag 1–3 minutes, and traffic in between is served | Lower the limit to leave room; combine with rate limiting rules |
| The site stays in maintenance after bandwidth falls | The automatic hold time has not passed, or recovery is manual | Wait for the hold time, or click **Restore** |
| No alert notifications | No subscription has `usage_warning` / `usage_limit` turned on | Turn these two kinds on in a subscription of the **Subscriptions** card on **Alerts** |
