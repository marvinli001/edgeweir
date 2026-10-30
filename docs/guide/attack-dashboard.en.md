# Attacks and automatic mitigation

What a site's "Attacks" tab shows about blocks, sources and matches, and automatic mitigation, which turns a site's Under Attack on and off by its CC level.

## Concepts

| Term | Definition |
| --- | --- |
| Block reason | Why a request was refused or challenged, see [Access logs](access-logs.en.md#block-reasons). |
| CC level | The site's challenge level on a node, from low to high: "Normal", "Cookie redirect", "JavaScript", "Proof of work", "Image captcha", see [Challenges and CC mitigation](challenges.en.md). |
| Site level | The highest CC level the site holds on the online, active nodes of its cluster. |
| Trigger level | The CC level at which automatic mitigation turns on Under Attack. Never "Normal". |
| Hold | Minutes (5–1440) Under Attack stays on after the site level was last at the trigger level. |
| Holding | Automatic mitigation has turned Under Attack on and has not turned it off yet. |

## The Attacks tab

Page: **Sites → (site) → Attacks** (`/sites/<site ID>?tab=attacks`). The "Range" at the top right ("Last hour", "Last 6 hours", "Last 24 hours" (default), "Last 7 days", "Last 30 days") applies to every card but "Automatic mitigation" and "Current level per node"; it is kept as `range` in the URL (`1h`, `6h`, `24h`, `7d`, `30d`, shared with the "Analytics" tab).

| Card | Content |
| --- | --- |
| Automatic mitigation | Settings and current state, see [Automatic mitigation](#automatic-mitigation) |
| Block reasons | From the statistics: the five block reasons with the most requests over time as stacked bars (the rest as "Other"), and the reasons ranked by requests; "View logs" at the end of a row opens the access logs filtered to that reason and the same range |
| Current level per node | Every active node of the cluster with its name, "Online" / "Offline", the site's level and "N escalated paths"; refreshed every 15 seconds |
| Top addresses and paths | The heaviest addresses and paths in the security events of the range (approximate); "View logs" at the end of a row opens the access logs filtered to that address (or path) and the same range; **⋯** → "Ban IP" on an address, **⋯** → "Purge URL" on a path |
| Most-matched CRS rules | The 10 CRS rule IDs the WAF matched most (approximate); **⋯** on a detection rule → "Exclude CRS rule {id}" or "Exclude by path", see [WAF](waf.en.md) |
| Log rule matches | The 10 rules with the log action matched most (approximate); global rules marked "(global)", deleted ones shown as "Deleted rule", see [Rules](rules.en.md) |
| Challenge pass rate | "Pass rate" (passed / issued, at most 100%), "Issued", "Passed" |
| Authentication failures | Requests the site's access authentication refused, see [Access control](access-control.en.md) |
| Events | Timeline of level changes, path escalations and automatic bans, see [Events](#events) |

When nodes of the cluster do not report the data, a card shows "Some nodes in the cluster do not report these statistics", "… rule matches" or "… authentication failures".

"Top addresses and paths" and "Events" come only from the security events the nodes report; each event carries the heaviest addresses and paths at that moment, so the results are approximate. For how long events are kept, see [State and events](challenges.en.md#state-and-events); a range beyond that has no data.

### Events

20 per page, refreshed every 30 seconds; "Event type" is "All", "Site level", "Path level" or "Automatic ban".

| Field | Content |
| --- | --- |
| Type | "Site level", "Path level", "Automatic ban" |
| Change | The level change "{from} → {to}", with the path for path levels; the banned address for automatic bans |
| Node | The node that reported the event; "Deleted node" once it is deleted |
| Trigger | "{metric} {observed} / {threshold}", metrics such as "Site QPS", "Per-URL QPS", "Per-IP QPS", "Origin error rate", "Cooldown" |
| Time | How long ago, the exact time on hover |

"View logs" at the end of a row opens the access logs from 5 minutes before to 5 minutes after the event (filtered to the address for automatic bans and to the path for path levels). **⋯** on an automatic ban: "Ban on all sites" opens the ban dialog with the scope "Global"; "Unban" lifts the site's bans of that address (a covering range stays), see [Bans](bans.en.md#ban-from-other-pages).

### Access log links

The link `/sites/<site ID>?tab=logs` opens the "Logs" tab with its query parameters as filters:

| Parameter | Content |
| --- | --- |
| `blockReason` | A block reason, `any` for any reason |
| `ip`, `cidr` | Client address or range (at most 64 characters) |
| `path` | Path (at most 2048 characters) |
| `from`, `to` | Time window, ISO 8601 |

Switching tabs clears them.

## Automatic mitigation

On the "Automatic mitigation" card click "Set up" ("Edit" at the top right of the card once set up), fill in the fields and click "Save":

| Field | Default | Notes |
| --- | --- | --- |
| Enabled | On | Off: it no longer turns Under Attack on; while holding, Under Attack is turned off at once |
| Trigger level | Proof of work | "Cookie redirect", "JavaScript", "Proof of work", "Image captcha" |
| Hold below trigger (minutes) | 30 | 5–1440 |

Sites not set up have no automatic mitigation; the card shows "Not set up". The card refreshes every 15 seconds and shows "State" ("On", "Armed", "Off"), "Trigger level", "Hold" and "Level now" (the site level).

1. The site level reaches the trigger level or goes above it.
2. Automatic mitigation turns on the site's Under Attack (with the "Challenge type" of the site's Under Attack card) and publishes the site's cluster. The card shows "Under Attack on until {time}" and "End now"; the Under Attack card on the site's "Security" tab shows "Automatic until {time}".
3. While the site level stays at the trigger level or above, the expiry moves to "now + hold", without a new revision.
4. Once the site level is below the trigger level and the expiry has passed, Under Attack is turned off again and the cluster is published.

| Condition | Behavior |
| --- | --- |
| Start | Enabled, not paused, the site enabled, the site's own Under Attack off, the site level at the trigger level |
| Site level | The highest of the online, active nodes: the level a node's last heartbeat carried; a "Site level" event of that node received after the heartbeat (within 5 minutes) wins |
| CC off | The card shows "CC is off for this site; the level cannot rise" |
| CC maximum below the trigger | The card shows "CC stops at {max}, below the trigger level" |

> [!NOTE]
> CC counts every request of the site on a node, so with Under Attack on the level stays high and only drops step by step once the attack stops: the expiry does not end Under Attack in the middle of an attack.

### Manual actions

Automatic mitigation only turns off the Under Attack it turned on itself:

| Action | Result |
| --- | --- |
| Under Attack turned on by hand before it starts | Left alone and never turned off |
| Under Attack turned on by hand while holding | Counts as turned on by hand: automatic mitigation no longer turns it off, and its hold is cleared |
| Under Attack turned off by hand while holding | The hold ends and the mitigation pauses: the card shows "Ended by hand; stays off until the level drops below {level}" |
| "End now" and confirm | Turns Under Attack off and pauses as above; without a hold, 409 `AUTO_MITIGATION_NOT_ACTIVE` ("Automatic mitigation holds no Under Attack") |
| Changing the settings | Clears the pause and the error; disabling turns Under Attack off at once; a shorter hold caps the expiry at "now + new hold" |
| Site disabled | Does not start |

The pause ends once the site level is below the trigger level. "Copy site settings" does not copy Under Attack that automatic mitigation holds, and does not turn it off on a target that holds it; a copy that turns Under Attack on counts as turned on by hand.

### Failure and retry

When turning Under Attack on or off cannot be published (for example an active node of the cluster lacks a needed capability, `NODE_CAPABILITY_REQUIRED`), that change is rolled back, its error code is kept as `lastError`, the card shows "Not applied; retried every minute", and every later evaluation retries it.

### How it runs

The pg-boss job `mitigation.evaluate` evaluates every site that is enabled, holding or paused once a minute; when a node reports a site's level going up, that site is evaluated at once instead of at the next minute. Each evaluation is one transaction; the hold and its expiry are stored in the database, so a console restart or a repeated job changes nothing.

## Permissions and audit

Changes need a console session or a read-write AccessKey; read-only AccessKeys and the demo account can only read (403 `ACCESS_KEY_READ_ONLY` / `DEMO_READ_ONLY`); service accounts cannot call these procedures (403 `SERVICE_ACCOUNT_FORBIDDEN`).

| Audit action | When | Metadata |
| --- | --- | --- |
| `site.auto_mitigation_update` | Settings changed | `from`, `to` |
| `site.auto_mitigation_apply` | Under Attack turned on automatically (actor: system) | `level`, `threshold`, `durationMinutes`, `revision` |
| `site.auto_mitigation_release` | Under Attack turned off: expired (actor: system) or disabled in the settings (actor: whoever saved them) | `reason` (`expired` / `disabled`), `since`, `revision` |
| `site.auto_mitigation_restore` | "End now" | `level`, `threshold`, `since`; `revision` when a revision was published |

The revisions published have the reasons "Automatic mitigation turned on Under Attack for {site}" and "Automatic mitigation turned off Under Attack for {site}" (`auto_mitigation_started` / `auto_mitigation_ended`).

## API

Paths are under `/api/v1`.

| Procedure | Endpoint | Notes |
| --- | --- | --- |
| `autoMitigation.get` | `GET /sites/{id}/auto-mitigation` | `settings` (`null` when not set up), `updatedAt`, `level`, `active` (`since`, `expiresAt`, `level`), `paused`, `lastError` |
| `autoMitigation.update` | `PUT /sites/{id}/auto-mitigation` | `enabled`, `threshold` (`cookie302` / `js` / `pow` / `captcha`), `durationMinutes`; optional `expectedUpdatedAt`, 409 `UPDATED_AT_MISMATCH` when it differs |
| `autoMitigation.restore` | `POST /sites/{id}/auto-mitigation/restore` | Ends it now |
| `analytics.breakdown` | `GET /analytics/breakdown?by=block_reason&siteId=…&range=…` | Requests per block reason over time |
| `analytics.dimensions` | `GET /analytics/dimensions?siteId=…&range=…` | Block reasons, challenges issued and passed |
| `security.state` | `GET /sites/{id}/security?hours=…` | Current level per node, and the top addresses and paths of the last `hours` (1–720, 24 by default) |
| `security.events` | `GET /sites/{id}/security/events` | Events; query parameters `kind` (`site_level` / `path_level` / `ip_banned`), `hours` (1–720), `page`, `pageSize` |
| `waf.topRules` | `GET /sites/{id}/waf/rules?range=…&limit=…` | Most-matched CRS rules |
| `rules.topLogged` | `GET /sites/{id}/rules/logged?range=…&limit=…` | Matches of rules with the log action |
| `authRules.failures` | `GET /sites/{id}/auth-rules/failures?range=…` | Authentication failures |

`range` is `1h`, `6h`, `24h` (default), `7d` or `30d`. Fields: [API and endpoints](../reference/api/sites.en.md#automatic-mitigation).
