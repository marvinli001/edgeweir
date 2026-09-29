# Rules, IP lists, and GeoIP

Expression rules for sites and the platform, IP lists, and the node-local GeoIP databases.

## Concepts

| Term | Definition |
| --- | --- |
| Rule | An expression plus an action in one phase. Site rules apply to one site; platform rules apply to every site in every cluster. |
| Phase | A fixed point in request processing where rules run; there are 8. |
| Expression | A typed, wirefilter-style condition, for example `ip.src in $blocked`. |
| IP list | A named set of IP addresses and CIDRs that expressions reference as `$name`. |
| Platform IP list | A list maintained by platform administrators, used as a set for rules, a block list, or an allow list. |

The console parses expressions and checks their fields, types, and actions before publishing a syntax tree; nodes validate the whole configuration and compile the tree. Nodes never run Lua text supplied by tenants.

## Edit site rules

1. Open **Console → Sites**, select the site, and open the **Rules** tab.
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

Platform rules are edited in **Admin → Platform rules** with the same editor and are published to every cluster on save. Platform administrators only.

Disabled rules are not sent to nodes.

## Phases and actions

Phases run in the order of this table.

| Phase | Actions | Effect |
| --- | --- | --- |
| Request transform | Rewrite path, Request header | Rewrites the origin path; sets or removes request headers |
| Redirect | Redirect | Returns 301, 302, 307, or 308 |
| Configuration | Override settings | Overrides cache bypass and HTTPS redirect; turns off Gzip |
| Custom WAF | Block, Log, Allow | Block returns 403 or 451; Log only writes a log line; Allow skips the remaining custom WAF rules of the same scope |
| Rate limit | Rate limit | Fixed-window counting; over the limit returns 429 or 403 |
| Cache | Override settings | Overrides cache-related settings |
| Origin | Request header | Sets or removes headers sent to the origin |
| Response transform | Response header | Sets or removes response headers based on status and response headers |

### Action fields

| Action | Field | Values | Default |
| --- | --- | --- | --- |
| Block | Status code | 403 / 451 | 403 |
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
| Rate limit | Rate limit key | `ip.src`, `http.host`, or `http.request.headers.<name>` | `ip.src` |
| Rate limit | Status code | 429 / 403 | 429 |

Protected headers cannot be set or removed by rules: `Host`, `Authorization`, `Proxy-Authorization`, `Cookie`, `Set-Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Upgrade`, `TE`, `Trailer`, `CDN-Loop`, and headers starting with `X-Edgeweir-`.

> [!WARNING]
> Static request and response header values are written into the configuration revision and sent to nodes. Do not put API keys or other secrets in them.

### Execution order

| Item | Behavior |
| --- | --- |
| Platform IP lists | Run first. An address in a platform block list gets 403; an address in a platform allow list is exempt from the platform block lists but not from rules; an address in both is allowed |
| Scope | In each phase, platform rules run before site rules; within a scope, in list order |
| Terminating actions | Block, redirect, and exceeding a rate limit end the request |
| Allow | Skips only the remaining custom WAF rules of the same scope, not the other scope and not rate limits; a site allow rule cannot bypass a platform block rule |
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
| Log | Does not change the response. Each rule writes at most one NOTICE-level nginx error log line per node per 60 seconds, containing the site ID and rule ID; nginx appends the client IP, request line, and Host to log lines written during a request |

### Rate limiting

| Item | Behavior |
| --- | --- |
| Scope | A fixed window per node, not a network-wide quota; each site counts separately, and platform rate-limit rules are also counted per site |
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
| `ip.geoip.subdivision` | String | First-level subdivision code from the database; DB-IP's English name when it has no code |
| `ip.geoip.asnum` | Integer | ASN; 0 without a record |

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

| Item | Limit |
| --- | --- |
| Length and characters | Up to 256 printable ASCII characters |
| Unsupported | Backreferences, groups starting with `(?` (lookaround, named groups, inline flags), `\p` `\P` `\k` `\K` `\g` `\G`, quantified groups, nested quantifiers, empty character classes |
| Repetition | Numbers in `{m,n}` up to 1000; a literal `}` must be escaped |
| Execution budget | Nodes use PCRE with a match limit of 10000 and a depth limit of 100; an execution error returns 503 (`X-Edgeweir-Error: policy-unavailable`) |

The language is a wirefilter-style subset, not a complete wirefilter implementation.

### Complexity limits

| Item | Limit |
| --- | --- |
| Expression length | 4096 characters |
| Tokens | 512 |
| Nesting | 16 levels |
| Basic conditions | 128 |
| Set elements | 256 |
| Rules | 64 per site; 32 for the platform |

## IP lists

1. Open **Console → IP lists** and click **Create list**.
2. Enter **Name**: starts with a letter or underscore, contains only letters, digits, and underscores, 1–64 characters.
3. Enter entries in **IP addresses and CIDRs**, separated by newlines, spaces, or commas.
4. Click **Save**.
5. Verify: the list shows `$name` and "N entries"; reference it in rules with `ip.src in $name`.

Platform IP lists are maintained in **Admin → Platform IP lists**, platform administrators only. The **Action** of a platform list:

| Action | Effect |
| --- | --- |
| Referenced by rules | Only a set for platform rules |
| Block | Matching addresses get 403 before any rule runs |
| Allow | Matching addresses are exempt from platform block lists |

| Item | Behavior |
| --- | --- |
| Name | Cannot change after creation; saving rules binds names to list IDs |
| Same name | An organization list shadows a platform list of the same name |
| Visibility | Organization lists can be referenced only by rules of that organization's sites; platform rules can reference only platform lists |
| Changes | Changing entries publishes a new revision; nodes apply it without reload |
| Deletion | A list referenced by a rule cannot be deleted ("IP list is used by a rule") |
| Entries | IPv4 / IPv6 addresses or CIDRs; host bits cleared, deduplicated, sorted; leading zeros and zone IDs refused |
| Quota | Each organization and the platform: up to 128 lists and 50,000 entries in total; up to 10,000 entries per list |
| Rollback | Site configuration rollbacks keep the current lists and platform rules; a rollback that references a deleted list is refused |

## Node capabilities and publishing

| Item | Behavior |
| --- | --- |
| Capabilities | Rules and platform block/allow lists need the node capability `rules-v1`; `ip.geoip.country` and `ip.geoip.subdivision` need `geoip-city-v1`; `ip.geoip.asnum` needs `geoip-asn-v1` |
| Tenant publishing | When a tenant save or an automatic background publish introduces a new capability, every active node of the cluster is checked, including temporarily offline ones; if any lacks it, the save is refused ("Cluster nodes need these capabilities first: …") and the rules and revision stay unchanged |
| Platform administrators | Can deliberately publish a configuration that needs an upgrade; nodes lacking the capability keep their last-known-good configuration and the admin area shows **Upgrade required**, see [Node upgrades](node-upgrades.en.md) |
| Unknown capabilities | Nodes reject configurations with unknown capabilities or enum values and keep last-known-good |

## Configure GeoIP databases

GeoIP fields read MMDB files on the node. The default choice is the [DB-IP Lite](https://db-ip.com/db/lite.php) City and ASN databases: CC BY 4.0 license, monthly updates, less precise than commercial databases. Pages that use the data keep the [IP Geolocation by DB-IP](https://db-ip.com) attribution. The project bundles no IP data, downloads no updates, and sends no visitor addresses to the data vendor.

1. Download and unpack the City Lite and ASN Lite MMDB files from DB-IP; check source, license, and integrity, and record the download month.
2. Put the files in a read-only directory the node can read, and set the node environment variables (or the flags `--geoip-city` and `--geoip-asn`):

   ```bash title="/etc/default/edgeweir-node"
   EDGEWEIR_GEOIP_CITY=/etc/edgeweir-node/geoip/dbip-city-lite.mmdb
   EDGEWEIR_GEOIP_ASN=/etc/edgeweir-node/geoip/dbip-asn-lite.mmdb
   ```

   For container deployments, mount the directory and pass the same variables with `-e`.
3. Restart the node to load the databases:

   ```bash
   sudo systemctl restart edgeweir-node
   ```

4. Verify: **Admin → System → GeoIP databases** shows "Country / subdivision: Ready" and "ASN: Ready" for the node.

| Item | Behavior |
| --- | --- |
| Capability reporting | A node with a City database reports `geoip-city-v1`, one with an ASN database reports `geoip-asn-v1`; a node lacking a capability rejects configurations that use its fields and keeps last-known-good |
| Invalid file | The node agent does not start with an invalid MMDB file |
| Lookups | The agent reads the files and serves results to Lua workers over a local Unix socket with mode 0600; each worker caches up to 10,000 results for 5 minutes; a lookup times out after 200 milliseconds |
| Lookup failure | When site or platform rules use GeoIP fields, every request of that site needs a lookup; while the service is unavailable, those requests get 503 |
| Updates | Replace the file on one node, restart, and verify before updating the others; never overwrite an MMDB file in use |

## Limits

| Item | Description |
| --- | --- |
| Rate limiting | Per-node fixed windows only; no network-wide quota and no sliding window |
| Expressions | A wirefilter-style subset; no custom functions, string transformations, or raw Lua |
| Protected headers | See [Action fields](#action-fields); rules cannot change them |
| Compression | Override settings can only turn Gzip off; they cannot turn on modules that are not built |
| GeoIP data | The operator downloads and updates the databases; accuracy depends on the chosen database |

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| "Check character N" below the editor | Unsupported syntax, field, type, or regular expression at that position | Fix it using the syntax tables above |
| Saving shows "Invalid rule" | The action does not belong to the phase, a protected header, or an invalid redirect target or rewrite path | Fix it using the action field table |
| "IP list not found" | The referenced list does not exist or is not visible to the site | Create the list or check its organization |
| "IP list name already exists" | The organization or platform already has a list with that name | Use another name |
| "IP list is used by a rule" | Deleting a list still referenced by a rule | Remove the reference from the rules first |
| "IP list limit reached (128 lists, 50,000 entries)" | Over quota | Merge or delete lists |
| "Cluster nodes need these capabilities first: …" | An active node of the cluster lacks `rules-v1` or a GeoIP capability | Upgrade the nodes or configure the GeoIP databases |
| 503 with `X-Edgeweir-Error: policy-unavailable` | A regular expression exceeded its budget, or a GeoIP lookup failed | Simplify the pattern; check the node's GeoIP service |
| A rule that redirects HTTP to HTTPS makes requests return 503 | The site has no certificate | Select a certificate on the **HTTPS** tab |
| Rate limits are not shared across nodes | Rate limits count per node | Scale the threshold by the number of nodes |
