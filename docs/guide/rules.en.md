# Rules, IP lists, and GeoIP

Site rules, global rules, IP lists, and the node-local GeoIP databases.

## Concepts

| Term | Definition |
| --- | --- |
| Rule | An expression plus an action in one phase. Site rules apply to one site; global rules apply to every site in every cluster. |
| Phase | A fixed point in request processing where rules run; there are 8. |
| Expression | A typed, wirefilter-style condition, for example `ip.src in $blocked`. |
| IP list | A named set of IP addresses and CIDRs that expressions reference as `$name`; allow and block lists also apply to every site directly. |

The console parses expressions and checks their fields, types, and actions before publishing a syntax tree; nodes validate the whole configuration and compile the tree. The configuration contains no executable Lua text.

## Edit site rules

1. Open **Sites**, select the site, and open the **Rules** tab.
2. Click **Add rule** next to the target phase.
3. Enter the rule name and **Expression**. When the expression is invalid, "Check character N" appears below the editor.
4. Select **Action** and fill in its fields; turn off **Enabled** as needed.
5. Drag the handle on the left of a rule to reorder rules within a phase.
6. Click **Save**. The console shows **Saved** and publishes a new configuration revision ("Rules and IP lists updated").
7. Verify: for example, the expression `http.request.uri.path eq "/blocked"` with the **Block** action:

   ```bash
   curl -sI -H 'Host: www.example.com' http://<node IP>/blocked
   ```

   The response is 403 with `X-Edgeweir-Error: policy-denied`.

Global rules are edited on the **Global rules** page with the same editor, apply to every site, and are published to every cluster on save. API: `GET` and `PUT /api/v1/platform-rules`.

Disabled rules are not sent to nodes.

## Phases and actions

Phases run in the order of this table.

| Phase | Actions | Effect |
| --- | --- | --- |
| Request transform | Rewrite path, Request header | Rewrites the origin path; sets or removes request headers |
| Redirect | Redirect | Returns 301, 302, 307, or 308 |
| Configuration | Override settings | Overrides cache bypass and HTTPS redirect; turns off Gzip |
| Custom WAF | Block, Log, Allow, Challenge | Block returns 403 or 451; Log only writes a log line; Allow skips the remaining custom WAF rules of the same scope; Challenge makes visitors pass a challenge first |
| Rate limit | Rate limit | Fixed-window counting; over the limit returns 429 or 403 |
| Cache | Override settings | Overrides cache-related settings |
| Origin | Request header | Sets or removes headers sent to the origin |
| Response transform | Response header | Sets or removes response headers based on status and response headers |

### Action fields

| Action | Field | Values | Default |
| --- | --- | --- | --- |
| Block | Status code | 403 / 451 | 403 |
| Challenge | Challenge type | Cookie redirect / JavaScript / Proof of work / Image captcha | JavaScript |
| Redirect | Value | An absolute path on the site (starts with `/`, not `//`), or an `http(s)` URL without credentials or whitespace; up to 4096 characters | `/` |
| Redirect | Status code | 301 / 302 / 307 / 308 | 301 |
| Rewrite path | Value | Starts with `/`, not `//`; no `?`, `#`, or `\` | `/` |
| Request header / Response header | Header name | 1–64 token characters, not a protected header | `x-custom` |
| Request header / Response header | Value | Up to 4096 characters, no control characters | Empty |
| Request header / Response header | Remove header | On / off | Off |
| Override settings | Bypass cache | Unchanged / On / Off | On |
| Override settings | Redirect HTTP to HTTPS | Unchanged / On / Off | Unchanged |
| Override settings | Gzip | Unchanged / Off | Unchanged |
| Rate limit | Requests per window | 1–100000 | 100 |
| Rate limit | Window (seconds) | 1–3600 | 60 |
| Rate limit | Rate limit key | `ip.src`, `http.host`, `tls.ja4`, or `http.request.headers.<name>` (pick **Request header** and enter the name) | `ip.src` |
| Rate limit | Status code | 429 / 403 | 429 |

Protected headers cannot be set or removed by rules: `Host`, `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Trailer`, `CDN-Loop`, and headers starting with `X-Edgeweir-`.

> [!WARNING]
> Static request and response header values are written into the configuration revision and sent to nodes. Do not put API keys or other secrets in them.

### Execution order

| Item | Behavior |
| --- | --- |
| Allow and block lists | Run first. An address in a block list gets 403; an address in an allow list is exempt from the block lists but not from rules; an address in both is allowed |
| Scope | In each phase, global rules run before site rules; within a scope, in list order |
| Terminating actions | Block, redirect, and exceeding a rate limit end the request |
| Allow | Skips only the remaining custom WAF rules of the same scope, not the other scope and not rate limits; a site allow rule cannot bypass a block in the global rules |
| Stacking | Other actions accumulate; a later action overrides an earlier setting |
| Ordering | Dragging changes order only within a phase |

### Action behavior

| Action | Behavior |
| --- | --- |
| Rewrite path | Changes the path sent to the origin; expressions in later phases see the rewritten path; cache rules, the cache key, and purges still use the normalized path before the rewrite |
| Response transform | Applies to cache hits and origin responses |
| Override settings: Gzip off | Removes `Accept-Encoding` towards the origin and bypasses the cache so previously cached compressed responses are not served; rules cannot turn on compression modules that are not built |
| Override settings: Redirect HTTP to HTTPS | Requests get 503 when the site has no certificate |
| Block, rate limit exceeded | Response header `X-Edgeweir-Error: policy-denied`; rate-limited responses also carry `Retry-After` (the window in seconds) |
| Challenge | A request with a pass of a sufficient level continues with the following rules; otherwise it gets the challenge page (non-GET/HEAD requests get 403 with `X-Edgeweir-Challenge: required`). Allow rules skip Under Attack and CC challenges, but a challenge rule that matched before the allow still applies. See [Challenges and CC mitigation](challenges.en.md) |
| Log | Does not change the response. Each rule writes at most one NOTICE-level nginx error log line per node per 60 seconds, containing the site ID and rule ID; nginx appends the client IP, request line, and Host to log lines written during a request |

### Rate limiting

| Item | Behavior |
| --- | --- |
| Scope | A fixed window per node, not a network-wide quota; each site counts separately, and rate limits in the global rules are also counted per site |
| Key | Request header key values are counted by their MD5 digest |
| Memory | A fixed 256 KiB shared memory partition per published site, never borrowed across sites; at most 512 published sites per cluster (128 MiB in total); log deduplication uses another 1 MiB |
| Out of memory | When a site's partition cannot create a counter, that site's rate-limited requests get 503; the limit is not relaxed |
| Reload and restart | Counters survive an nginx reload; they reset when the node restarts or when a site is removed and added back |
| Hot updates | Rule and list changes for the same set of sites do not reload; adding or removing sites reloads, and existing partitions keep their names and sizes |

## Expressions

```text
ip.src in $blocked
http.request.uri.path matches "^/(admin|private)/" and not ssl eq true
http.request.method in {"POST" "PUT"}
http.request.headers["x-region"] eq "nz"
ip.geoip.country eq "NZ" and ip.geoip.asnum in {64512 64513}
http.response.code ge 500
```

### Fields

| Field | Type | Value |
| --- | --- | --- |
| `http.host` | String | The request Host |
| `http.request.method` | String | The request method |
| `http.request.uri.path` | String | The path after nginx normalization |
| `http.request.uri.query` | String | The query string without `?` |
| `http.request.uri` | String | The raw request URI (path plus query) |
| `http.request.headers["name"]` | String | Case-insensitive name; multiple values joined with `, ` |
| `http.response.code` | Integer | Response status; response transform phase only |
| `http.response.headers["name"]` | String | Response header; response transform phase only |
| `ip.src` | IP | The TCP client address; with the PROXY protocol on the listener, the address the load balancer passed |
| `ssl` | Boolean | `true` for HTTPS requests |
| `ip.geoip.country` | String | ISO country code; empty string without a record |
| `ip.geoip.subdivision` | String | First-level subdivision code from the City MMDB, or its English name when it has no code; empty string without a record or when the City MMDB's country differs from `ip.geoip.country` |
| `ip.geoip.asnum` | Integer | ASN; 0 without a record |
| `tls.ja4` | String | JA4 TLS client fingerprint of the connection; empty string over plain HTTP, see [JA4](challenges.en.md#ja4) |

### Operators and literals

| Syntax | Types | Description |
| --- | --- | --- |
| `eq`, `ne` | All | IP values compare by address or CIDR containment |
| `lt`, `le`, `gt`, `ge` | Integer | Ordered comparison |
| `contains` | String | Substring match |
| `matches` | String | Regular expression match |
| `in {…}` | All | Set, elements separated by whitespace |
| `in $name` | IP | References an IP list |
| `not`, `and`, `or`, `( )` | — | Precedence `not` → `and` → `or` |
| Literals | — | Strings in double quotes (JSON escapes); integers; `true` / `false`; IPs and CIDRs unquoted; a bare `true` is a valid expression |

### IP semantics

| Item | Behavior |
| --- | --- |
| IPv4-mapped addresses | `::ffff:a.b.c.d` equals the IPv4 address; mapped CIDRs with a prefix shorter than 96 bits are ambiguous and refused |
| NAT64 | A distinct IPv6 address, not equal to IPv4 |
| CIDR | Host bits are cleared before saving |
| Refused | Leading zeros (octal ambiguity) and zone IDs (`%`) |

### Regular expressions

Console validation, node validation and node execution (PCRE) accept the same subset; constructs whose meaning differs between the engines are refused.

| Item | Rule |
| --- | --- |
| Subject | The value's UTF-8 bytes, case-sensitive; `.`, `[^…]`, `\D`, `\W` match one byte (a CJK character is 3 bytes) |
| Length and characters | Up to 256 printable ASCII characters; write others as `\t` `\n` `\r` `\f` or `\x00`–`\x7f` |
| Anchors | `^` start of the value; `$` end of the value; `\b` `\B` ASCII word boundary |
| Characters | `.` is any byte except `\n`; `\d` `\D` `\w` `\W` are ASCII; a backslash before ASCII punctuation matches that character; escape literal `]` `{` `}` |
| Classes | `[…]` `[^…]` of characters, `\d` `\D` `\w` `\W` and ranges such as `a-z`; `-` is literal only first or last, elsewhere `\-`; escape `[` inside a class |
| Quantifiers | `*` `+` `?` `{n}` `{n,}` `{n,m}` (n ≤ m ≤ 1000, no leading zeros), optionally lazy with `?`; only after a character, class or escape |
| Groups | `( )` and `\|`; groups take no quantifier |
| Unsupported | `\s` `\S` `\v` (write an explicit class such as `[ \t\r\n\f]`), `\xHH` above `\x7f`, `\z` `\A` `\Q` `\p{…}` `\K` and other escapes, backreferences and octal, groups starting with `(?`, possessive and stacked quantifiers, `{,n}`, `[[:alpha:]]`, empty classes and `[]…]` |
| Execution budget | Nodes use PCRE with a match limit of 10000 and a depth limit of 100; an execution error returns 503 (`X-Edgeweir-Error: policy-unavailable`) |

A saved rule that uses a construct no longer supported (such as `\s`) fails to save or publish with `RULE_INVALID`; rewrite it and save again.

The language is a wirefilter-style subset, not a complete wirefilter implementation.

### Complexity limits

| Item | Limit |
| --- | --- |
| Expression length | 4096 characters |
| Tokens | 512 |
| Nesting | 16 levels |
| Basic conditions | 128 |
| Set elements | 256 |
| Rules | 64 per site; 32 global rules |

## IP lists

1. Open **IP lists** and click **Create list**.
2. Enter **Name**: starts with a letter or underscore, contains only letters, digits, and underscores, 1–64 characters.
3. Select **Action**: **Referenced by rules**, **Block**, or **Allow**.
4. Enter entries in **IP addresses and CIDRs**, separated by newlines, spaces, or commas.
5. Click **Save**.
6. Verify: the list shows `$name` and "N entries", block and allow lists also a **Block** or **Allow** badge; reference it in rules with `ip.src in $name`.

| Action | Effect |
| --- | --- |
| Referenced by rules | Only a set for rules to reference |
| Block | A block list: applies to every site of every cluster without a rule; matching addresses get 403 before any rule runs |
| Allow | An allow list: applies to every site of every cluster; matching addresses are exempt from block lists and bans, but not from rules |

| Item | Behavior |
| --- | --- |
| Name | All lists share one namespace and names are unique; a name cannot change after creation; saving rules binds names to list IDs |
| References | Any site rule or global rule can reference any list, block and allow lists included |
| Changes | Entries and **Action** can change at any time; creating, changing, or deleting a list publishes a new revision to every cluster ("Rules and IP lists updated"); nodes apply it without reload |
| Deletion | A list referenced by a rule cannot be deleted ("IP list is used by a rule") |
| Entries | IPv4 / IPv6 addresses or CIDRs; host bits cleared, deduplicated, sorted; leading zeros and zone IDs refused |
| Quota | Up to 128 lists and 50,000 entries in total; up to 10,000 entries per list; a change that does not add entries always saves |
| Rollback | Site configuration rollbacks keep the current lists and global rules; a rollback that references a deleted list is refused |

API: `GET` and `POST /api/v1/ip-lists`, `PUT` and `DELETE /api/v1/ip-lists/{id}`.

## Node capabilities and publishing

| Item | Behavior |
| --- | --- |
| Capabilities | Rules and block/allow lists need the node capability `rules-v1`; `ip.geoip.country` and `ip.geoip.subdivision` need `geoip-city-v1`; `ip.geoip.asnum` needs `geoip-asn-v1`; the challenge action needs `challenge-v1`; `tls.ja4` (field or rate limit key) needs `ja4-v1`; when `ip.geoip.subdivision` is used, the console also checks `geoip-subdivision-v1` (not written into the configuration) |
| Console and AccessKeys | A save is published even when an active node of the cluster lacks a required capability; such nodes keep their last-known-good configuration and **Clusters & nodes** shows **Upgrade required**, see [Node upgrades](node-upgrades.en.md) |
| Service accounts and background jobs | When a configuration they publish introduces a new capability, every active node of the cluster is checked, including temporarily offline ones; if any lacks it, the publish is refused (`NODE_CAPABILITY_REQUIRED`, "Cluster nodes need these capabilities first: …") and the configuration and revision stay unchanged |
| Unknown capabilities | Nodes reject configurations with unknown capabilities or enum values and keep last-known-good |

## Configure GeoIP databases

GeoIP fields read MMDB files on the node. Nodes download no updates and send no visitor addresses to data vendors.

| Database | Fields | Source | License and updates | Attribution |
| --- | --- | --- | --- | --- |
| [IPinfo Lite](https://ipinfo.io/lite) | Country, ASN | Bundled in node release images; package and archive nodes download it from IPinfo (free account) | CC BY-SA 4.0; IPinfo updates daily, images carry a snapshot from their build day | IP address data is powered by [IPinfo](https://ipinfo.io) |
| City MMDB, e.g. [DB-IP Lite](https://db-ip.com/db/lite.php) City | Country, first-level subdivision | Downloaded by the operator | DB-IP Lite: CC BY 4.0, monthly updates | [IP Geolocation by DB-IP](https://db-ip.com) |
| ASN MMDB, e.g. DB-IP Lite ASN | ASN | Downloaded by the operator | Same as above | Same as above |

| Item | Behavior |
| --- | --- |
| Precedence | Country and ASN come from IPinfo Lite first, then from the City / ASN MMDB when IPinfo has no record |
| Subdivision | Comes only from the City MMDB, and only when the City MMDB's country matches the final country |
| Bundled data | `/usr/share/edgeweir-node/geoip/ipinfo_lite.mmdb`, checked at build time against the sha256 IPinfo publishes; `NOTICE` in the same directory records the download time and sha256 |
| Console attribution | **System → GeoIP databases** carries the IPinfo attribution link |

1. Container nodes running a release image need no configuration for country and ASN; for newer data, pull a newer image, or mount a separately downloaded copy and set `EDGEWEIR_GEOIP_IPINFO`.
2. Package or archive nodes: download `ipinfo_lite.mmdb` from IPinfo. To match on subdivisions, also download a City MMDB. Check source, license, and integrity, and record the download date.
3. Put the files in a read-only directory the node can read, and set the node environment variables:

   ```bash title="/etc/default/edgeweir-node"
   EDGEWEIR_GEOIP_IPINFO=/etc/edgeweir-node/geoip/ipinfo_lite.mmdb
   EDGEWEIR_GEOIP_CITY=/etc/edgeweir-node/geoip/dbip-city-lite.mmdb
   ```

   For container deployments, mount the directory and pass the same variables with `-e`.
4. Restart the node to load the databases:

   ```bash
   sudo systemctl restart edgeweir-node
   ```

5. Verify: **System → GeoIP databases** shows "Country: Ready" and "ASN: Ready" for the node, plus "Subdivision: Ready" when a City MMDB is configured.

| Variable | Flag | Default | Description |
| --- | --- | --- | --- |
| `EDGEWEIR_GEOIP_IPINFO` | `--geoip-ipinfo` | `auto` | IPinfo Lite MMDB path; `auto` uses the database bundled in the image when present, `off` disables it |
| `EDGEWEIR_GEOIP_CITY` | `--geoip-city` | Empty | City MMDB path |
| `EDGEWEIR_GEOIP_ASN` | `--geoip-asn` | Empty | ASN MMDB path |

| Item | Behavior |
| --- | --- |
| Capability reporting | A node with country data (IPinfo Lite or a City MMDB) reports `geoip-city-v1`, one with a City MMDB reports `geoip-subdivision-v1`, one with ASN data reports `geoip-asn-v1`; current nodes also report `geoip-country-v1` |
| Older nodes | A node that does not report `geoip-country-v1` reports `geoip-city-v1` only with a City MMDB, and the console treats it as having `geoip-subdivision-v1` |
| Missing capability | A node rejects configurations that use GeoIP fields it lacks and keeps last-known-good |
| Invalid file | The node agent does not start when a configured MMDB file is invalid or of the wrong database type; an invalid bundled IPinfo Lite database is logged and left unused |
| Lookups | The agent reads the files and serves results to Lua workers over a local Unix socket with mode 0600; each worker caches up to 10,000 results for 5 minutes; a lookup times out after 200 milliseconds |
| Lookup failure | When site rules or global rules use GeoIP fields, every request of that site needs a lookup; while the service is unavailable, those requests get 503 |
| Updates | Replace the file or image on one node, restart, and verify before updating the others; never overwrite an MMDB file in use |

## Limits

| Item | Description |
| --- | --- |
| Rate limiting | Per-node fixed windows only; no network-wide quota and no sliding window |
| Expressions | A wirefilter-style subset; no custom functions, string transformations, or raw Lua |
| Protected headers | See [Action fields](#action-fields); rules cannot change them |
| Compression | Override settings can only turn Gzip off; they cannot turn on modules that are not built |
| GeoIP data | The bundled IPinfo Lite database is a snapshot from the image build day; subdivisions need an operator-provided City MMDB; accuracy depends on the chosen database |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "Check character N" below the editor | Unsupported syntax, field, type, or regular expression at that position | Fix it using the syntax tables above |
| Saving shows "Invalid rule" | The action does not belong to the phase, a protected header, or an invalid redirect target or rewrite path | Fix it using the action field table |
| "IP list not found" | The referenced list does not exist | Create the list in **IP lists** first, or fix the name |
| "IP list name already exists" | A list with that name exists | Use another name |
| "IP list is used by a rule" | Deleting a list still referenced by a rule | Remove the reference from the rules first |
| "IP list limit reached (128 lists, 50,000 entries)" | Over quota | Merge or delete lists |
| A node shows **Upgrade required** | The node lacks a capability the rules need (`rules-v1`, a GeoIP capability, and so on) and keeps its last-known-good configuration | Upgrade the node or configure the GeoIP databases |
| 503 with `X-Edgeweir-Error: policy-unavailable` | A regular expression exceeded its budget, or a GeoIP lookup failed | Simplify the pattern; check the node's GeoIP service |
| A rule that redirects HTTP to HTTPS makes requests return 503 | The site has no certificate | Select a certificate on the **HTTPS** tab |
| Rate limits are not shared across nodes | Rate limits count per node | Scale the threshold by the number of nodes |
