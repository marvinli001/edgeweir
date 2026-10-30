# OWASP CRS managed rules

Turn on the OWASP Core Rule Set (CRS) per site: ModSecurity on the nodes inspects requests, records the rules they match, and in block mode refuses attacks.

## Concepts

| Term | Definition |
| --- | --- |
| CRS | The generic web attack detection rules maintained by OWASP (SQL injection, XSS, path traversal, protocol violations, and more). Rule IDs are in 900000–999999. |
| ModSecurity | The WAF engine that runs CRS (ModSecurity v3), installed as an OpenResty dynamic module with the `edgeweir-openresty-modsecurity` package. The CRS (4.29.0) is fixed by the package; nodes never download rules at run time. |
| Anomaly score | Every matched rule adds to a request's score by severity: critical 5, error 4, warning 3, notice 2. A request whose total reaches the threshold counts as an attack. |
| Paranoia level | The CRS rule level, 1–4. Higher levels run more rules, detecting more attacks and producing more false positives. |
| Mode | Off, detect only (record matches only), or block (answer 403 at the threshold). |

## Turn on CRS

Prerequisites: every active node of the site's cluster supports `modsecurity-v1` (has `edgeweir-openresty-modsecurity` installed, see [Adding nodes](../deploy/nodes.en.md)).

1. Open **Sites**, select the site, and open the **Security** tab.
2. In the **OWASP CRS managed rules** card, set **Mode** to **Detect only**.
3. Pick Loose, Standard (the default), or Strict under **Preset**, or **Custom** to set **Paranoia level**, **Anomaly score threshold**, and **Request body inspected (bytes)**; add [exclusions](#exclusions) as needed.
4. Click **Save**. The console shows **Saved** and publishes a new configuration revision for the site's cluster.
5. Verify: after the node applies the revision, send a test payload:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' --resolve www.example.com:443:<node IP> \
     'https://www.example.com/?q=%3Cscript%3Ealert(1)%3C/script%3E'
   ```

   In **Detect only** mode the origin's usual status comes back; within a minute, **Most-matched CRS rules** on the **Attacks** tab lists the rules the request matched (such as 941100).
6. Once matches and false positives are reviewed, set **Mode** to **Block** and save. The same request returns `403`.

## Fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Mode | Off / Detect only / Block | Off | Detect only records matches; Block answers 403 once the anomaly score reaches the threshold |
| Paranoia level | 1–4 (shown as **Level 1** … **Level 4**) | 1 | CRS rule level that runs |
| Anomaly score threshold | 1–1000 | 5 | A request whose anomaly score reaches it counts as an attack; 5 means a single critical rule is enough |
| Request body inspected (bytes) | 0–134217728 (128 MiB) | 131072 (128 KiB) | Only this many bytes of the request body are inspected; 0 inspects no body, see [Request body inspection](#request-body-inspection) |
| Exclusions | Up to 100 entries, see [Exclusions](#exclusions) | None | These rules do not run on the entry's path (or do not inspect its targets); use them against false positives |

| Preset | Paranoia level | Anomaly score threshold | Request body inspected (bytes) |
| --- | --- | --- | --- |
| Loose | 1 | 10 | 65536 |
| Standard | 1 | 5 | 131072 |
| Strict | 2 | 5 | 1048576 |

Presets leave **Mode** and the exclusions alone. Saved values that match no preset show as **Custom**.

## Exclusions

Each exclusion keeps a set of rules from running on a path, or only from inspecting some targets:

| Field | Values | Notes |
| --- | --- | --- |
| Path | Empty for **Whole site**; or starting with `/`, at most 1024 bytes, without `?`, `#`, whitespace or control characters | Matched against the client's normalized path (before rewrites, a signed URL's signature removed) |
| Match | Prefix / Exact | Prefixes compare bytes; `/api/` does not match `/apix` |
| Rule IDs | 1–200, 900000–999999, unique; no 901xxx, 949xxx, 959xxx or 980xxx | These rules do not run on the path |
| Targets (optional) | Up to 16, unique: `ARGS:name`, `REQUEST_COOKIES:name` (1–64 letters, digits or `_` `.` `-` `[` `]`), `REQUEST_HEADERS:name` (1–64 letters, digits or `-`) | With targets the rules still run, but do not inspect those arguments, cookies or request headers |

Up to 100 entries, in the order saved.

| Where | How | Node capability |
| --- | --- | --- |
| **Excluded rule IDs** on the CRS card | Type rule IDs (separated by commas or spaces) and click **Add**; saved as the whole-site entry without targets | `modsecurity-v1` |
| **Exclusions by path** → **Add exclusion** on the CRS card | Fill in **Path**, **Match**, **Rule IDs** and **Targets (optional)** in the dialog and confirm | `waf-v2` |

Both need the card's **Save**. While an active node of the cluster lacks `waf-v2`, **Add exclusion** is unavailable and shows "Some nodes in the cluster do not support it". A change of exclusions is structural: nodes render the rule file again and reload nginx (open connections stay).

## Overrides and exclusions by path

| Way | How | Effect |
| --- | --- | --- |
| Exclude by path | **Exclusions by path** → **Add exclusion**, with a path | The rules do not run on that path; other rules still do |
| Override the mode by path | The **OWASP CRS** override of a configuration phase rule: Unchanged / Off / Detect only / Block, see [Override settings](rules.en.md#override-settings) | Matching requests have CRS off, detect only or block; no effect on sites without CRS; hot update, no reload |
| Skip | **OWASP CRS** in a custom WAF **Skip** action, see [WAF actions](rules.en.md#waf-actions) | The request is not inspected by CRS |

Nodes match the normalized path in the edge layer and hand the matching entries to ModSecurity in an internal request header; ModSecurity's own `REQUEST_FILENAME` is not normalized and is not used for paths. The internal header is removed before the origin and never reaches it. Excluding the prefix `/api/`, for one, does not cover `/api/../admin`, which normalizes to `/admin`.

| Raw path | Do exclusions apply |
| --- | --- |
| Ambiguous: an encoded `/`, `\`, `.`, `%` or `;` (`%2F`, `%5C`, `%2E`, `%25`, `%3B`, either case), a `%u` escape, a `\`, a `;`, a `#`, a `.` or `..` segment, a leading `//` | No (the origin may route it elsewhere); `/admin/../api/x` goes through every rule |
| `//` inside | No (the node merges slashes, the origin may keep the empty segment) |
| Under one of the site's [encoded path exceptions](access-control.en.md#encoded-path-exceptions) and no longer ambiguous by it | Only when every reading of the path matches the entry |

A heavily matched rule can be excluded by path where it shows: click **⋯** in its row of **Most-matched CRS rules** or of the logs → **Exclude by path**; the **Exclude CRS rules by path** dialog holds the rule ID (and, from a log row, the request's path); fill in the path, choose prefix or exact, and click **Add**. The entry is added to **Exclusions by path** (an entry with the same path, match and targets takes the rule IDs instead) and saved at once. Needs `waf-v2`.

To skip verified search engine crawlers, add a custom WAF rule with the condition `http.request.bot.verified` and the action **Skip** with **OWASP CRS**. The field: [Verified search engine crawlers](challenges.en.md#verified-search-engine-crawlers); needs `challenge-v2` and `waf-v2`.

## Request body inspection

| Item | Behavior |
| --- | --- |
| Inspected | The first **Request body inspected (bytes)** bytes of the body; the rest is not inspected and the request goes on. 0 reads no body |
| Parsing | `application/json` as JSON (nesting depth at most 512); `text/xml`, `application/xml` and `application/soap+xml` as XML; `application/x-www-form-urlencoded` and `multipart/form-data` as forms |
| Parse failures | In block mode 400 (`X-Edgeweir-Error: waf-blocked`): a body that cannot be parsed, a multipart body that fails strict validation, 1000 or more arguments; a multipart body with an unmatched boundary is blocked |
| Node configuration | The node renders one inspection location per distinct limit; adding or dropping a limit reloads nginx |

Larger limits cost the node more memory and CPU, see [Performance](#performance).

## Behavior

| Item | Behavior |
| --- | --- |
| Scope | Only sites with CRS on go through ModSecurity; other sites are not affected |
| Cache hits | Sites with CRS on inspect cache hits too (inspection runs before the cache lookup) |
| Blocking | In block mode, requests at the threshold get 403 with `X-Edgeweir-Error: waf-blocked` and the site's error page, and never reach the origin |
| Changes | The node renders the site's CRS settings into a rule file, tests it, and reloads; a failed test keeps the previous configuration. Mode, paranoia level, threshold and per-path overrides update without a reload; exclusions and the body limit need a reload |
| Rollback | A configuration rollback restores the site's CRS settings of that revision |
| Permissions | As for challenges: the operator's session and read-write AccessKeys can change it, the demo account and read-only AccessKeys only read it, service accounts cannot call it, see [Permissions](challenges.en.md#permissions) |
| Audit | Every change is audited as `site.waf_update` |

## View matches

| Where | Contents |
| --- | --- |
| **Attacks** tab → **Most-matched CRS rules** | The rule IDs matched most often in the **Range** (1 hour, 6 hours, 24 hours, 7 days, 30 days). The counts are approximate: each node reports only the 20 most-matched rules per site and minute |
| The site's **Logs** tab | With access log sampling on, requests that matched rules show **CRS** under the request: the rule IDs (at most 16 per request) and a **Blocked** badge. The CSV gets `wafRuleIds` (space-separated) and `wafBlocked` columns |

Matches are recorded in both detect and block mode.

A rule that raises false positives can be excluded for the whole site where it shows: click **⋯** in its row of **Most-matched CRS rules** or of the logs → **Exclude CRS rule N**, then **Add** in **Exclude CRS rule N on this site?**; the rule ID joins the whole-site exclusion and is saved at once, and the CRS card updates. **Exclude by path** excludes it on one path only, see [Overrides and exclusions by path](#overrides-and-exclusions-by-path).

Initialization, blocking evaluation and correlation rules (901xxx, 949xxx, 959xxx, 980xxx) only add up scores and decide, so 949110, for one, matches every blocked request. They are left out of **Most-matched CRS rules** and cannot be excluded (the console and the API refuse them, 400 `WAF_RULE_NOT_EXCLUDABLE`), since excluding them breaks CRS or turns blocking off. Against a false positive, exclude the rule that detected it in the log row; to stop blocking, set the mode to **Detect only**.

The **In effect** line at the top of the **Security** tab shows **CRS: (mode) · (preset)**; click it to jump to the CRS card, whose title shows the mode while it is detect only or block. Access logs: [Access logs](access-logs.en.md).

## Performance

On a site with CRS on, every request goes through ModSecurity rule matching; node CPU and request latency grow with the paranoia level, the request body limit, and request size. Sites without CRS never go through ModSecurity. Run in **Detect only** first and watch matches, false positives, and node load before switching to **Block**; turn CRS on only for the sites that need it, and keep the paranoia level and body limit as low as practical.

While any site on a node runs CRS, the node loads ModSecurity and the bundled rules, and nginx uses about 40 MiB more memory, more under sustained load. After the last site turns CRS off, that memory is only released the next time the node restarts nginx (for example on a node upgrade or a service restart).

## Node capabilities

| Capability | Needed for |
| --- | --- |
| `modsecurity-v1` | Any site with CRS on (detect or block); whole-site exclusions without targets |
| `waf-v2` | Exclusions with a path or targets; the **OWASP CRS** override; the **Skip** action |

While an active node of the cluster lacks `modsecurity-v1`, **Mode** of a site without CRS cannot be changed and shows "Some nodes in the cluster do not support it" (`crs.reason` is `nodes` in `GET /sites/{id}/features`); CRS already on can still be changed or turned off. The API can still turn it on: the configuration is published, and nodes without the capability keep their last-known-good configuration and show **Upgrade required** until `edgeweir-openresty-modsecurity` is installed or the node is upgraded.

## API

| Procedure | Endpoint |
| --- | --- |
| `waf.get` | `GET /sites/{id}/waf` |
| `waf.update` | `PATCH /sites/{id}/waf` (changes only the fields given; `exclusions` replaces every entry) |
| `waf.topRules` | `GET /sites/{id}/waf/rules?range=24h&limit=10` (`range` is `1h`, `6h`, `24h`, `7d` or `30d`; `limit` 1–50; approximate) |
| `sites.features` | `GET /sites/{id}/features` (whether `crs` and `wafV2` can be turned on) |

Fields and examples: [API and endpoints](../reference/api/security.en.md#owasp-crs).

## Limits

| Item | Description |
| --- | --- |
| Rules | Only the CRS bundled with the node package runs; custom ModSecurity rules cannot be added |
| Exclusions | By path prefix or exact path, rule ID and argument / cookie / request header name; not by path pattern, rule tag or request body field |
| Statistics | Approximate; each node reports only the 20 most-matched rules per site and minute |
| Nodes | Nodes installed with `--no-modsecurity` do not support CRS |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **Mode** is unavailable with "Some nodes in the cluster do not support it" | An active node of the cluster lacks `edgeweir-openresty-modsecurity` or is too old | Install the package on the node or upgrade it |
| **Add exclusion** is unavailable with "Some nodes in the cluster do not support it" | An active node of the cluster lacks `waf-v2` | Upgrade the node |
| A node shows **Upgrade required** | CRS was turned on through the API and the node lacks `modsecurity-v1` | Install the package on the node or upgrade it |
| Legitimate requests get 403 with `X-Edgeweir-Error: waf-blocked` | False positive | Find the rule ID in **Most-matched CRS rules** or the access logs and exclude it (for the path, or the whole site); or lower the paranoia level or raise the threshold |
| Uploads or API requests get 400 with `X-Edgeweir-Error: waf-blocked` | The body cannot be parsed per its `Content-Type`, or it has 1000 or more arguments | Fix the client's body or `Content-Type`; turn CRS off for that path with **Skip** or an override |
| The test payload is not blocked | Mode is **Detect only**; the anomaly score stays below the threshold; the rules are excluded; the node has not applied the configuration yet | Check the settings and the node's applied revision |
| "Rule IDs are integers from 900000 to 999999, without duplicates, at most 200" | An ID outside the CRS range, a duplicate, or too many IDs | Correct the input |
| "N set up or evaluate the CRS and cannot be excluded; …" | The rule ID is in 901xxx, 949xxx, 959xxx or 980xxx | Exclude the rule that detected the request, or use **Detect only** |
| Still blocked after excluding by path | Paths are matched normalized (prefixes by bytes); the raw path is ambiguous or holds `//`; more than one rule matched; the node has not reloaded yet | Look up every matched rule in the logs; check prefix or exact; wait for the node to apply the configuration |
