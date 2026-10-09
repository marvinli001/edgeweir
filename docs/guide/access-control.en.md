# Access control

Access authentication of a site: Basic authentication, forward authentication (an external service decides) and signed URLs of kinds A–D. Authentication runs before the rules and the cache, and cache hits are checked too.

## Concepts

| Term | Definition |
| --- | --- |
| Authentication rule | One access authentication setting of a site: kind, scope and the kind's settings. At most 16 per site, matched in order. |
| Scope | Which requests a rule checks: domains, path prefixes, extensions and excluded path prefixes; all empty means every request. |
| Basic authentication | The browser asks for a user name and password (RFC 7617). |
| Forward authentication | The node sends some of the request's headers to an authentication service and lets the request through or refuses it by the answer. |
| Signed URL | The link carries a timestamp and a signature that the node checks with a key, with a validity; typical for paid or time-limited downloads and videos. |
| Signature | A lowercase hexadecimal `md5` digest (32 characters) of the path, the timestamp and the key. |

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
| 1 | The probes' health endpoint, CDN-Loop, the node certificates' HTTP-01, the site by Host, SNI check, client certificates, dynamic bans, the PURGE method |
| 2 | The rule is chosen; signed URLs are parsed and **their signature removed** (maintenance, CC, the rules, the cache key, purges and the origin then see the URI without it) |
| 3 | Maintenance, CC counting, the reserved prefix `/.edgeweir/` |
| 4 | The global allow and block lists |
| 5 | **Authentication**: a plain HTTP request the site's Force HTTPS redirects is redirected first (with its URL and signature), so credentials never travel unencrypted; then the kind's check |
| 6 | Rule phases, Under Attack and CC challenges, cache lookup and the origin |

ACME HTTP-01 requests, the reserved prefix `/.edgeweir/` and the node's local prefetch requests are not authenticated (a prefetched signed URL loses its signature too and fills the same cached object). Config rules that override Force HTTPS run after authentication, so they do not apply to requests a rule checks.

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

## Failure counts and error codes

Requests authentication refused (401, 403, 429, 503, a browser's first request without credentials included) are counted per site and minute; the "Authentication failures" card of the site's Security tab shows the count over the chosen range (`GET /sites/{id}/auth-rules/failures`). Requests let through (also when the service fails) are not counted.

| `X-Edgeweir-Error` | Status | Cause |
| --- | --- | --- |
| `auth-required` | 401 | Basic: no or wrong credentials |
| `auth-denied` | 403 (forward authentication also 401 or 3xx) | A missing or wrong signature; forward authentication refused |
| `auth-expired` | 403 | An expired signature or a timestamp ahead |
| `auth-rate-limited` | 429 | Basic failure limit |
| `auth-unavailable` | 503 | The authentication service is unavailable |

## Security and audit

| Item | Behavior |
| --- | --- |
| Storage | Password hashes and signing keys are envelope-encrypted with `EDGEWEIR_MASTER_KEY` (bound to their rule) and sealed again when the master key rotates |
| Delivery | Only to nodes of the site's cluster, over the mTLS node channel; nodes keep them in their state directory (`credentials.json`, 0600); configuration revisions carry references only |
| Never in | Configuration revisions, snapshots, audit entries, logs and API answers |
| Audit | `site.auth_update`: each rule's kind, state, number of users or keys and whether its secret changed (no credentials beyond user names); `site.auth_sign_url` |

## Node requirements

| Item | Requirement |
| --- | --- |
| Authentication rules | Node capability `access-auth-v1`; while an active node of the cluster lacks it the UI cannot turn rules on, publishes by service accounts and background jobs answer `NODE_CAPABILITY_REQUIRED`, and nodes without it keep their last-known-good configuration |
| Hot updates | Rules, users and keys are hot-updated; upgrading a node to a version with the capability adds one shared dictionary and one internal location to its nginx configuration (one structural reload that keeps open connections) |

## API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/sites/{id}/auth-rules` | The rules (no password hashes or keys) |
| PUT | `/sites/{id}/auth-rules` | Replaces them; rules with an `id` keep their passwords and keys, see [API](../reference/api.en.md) |
| POST | `/sites/{id}/auth-rules/{ruleId}/sign` | Signs a URL |
| GET | `/sites/{id}/auth-rules/failures` | Refused requests |

## Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Every request is 401 / 403 | The rule's secret did not reach the node (node log `access authentication rule … unavailable; its requests are refused`) or the scope is too wide | Check that the node is online and recent enough; narrow the scope or reorder the rules |
| A correct signature gets 403 `auth-expired` | The clocks of the node and the signer differ, or the timestamp is in milliseconds | Sync the clocks, use seconds; allow more clock skew |
| A correct signature gets 403 `auth-denied` | The signed path differs from the one visitors request (an unencoded non-ASCII path, or other percent-encoding case); wrong parameter names | Sign the percent-encoded path visitors send; check the parameter names |
| The browser does not ask for credentials | The site's 401 page redirects | Basic ignores redirects; check whether another rule matches first |
| Forward authentication always answers 503 | The URL is a private address outside the origin allow list, DNS fails or the service times out | Add the network to the origin allow list in the system settings; check the URL and the timeout |
| Asked to sign in again after signing in | A 401 answer is cached | Cache answers for less time, or not at all |
