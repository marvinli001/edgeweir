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

For every site: in **System → Protection**, pick the **Challenge type**, turn on **Global Under Attack**, and confirm; every cluster gets a new configuration. The **Security** tab of each site then shows "Global Under Attack is on for every site". See [Protection](system.en.md#protection).

These requests are never challenged by Under Attack or CC mitigation:

| Request | Note |
| --- | --- |
| ACME HTTP-01 validation | Handled before the site is resolved |
| Addresses on an **Allow** IP list | Applies to every site, see [IP lists](rules.en.md#ip-lists) |
| Requests that match an `allow` rule | A `challenge` rule that matched before the `allow` still applies |

The level required is the highest of: global Under Attack, the site's Under Attack, matching `challenge` rules, the site's current CC level, and the path's CC level. Rules of the configuration phase can turn the site's Under Attack on or off, turn **CC mitigation** off, or set **CC highest level** per request; global Under Attack is unaffected, see [Override settings](rules.en.md#override-settings).

## Challenge settings

**Security → Challenges**:

| Field | Values | Default |
| --- | --- | --- |
| Pass lifetime (seconds) | 300–86400 | 1800 |
| Proof-of-work difficulty | 8–24 | 16 |
| High proof-of-work difficulty | 8–26, at least the proof-of-work difficulty | 20 |
| Record JA4 in access logs | On / off | Off |

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
2. Keep **Follow the default template** to use the default thresholds (**System → CC template**), or turn it off to set your own.
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

| Trigger | Behavior |
| --- | --- |
| Site QPS | The site's request rate is over the threshold: the whole site escalates |
| Per-URL QPS | A path's rate is over the threshold: only that path escalates (exact path match); other paths are unaffected |
| Per-IP QPS | An address's rate is over the threshold: the address is banned automatically for the ban duration, see [Automatic bans](bans.en.md#automatic-bans) |
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

Lower on the **Security** tab:

| Section | Content |
| --- | --- |
| Current level per node | The site's level, online state and escalated paths on every active node of the cluster (refreshed every 15 seconds) |
| Top addresses and paths | Heaviest addresses and paths in the events of the last hour, 24 hours or 7 days (approximate) |
| Events | Timeline of level changes, escalated paths and automatic bans: node and trigger (observed / threshold), filterable by type |

Events are kept for 30 days by default, adjustable to 7–365 days with **Security event retention (days)** in **System → Protection**. A site leaving the normal level raises the **CC mitigation raised** alert (`cc_mitigation`), at most once per site in 15 minutes, see [Alerts](dns-and-alerts.en.md#set-alert-rules).

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
| Access logs | With **Record JA4 in access logs**, sampled logs carry a JA4 column, see [Access logs](access-logs.en.md) |

> [!NOTE]
> The TLS version is the highest version of the client's `supported_versions` extension; clients that do not send it get the version negotiated in the handshake. For such older clients, the version of the fingerprint is an approximation.

Only JA4 (the TLS client fingerprint) is implemented; JA4S, JA4H and the other methods are not.

## Permissions

Changes need a console session or a read-write AccessKey; read-only AccessKeys can only read; service accounts cannot call these procedures (`SERVICE_ACCOUNT_FORBIDDEN`). Every change is audited: `site.protection_update`, `system.protection_update`, `system.cc_template_update`.

## Node capabilities

| Feature | Capability |
| --- | --- |
| Under Attack, CC mitigation, challenge rules | `challenge-v1` |
| `tls.ja4` field, JA4 rate limit key, JA4 logging | `ja4-v1` |

When an active node of the cluster lacks a capability, the change is still saved and published; nodes without the capability keep their previous configuration and show **Upgrade required** in **Clusters & nodes**, see [Node upgrades](node-upgrades.en.md). Service accounts and background jobs that publish such a configuration get 409 `NODE_CAPABILITY_REQUIRED` ("Cluster nodes need these capabilities first: …") and the settings stay as they were. Clusters that use none of these features keep their configuration unchanged.

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
| "Cluster nodes need these capabilities first: challenge-v1" | A service account or background job published a configuration that needs a capability the cluster's nodes lack | Upgrade the node |
| 503, `X-Edgeweir-Error: challenge-unavailable` | The node has not fetched the pass keys yet | Check the node's connection to the console |
| Forms or API calls get 403 with `X-Edgeweir-Challenge: required` | Non-GET/HEAD requests without a valid pass | Pass the challenge in a browser first; let machine-to-machine endpoints through with an `allow` rule |
| Challenged again after passing | The pass expired; the client changed network or User-Agent; the required level is above the pass level | Lengthen the lifetime; check whether a proxy's exit address keeps changing |
| CC mitigation does not escalate | Traffic spreads over several nodes and no single node reaches the thresholds | Lower the thresholds by the number of nodes |
