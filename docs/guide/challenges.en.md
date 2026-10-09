# Challenges and CC mitigation

Make visitors pass a challenge before they reach a site: through rules, for the whole site (Under Attack), or automatically, level by level, when a node sees too many requests (tiered CC mitigation). Visitors who pass get a pass and are not challenged again until it expires.

## Concepts

| Term | Definition |
| --- | --- |
| Challenge | A verification page the node returns instead of the origin; passing it returns to the original URL. |
| Level | Strength of a challenge, from low to high: cookie redirect (1), JavaScript (2), proof of work (3), image captcha (4). A pass of level L satisfies every requirement up to L. |
| Pass | Signed cookie issued after a challenge, bound to the site, the level, the client network and the User-Agent. |
| Under Attack | Every GET/HEAD request without a valid pass is challenged first. It can be turned on per site, or for every site (global Under Attack). |
| CC mitigation | Per-site policy that escalates automatically: a trigger that holds raises the level by one step, and the level falls one step after a cool-down. |
| JA4 | TLS client fingerprint, usable in rules and rate limits and recordable in access logs. |

## Challenge types

| Type | Level | How it is passed |
| --- | --- | --- |
| Cookie redirect (`cookie302`) | 1 | 302 back to the original URL with the pass; any client that keeps cookies passes |
| JavaScript (`js`) | 2 | The page script computes one SHA-256 and submits it |
| Proof of work (`pow`) | 3 | The browser finds, in a background worker, an answer with enough leading zero bits; 16 by default, 8–24 |
| Image captcha (`captcha`) | 4 | Type the 5 characters of the image; the form works without scripts. The page offers a computed alternative: a high-difficulty proof of work (20 bits by default, 8–26, at least the normal difficulty) that also earns a level 4 pass |

Challenge pages reference no external address, carry a strict `Content-Security-Policy`, are shown in Chinese or English per `Accept-Language`, and play no animation when the system asks for reduced motion. They answer with status 403, `X-Edgeweir-Challenge` set to the challenge type, and `Cache-Control: no-store, private`.

| Request | When a challenge is needed and there is no valid pass |
| --- | --- |
| GET, HEAD | The challenge page; HEAD gets the headers only |
| Other methods (POST, PUT…) | 403 with `X-Edgeweir-Challenge: required`, no challenge page |
| The node has no pass keys yet | 503 with `X-Edgeweir-Error: challenge-unavailable` |

### Reserved paths

Nodes handle paths under `/.edgeweir/` themselves once the site is known and never forward them to the origin:

| Path | Purpose |
| --- | --- |
| `POST /.edgeweir/challenge/verify` | Submits an answer; on success 303 back to the URL of the challenge (same-site paths only) |
| `GET /.edgeweir/challenge/worker.js` | Background script of the proof of work |
| Anything else | 404, `X-Edgeweir-Error: not-found` |

Origins cannot serve content under this prefix.

## Passes

| Item | Behavior |
| --- | --- |
| Cookie | `__ew_pass`, `Path=/; HttpOnly; SameSite=Lax`, plus `Secure` over HTTPS |
| Binding | Site, level passed, client network (IPv4 `/24`, IPv6 `/64`), hash of the User-Agent; another network or browser is challenged again |
| Lifetime | 30 minutes by default; per site 5 minutes to 24 hours (300–86400 seconds) |
| Cluster-wide | Signing keys are per cluster, so every node of the cluster accepts the pass; forged or altered passes are refused |
| Key rotation | The console rotates the keys once a day; passes issued before a rotation stay valid until they expire |
| Replay | Each challenge can be redeemed once; challenge parameters expire after 5 minutes |

## Turn on Under Attack

1. Open **Sites → (site) → Security**.
2. Pick the **Challenge type** (JavaScript by default).
3. Turn on the **Under Attack** switch and confirm. Nodes apply it once the configuration is published.
4. Verify:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/
   ```

   The answer is 403 with `X-Edgeweir-Challenge: js`. In a browser, the site opens normally after the challenge.

To turn it off, click the switch again and confirm.

For every site: in **Protection settings → Protection**, pick the **Challenge type**, turn on **Global Under Attack**, and confirm; every cluster gets a new configuration. The **Security** tab of each site then shows "Global Under Attack is on for every site". See [Protection](system.en.md#protection).

Without leaving the page: press ⌘K / Ctrl+K, type a site's name or domain, pick **Under Attack: (site)** and confirm; the switch turns the other way. **Global Under Attack** turns the global switch the same way.

These requests are never challenged by Under Attack or CC mitigation:

| Request | Note |
| --- | --- |
| ACME HTTP-01 validation | Handled before the site is resolved |
| Addresses on an **Allow** IP list | Applies to every site, see [IP lists](rules.en.md#ip-lists) |
| Addresses on a site's allow lists | That site only, see [Site lists](access-control.en.md#site-lists) |
| Requests that match an `allow` rule | A `challenge` rule that matched before the `allow` still applies |
| Requests matching a **Skip** rule with **Under Attack and CC challenges** | Like `allow`, see [WAF actions](rules.en.md#waf-actions) |
| Verified search engine crawlers | When the site has **Allow verified search engine crawlers** on, see [Verified search engine crawlers](#verified-search-engine-crawlers) |

The level required is the highest of: global Under Attack, the site's Under Attack, matching `challenge` rules, the site's current CC level, and the path's CC level. Rules of the configuration phase can turn the site's Under Attack on or off, turn **CC mitigation** off, or set **CC highest level** per request; global Under Attack is unaffected, see [Override settings](rules.en.md#override-settings).

## Challenge settings

**Security → Challenges**: **Preset** picks Loose, Standard (the default), or Strict and fills in the first three fields below; pick **Custom** to set each one. Saved values that match no preset show as **Custom**.

| Field | Values | Default |
| --- | --- | --- |
| Pass lifetime (seconds) | 300–86400 | 1800 |
| Proof-of-work difficulty | 8–24 | 16 |
| High proof-of-work difficulty | 8–26, at least the proof-of-work difficulty | 20 |
| Record JA4 in access logs | On / off | Off |
| Allow verified search engine crawlers | On / off | Off |
| Challenge page text | Chinese title, Chinese hint, English title, English hint, ≤ 200 characters each, plain text | Empty (built-in text) |
| Challenge failure bans | On / off; failures within 10 minutes 3–100; ban 60–86400 seconds | Off; 10; 600 seconds |

| Preset | Pass lifetime | Proof-of-work difficulty | High proof-of-work difficulty |
| --- | --- | --- | --- |
| Loose | 3600 | 14 | 18 |
| Standard | 1800 | 16 | 20 |
| Strict | 900 | 18 | 22 |

Each extra step of difficulty doubles the work a browser does on average.

## Verified search engine crawlers

With **Allow verified search engine crawlers** on, when Under Attack (the site's or the global one) or CC requires a challenge from a request without a sufficient pass, the node checks whether its User-Agent claims a crawler of the table; if so it verifies the address and skips the challenge when that passes. `challenge` rules, bans, CC per-IP bans and other checks still apply.

| Name | User-Agent contains (case-insensitive) | Reverse DNS name must be in |
| --- | --- | --- |
| `googlebot` | `Googlebot`, `Storebot-Google`, `Google-InspectionTool`, `GoogleOther`, `Google-CloudVertexBot` | `googlebot.com`, `google.com`, `googleusercontent.com` |
| `bingbot` | `bingbot` | `search.msn.com` |
| `baiduspider` | `Baiduspider` | `baidu.com`, `baidu.jp` |
| `yandexbot` | `Yandex` | `yandex.ru`, `yandex.net`, `yandex.com` |
| `applebot` | `Applebot` | `applebot.apple.com` |

| Item | Behavior |
| --- | --- |
| Verification | A reverse lookup (PTR, at most 3 names) of the visitor address; a name equal to a domain of the table or ending in `.` plus it is resolved forward (A for IPv4 visitors, AAAA for IPv6), and the visitor address must be among the answers. No third-party IP list is downloaded |
| Resolver | The node's resolver (node flag `--resolver`, by default from `/etc/resolv.conf`); 1 second per query, at most 2 tries |
| Cache | Per address and crawler in the node's shared memory: verified 24 hours, not verified 1 hour, timeouts and lookup failures 60 seconds; while an address is being looked up, other requests count as not verified |
| Rule fields | `http.request.bot.verified`, `http.request.bot.name`, see [Fields](rules.en.md#fields); looked up only when a rule evaluates them |
| Node capability | `challenge-v2` |

This verifies identity only; it is no bot scoring. A crawler address seen for the first time waits for the lookups (a few seconds at most); while the resolver is unavailable crawlers are challenged as usual.

## Challenge page text

**Challenge page text** sets the page title and a hint below it, one set in Chinese and one in English, chosen by `Accept-Language`; empty values keep the built-in text. Plain text of at most 200 characters each, without control characters; the node escapes it as HTML. It applies to the site's challenge pages only (Under Attack, CC and `challenge` rules). Needs the node capability `challenge-v2`.

## Challenge failure bans

With **Challenge failure bans** on, an address (an IPv4 address, the `/64` of an IPv6 one) that fails the site's challenges **Failures** times within 10 minutes (from its first failure) is banned on the site for **Ban duration** seconds by the node (reason **Too many failed challenges**), see [Bans](bans.en.md#automatic-bans). Failures are wrong answers and invalid, expired or reused challenge tokens. Addresses on global allow lists or the site's allow lists and the cluster's trusted proxies are not counted. Needs the node capability `challenge-v2`.

## Challenge rules

In **Rules → Custom WAF**, pick the action **Challenge** and a challenge type, for example to challenge the login page only, or given JA4 fingerprints:

```text
http.request.uri.path eq "/login"
tls.ja4 in {"t13d1516h2_8daaf6152771_02713d6af862"}
```

A request with a pass of a sufficient level continues with the following rules; otherwise it is challenged as above. Fields and syntax: [Rules](rules.en.md).

## CC mitigation

CC mitigation is set per site and off by default. **Security → CC mitigation**:

1. Turn on **Enabled**.
2. Keep **Follow the default template** to use the default thresholds (**Protection settings → CC template**), or turn it off and pick Loose, Standard, or Strict under **Preset**, or **Custom** to set each threshold. Saved thresholds that match no preset show as **Custom**.
3. Click **Save**.

| Field | Values | Template default |
| --- | --- | --- |
| Highest level | Cookie redirect / JavaScript / Proof of work / Image captcha | Image captcha |
| High proof of work instead of the captcha | On / off | Off |
| Window (seconds) | 5–60 | 10 |
| Site QPS | 0–1000000 | 1000 |
| Per-URL QPS | 0–1000000 | 200 |
| Per-IP QPS | 0–1000000 | 50 |
| IP ban duration (seconds) | 60–86400 | 600 |
| Origin error rate (%) | 0–100 | 50 |
| Minimum origin requests | 0–1000000 | 100 |
| Escalate after (seconds) | 1–3600 | 10 |
| Step down after (seconds) | 1–86400 | 60 |

A threshold of 0 turns its trigger off. Sites that follow the template use its new thresholds as soon as it changes.

| Preset | Highest level | Site / per-URL / per-IP QPS | IP ban duration | Origin error rate / minimum origin requests | Escalate after / step down after |
| --- | --- | --- | --- | --- | --- |
| Loose | Proof of work | 3000 / 600 / 150 | 300 | 70 / 200 | 20 / 60 |
| Standard (template default) | Image captcha | 1000 / 200 / 50 | 600 | 50 / 100 | 10 / 60 |
| Strict | Image captcha | 300 / 60 / 20 | 3600 | 30 / 50 | 5 / 300 |

Every preset uses a 10-second window and keeps the captcha level as a captcha.

| Trigger | Behavior |
| --- | --- |
| Site QPS | The site's request rate is over the threshold: the whole site escalates |
| Per-URL QPS | A path's rate is over the threshold: only that path escalates (exact path match); other paths are unaffected |
| Per-IP QPS | A client's rate is over the threshold (IPv4 per address, IPv6 per `/64`): it is banned automatically for the ban duration, see [Automatic bans](bans.en.md#automatic-bans) |
| Origin error rate | With at least the minimum number of origin requests in the window, the share of errors (5xx and failed connections) is over the threshold: the whole site escalates |
| Escalation | A trigger that holds for **Escalate after** raises the level by one step, up to **Highest level** |
| Stepping down | Without triggers (below 80% of the thresholds) for **Step down after**, the level falls by one step |

> [!IMPORTANT]
> Each node counts and escalates on its own, so thresholds apply per node. When an attack spreads over several nodes, a single node may stay under the thresholds; scale the thresholds by the number of nodes.

| Item | Behavior |
| --- | --- |
| Counting | Sliding windows (two adjacent windows weighted); paths are tracked with a bounded top-K of 64 candidates per site, at most 64 escalated paths |
| Captcha as the highest level | With **High proof of work instead of the captcha**, that level uses the high-difficulty proof of work |
| Reporting | Level changes, escalated paths and automatic bans are reported every 5 seconds, with the heaviest addresses and paths of the moment (up to 10 each, approximate) |

### State and events

The top of the **Security** tab shows in one line what is in effect: Under Attack (the site's or global), CC (the preset, **Custom**, **Template** or **Off**), the CRS mode and preset, the challenge preset and, when an online node is above normal, **Nodes: (highest level)**. Click a part to jump to its card.

Lower on the **Security** tab:

| Section | Content |
| --- | --- |
| Current level per node | The site's level, online state and escalated paths on every active node of the cluster (refreshed every 15 seconds) |
| Top addresses and paths | Heaviest addresses and paths in the events of the last hour, 24 hours or 7 days (approximate); **⋯** at the end of a row offers **Ban IP** (the dialog has the site and address filled in) or **Purge URL** (the path expands to each of the site's domains that is not a wildcard; submitted after a confirmation) |
| Events | Timeline of level changes, escalated paths and automatic bans: node and trigger (observed / threshold), filterable by type; on an automatic ban, **⋯** offers **Ban on all sites** (the ban dialog with the global scope) or **Unban** (lifts the site's bans of exactly that address; a range that covers it stays) |

Events are kept for 30 days by default, adjustable to 7–365 days with **Security event retention (days)** in **Protection settings → Protection**. A site leaving the normal level raises the **CC mitigation raised** alert (`cc_mitigation`), at most once per site in 15 minutes (a raise held back fires once they are over if the site has not recovered), see [Alerts](dns-and-alerts.en.md#set-alert-rules).

## JA4

JA4 is a TLS client fingerprint (format `a_b_c`, e.g. `t13d1516h2_8daaf6152771_02713d6af862`) computed during the TLS handshake and shared by the requests of a connection.

| Part | Content |
| --- | --- |
| `a` | Protocol (`t` for TCP, `q` for HTTP/3), TLS version, SNI present (`d` / `i`), number of cipher suites, number of extensions, first and last character of the first ALPN value |
| `b` | First 12 hex characters of the SHA-256 of the sorted cipher suites |
| `c` | First 12 hex characters of the SHA-256 of the sorted extensions and the signature algorithms |

| Use | Note |
| --- | --- |
| Rule field | `tls.ja4` (string, empty over plain HTTP) in custom WAF, challenge and rate limit rules |
| Rate limit key | A rate limit rule can count by `tls.ja4`, so one fingerprint shares a counter |
| Access logs | With **Record JA4 in access logs**, sampled logs show the JA4 under the request, see [Access logs](access-logs.en.md) |

> [!NOTE]
> The TLS version is the highest version of the client's `supported_versions` extension; clients that do not send it get the version negotiated in the handshake. For such older clients, the version of the fingerprint is an approximation.

Only JA4 (the TLS client fingerprint) is implemented; JA4S, JA4H and the other methods are not.

## Permissions

Changes need a console session or a read-write AccessKey; read-only AccessKeys can only read; service accounts cannot call these procedures (`SERVICE_ACCOUNT_FORBIDDEN`). Every change is audited: `site.protection_update`, `system.protection_update`, `system.cc_template_update`.

## Node capabilities

| Feature | Capability |
| --- | --- |
| Under Attack, CC mitigation, challenge rules | `challenge-v1` |
| Allow verified search engine crawlers, challenge page text, challenge failure bans, `http.request.bot.*` | `challenge-v2` |
| `tls.ja4` field, JA4 rate limit key, JA4 logging | `ja4-v1` |

When an active node of the cluster lacks a capability, the change is still saved and published; nodes without the capability keep their previous configuration and show **Upgrade required** in **Clusters & nodes**, see [Node upgrades](node-upgrades.en.md). Service accounts and background jobs that publish such a configuration get 409 `NODE_CAPABILITY_REQUIRED` ("Some nodes don't support … yet: {nodes}") and the settings stay as they were. Clusters that use none of these features keep their configuration unchanged.

## API

| Procedure | Endpoint |
| --- | --- |
| `protection.get` | `GET /sites/{id}/protection` |
| `protection.update` | `PATCH /sites/{id}/protection` |
| `security.state` | `GET /sites/{id}/security?hours=24` |
| `security.events` | `GET /sites/{id}/security/events` |
| `settings.protection`, `settings.setProtection` | `GET`, `PUT /settings/protection` (global Under Attack, event retention) |
| `settings.ccTemplate`, `settings.setCcTemplate` | `GET`, `PUT /settings/cc-template` |

Fields and examples: [API and endpoints](../reference/api.en.md#challenges-and-cc-mitigation).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The high proof-of-work difficulty must be at least N" | The high difficulty is below the proof-of-work difficulty | Raise the high difficulty or lower the normal one |
| A node shows **Upgrade required** | The node is too old and lacks `challenge-v1` or `ja4-v1` | Upgrade the node |
| "Some nodes don't support Challenges yet: {nodes}" | A service account or background job published a configuration that needs a capability the cluster's nodes lack | Upgrade the node |
| 503, `X-Edgeweir-Error: challenge-unavailable` | The node has not fetched the pass keys yet | Check the node's connection to the console |
| Forms or API calls get 403 with `X-Edgeweir-Challenge: required` | Non-GET/HEAD requests without a valid pass | Pass the challenge in a browser first; let machine-to-machine endpoints through with an `allow` rule |
| Challenged again after passing | The pass expired; the client changed network or User-Agent; the required level is above the pass level | Lengthen the lifetime; check whether a proxy's exit address keeps changing |
| A search engine crawler is still challenged | **Allow verified search engine crawlers** is off; the crawler is not in the table; the node's resolver finds no PTR or A / AAAA record, or the lookup timed out (retried after 60 seconds) | Turn it on; check that the node resolves the address's PTR record |
| Visitors get 403 `ip-banned` with the reason **Too many failed challenges** | The address failed the challenge the set number of times within 10 minutes | Unban it under **Bans**; raise the number of failures |
| CC mitigation does not escalate | Traffic spreads over several nodes and no single node reaches the thresholds | Lower the thresholds by the number of nodes |
