# Usage protection

Set limits on bytes sent, requests and bandwidth for your own sites: alerts at a warning threshold and at the limit, and at the limit optionally maintenance mode or disabling the site, so traffic costs cannot run away. Usage comes from the statistics nodes report every minute; the console checks once a minute.

## Concepts

| Term | Definition |
| --- | --- |
| Period | The calendar day or month in the chosen time zone, from local midnight. The day of a daylight saving transition counts 23 or 25 hours. |
| Bytes sent | The bytes nodes sent to visitors in the period (headers included), every node added up; the same as `bytesSent` of `usage.list`. |
| Requests | The requests nodes handled in the period, every node added up. |
| Bandwidth | The average rate at which all of the site's nodes sent bytes over the last 5 complete minutes, in decimal units (1 Mbps = 10⁶ bit/s), computed again every minute; not accumulated over the period. |
| Warning threshold | A percentage of the limit (1–99, 80 by default) that sends "Usage near its limit"; can be off. |
| Action | At the limit: alert only, turn on maintenance, or disable the site. |
| Recovery | Automatic or manual, see [Recovery](#recovery). |

## Setting it up

1. Open **Sites** → the site → the **Overview** tab.
2. In the **Usage protection** card click **Set up** (the edit button once it is set).
3. Choose the period and time zone (the browser's by default), fill in at least one limit, choose the warning, the action and the recovery, and click **Save**.

| Setting | Default | Range | Notes |
| --- | --- | --- | --- |
| Period | Monthly | Daily, monthly | |
| Time zone | The browser's | IANA time zone | The period starts at midnight there |
| Bytes sent (GB) | No limit | > 0 | 1 GB = 10⁹ bytes |
| Requests | No limit | ≥ 1 | |
| Bandwidth (Mbps) | No limit | 0.001–10000000 | |
| Warning | On, 80% | 1–99 | |
| At the limit | Turn on maintenance | Alert only, turn on maintenance, disable the site | |
| Recovery | Automatic | Automatic, manual | Not used with alert only |
| Hold after bandwidth is over (minutes) | 30 | 5–1440 | Shown only with automatic recovery and a bandwidth limit |

Saved settings apply at the next check (within a minute). The card refreshes every minute and shows the period's usage of each limit, the percentage and the period's bandwidth peak; a meter turns to the warning color at the warning threshold and to the error color at the limit.

## At the limit

| Action | Effect |
| --- | --- |
| Alert only | Sends the alerts only. |
| Turn on maintenance | Turns on the site's maintenance mode only, with the saved maintenance page, Retry-After, allowed addresses and allowed paths (see [Error pages and maintenance](error-pages.en.md)): visitors get the 503 maintenance page, allowed addresses and paths pass. The site stays in the nodes' configuration and DNS is unchanged. |
| Disable the site | Like disabling the site on its overview: nodes answer its domains with the disabled page (503 `site-disabled`); DNS records stay. |

- The action publishes a configuration revision with the reason "Usage limit of … reached" and writes the audit entry "Usage protection applied its action" by the system, with the metric, the period's usage, the limits and the revision.
- A site already in that state (maintenance or disabled by you) is left alone, and recovery does not touch it. A disabled site is not put into maintenance.
- In a cluster with canary releases, the action reaches the canary nodes first, like any configuration, and goes on by the release policy.
- When publishing fails (for example nodes lack a feature the action needs), the alerts are still sent, the card shows "The action could not be published; retried every minute" and `lastError` of the API holds the error code (such as `NODE_CAPABILITY_REQUIRED`).

## Recovery

| Case | Automatic | Manual |
| --- | --- | --- |
| A new period starts | Lifted | Held |
| A higher (or no) limit is no longer reached | Lifted | Held |
| Bandwidth falls | Held for "Hold after bandwidth is over" after the last time it was over, then lifted; applied again when it is over again | Held |
| **Restore** on the card | Lifted; no action for the rest of the period | Same |
| You enable the site or turn maintenance off (batch enabling included) | Same as **Restore** | Same |
| The action changes (for example to alert only) | The old action is lifted first, the new one applied when called for | Same |
| Usage protection deleted | Lifted | Lifted |

- Only the action usage protection applied itself is lifted. Lifting publishes a revision with the reason "Usage protection of … lifted"; the audit entry is "Usage protection lifted its action" (the system) when lifted automatically and "Usage protection action restored" (you) for **Restore**.
- After a manual restore the card shows "Restored by hand: no action until …"; alerts continue. Saving the settings again ends the pause.

## Alerts

| Alert | Fires | Resolves |
| --- | --- | --- |
| Usage near its limit (`usage_warning`) | A usage of the period reaches the warning threshold | A new period, or a higher limit no longer reached |
| Usage limit reached (`usage_limit`) | A usage of the period reaches its limit; for bandwidth, it was over at some time in the period | Same |

Each metric (`resourceId` `bytes`, `requests` or `bandwidth`) alerts at most once per period and level, and the notification names it, such as "Usage limit reached: Bytes sent". The alerts hold for a disabled site too. Choose these two kinds under **Alerts → Subscriptions**, or use a channel that receives every alert, see [DNS and alerts](dns-and-alerts.en.md#subscribe-to-alerts).

## Delay and overshoot

Nodes report statistics once a minute and the console checks once a minute, so from a request to the alert and the action in force at the nodes usually takes 1–3 minutes (of which the configuration release to the nodes takes seconds, longer with canary releases). Traffic in between is served: the usage ends somewhat above the limit, the more the higher the traffic. Leave room in the limits; to limit requests at once, combine them with [rate limiting rules](rules.en.md) by IP or key or with [CC mitigation](challenges.en.md#cc-mitigation).

Statistics of a node that was offline arrive when it is back and count in the period they belong to: a period's usage can grow later and then fire an alert or the action.

## API

| Operation | Endpoint |
| --- | --- |
| Settings, the period's usage and state | `GET /api/v1/sites/{id}/usage-guard` |
| Save | `PUT /api/v1/sites/{id}/usage-guard` |
| Delete | `DELETE /api/v1/sites/{id}/usage-guard` |
| Restore | `POST /api/v1/sites/{id}/usage-guard/restore` |

Fields and error codes: [API reference](../reference/api.en.md#usage-protection). A read-only AccessKey can only read; service accounts cannot call these endpoints. Copying settings and cloning leave usage protection out.
