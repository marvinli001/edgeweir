# OWASP CRS managed rules

Turn on the OWASP Core Rule Set (CRS) per site: ModSecurity on the nodes inspects requests, records the rules they match, and in block mode refuses attacks.

## Concepts

| Term | Definition |
| --- | --- |
| CRS | The generic web attack detection rules maintained by OWASP (SQL injection, XSS, path traversal, protocol violations, and more). Rule IDs are in 900000–999999. |
| ModSecurity | The WAF engine that runs CRS, installed as an OpenResty dynamic module with the `edgeweir-openresty-modsecurity` package. The CRS version is fixed by the package; nodes never download rules at run time. |
| Anomaly score | Every matched rule adds to a request's score by severity: critical 5, error 4, warning 3, notice 2. A request whose total reaches the threshold counts as an attack. |
| Paranoia level | The CRS rule level, 1–4. Higher levels run more rules, detecting more attacks and producing more false positives. |
| Mode | Off, detect (record matches only), or block (answer 403 at the threshold). |

## Turn on CRS

Prerequisites: every active node of the site's cluster supports `modsecurity-v1` (has `edgeweir-openresty-modsecurity` installed, see [Adding nodes](../deploy/nodes.en.md)), and the platform lets tenants turn CRS on (administrators are not limited by this).

1. Open **Console → Sites**, select the site, and open the **Security** tab.
2. In the **OWASP CRS managed rules** card, set **Mode** to **Detect only**.
3. Set **Paranoia level**, **Anomaly score threshold**, **Request body inspected (bytes)**, and **Excluded rule IDs** as needed.
4. Click **Save**. The console shows **Saved** and publishes a new configuration revision for the site's cluster.
5. Verify: after the node applies the revision, send a test payload:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' --resolve www.example.com:443:<node IP> \
     'https://www.example.com/?q=%3Cscript%3Ealert(1)%3C/script%3E'
   ```

   In **Detect only** mode the origin's usual status comes back; within a minute, **Most-matched CRS rules** lists the rules the request matched (such as 941100).
6. Once you have reviewed matches and false positives, set **Mode** to **Block** and save. The same request returns `403`.

Only owners and admins of the organization can change the settings; members can view them and the matches.

## Fields

| Field | Values | Default | Effect |
| --- | --- | --- | --- |
| Mode | Off / Detect only / Block | Off | Detect only records matches; Block answers 403 once the anomaly score reaches the threshold |
| Paranoia level | 1–4 | 1 | CRS rule level that runs |
| Anomaly score threshold | 1–1000 | 5 | A request whose anomaly score reaches it counts as an attack; 5 means a single critical rule is enough |
| Request body inspected (bytes) | 0–134217728 (128 MiB) | 131072 (128 KiB) | Only this many bytes of the request body are inspected; 0 inspects no body |
| Excluded rule IDs | 900000–999999, unique, up to 200 | None | These rules never run for the site; use them against false positives |

To exclude rules, type one or more IDs (separated by commas or spaces) into **Excluded rule IDs** and click **Add** or press Enter; click the × next to an ID to remove it. Changes apply once you click **Save**.

## Behavior

| Item | Behavior |
| --- | --- |
| Scope | Only sites with CRS on go through ModSecurity; other sites are not affected |
| Cache hits | Sites with CRS on inspect cache hits too |
| Blocking | In block mode, requests at the threshold get 403 and never reach the origin |
| Changes | The node renders the site's CRS settings into a rule file, tests it, and reloads; a failed test keeps the previous configuration |
| Rollback | A configuration rollback restores the site's CRS settings of that revision |

## View matches

| Where | Contents |
| --- | --- |
| **Security** tab → **Most-matched CRS rules** | The rule IDs matched most often in the selected range (last hour to 30 days). The counts are approximate: each node keeps at most 50 rules per site and minute |
| The site's **Logs** tab | With access log sampling on, requests that matched rules show a **CRS** column: the rule IDs (at most 16 per request) and a **Blocked** badge. The CSV gets `wafRuleIds` (space-separated) and `wafBlocked` columns |

Matches are recorded in both detect and block mode. Access logs: [Access logs](access-logs.en.md).

## Platform setting

Platform administrators set **Tenants may turn on OWASP CRS** in **Admin → System settings → OWASP CRS** (on by default).

| State | Behavior |
| --- | --- |
| On | Owners and admins of an organization can turn CRS on |
| Off | Tenants turning CRS on, or changing it while it runs, get "The platform does not allow tenants to turn on OWASP CRS"; they can still set the mode to **Off** and change the other fields while it is off. Sites already running CRS keep it. Platform administrators are not limited |

Changes are audited as `system.waf_update`; changes to a site's settings as `site.waf_update`.

## Performance

On a site with CRS on, every request goes through ModSecurity rule matching; node CPU and request latency grow with the paranoia level, the request body limit, and request size. Sites without CRS never go through ModSecurity. Run in **Detect only** first and watch matches, false positives, and node load before switching to **Block**; turn CRS on only for the sites that need it, and keep the paranoia level and body limit as low as practical.

While any site on a node runs CRS, the node loads ModSecurity and the bundled rules, and nginx uses about 40 MiB more memory, more under sustained load. After the last site turns CRS off, that memory is only released the next time the node restarts nginx (for example on a node upgrade or a service restart).

## Node capabilities

| Capability | Needed for |
| --- | --- |
| `modsecurity-v1` | Any site with CRS on (detect or block) |

While an active node of the cluster lacks `modsecurity-v1`, **Mode** cannot be changed and shows "Some nodes of the site's cluster do not support it yet"; CRS already on can still be turned off. Tenants turning it on through the API get "Cluster nodes need these capabilities first: modsecurity-v1". Platform administrators can publish deliberately; nodes without the capability keep their last-known-good configuration.

## Limits

| Item | Description |
| --- | --- |
| Rules | Only the CRS bundled with the node package runs; custom ModSecurity rules cannot be added |
| Exclusions | Only by rule ID for the whole site; not by path or parameter |
| Statistics | Approximate; each node keeps the 50 most-matched rules per site and minute |
| Nodes | Nodes installed with `--no-modsecurity` do not support CRS |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| **Mode** is unavailable with "Some nodes of the site's cluster do not support it yet" | An active node of the cluster lacks `edgeweir-openresty-modsecurity` or is too old | Install the package on the node or upgrade it |
| **Mode** is unavailable with "The platform does not allow tenants to turn it on" | The platform turned off **Tenants may turn on OWASP CRS** | Contact the platform administrators |
| "The platform does not allow tenants to turn on OWASP CRS" | As above; or a tenant changed running CRS after the platform turned it off | Only setting the mode to **Off** is possible, or ask a platform administrator |
| Legitimate requests get 403 | False positive | Find the rule ID in **Most-matched CRS rules** or the access logs and add it to **Excluded rule IDs**; or lower the paranoia level or raise the threshold |
| The test payload is not blocked | Mode is **Detect only**; the anomaly score stays below the threshold; the rules are excluded; the node has not applied the configuration yet | Check the settings and the node's applied revision |
| "Rule IDs are integers from 900000 to 999999, without duplicates, at most 200" | An ID outside the CRS range, a duplicate, or too many IDs | Correct the input |
