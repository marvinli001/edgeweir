# Access control

Access authentication of a site (Basic authentication, forward authentication, signed URLs of kinds A–D), its access control (site lists, geo, CORS, hotlink protection, user agents, WebSocket origins, security response headers) and the IP check. All of them run before the rules and the cache, and apply to cache hits too.

## Concepts

| Term | Definition |
| --- | --- |
| Authentication rule | One access authentication setting of a site: kind, scope and the kind's settings. At most 16 per site, matched in order. |
| Scope | Which requests a rule checks: domains, path prefixes, extensions and excluded path prefixes; all empty means every request. |
| Basic authentication | The browser asks for a user name and password (RFC 7617). |
| Forward authentication | The node sends some of the request's headers to an authentication service and lets the request through or refuses it by the answer. |
| Signed URL | The link carries a timestamp and a signature that the node checks with a key, with a validity; typical for paid or time-limited downloads and videos. |
| Signature | A lowercase hexadecimal `md5` digest (32 characters) of the path, the timestamp and the key. |
| Site lists | IP lists a site chooses: addresses on its block lists get 403 on that site; addresses on its allow lists skip some of its checks. |
| Access control | The settings of the sections "Site lists" to "Security headers" below, each with its own switch and Save. |

## Add a rule

1. Open **Sites → (site) → Access control**.
2. Click "Add rule", choose the "Type", fill in the scope and the kind's settings as below, then click "Done".
3. Order the rules with move up and move down; turn rules on and off with their switch.
4. Click "Save". The console publishes a configuration revision (reason "Access authentication of {site} updated"); nodes hot-update without an nginx reload.

While an active node of the cluster lacks the capability `access-auth-v1`, the tab shows "Some nodes of the site's cluster do not support it yet" and no rule can be added; saved rules can still be changed or removed.

## Scope and selection

| Field | Values | Match |
| --- | --- | --- |
| Domains | Any of the site's domains; none means all | Each domain matches the request's Host as written: `a.com` exactly, `*.a.com` one label, `.a.com` any subdomain, `~pattern` the whole host |
| Path prefixes | One per line, starting with `/`, at most 32, each ≤ 1024 bytes | The path starts with one of them; empty means any |
| Extensions | Separated by commas or spaces, at most 64, 1–16 lowercase letters or digits, no dot | The last path segment's extension (as the rule field `http.request.uri.path.extension`, lowercase); empty means any |
| Excluded path prefixes | As path prefixes | Paths starting with one of them are not checked |

- The path is nginx's normalized path (percent-decoded, as the rule field `http.request.uri.path`). Signed URLs of kinds B and C are matched by the path without their two signature segments.
- **The first enabled rule whose scope the request matches decides**; later rules are not looked at. Disabled rules are not sent to nodes.
- Domains removed from the site disappear from scopes; when that removes all of a scope's domains, the rule covers every domain of the site (more requests are authenticated, never fewer).

## Order

| Order | Step |
| --- | --- |
| 1 | The probes' health endpoint, CDN-Loop, the node certificates' HTTP-01, the site by Host, SNI check, client certificates, dynamic bans (global bans always; site bans not for addresses on the site's allow lists), the PURGE method |
| 2 | The authentication rule is chosen; signed URLs are parsed and **their signature removed** (maintenance, CC, the rules, the cache key, purges and the origin then see the URI without it) |
| 3 | Maintenance, CC counting, the reserved prefix `/.edgeweir/` |
| 4 | The global allow and block lists |
| 5 | [Site block lists](#site-lists) |
| 6 | [Geo access](#geo-access) |
| 7 | [CORS](#cors) preflights answered (before authentication: browsers send preflights without credentials) |
| 8 | [Hotlink protection](#hotlink-protection) |
| 9 | [User agents](#user-agents) |
| 10 | **Authentication**: a plain HTTP request the site's Force HTTPS redirects is redirected first (with its URL and signature), so credentials never travel unencrypted; then the kind's check |
| 11 | Rule phases, CC bans of single clients, Under Attack and CC challenges, [WebSocket origins](#websocket-origins-and-idle-timeout), cache lookup and the origin |
| 12 | Responses: [CORS](#cors) headers, [security headers](#security-headers), then the rules of the response-transform and compression phases (rules may change or remove both) |

ACME HTTP-01 requests, the reserved prefix `/.edgeweir/` and the node's local prefetch requests are not authenticated (a prefetched signed URL loses its signature too and fills the same cached object), and skip steps 5–9 and the WebSocket origin check; their responses get the headers as usual. Config rules that override Force HTTPS run after authentication, so they do not apply to requests a rule checks.

## Basic authentication

| Field | Values | Default |
| --- | --- | --- |
| Realm | 1–64 characters without `"`, `\` or control characters; sent in `WWW-Authenticate` | The site's name |
| Users | 1–100. User names 1–64 printable ASCII characters without `:`; passwords 8–128 characters | One |
| Keep Authorization towards the origin | On / off | Off (removed) |
| Send X-Auth-User to the origin | On / off; when on it always replaces the visitor's own header of that name | Off |

| Item | Behavior |
| --- | --- |
| Passwords | Only salted hashes are stored: PBKDF2-HMAC-SHA256, 16-byte random salt, 10000 iterations, envelope-encrypted, delivered over the node channel; the UI and the API return user names only, and password fields show "Saved; leave empty to keep it" |
| Changes | An existing user's empty password keeps it; new and renamed users need a password |
| Refusal | 401, `WWW-Authenticate: Basic realm="…", charset="UTF-8"`, `X-Edgeweir-Error: auth-required`, with the site's 401 page (else its "Other 4xx" page, else the built-in page). A 401 page set to redirect or to another status does not apply to Basic (browsers ask for credentials on a 401 only) |
| Allowed | By default `Authorization` is removed from the request to the origin and the request is cached as usual; when kept, the usual rule applies: requests with `Authorization` are cached only when a cache rule allows it |
| Node caches | Results are kept per worker: successes 60 s, failures 10 s, by the hash of the `Authorization` value and the secret's version; changing a password or removing a user ends old results at once |
| Failure limit | The 11th and later failed verification of one client network (an IPv4 address or an IPv6 /64) on one site within 10 seconds answers 429 (`auth-rate-limited`, with `Retry-After`) without hashing |

Check:

```bash
curl -sI -H 'Host: www.example.com' http://<node IP>/admin/
curl -sI -u alice:<password> -H 'Host: www.example.com' http://<node IP>/admin/
```

The first answers 401 with `WWW-Authenticate`, the second 200.

## Forward authentication

| Field | Values | Default |
| --- | --- | --- |
| Authentication URL | An `http://` or `https://` URL, ≤ 2048 characters, host name or IP, no user information or fragment | — |
| Method | GET / HEAD | GET |
| Timeout (s) | 0.1–10 | 5 |
| Forwarded request headers | The visitor's header names, comma-separated, at most 16; not `Host`, hop-by-hop headers or the five headers the node sets | `authorization, cookie` |
| Response headers copied to the origin | Header names of the service's answer, at most 8; not protected headers (as in header rules) | Empty |
| Cache answers (s) | 0 (off)–300 | 0 |
| Pass redirects on | On / off | Off |
| Allow when the service fails | On / off | Off |

The request the node sends to the service:

| Item | Content |
| --- | --- |
| Path | Through the node's origin layer: the origin address policy (special-purpose addresses outside the [origin allow list](system.en.md#origin-allow-list) are refused), DNS resolution and TLS certificate verification as for origins |
| Headers | The visitor's headers on the forwarded list, and `X-Original-URI` (the visitor's original request URI, signature and query included), `X-Original-Method`, `X-Original-Host`, `X-Real-IP` (the visitor's IP, as `ip.src`) and `X-Forwarded-For` (as towards origins); no other header |
| Body | None |

| Answer | What the node does |
| --- | --- |
| 2xx | Lets the request through; the copied response headers the answer carries are set on the request to the origin, the ones it lacks are removed from it (visitors cannot send their own) |
| 401, 403 | Passed on: status, `WWW-Authenticate`, `Content-Type` and body (the site's error page when the body is over 64 KiB), `Cache-Control: no-store`, `X-Edgeweir-Error: auth-denied` |
| 3xx | With "Pass redirects on": status and `Location` (login redirects); otherwise a refusal |
| Other 4xx | 403 (error page, `auth-denied`) |
| 5xx, connection failures, timeouts, refused addresses | The service is unavailable: 503 (error page, `auth-unavailable`); with "Allow when the service fails" the request continues without authentication. At most one NOTICE nginx error log line per rule and node every 60 seconds (site ID, rule ID and status) |

> [!WARNING]
> Cached answers are keyed by the forwarded request headers (names and values) only, not by path or visitor IP. Do not cache answers when the service decides by path or IP. Only 2xx, 401 and 403 answers are cached.

## Signed URLs A–D

| Kind | URL | Signature |
| --- | --- | --- |
| A | `path?sign=timestamp-rand-signature` | `md5(path@timestamp@rand@key)` |
| B | `/timestamp/signature/path` | `md5(path@timestamp@key)` |
| C | `/signature/timestamp/path` | `md5(path@timestamp@key)` |
| D | `path?sign=signature&t=timestamp` | `md5(path@timestamp@key)` |

| Field | Values | Default |
| --- | --- | --- |
| Primary key | 16–128 printable ASCII characters (no spaces); "Generate" makes 32 letters and digits in the browser | — |
| Backup key | As the primary key; both are accepted while rotating | None |
| Validity (s) | 1–31536000 | 1800 |
| Clock skew allowed (s) | 0–600 | 300 |
| Signature parameter (A, D) | 1–32 letters, digits, `_` or `-` | `sign` |
| Time parameter (D) | As above, not the signature parameter | `t` |

| Item | Behavior |
| --- | --- |
| Path | The visitor's raw path: the request line's part before `?`, percent-encoding as sent; for B and C the part after the two segments (it must start with `/`) |
| Timestamp | Decimal Unix seconds (1–12 digits); valid from `timestamp − skew` to `timestamp + validity + skew` |
| Signature, rand | The signature is 32 lowercase hexadecimal characters; rand (A) 1–64 letters or digits |
| Parameters | The first of several parameters of one name counts; all of them are removed; values are not decoded |
| Comparison | Both keys are computed and compared with the signature in constant time |
| Removal | A and D lose their signature parameters (other parameters keep their order); B and C their two segments. The cache key, purges, rules and the origin see the URI without the signature, so different signatures of one object share its cached copy |
| B and C normalization | nginx's normalized path must start with the same two segments (`/1661824870/<signature>/a/../b` normalizes to `/1661824870/<signature>/b`, `/b` once removed); otherwise there is no signature |
| Refusal | 403 with the site's error page: a missing, malformed or wrong signature is `auth-denied`, an expired one or a timestamp ahead `auth-expired` |
| Keys | Envelope-encrypted, delivered over the node channel; the UI and the API only tell whether a key is set. A generated key shows once in the dialog: copy it before saving |

Example: key `123456`, timestamp `1661824870`, rand `c6d1a57067b21f7b`, path `/images/test.jpg`:

```text
A  /images/test.jpg?sign=1661824870-c6d1a57067b21f7b-0baac47b6c2ad519bb1bfe7babff37a3
B  /1661824870/64bf8671521f2a61a3b64691fde82729/images/test.jpg
C  /64bf8671521f2a61a3b64691fde82729/1661824870/images/test.jpg
D  /images/test.jpg?sign=64bf8671521f2a61a3b64691fde82729&t=1661824870
```

Signing in your own application (D):

```bash
ts=$(date +%s); path=/images/test.jpg
sign=$(printf '%s@%s@%s' "$path" "$ts" "$KEY" | openssl md5 | awk '{print $NF}')
echo "https://www.example.com${path}?sign=${sign}&t=${ts}"
```

### Sign a URL in the console

1. Click the link icon "Sign a URL" next to a signed URL rule (save pending changes first).
2. Enter a path (starting with `/`) or an `http(s)` URL of one of the site's domains, and how long it stays valid (1 second up to the rule's validity, the rule's validity by default).
3. Click "Sign". The console computes the signed URL with the rule's primary key and shows it with its expiry; nothing is stored or sent to nodes. For a link that expires after P seconds the console takes the timestamp `now − (the rule's validity − P)`.

Each signed URL is audited as `site.auth_sign_url` (rule, path and expiry, never the signature).

## Site lists

1. Create the lists under **IP lists** first (any action, see [IP lists](rules.en.md#ip-lists)).
2. Open **Sites → (site) → Access control**, tick "Site block lists" and "Site allow lists" (at most 16 each; a list ticked on one side cannot be ticked on the other) on the "Site lists" card and click "Save".

| Item | Behavior |
| --- | --- |
| Site block lists | A client address (`ip.src`) on any of them gets 403 (`X-Edgeweir-Error: ip-blocked`) on this site only; addresses on a global allow list or on the site's allow lists excepted |
| Site allow lists | Skip the site's block lists, the site's bans (CC bans of single clients included), geo, hotlink protection, user agents, and Under Attack and CC challenges |
| Not skipped | Global block lists, global bans, CORS, WebSocket origins, authentication, rules and maintenance |
| One list | Cannot be both a site block and allow list ("A list cannot be both a site block and allow list: …") |
| List changes | When a list's entries change, every site that chose it follows |
| Deleting a list | A list a site chose cannot be deleted: "The IP list is used by …" names the site |

## Geo access

Turn on "Enabled" on the "Geo access" card, choose the mode ("Deny listed" or "Allow listed only"), fill in the lists (countries and ASNs comma-separated, subdivisions and path prefixes one per line) and click "Save".

| Field | Values | Default |
| --- | --- | --- |
| Mode | Deny: clients matching the lists get 403; Allow only: clients not matching them get 403 | Deny |
| Countries (ISO codes) | ISO 3166-1 alpha-2 codes, at most 256 | Empty |
| Subdivisions | `country-subdivision`, the subdivision as `ip.geoip.subdivision` reads it (the City MMDB code, else its English name), e.g. `US-CA`; compared ASCII case-insensitively; at most 256 | Empty |
| ASNs | 1–4294967295, at most 256 | Empty |
| Path prefixes | One per line, at most 32; empty: every path | Empty |
| Excluded path prefixes | Paths starting with one of them are not checked (exceptions), at most 32 | Empty |

| Item | Behavior |
| --- | --- |
| Match | The country is listed, `country-subdivision` is listed, or the ASN is listed |
| No record | An address the GeoIP data does not know (no country, ASN 0) matches nothing: Allow only answers 403 |
| Denied | 403 with the site's 403 error page, `X-Edgeweir-Error: geo-denied` |
| GeoIP unavailable | 503 (`X-Edgeweir-Error: policy-unavailable`), as for rules; only requests in scope look GeoIP up |
| Data | The node's local MMDB files, see [GeoIP databases](rules.en.md#configure-geoip-databases); subdivisions need a City MMDB |

## CORS

Turn on "Enabled" on the "CORS" card, fill in "Allowed origins" and the rest, and click "Save".

| Field | Values | Default |
| --- | --- | --- |
| Allowed origins | `https://a.com`, `https://a.com:8443`, `https://*.a.com` (one label below) or `*` alone, one per line, at most 100; saved with lowercase scheme and host and without the default port | Empty (at least one while on) |
| Allow credentials | Responses carry `Access-Control-Allow-Credentials: true` and `Access-Control-Allow-Origin` always echoes the request's `Origin`; origins cannot be `*` | Off |
| Allowed methods | At most 16, sent in this order | GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS |
| Allowed request headers | A list (at most 64), or "Echo the preflight's headers" | Empty |
| Exposed headers | At most 64 | Empty |
| Max-Age (s) | 0–86400 | 600 |
| Preflights go to the origin | Preflights go to the origin as usual instead of being answered at the edge; for an allowed origin its answer gets the full preflight headers too (methods, request headers, Max-Age and `Vary`), unless the origin's CORS headers are kept and it sent `Access-Control-Allow-Origin` | Off |
| Keep the origin's CORS headers | When the origin's response has `Access-Control-Allow-Origin`, no `Access-Control-*` header is changed | Off |
| Path prefixes | At most 32; empty: every path | Empty |

| Item | Behavior |
| --- | --- |
| Origin match | The request's `Origin`, normalized (lowercase, no default port), against the list; `*.a.com` matches one label below `a.com` only; `null` and origins that cannot be parsed match nothing but `*` |
| Preflights | `OPTIONS` with `Origin` and `Access-Control-Request-Method`: for an allowed origin the node answers 204 itself with `Access-Control-Allow-Origin` (and credentials), `Access-Control-Allow-Methods`, `Access-Control-Allow-Headers`, `Access-Control-Max-Age`, `Vary: Origin, Access-Control-Request-Method, Access-Control-Request-Headers` and `Cache-Control: no-store`, without asking the origin; other origins get 403 (`X-Edgeweir-Error: cors-origin-denied`) |
| Other responses | Cache hits, origin responses and responses the node makes (error pages, redirects): the origin's `Access-Control-*` headers are removed by default; a request with an allowed `Origin` gets `Access-Control-Allow-Origin` (and credentials) and `Access-Control-Expose-Headers` |
| `Vary` | Responses in scope always get `Origin` in `Vary` (unless it has `Origin` or `*` already), also for requests without `Origin`; cached objects are not split by `Origin` |
| Rules | Response header rules run after CORS and may change these headers |

## Hotlink protection

Turn on "Enabled" on the "Hotlink protection" card, adjust the sources and scope, and click "Save".

| Field | Values | Default |
| --- | --- | --- |
| Allow no referer | Requests without `Referer` (and without `Origin` when it is checked) pass | On |
| Allow the site's domains | A `Referer` whose host this site serves (exact, wildcard, suffix and pattern domains) passes | On |
| Allowed sources | `a.com` (exact), `*.a.com` (one label below), `.a.com` (any depth below, not `a.com`) or `*` alone (any host), one per line, at most 200 | Empty |
| Denied sources | The same forms, at most 200; a match is refused, before allowed sources and the site's domains | Empty |
| Check Origin too | A request's `Origin` is checked the same way | Off |
| Extensions | At most 64, comma-separated | Common image, audio, video and download types (jpg, png, webp, mp4, m3u8, zip, apk, pdf and others, 49) |
| Path prefixes | At most 32 | Empty |
| Excluded path prefixes | At most 32 | Empty |
| Action | "Answer 403" (error page) or "302 redirect" to "Redirect to" (a site path or an `http(s)` URL, at most 2048 characters) | Answer 403 |

| Item | Behavior |
| --- | --- |
| Scope | Every request when extensions and path prefixes are both empty; else an extension in the list or a path under a prefix; minus the excluded prefixes |
| Parsing | Only `http://` and `https://` URLs: their host (lowercase, without user, port and a trailing `.`); a `Referer` that cannot be parsed (`android-app://…`, `Origin: null`) is not allowed, even with "Allow no referer" on |
| Decision | Every value present must be allowed: denied sources first, then the site's domains and the allowed sources |
| Refused | 403, `X-Edgeweir-Error: hotlink-denied`; or a 302 with `Cache-Control: no-store` and the same `X-Edgeweir-Error` |
| Redirect target | A request for a target that is a site path is not checked itself; a full URL of this site in scope would redirect in a loop: exclude its path |
| Limits | Visitors and browsers can drop `Referer` (e.g. `Referrer-Policy: no-referrer`); turn "Allow no referer" off to refuse them |

## User agents

Click "Add rule" on the "User agents" card, fill in "Pattern" and choose "Allow" or "Deny", reorder with up and down, and click "Save". Without rules nothing is checked.

| Field | Values |
| --- | --- |
| Pattern | Like the rule operator `wildcard`: the whole value, `*` any bytes (at most 8), `\*` and `\\` literals; ASCII case-insensitive; at most 512 printable ASCII characters; an empty pattern matches an empty or missing User-Agent |
| Rules | At most 200, in their order |
| Path prefixes, excluded path prefixes | At most 32 each |

| Item | Behavior |
| --- | --- |
| Decision | A matching "Allow" entry lets the request through without looking at "Deny" entries; else a matching "Deny" entry answers 403 (`X-Edgeweir-Error: ua-denied`) |
| Substrings | Write `*word*`, e.g. `*curl*` |
| Only listed user agents | Add a "Deny" entry `*` |
| Several User-Agent headers | Matched joined with `, `, like `http.user_agent` |

## WebSocket origins and idle timeout

Choose "Any origin" or "Listed origins only" with the origins on the "WebSocket" card, adjust "Idle timeout (s)" and click "Save". The site's WebSocket switch is on the Origins tab, see [WebSocket](origins-and-cache.en.md#websocket).

| Field | Values | Default |
| --- | --- | --- |
| Origins | Every origin, or a list (the CORS forms without `*` alone, at most 100) | Every origin |
| Idle timeout (s) | 60–86400 | 3600 |

| Item | Behavior |
| --- | --- |
| Refused | An upgrade without `Origin`, with an `Origin` that cannot be parsed or is not listed gets 403 (`X-Edgeweir-Error: websocket-origin-denied`); site allow lists do not skip it |
| Idle timeout | An upgraded connection closes after being idle this long; config rules' origin send and read timeouts still win |

## Security headers

Turn on what you need on the "Security headers" card and click "Save".

| Field | Response header |
| --- | --- |
| X-Content-Type-Options: nosniff | `X-Content-Type-Options: nosniff` |
| X-Frame-Options | Not set / `DENY` / `SAMEORIGIN` |
| Referrer-Policy | Not set, or `no-referrer`, `no-referrer-when-downgrade`, `origin`, `origin-when-cross-origin`, `same-origin`, `strict-origin`, `strict-origin-when-cross-origin`, `unsafe-url` |
| Permissions-Policy | The value (at most 1024 printable ASCII characters); empty: not set |
| Hide Server | Removes the `Server` header |
| Remove X-Powered-By | Removes the origin's `X-Powered-By` |

The headers replace the origin's headers of the same name on cache hits, origin responses and responses the node makes. Rules of the response-transform phase run afterwards: a rule that sets or removes one of these headers wins.

## IP check

**Sites → (site) → Access control → IP check** (for that site) or **IP lists → IP check** (a site is optional): enter an IP address and click "Check".

| Result | Content |
| --- | --- |
| Outcome (with a site) | The first step in the order above that decides: a global ban, a site ban, a global block list, a site block list, an exemption by a global or site allow list, or "none" (geo, hotlink and the rest still apply) |
| Lists | Every IP list holding the address, the matching entries, the list's action, and whether it is one of the site's block or allow lists |
| Bans | Active bans covering the address (with a site: global bans and that site's) |
| Client address | Each cluster's client address mode (with a site: its cluster's), and whether the address is a trusted proxy (trusted proxy header mode) or a node |

An IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) is checked as the IPv4 address, like nodes do. The console has no GeoIP database, so the IP check does not evaluate geo access.

## Failure counts and error codes

Requests authentication refused (401, 403, 429, 503, a browser's first request without credentials included) are counted per site and minute; the "Authentication failures" card of the site's Security tab shows the count over the chosen range (`GET /sites/{id}/auth-rules/failures`). Requests let through (also when the service fails) are not counted.

| `X-Edgeweir-Error` | Status | Cause |
| --- | --- | --- |
| `auth-required` | 401 | Basic: no or wrong credentials |
| `auth-denied` | 403 (forward authentication also 401 or 3xx) | A missing or wrong signature; forward authentication refused |
| `auth-expired` | 403 | An expired signature or a timestamp ahead |
| `auth-rate-limited` | 429 | Basic failure limit |
| `auth-unavailable` | 503 | The authentication service is unavailable |

Access control refusals do not count as authentication failures:

| `X-Edgeweir-Error` | Status | Cause |
| --- | --- | --- |
| `ip-blocked` | 403 | A site block list |
| `geo-denied` | 403 | Geo access |
| `cors-origin-denied` | 403 | A CORS preflight from an origin not allowed |
| `hotlink-denied` | 403 | Hotlink protection |
| `ua-denied` | 403 | User agents |
| `websocket-origin-denied` | 403 | WebSocket origins |

## Security and audit

| Item | Behavior |
| --- | --- |
| Storage | Password hashes and signing keys are envelope-encrypted with `EDGEWEIR_MASTER_KEY` (bound to their rule) and sealed again when the master key rotates |
| Delivery | Only to nodes of the site's cluster, over the mTLS node channel; nodes keep them in their state directory (`credentials.json`, 0600); configuration revisions carry references only |
| Never in | Configuration revisions, snapshots, audit entries, logs and API answers |
| Audit | `site.auth_update`: each rule's kind, state, number of users or keys and whether its secret changed (no credentials beyond user names); `site.auth_sign_url`; `site.access_control_update`: which parts changed with their switches and entry counts (not the sources, patterns or other list contents); revision reason "Access control of {site} updated" |

## Node requirements

| Item | Requirement |
| --- | --- |
| Authentication rules | Node capability `access-auth-v1`; while an active node of the cluster lacks it the UI cannot turn rules on, publishes by service accounts and background jobs answer `NODE_CAPABILITY_REQUIRED`, and nodes without it keep their last-known-good configuration |
| Hot updates | Rules, users and keys are hot-updated; upgrading a node to a version with the capability adds one shared dictionary and one internal location to its nginx configuration (one structural reload that keeps open connections) |
| Access control | Node capability `access-control-v1` (any part on or a site list chosen); geo access with countries or subdivisions also needs `geoip-city-v1`, with subdivisions the console also checks `geoip-subdivision-v1`, with ASNs `geoip-asn-v1`. While an active node of the cluster lacks it the cards show "Some nodes of the site's cluster do not support it yet", and publishes by service accounts and background jobs answer `NODE_CAPABILITY_REQUIRED`. Sites without any access control setting compile byte for byte as before |
| Access control updates | Every setting is hot-updated without an nginx reload; upgrading a node to a version with the capability raises the timeouts of the edge layer's hop to the origin layer to 86400 seconds for longer WebSocket idle timeouts (one structural reload that keeps open connections) |

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/sites/{id}/auth-rules` | The rules (no password hashes or keys) |
| PUT | `/sites/{id}/auth-rules` | Replaces them; rules with an `id` keep their passwords and keys, see [API](../reference/api.en.md) |
| POST | `/sites/{id}/auth-rules/{ruleId}/sign` | Signs a URL |
| GET | `/sites/{id}/auth-rules/failures` | Refused requests |
| GET | `/sites/{id}/access-control` | Every access control setting |
| PATCH | `/sites/{id}/access-control` | Changes the parts in the request only (`siteLists`, `hotlink`, `userAgents`, `cors`, `geo`, `websocket`, `securityHeaders`), see [API](../reference/api.en.md) |
| GET | `/ip-check?ip=…&siteId=…` | The IP check |

Read-only AccessKeys can call the `GET` ones only; service accounts none of them (`SERVICE_ACCOUNT_FORBIDDEN`).

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every request is 401 / 403 | The rule's secret did not reach the node (node log `access authentication rule … unavailable; its requests are refused`) or the scope is too wide | Check that the node is online and recent enough; narrow the scope or reorder the rules |
| A correct signature gets 403 `auth-expired` | The clocks of the node and the signer differ, or the timestamp is in milliseconds | Sync the clocks, use seconds; allow more clock skew |
| A correct signature gets 403 `auth-denied` | The signed path differs from the one visitors request (an unencoded non-ASCII path, or other percent-encoding case); wrong parameter names | Sign the percent-encoded path visitors send; check the parameter names |
| The browser does not ask for credentials | The site's 401 page redirects | Basic ignores redirects; check whether another rule matches first |
| Forward authentication always answers 503 | The URL is a private address outside the origin allow list, DNS fails or the service times out | Add the network to the origin allow list in the system settings; check the URL and the timeout |
| Asked to sign in again after signing in | A 401 answer is cached | Cache answers for less time, or not at all |
| "A list cannot be both a site block and allow list: …" | The same list on both sides | Remove it from one side |
| "With credentials, origins cannot be *" | CORS allows credentials and lists `*` | List the origins, or turn credentials off |
| The browser reports a CORS error; no `Access-Control-Allow-Origin` | The request's `Origin` is not allowed (`*.a.com` matches neither `a.com` nor deeper names) or the path is out of scope | Add the origin or adjust the path prefixes |
| Images on your own pages get 403 `hotlink-denied` | The page's host is neither served by this site nor allowed, or the page sends `Referrer-Policy: no-referrer` while "Allow no referer" is off | Allow the page's domain; turn "Allow no referer" on |
| Every request 503 `policy-unavailable` | Geo access is on and the node's GeoIP service is unavailable | Check the node's GeoIP setup, see [GeoIP databases](rules.en.md#configure-geoip-databases) |
| WebSocket connections get 403 `websocket-origin-denied` | The origin is not listed, or the client sends no `Origin` | Add the origin; have non-browser clients send an allowed `Origin` |
| A security header is missing or different | A response-transform rule changed or removed it | Check the site's and the global rules |
