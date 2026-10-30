# Attacks and automatic mitigation

A site's **Attacks** tab shows what the site is blocking, who is attacking it and which rules match, and jumps from any row into the access logs filtered the same way. **Automatic mitigation** turns on the site's Under Attack when its CC level reaches a threshold and turns it off again once the attack is over.

## Concepts

| Term | Definition |
| --- | --- |
| Block reason | Why a request was blocked, see [Access logs](access-logs.en.md#block-reasons). |
| CC level | The site's challenge level on a node, from low to high: Normal, Cookie redirect, JavaScript, Non-interactive challenge, Interactive challenge, see [Challenges and CC protection](challenges.en.md). |
| Trigger level | The CC level at which automatic mitigation turns on Under Attack. Never Normal. |
| Hold | Minutes (5–1440) Under Attack stays on after the level was last at the trigger level. |
| Holding | Automatic mitigation has turned Under Attack on and has not turned it off yet. |

## The Attacks tab

The range at the top (1 hour, 6 hours, 24 hours, 7 days, 30 days) applies to every card below it:

| Card | Content |
| --- | --- |
| Automatic mitigation | Settings and current state, see [Automatic mitigation](#automatic-mitigation) |
| Block reasons | Requests per block reason over time as a stacked chart and a list; **View logs** at the end of a row opens the access logs filtered to that reason and the same range |
| Current level per node | The site's level, online state and escalated paths on every active node of the cluster (refreshed every 15 seconds) |
| Top addresses, Top paths | Heaviest addresses and paths in the events (approximate); clicking an address or a path opens the access logs filtered to that value and the same range; **⋯** at the end of a row offers **Ban IP** or **Purge URL** |
| Most-matched CRS rules | The CRS rule IDs the WAF matched most; **Exclude CRS rule** or **Exclude by path**, see [WAF](waf.en.md) |
| Log rule matches | Matches of rules that only log, see [Rules](rules.en.md) |
| Challenge pass rate | Challenges issued, passes granted once they were solved, and their ratio |
| Authentication failures | Failed external authentication, see [Access control](access-control.en.md) |
| Events | Timeline of level changes, escalated paths and automatic bans, filterable by type |

Top addresses, Top paths and Events come only from the security events nodes report. Each event carries the busiest addresses and paths at that moment, so the results are approximate. Events are kept as set in [Challenges and CC protection](challenges.en.md#state-and-events); a range beyond the retention has no data.

Jumps from other pages carry the log filters and the time window in the link: `/sites/<site ID>?tab=logs` (the **Logs** tab) accepts `blockReason`, `ip`, `cidr`, `path`, `from` and `to`. Changing the tab clears them.

## Automatic mitigation

On the **Attacks** tab, click **Set up** in the **Automatic mitigation** card and fill in:

| Field | Default | Description |
| --- | --- | --- |
| Enabled | On | Off stops automatic turn-on; a hold in progress turns Under Attack off at once |
| Trigger level | Non-interactive challenge | Cookie redirect, JavaScript, Non-interactive challenge or Interactive challenge |
| Hold below trigger (minutes) | 30 | 5–1440 |

1. On any online, active node of the cluster, the site's CC level reaches the trigger level.
2. Automatic mitigation turns on the site's Under Attack (the challenge type follows the site's **Challenge type**) and publishes the configuration of the site's cluster. The card shows **Under Attack on until …** and the site's Under Attack card shows **Automatic until …**.
3. While the level stays at or above the trigger level, the end time keeps moving to now plus the hold; no new configuration version is published.
4. Once the level is below the trigger level and the end time has passed, Under Attack is turned off and a configuration version is published.

> [!NOTE]
> The site's CC protection must be on and its **maximum level** at least the trigger level, otherwise the level cannot reach it; the card shows a hint in both cases. Every request counts toward a site's QPS on the node, so the level stays high while Under Attack is on and falls back step by step only after the attack stops: the hold does not end in the middle of an attack.

### By hand

Automatic mitigation only turns off an Under Attack it turned on itself:

| Action | Result |
| --- | --- |
| Under Attack was already on, turned on by a person | Left alone and never turned off |
| Turn Under Attack on during a hold | Counts as turned on by hand; automatic mitigation no longer turns it off and its state is cleared |
| Turn Under Attack off during a hold | The hold ends, the card shows **Ended by hand**, and nothing starts until the level is below the trigger level |
| **End now** | Turns Under Attack off and pauses the same way; with no hold it returns 409 `AUTO_MITIGATION_NOT_ACTIVE` |
| Change the settings | Disabling turns it off at once; shortening the hold shortens the end time; the pause is cleared |
| Site disabled | Nothing starts |

**Copy site settings** neither copies an Under Attack held by automatic mitigation nor turns it off on a target that holds it; copying with Under Attack on counts as turned on by hand.

### Failure and retry

When the change cannot be published (for example an active node of the cluster lacks `challenge-v1`), it is rolled back, the card shows **Not applied; retried every minute**, the error code is kept in `lastError` and the change is retried every minute.

### How it runs

The background job `mitigation.evaluate` checks every site with automatic mitigation each minute; when a node reports a site's level going up, that site is checked at once instead of at the next minute. The end time is stored in the database, so a console restart loses nothing.

The site's level is the highest among its online, active nodes: the level from the node's last heartbeat, replaced by a level-change event received after it (within 5 minutes).

## Permissions and audit

Changes need a console session or a read-write AccessKey; a read-only AccessKey can only read; service accounts cannot call these endpoints (`SERVICE_ACCOUNT_FORBIDDEN`). Audit:

| Action | When |
| --- | --- |
| `site.auto_mitigation_update` | Settings changed |
| `site.auto_mitigation_apply` | Under Attack turned on automatically (the actor is the system; metadata has `level`, `threshold`, `durationMinutes`, `revision`) |
| `site.auto_mitigation_release` | Under Attack turned off automatically (also `reason`: `expired` or `disabled`, and `since`) |
| `site.auto_mitigation_restore` | **End now** |

The configuration versions carry the reasons "Automatic mitigation turned on / off Under Attack for {site}" (`auto_mitigation_started` / `auto_mitigation_ended`).

## API

| Procedure | Endpoint |
| --- | --- |
| `autoMitigation.get` | `GET /sites/{id}/auto-mitigation` |
| `autoMitigation.update` | `PUT /sites/{id}/auto-mitigation` |
| `autoMitigation.restore` | `POST /sites/{id}/auto-mitigation/restore` |
| `analytics.breakdown` (`by=block_reason`) | Requests per block reason |
| `security.state`, `security.events` | Node levels, tops and events of the last `hours` (up to 720) |

Fields: [API and endpoints](../reference/api.en.md#automatic-mitigation).
