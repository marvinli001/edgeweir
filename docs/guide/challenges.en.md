# Challenges and CC mitigation

Make visitors pass a challenge first: by rule, per site or globally (Under Attack), or escalating with load (tiered CC); a pass admits them until it expires.

## Concepts

| Term | Definition |
| --- | --- |
| Challenge | A verification page the node returns instead of the origin; passing it returns to the original URL. |
| Level | Strength of a challenge, from low to high: cookie redirect (1), JavaScript (2), non-interactive challenge (3), interactive challenge (4). A pass of level L satisfies every requirement up to L. |
| Managed challenge | Asks for interaction only when the node finds the visitor suspicious; otherwise passes as a non-interactive challenge. |
| CAPTCHA provider | The CAPTCHA of the interactive challenge: the built-in image captcha or a third-party provider, per site or global. |
| Pass | Signed cookie issued after a challenge, bound to the site, the level, the client network and the User-Agent. |
| Under Attack | Every GET/HEAD request without a valid pass is challenged first. Turned on per site, or for every site (global Under Attack). |
| CC mitigation | Per-site policy that escalates automatically: a trigger that holds raises the level by one step, and the level falls one step after a cool-down. |
| JA4 | TLS client fingerprint, used in rules and rate limits and recordable in access logs. |

## Challenge types

| Type | Level | How it is passed |
| --- | --- | --- |
| Cookie redirect (`cookie302`) | 1 | 302 back to the original URL with the pass; any client that keeps cookies passes |
| JavaScript (`js`) | 2 | The page script computes one SHA-256 and submits it |
| Non-interactive challenge (`pow`) | 3 | The browser finds, in a background worker, an answer with enough leading zero bits (proof of work); 16 by default, 8–24 |
| Managed challenge (`managed`) | 3 or 4 | A non-interactive challenge first; an interactive one for suspicious visitors, see [Managed challenge](#managed-challenge) |
| Interactive challenge (`captcha`) | 4 | Solve the site's CAPTCHA, see [CAPTCHA providers](#captcha-providers). The built-in image captcha asks for the 5 characters of the image and works without scripts; the page offers a computed alternative: a high-difficulty proof of work (20 bits by default, 8–26, at least the normal difficulty) that also earns a level 4 pass |

| Item | Behavior |
| --- | --- |
| Status | 403; HEAD gets the headers only |
| Headers | `X-Edgeweir-Challenge: <type>` (`pow` for the high-difficulty proof of work), `Cache-Control: no-store, private`, `Content-Security-Policy` (`default-src 'none'`, scripts and styles only with the page's nonce, forms and connections only to the site) |
| External resources | None; images are inline `data:`; a third-party CAPTCHA allows only its provider's addresses |
| Language | Chinese or English per `Accept-Language`; English when nothing matches |
| Animation | None when the system asks for reduced motion |

| Request | When a challenge is needed and there is no valid pass |
| --- | --- |
| GET, HEAD | The challenge page (a 302 redirect for `cookie302`) |
| Other methods (POST, PUT…) | Plain-text 403 with `X-Edgeweir-Challenge: required`, no challenge page |
| The node has no pass keys yet | 503 with `X-Edgeweir-Error: challenge-unavailable` (the site's error page) |

### Reserved paths

Nodes handle paths under `/.edgeweir/` themselves once the site is known and never forward them to the origin:

| Path | Purpose |
| --- | --- |
| `POST /.edgeweir/challenge/verify` | Submits an answer (body at most 4096 bytes, 413 above); on success 303 back to the URL of the challenge (same-site paths only, none starting with `//` or under `/.edgeweir/`); a wrong answer shows the challenge page again, an invalid, expired or used token 303s back to the original URL for a new challenge |
| `GET /.edgeweir/challenge/worker.js` | Background script of the proof of work |
| Anything else | 404, `X-Edgeweir-Error: not-found` |

Origins cannot serve content under this prefix. CC per-IP bans apply to it too.

## Passes

| Item | Behavior |
| --- | --- |
| Cookie | `__ew_pass`, `Path=/; Max-Age=<lifetime>; HttpOnly; SameSite=Lax`, plus `Secure` over HTTPS |
| Binding | Site, level passed, client network (IPv4 `/24`, IPv6 `/64`), hash of the User-Agent; another network or browser is challenged again |
| Lifetime | 1800 seconds (30 minutes) by default; per site 300–86400 seconds |
| Cluster-wide | Signing keys (HMAC-SHA256) are per cluster, so every node of the cluster accepts the pass; forged or altered passes are refused |
| Key rotation | The console rotates the keys every 24 hours (checked hourly); nodes hold the next, current and previous key, so passes issued before a rotation stay valid until they expire |
| Replay | Each challenge token can be redeemed once; tokens expire after 5 minutes |

## Turn on Under Attack

1. Open **Sites**, select the site, and open the **Security** tab.
2. In the **Under Attack** card, pick the **Challenge type** (**JavaScript** by default); the choice is saved at once.
3. Turn on the **Under Attack** switch and click **Turn on** in the **Turn on Under Attack?** dialog. The card shows **On**; nodes apply it once the configuration is published.
4. Verify:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/
   ```

   The answer is 403 with `X-Edgeweir-Challenge: js`. In a browser, the site opens normally after the challenge.

To turn it off, click the switch again and click **Turn off** in the **Turn off Under Attack?** dialog.

To turn it on during an attack and off again afterwards, see [Automatic mitigation](attack-dashboard.en.md#automatic-mitigation); while it holds the switch, the card shows **Automatic until (time)**. Switching it by hand takes it away from the automatic mitigation.

For every site:

1. Open **Protection settings** (`/protection`) and pick the **Challenge type** in the **Protection** card.
2. Turn on **Global Under Attack** and click **Turn on** in the **Turn on Under Attack for every site?** dialog. Every cluster gets a new configuration.
3. The **Under Attack** card of every site then shows "Global Under Attack is on for every site".

A changed **Challenge type** while global Under Attack is on is published to every cluster once you click **Save**. See [Protection](system.en.md#protection).

Without leaving the page: press ⌘K / Ctrl+K, type a site's name or domain, pick **Under Attack: (site)** and confirm; the switch turns the other way. **Global Under Attack** turns the global switch the same way.

These requests are never challenged by Under Attack or CC mitigation:

| Request | Note |
| --- | --- |
| ACME HTTP-01 validation (`/.well-known/acme-challenge/<token>`) | Tokens of the console's certificates are answered by the node before the site is resolved; other tokens go to the origin, never cached or challenged |
| Addresses on an **Allow** IP list | Applies to every site, see [IP lists](rules.en.md#ip-lists) |
| Addresses on a site's allow lists | That site only, see [Site lists](access-control.en.md#site-lists) |
| Requests that match an `allow` rule | A `challenge` rule that matched before the `allow` still applies |
| Requests matching a **Skip** rule with **Under Attack and CC challenges** | Like `allow`, see [WAF actions](rules.en.md#waf-actions) |
| Verified search engine crawlers | When the site has **Allow verified search engine crawlers** on, see [Verified search engine crawlers](#verified-search-engine-crawlers) |

The level required is the highest of: global Under Attack, the site's Under Attack, the site's current CC level, the path's CC level, and [greylist](bans.en.md#greylist) entries that ask for a challenge. A matching `challenge` rule challenges on its own in the rule phase. Rules of the configuration phase can turn the site's Under Attack on or off, turn **CC mitigation** off, or set **CC highest level** per request; global Under Attack is unaffected, see [Override settings](rules.en.md#override-settings).

## Challenge settings

The **Challenges** card of the **Security** tab:

1. Under **Preset**, pick Loose, Standard (the default), or Strict to fill in the first three fields below; pick **Custom** to set each one. Saved values that match no preset show as **Custom**.
2. Set the other fields as needed.
3. Click **Save**.

| Field | Values | Default |
| --- | --- | --- |
| Pass lifetime (seconds) | 300–86400 | 1800 |
| Proof-of-work difficulty | 8–24 | 16 |
| High proof-of-work difficulty | 8–26, at least the proof-of-work difficulty | 20 |
| Record JA4 in access logs | On / off | Off |
| Allow verified search engine crawlers | On / off | Off |
| Challenge failure bans | On / off; **Failures within 10 minutes** 3–100; **Ban duration (seconds)** 60–86400 | Off; 10; 600 |
| Challenge page text | **Chinese title**, **Chinese hint**, **English title**, **English hint**, ≤ 200 characters each, plain text | Empty (built-in text) |

| Preset | Pass lifetime | Proof-of-work difficulty | High proof-of-work difficulty |
| --- | --- | --- | --- |
| Loose | 3600 | 14 | 18 |
| Standard | 1800 | 16 | 20 |
| Strict | 900 | 18 | 22 |

Each extra step of difficulty doubles the work a browser does on average. While an active node of the cluster lacks `challenge-v2`, the card shows "Some nodes in the cluster do not support it", and **Allow verified search engine crawlers**, **Challenge failure bans** and **Challenge page text** cannot be turned on or filled in; values already set can still be changed or turned off.

## Verified search engine crawlers

With **Allow verified search engine crawlers** on, when Under Attack (the site's or the global one) or CC requires a challenge from a request without a sufficient pass, the node checks whether its User-Agent claims a crawler of the table; if so it verifies the address and skips the challenge when that passes. `challenge` rules, greylist challenges, bans, CC per-IP bans and other checks still apply.

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
| Resolver | The node's resolver (node flag `--resolver`, otherwise from `--resolv-conf`, by default `/etc/resolv.conf`); 1 second per query, at most 2 tries |
| Cache | Per address and crawler in the node's shared memory: verified 24 hours, not verified 1 hour, timeouts and lookup failures 60 seconds; while an address is being looked up, other requests count as not verified |
| Rule fields | `http.request.bot.verified`, `http.request.bot.name`, see [Fields](rules.en.md#fields); looked up only when a rule evaluates them |
| Node capability | `challenge-v2` |

This verifies identity only; there is no scoring. A crawler address seen for the first time waits for the lookups (a few seconds at most); while the resolver is unavailable crawlers are challenged as usual.

## Challenge page text

**Challenge page text** sets the page title and a hint below it, one set in Chinese and one in English, chosen by `Accept-Language`; empty values keep the built-in text. Plain text of at most 200 characters each, without control characters; the node escapes it as HTML. It applies to the site's challenge pages only (Under Attack, CC, `challenge` rules and the greylist). Needs the node capability `challenge-v2`.

## Challenge failure bans

With **Challenge failure bans** on, an address (an IPv4 address, the `/64` of an IPv6 one) that fails the site's challenges **Failures within 10 minutes** times, counted from its first failure, is banned on the site for **Ban duration (seconds)** by the node (reason **Too many failed challenges**), and its count starts over, see [Automatic bans](bans.en.md#automatic-bans).

| Item | Behavior |
| --- | --- |
| Counted as a failure | A wrong answer; a challenge token that is invalid, expired or already used |
| Not counted | Addresses on the global allow lists and the site's allow lists, the cluster's trusted proxies |
| Node capability | `challenge-v2` |

## Managed challenge

The managed challenge (`managed`) is available for Under Attack (site and global) and as the rule action **Managed challenge**. The node serves a non-interactive challenge whose page also collects browser signals, and switches to an interactive challenge (a level 4 pass) when:

| Condition | Checked |
| --- | --- |
| The User-Agent is empty, or a common command-line tool, HTTP library or headless browser | When the challenge is served |
| The client network (IPv4 `/24`, IPv6 `/64`) failed a challenge of the site within 10 minutes | When the challenge is served |
| The client network got 4 managed challenge pages in a row without passing | When the challenge is served |
| The page detects an automated browser (`navigator.webdriver`, missing common browser APIs, …) | When the answer is submitted |

Other visitors pass without interaction and get a level 3 pass. Needs the node capability `challenge-v3`.

## CAPTCHA providers

The CAPTCHA of the interactive challenge. **Security → Interactive challenge**, **CAPTCHA**:

| Option | Behavior |
| --- | --- |
| Follow global (default) | Uses **Interactive challenge** under **Protection settings → Protection** |
| Built-in image | No third-party provider |
| This site's own | The site's own provider and keys |

| Provider | Site parameters | Secrets | Verification |
| --- | --- | --- | --- |
| Built-in image captcha | — | — | On the node |
| Cloudflare Turnstile | Site key | Secret key | `challenges.cloudflare.com/turnstile/v0/siteverify` |
| reCAPTCHA v2 | Site key | Secret key | `www.google.com/recaptcha/api/siteverify` |
| reCAPTCHA v3 | Site key, minimum score (1–100, 50 by default) | Secret key | Same; the action must be `edgeweir_challenge` |
| reCAPTCHA Enterprise | Site key, project ID, minimum score | API key | assessments of `recaptchaenterprise.googleapis.com` |
| Tencent Cloud Captcha | CaptchaAppId | SecretId, SecretKey, AppSecretKey | DescribeCaptchaResult of `captcha.tencentcloudapi.com` (TC3-HMAC-SHA256) |
| Alibaba Cloud Captcha 2.0 | SceneId, region (Chinese mainland or Singapore), identity prefix | AccessKey ID, AccessKey Secret | VerifyIntelligentCaptcha (ACS3-HMAC-SHA256) |
| GeeTest v4 | captcha_id | captcha_key | `gcaptcha4.geetest.com/validate` |

| Item | Behavior |
| --- | --- |
| Secrets | Written in the console only, stored encrypted, read back as **Saved** only; empty fields keep them. A new provider needs all of its secrets |
| Delivery | Secrets never enter the node configuration; only nodes of clusters with sites that use them get them, kept in the node agent and never in nginx shared memory |
| Verification | The node hands the visitor's answer to the local node agent, which calls the provider (3-second timeout); the console takes no part, so an unreachable console does not affect challenges |
| Fallback | While a provider is unavailable (timeout, network error, rejected key, the node has no secret yet) the node serves the built-in image captcha for it for 60 seconds. When the provider's script fails or does not show within 10 seconds, the page offers **Use the built-in check**; browsers without scripts see it right away |
| Page | Only the provider's scripts, styles, frames and endpoints are allowed (`Content-Security-Policy` with a nonce) |

Needs the node capability `challenge-v3`; without it the console offers neither the managed challenge nor **This site's own**.

## Challenge rules

In the **Custom WAF** phase of the site's **Rules** tab or of **Global rules** (`/rules`), pick the action **Managed challenge**, **Non-interactive challenge**, or **Challenge** and a **Challenge type**, for example to challenge the login page only, or given JA4 fingerprints:

```text
http.request.uri.path eq "/login"
tls.ja4 in {"t13d1516h2_8daaf6152771_02713d6af862"}
```

| Action | Level required |
| --- | --- |
| Managed challenge (`managed_challenge`) | 3, 4 when suspicious, see [Managed challenge](#managed-challenge); needs `challenge-v3` |
| Non-interactive challenge (`js_challenge`) | 3 (proof of work) |
| Challenge (`challenge`) | The chosen challenge type; new rules start with the interactive challenge |

A request with a pass of a sufficient level continues with the following rules; otherwise it is challenged as above. Fields and syntax: [Rules](rules.en.md).

## CC mitigation

CC mitigation is set per site and off by default. The **CC mitigation** card of the **Security** tab:

1. Turn on **Enabled**.
2. Keep **Follow the default template** to use the thresholds of **Protection settings → CC template**, or turn it off and pick Loose, Standard, or Strict under **Preset**, or **Custom** to set each threshold. Saved thresholds that match no preset show as **Custom**.
3. Click **Save**.

| Field | Values | Template default |
| --- | --- | --- |
| Highest level | Cookie redirect / JavaScript / Non-interactive challenge / Interactive challenge | Interactive challenge |
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

A threshold of 0 turns its trigger off. Sites that follow the template use its new thresholds as soon as it changes (saving the template publishes their clusters). The template is edited in the **CC template** card of **Protection settings** (`/protection`), with the fields above, see [CC template](system.en.md#cc-template).

| Preset | Highest level | Site / per-URL / per-IP QPS | IP ban duration | Origin error rate / minimum origin requests | Escalate after / step down after |
| --- | --- | --- | --- | --- | --- |
| Loose | Non-interactive challenge | 3000 / 600 / 150 | 300 | 70 / 200 | 20 / 60 |
| Standard (template default) | Interactive challenge | 1000 / 200 / 50 | 600 | 50 / 100 | 10 / 60 |
| Strict | Interactive challenge | 300 / 60 / 20 | 3600 | 30 / 50 | 5 / 300 |

Every preset uses a 10-second window and keeps the captcha level as a captcha.

| Trigger | Behavior |
| --- | --- |
| Site QPS | The site's request rate is over the threshold: the whole site escalates |
| Per-URL QPS | A path's rate is over the threshold: only that path escalates (exact path match); other paths are unaffected |
| Per-IP QPS | A client's rate is over the threshold (IPv4 per address, IPv6 per `/64`): it is banned automatically on the site for **IP ban duration** (reason **Per-IP request rate**), see [Automatic bans](bans.en.md#automatic-bans) |
| Origin error rate | With at least **Minimum origin requests** in the window, the share of errors (5xx and failed connections) is over the threshold: the whole site escalates |
| Escalation | A trigger that holds for **Escalate after** raises the level by one step, up to **Highest level** |
| Stepping down | With every trigger below 80% of its threshold for **Step down after**, the level falls by one step; between 80% and the threshold the level stays |

> [!IMPORTANT]
> Each node counts and escalates on its own, so thresholds apply per node. When an attack spreads over several nodes, a single node may stay under the thresholds; scale the thresholds by the number of nodes.

| Item | Behavior |
| --- | --- |
| Counting | Sliding windows (two adjacent windows weighted); paths are tracked with a bounded top-K of 64 candidates per site, at most 64 escalated paths. The cluster's trusted proxies (when the request headers name no client) are not counted |
| Captcha as the highest level | With **High proof of work instead of the captcha**, that level uses the high-difficulty proof of work |
| State | Levels survive node reloads and threshold changes; a policy turned off and on again starts from normal |
| Reporting | Level changes, escalated paths and automatic bans are reported every 5 seconds, with the heaviest addresses and paths of the moment (up to 10 each, approximate) |

### State and events

The **In effect** line at the top of the **Security** tab shows Under Attack (the site's or global), CC (the preset, **Custom**, **Template** or **Off**), the CRS mode and preset, and the challenge preset; when an online node is above normal it also shows **Nodes: (highest level)**. The first four jump to their cards; **Nodes: …** opens the **Attacks** tab. **This site's bans**, **Global rules** and **Protection settings** on the same line open those pages.

The parts of a site's **Attacks** tab (see [Attacks and automatic mitigation](attack-dashboard.en.md)) about challenges and CC:

| Section | Content |
| --- | --- |
| Current level per node | The site's level, online state and escalated paths on every active node of the cluster (refreshed every 15 seconds) |
| Top addresses and paths | Heaviest addresses and paths in the events of the **Range** (1 hour, 6 hours, 24 hours, 7 days, 30 days; approximate); **⋯** at the end of a row offers **Ban IP** (the dialog has the site and address filled in) or **Purge URL** (the path expands to each of the site's domains that is not a wildcard; submitted after a confirmation) |
| Challenge pass rate | **Issued**, **Passed** and **Pass rate** (at most 100%) over the range; cookie redirects count as issued only; `challenge-v3` nodes add, per type (challenge type or provider), issued, passed, failed, **Escalated** (managed challenge) and **Fallback** (providers) |
| Events | Timeline of level changes, escalated paths and automatic bans: node and trigger (observed / threshold), filterable by **Event type**; on an automatic ban, **⋯** offers **Ban on all sites** (the ban dialog with the global scope) or **Unban** (lifts the site's bans of exactly that address; a range that covers it stays) |

Events are kept for 30 days by default, adjustable to 7–365 days with **Security event retention (days)** in the **Protection** card of **Protection settings**. A site leaving the normal level on any node raises the **CC mitigation raised** alert (`cc_mitigation`), at most once per site in 15 minutes (a raise held back fires once they are over if the site has not recovered); it resolves when every node is back to normal, see [Set alert rules](alerts.en.md#set-alert-rules).

## JA4

JA4 is a TLS client fingerprint (format `a_b_c`, e.g. `t13d1516h2_8daaf6152771_02713d6af862`) computed during the TLS handshake and shared by the requests of a connection.

| Part | Content |
| --- | --- |
| `a` | Protocol (`t` for TCP, `q` for HTTP/3), TLS version, SNI present (`d` / `i`), number of cipher suites, number of extensions, first and last character of the first ALPN value |
| `b` | First 12 hex characters of the SHA-256 of the sorted cipher suites |
| `c` | First 12 hex characters of the SHA-256 of the sorted extensions (without SNI and ALPN) followed by the signature algorithms in their original order |

GREASE values are left out.

| Use | Note |
| --- | --- |
| Rule field | `tls.ja4` (string, empty over plain HTTP), usable in rule expressions of every phase, such as custom WAF, challenge and rate limit rules |
| Rate limit key | A rate limit rule can count by `tls.ja4` under **Rate limit key**, so one fingerprint shares a counter |
| Access logs | With **Record JA4 in access logs**, sampled logs show the JA4 under the request, see [Access logs](access-logs.en.md) |

> [!NOTE]
> The TLS version is the highest version of the client's `supported_versions` extension; clients that do not send it get the version negotiated in the handshake, an approximation. Nodes only count the extensions OpenSSL knows; unknown ones (such as ALPS or ECH) are missing from the extension count and hash, so fingerprints may differ from other JA4 implementations.

Only JA4 (the TLS client fingerprint) is implemented; JA4S, JA4H and the other methods are not.

## Permissions

| Caller | Read | Change |
| --- | --- | --- |
| Console session (the operator account) | Yes | Yes |
| Demo account | Yes | No, 403 `DEMO_READ_ONLY` |
| Read-write AccessKey | Yes | Yes |
| Read-only AccessKey | Yes | No, 403 `ACCESS_KEY_READ_ONLY` |
| Service account | No, 403 `SERVICE_ACCOUNT_FORBIDDEN` | No |

Every change is audited: `site.protection_update` (a site's Under Attack, challenge settings and CC mitigation), `system.protection_update` (global Under Attack, event retention), `system.cc_template_update` (the CC template).

## Node capabilities

| Feature | Capability |
| --- | --- |
| Under Attack, CC mitigation, challenge rules, configuration rules that turn Under Attack on | `challenge-v1` |
| Allow verified search engine crawlers, challenge page text, challenge failure bans, `http.request.bot.*` | `challenge-v2` |
| Managed challenge, third-party CAPTCHA providers, challenge statistics per type | `challenge-v3` |
| `tls.ja4` field, JA4 rate limit key, JA4 logging | `ja4-v1` |

The operator's changes are saved and published even when an active node of the cluster lacks a capability they need; nodes without it keep their previous configuration and show **Upgrade required** in **Clusters & nodes**, see [Node upgrades](node-upgrades.en.md). When a configuration published by a service account or a background job adds a capability the cluster's nodes lack, it gets 409 `NODE_CAPABILITY_REQUIRED` ("Nodes do not support … yet: `<nodes>`") and the settings stay as they were. Clusters that use none of these features keep their configuration unchanged.

## API

| Procedure | Endpoint |
| --- | --- |
| `protection.get` | `GET /sites/{id}/protection` |
| `protection.update` | `PATCH /sites/{id}/protection` (changes only the fields given; `cc` fields merge into the saved policy) |
| `security.state` | `GET /sites/{id}/security?hours=24` (`hours` 1–720) |
| `security.events` | `GET /sites/{id}/security/events` (`kind`, `hours` 1–720, `page`, `pageSize` ≤ 100) |
| `autoMitigation.get`, `autoMitigation.update`, `autoMitigation.restore` | See [Attacks and automatic mitigation](attack-dashboard.en.md#api) |
| `settings.protection`, `settings.setProtection` | `GET`, `PUT /settings/protection` (global Under Attack, challenge type, event retention, global CAPTCHA provider) |
| `settings.ccTemplate`, `settings.setCcTemplate` | `GET`, `PUT /settings/cc-template` |

Fields and examples: [API and endpoints](../reference/api/security.en.md#challenges-and-cc-mitigation).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "The high proof-of-work difficulty must be at least N" (`PROTECTION_POW_DIFFICULTY`) | The high difficulty is below the proof-of-work difficulty | Raise the high difficulty or lower the normal one |
| A node shows **Upgrade required** | The node is too old and lacks `challenge-v1`, `challenge-v2` or `ja4-v1` | Upgrade the node |
| **Challenges** shows "Some nodes in the cluster do not support it" | An active node of the cluster lacks `challenge-v2` | Upgrade the node |
| "Nodes do not support Challenges yet: `<nodes>`" | A service account or background job published a configuration that needs a capability the cluster's nodes lack | Upgrade the node |
| 503, `X-Edgeweir-Error: challenge-unavailable` | The node has not fetched the pass keys yet | Check the node's connection to the console |
| Forms or API calls get 403 with `X-Edgeweir-Challenge: required` | Non-GET/HEAD requests without a valid pass | Pass the challenge in a browser first; let machine-to-machine endpoints through with an `allow` or **Skip** rule |
| Challenged again after passing | The pass expired; the client changed network or User-Agent; the required level is above the pass level | Lengthen the lifetime; check whether a proxy's exit address keeps changing |
| A search engine crawler is still challenged | **Allow verified search engine crawlers** is off; the crawler is not in the table; the challenge comes from a `challenge` rule or the greylist; the node's resolver finds no PTR or A / AAAA record, or the lookup timed out (retried after 60 seconds) | Turn it on; check that the node resolves the address's PTR record |
| "Enter the provider's secret keys: …" | The provider changed, or the site switched to **This site's own**, without all of its secrets | Fill in the listed secrets |
| Visitors see the built-in image captcha instead of the provider's | The provider is unavailable, rejected the key, or the node has no secret yet; the provider is tried again after 60 seconds | Look for "challenge provider unavailable" in the node log; check the secrets and the node's network to the provider |
| Visitors get 403 `ip-banned` with the reason **Too many failed challenges** | The address failed the challenge the set number of times within 10 minutes | Unban it under **Bans** of **IP lists & bans**; raise the number of failures |
| CC mitigation does not escalate | Traffic spreads over several nodes and no single node reaches the thresholds | Lower the thresholds by the number of nodes |
