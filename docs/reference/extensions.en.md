# Node extensions

Node extensions add Lua code to the request path of edge nodes. Anyone can write and sign one; the operator decides which publishers to trust, installs packages in the console, configures them and turns them on per site. The console distributes packages to nodes over the node channel and nodes load them. Neither the console nor the node checks licenses or contacts anyone about extensions; everything goes through the console's normal API.

This page is the format and runtime contract (`edgeweir-node-extension-v1`, Lua API 1). The [guide](../guide/extensions.en.md) describes the console screens.

## Overview

| Term | Meaning |
| --- | --- |
| Package | A `.ewx` file: gzip-compressed tar with `manifest.json`, Lua modules and optional static assets |
| Signature | A `.ewx.sig` file: compact JWS (EdDSA / Ed25519) over the package's SHA-256 and identity |
| Publisher key | An Ed25519 public key the operator trusts for one publisher name; none is trusted by default |
| Extension | An installed package id; it keeps every uploaded version and runs one of them (the active version) |
| Hook | A Lua function the node calls at a fixed point of the request |
| Kill switch | Console setting that stops every extension on every node at once |

## Package

The package is a gzip stream of a POSIX ustar archive.

- Entries are regular files and directories only (no links, devices or PAX/GNU extension headers beyond a `path` record); paths are relative, use `[A-Za-z0-9._-]` segments separated by `/`, have no `.` or `..` segment, are at most 200 bytes and appear once.
- Limits: archive ≤ 4 MiB, unpacked ≤ 16 MiB, ≤ 512 entries, each file ≤ 4 MiB.
- Allowed top-level entries: `manifest.json` (required), `lua/` (required, must contain `main.lua`), `assets/`, and files named `LICENSE*`, `NOTICE*` or `README*`. Anything else is rejected. Files under `lua/` must end in `.lua`.
- No native code: no `.so` / `.dll` / `.dylib`, no executable bits honored, no LuaJIT bytecode (every `.lua` file must be text; chunks are loaded in text mode).
- File modes, owners and times are ignored. `edgeweir-node extension pack` writes a reproducible archive (sorted entries, mtime 0, uid/gid 0, mode 0644/0755).

### manifest.json

UTF-8 JSON, at most 64 KiB. Unknown top-level members are rejected (so that a newer format is never half-understood).

```json
{
  "format": "edgeweir-node-extension-v1",
  "id": "hello-header",
  "version": "1.0.0",
  "publisher": "example.org",
  "name": { "en": "Hello header", "zh-CN": "问候响应头" },
  "description": { "en": "Adds a greeting header.", "zh-CN": "添加问候响应头。" },
  "license": "Apache-2.0",
  "homepage": "https://example.org/hello-header",
  "requires": { "lua_api": 1, "node": ">=1.7.0" },
  "hooks": ["access", "header_filter", "log", "endpoint"],
  "capabilities": ["response_headers", "verdicts"],
  "config": {
    "global": { "type": "object", "properties": { "greeting": { "type": "string", "default": "hello", "maxLength": 64 } } },
    "site": { "type": "object", "properties": { "header": { "type": "string", "default": "X-Hello", "pattern": "^[A-Za-z0-9-]{1,64}$" } } }
  },
  "fields": [{ "name": "greeted", "type": "boolean", "description": { "en": "The greeting header was added" } }],
  "log_fields": ["greeting"],
  "counters": ["greeted"],
  "endpoints": [{ "path": "ping", "methods": ["GET", "HEAD"] }],
  "shared_dicts": [{ "name": "state", "size_kb": 256 }]
}
```

| Member | Rule |
| --- | --- |
| `format` | Exactly `edgeweir-node-extension-v1` |
| `id` | `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`; not `edgeweir`, `core`, `challenge`, `session`, `health`, `ext` |
| `version` | Semantic Versioning 2.0.0 without build metadata (`1.2.3`, `1.2.3-rc.1`) |
| `publisher` | `^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$`, usually a domain the publisher controls; must equal the publisher of the signing key |
| `name` | Map of locale (`en` required, `zh-CN` optional) to ≤ 64 characters |
| `description` | Optional, same locales, ≤ 512 characters |
| `license`, `homepage` | Optional, informational (SPDX expression ≤ 128 characters; `https://` URL) |
| `requires.lua_api` | Required, `1` |
| `requires.node` | Optional semver range: space-separated comparators (`>=1.7.0 <2.0.0`), operators `=`, `>`, `>=`, `<`, `<=` |
| `hooks` | Non-empty subset of `init`, `access`, `access_late`, `header_filter`, `body_filter`, `log`, `endpoint`; each needs a function of that name in `main.lua` |
| `capabilities` | Subset of the table under [Capabilities](#capabilities); API calls outside them raise an error |
| `config.global`, `config.site` | Optional JSON Schemas (subset below) of the global and per-site configuration; missing means `{}` with no properties |
| `fields` | ≤ 16 rule fields, `name` `^[a-z][a-z0-9_]{0,31}$`, `type` `string`, `number` or `boolean`; rules read them as `ext.<id>.<name>` |
| `log_fields` | ≤ 8 names (same pattern); access logs show them as `ext.<id>.<name>` |
| `counters` | ≤ 8 names (same pattern); per-site minute counters `ext.<id>.<name>` |
| `endpoints` | ≤ 8 entries, `path` `^[a-z0-9][a-z0-9._-]{0,63}$` (one segment), `methods` subset of `GET HEAD POST PUT DELETE OPTIONS`, optional `max_body` ≤ 65536 (default 4096); served at `/.edgeweir/ext/<id>/<path>` on every site that enables the extension. `assets` is not allowed as a path |
| `shared_dicts` | ≤ 4 entries, `name` `^[a-z][a-z0-9_]{0,15}$`, `size_kb` 16–16384, total ≤ 32768 |

### Configuration schema subset

Schemas are JSON Schema 2020-12 restricted to what the console can render and validate:

- The root is `{"type": "object", "properties": {…}}` with optional `required` and `additionalProperties: false` (the default; unknown keys are always rejected).
- A property is one of `string` (`enum`, `minLength`, `maxLength` ≤ 4096, `pattern` (ECMAScript and PCRE compatible subset: no look-behind, no back references), `format`: `uri` or `hostname`), `integer` / `number` (`minimum`, `maximum`, `enum`), `boolean`, or `array` of strings or integers (`items` with the keywords above, `maxItems` ≤ 256, `uniqueItems`).
- Each property may have `title` and `description` as plain strings or locale maps, `default`, and `x-secret: true` (string, masked in the UI and the API response; stored as given — do not put credentials that must not reach nodes here, every value is delivered to nodes).
- Nested objects, `$ref`, `oneOf` / `anyOf` / `allOf`, `if` are not supported in format v1.
- The console fills defaults and validates on every write; nodes receive the complete object.

## Signature

`<package>.ewx.sig` holds a JWS compact serialization (RFC 7515), one line:

- Protected header: exactly `{"alg":"EdDSA","kid":"<kid>","typ":"edgeweir-ext+jws"}` members (any order); no `crit`, `jku`, `jwk`, `x5u`.
- Payload: JSON `{"format":"edgeweir-node-extension-v1","id":"…","version":"…","publisher":"…","sha256":"<64 lowercase hex of the .ewx bytes>","size":<bytes>,"iat":<Unix seconds>}`.
- Signature: Ed25519 (RFC 8037) over `BASE64URL(header) "." BASE64URL(payload)`.
- `kid` is the RFC 7638 JWK thumbprint of the publisher's public key: `BASE64URL(SHA-256('{"crv":"Ed25519","kty":"OKP","x":"<x>"}'))`.

A package is accepted only when: the header is as above; `kid` names a trusted key; the key's publisher equals the payload's and the manifest's `publisher`; the signature verifies; `sha256` and `size` match the uploaded bytes; `id`, `version` and `format` equal the manifest's. Nothing else in the archive is trusted before this check.

### Publisher keys

Publishers create an Ed25519 key pair and publish the public key as a JWK (`{"kty":"OKP","crv":"Ed25519","x":"…"}`) on their own channel. The operator adds it in the console together with the publisher name (System → Extensions → Trusted keys). No key is trusted by default, the console ships none, and removing a key is refused while an installed version is signed by it.

```bash
edgeweir-node extension keygen --out publisher.jwk          # private JWK, 0600; prints the public JWK and kid
edgeweir-node extension pack --out hello-header-1.0.0.ewx ./hello-header   # flags go first
edgeweir-node extension sign --key publisher.jwk --publisher example.org hello-header-1.0.0.ewx   # writes .ewx.sig
edgeweir-node extension verify --pubkey publisher.pub.jwk --publisher example.org hello-header-1.0.0.ewx
```

## Lifecycle

| Action | API (`/api/v1`) | Effect |
| --- | --- | --- |
| Verify | `POST /extensions/verify` | Checks package and signature, returns the manifest, digest and key; stores nothing |
| Install / upgrade | `POST /extensions` | Verifies, stores the version and makes it active. A new id is installed disabled; a higher or lower version of an installed id becomes the active version (its configuration is validated against the new schema first) |
| Roll back | `POST /extensions/{id}/activate` | Makes another stored version active |
| Delete a version | `DELETE /extensions/{id}/versions/{version}` | Only inactive versions |
| Enable / disable, configure | `PATCH /extensions/{id}` | `enabled`, `failureMode` (`open` / `closed`), `config` (global) |
| Per site | `GET /sites/{id}/extensions`, `PUT /sites/{id}/extensions/{extensionId}` | `enabled`, `config` (site) |
| Uninstall | `DELETE /extensions/{id}` | Removes every version, the global and site settings. Refused with `EXTENSION_IN_USE` while a rule reads one of its fields |
| Kill switch | `GET` / `PUT /extensions/settings` | `disabled: true` stops all extensions on all nodes (packages stay installed) |
| Trusted keys | `GET` / `POST /extension-keys`, `DELETE /extension-keys/{kid}` | Trust store |
| Status | `GET /extensions/{id}` | Manifest, versions, configuration, sites and each node's load state |

Every write is audited (`extension.install`, `extension.upgrade`, `extension.activate`, `extension.delete_version`, `extension.update`, `extension.uninstall`, `extension.settings_update`, `extension_key.add`, `extension_key.remove`, `site.extension_update`) and publishes a new configuration revision in the same transaction. The same procedures serve `/rpc` for the console UI. Service account keys cannot call them.

Packages are sent as base64 in JSON (`{"package": "<base64>", "signature": "<jws>"}`); the 16 MiB request limit leaves room for the 4 MiB archive.

## Distribution

1. The configuration carries each installed extension that a site of the cluster turns on (active version, digest, size, signature, signing key, enabled, failure mode, global configuration) and each site's enabled extensions with their site configuration, plus the kill switch.
2. Nodes advertise `extensions-v1`. A configuration that delivers any extension requires `extensions-v1`; the console refuses with `NODE_CAPABILITY_REQUIRED` to enable an extension, or enable it on a site, while a cluster that would receive it has an active node without the feature.
3. The node fetches each missing package by digest (`GetExtensionPackage`, mTLS), checks size and SHA-256, verifies the JWS with the delivered key (and, when `--extension-keys` names a local file of JWKs, also requires the key to be in it), unpacks and validates the manifest exactly as the console did, and checks `requires`. A package that fails is not loaded and is reported; the rest of the configuration applies normally.
4. A change in the set of loaded packages (install, upgrade, uninstall, shared dict sizes) re-renders `nginx.conf` and reloads gracefully. Enable / disable, configuration, per-site settings and the kill switch are hot updates.
5. Nodes report each extension's state (`loaded`, `failed`, `incompatible`, `disabled`) with the last error and fault counters. Package files no longer referenced by the current or previous configuration are deleted.

`edgeweir-node run --no-extensions` turns the mechanism off on that node: it does not advertise `extensions-v1`, never downloads or loads packages, and the console cannot override it.

## Runtime

### Hooks

`lua/main.lua` returns a table; the node calls the declared functions with an API object `ew` (one per extension and request):

| Hook | When | May |
| --- | --- | --- |
| `init(ew)` | Once per worker, on the extension's first use after (re)load | Prepare state; `ew.timer` when `timers` |
| `access(ew)` | After host lookup, bans and reserved paths, before access control, rules and challenges | Set fields, read the request, return a verdict |
| `access_late(ew)` | After rules and challenges passed, before the CRS, the cache and the origin | Return a verdict, set origin request headers |
| `header_filter(ew)` | Response headers, every response of an enabled site (including the node's own pages, not reserved paths) | Read / change response headers, queue HTML injections |
| `body_filter(ew, chunk, eof)` | Each body chunk, only with `body_rewrite` | Return a replacement chunk (or `nil` to keep it) |
| `log(ew)` | Log phase, before the access log is written | Set log fields, count |
| `endpoint(ew, path)` | Requests to `/.edgeweir/ext/<id>/<path>` declared in `endpoints` | Return `ew.respond(...)` |

Hooks run only on sites that enable the extension, in the order the extensions were installed. A request to `/.edgeweir/ext/<id>/…` on a site that does not enable it gets 404. Like the node's other reserved paths, assets and endpoints get bans and CC (and count towards CC), not access control, rules or challenges.

### Verdicts

`access` and `access_late` return nothing to continue, or one of:

| Verdict | Effect |
| --- | --- |
| `ew.deny(status?)` | Node error page with `status` (400–499, default 403), `X-Edgeweir-Error: extension-denied`, reason `extension`, rule id `ext:<id>` |
| `ew.challenge(level)` | Core challenge at `cookie302`, `js`, `pow` or `captcha`; a pass of that level continues |
| `ew.allow()` | `access` only: skip Under Attack and CC challenges for this request (rules and WAF still run) |
| `ew.respond(status, body?, headers?)` | Answer directly (no origin) |

The first verdict wins; later extensions' hooks are not called. Verdicts need `verdicts`.

### API

| Call | Notes |
| --- | --- |
| `ew.id`, `ew.version`, `ew.api` (`1`) | |
| `ew.site_id`, `ew.global_config`, `ew.site_config` | Configuration tables (the extension's own copies; do not change them) |
| `ew.ctx` | Table kept for this request and extension across hooks |
| `ew.req.method()`, `host()`, `path()`, `query()`, `uri()`, `scheme()`, `header(name)`, `headers()`, `cookie(name)`, `arg(name)`, `client_ip()`, `country()`, `asn()`, `ja4()`, `request_id()`, `pass_level()` | Request view (copies) |
| `ew.req.body()` | `request_body`; `access`, `access_late`, `endpoint`: a body with `Content-Length` up to 64 KiB (endpoints: their `max_body`), else `nil, "truncated"` |
| `ew.req.set_header(name, value)`, `ew.req.clear_header(name)` | `request_headers`; headers sent to the origin |
| `ew.resp.status()`, `header(name)`, `content_type()`, `cache_status()` | Response view (`header_filter`, `body_filter`, `log`) |
| `ew.resp.set_header(name, value)`, `add_header`, `clear_header` | `response_headers`; `header_filter` only |
| `ew.html.inject(position, html)` | `html_inject`; position `head_end` or `body_end`; ≤ 8 KiB per extension and response |
| `ew.html.script({src=, inline=, defer=, async=, type=})` | `html_inject`; queues a `<script>` at `head_end` with the nonce rules below |
| `ew.field(name, value)` | Declared rule field; `access` only; type-checked |
| `ew.log_field(name, value)` | Declared log field; string (numbers and booleans are converted), cut at 256 bytes |
| `ew.count(name, n?)` | Declared counter |
| `ew.shared(name)` | Declared shared dict (`ngx.shared` object) |
| `ew.log(level, ...)` | `"err"`, `"warn"`, `"info"`; prefixed `[ext <id>]`, rate-limited |
| `ew.now()`, `ew.sha256(s)`, `ew.hmac_sha256(key, s)`, `ew.random_bytes(n)`, `ew.b64url_encode(s)`, `ew.b64url_decode(s)`, `ew.json_encode(v)`, `ew.json_decode(s)` | Helpers |
| `ew.tcp()` | `http_client`; an `ngx.socket.tcp` cosocket (`access`, `access_late`, `endpoint`, timers) |
| `ew.timer(delay, fn)` | `timers`; `init` and timers; `fn(ew)` runs in a timer with the same isolation and budget |

### Capabilities

| Capability | Grants |
| --- | --- |
| `verdicts` | Return `deny`, `challenge`, `allow`, `respond` from `access` / `access_late` |
| `request_headers` | Change headers sent to the origin |
| `request_body` | Read the request body |
| `response_headers` | Change response headers |
| `html_inject` | HTML injection helpers |
| `body_rewrite` | The `body_filter` hook |
| `http_client` | Outgoing TCP connections |
| `timers` | Background timers from `init` |

The console shows the capabilities when the package is verified and on the extension page.

### HTML injection

The node injects queued snippets once per response, in the body filter, and only into responses that are: `GET`, status 200, `Content-Type: text/html`, without `Content-Encoding`, without `Content-Range`, without `Cache-Control: no-transform`. `head_end` goes before the first `</head>` found in the first 64 KiB (otherwise before `</body>`, otherwise appended); `body_end` before the last `</body>` within the response's final 512 bytes (otherwise appended). The node removes `Content-Length` and turns a strong `ETag` into a weak one. The cache always stores the origin's bytes; injection happens on the way out, for hits and misses alike, and edge compression runs after it.

CSP: when the response has a `Content-Security-Policy` header, `ew.html.script` takes the effective `script-src` (else `default-src`): with a `'nonce-…'` source the script gets the same nonce; with `'self'` (and `src` same-origin) and no `'strict-dynamic'` it is injected as is; otherwise it is not injected (the call's result reports `false`). Inline scripts need a nonce. `ew.html.inject` (raw HTML) is never adjusted for CSP. `<meta>` policies inside the page are not parsed.

### Static assets

Files under `assets/` are served at `/.edgeweir/ext/<id>/assets/<path>` (GET / HEAD) on sites that enable the extension, with `Cache-Control: public, max-age=3600`, an ETag from the file digest, and a content type from the extension (`.js`, `.css`, `.json`, `.svg`, `.png`, `.jpg`, `.webp`, `.woff2`, `.txt`, `.html`; otherwise `application/octet-stream`) with `X-Content-Type-Options: nosniff`.

### Isolation and limits

- Code runs in its own environment: standard Lua functions (`string`, `table`, `math`, `bit`, `pairs`, `pcall`, …), `os.time` / `os.clock` / `os.date`, and `require` limited to the package's own `lua/` modules (`require("util")` loads `lua/util.lua`) plus `cjson.safe`, `resty.sha256`, `resty.string`, `resty.random`, `resty.lrucache`, `ngx.re`. There is no `ngx` global, `io`, `os.execute`, `debug`, `ffi`, `jit`, `load` of bytecode, `package`, `setfenv` / `getfenv` or `collectgarbage`.
- **This is hygiene, not a security sandbox.** A trusted publisher's code runs inside the nginx worker with the worker's privileges and can reach anything the worker can. Trust a key only if you would run that publisher's code on your edge.
- Every hook call runs under `pcall`. An error or a call longer than the budget (10 ms wall time, including waits on cosockets in `access` / `access_late` / `endpoint`: 1000 ms) is a fault. 20 faults within 60 seconds in a worker trip the extension in that worker for 60 seconds; tripped extensions are treated like failing ones.
- **Failure mode** (per extension, default `open`): `open` ignores a failing or tripped extension (the request continues as if the hook returned nothing). `closed` answers requests on sites that enable it with 503 `X-Edgeweir-Error: extension` when its `access`, `access_late` or `endpoint` hook fails, is tripped, or the package could not be loaded. Header filter, body filter and log hooks always fail open.
- Faults are logged (`[ext <id>]`, rate-limited), counted per site in the minute stats (`ext.<id>.faults`), and reported per node.

### Rule fields, logs and statistics

- Rule fields `ext.<id>.<name>` are usable in the request phases (`request-transform`, `redirect`, `config`, `waf-custom`, `ratelimit`, `origin`) and require `extensions-v1`. A rule may use a field only while the extension is installed and declares it; unset fields read as `""`, `0` or `false`.
- Access logs carry `ext.<id>.<name>` log fields and `ext.<id>.verdict` (`deny`, `challenge`, `allow`, `respond`) when set.
- Minute statistics carry per-site counters `ext.<id>.<name>` and `ext.<id>.faults`.

## Example

```lua
-- lua/main.lua of hello-header
local M = {}

function M.access(ew)
  ew.field("greeted", ew.req.header("x-no-greeting") == nil)
end

function M.header_filter(ew)
  if ew.req.header("x-no-greeting") then return end
  ew.resp.set_header(ew.site_config.header, ew.global_config.greeting)
  ew.log_field("greeting", ew.global_config.greeting)
  ew.count("greeted")
end

function M.endpoint(ew, path)
  return ew.respond(200, "pong\n", { ["Content-Type"] = "text/plain" })
end

return M
```

`examples/extensions/hello-header` in the edgeweir-node repository is this extension; the node's Lua tests load it and the end-to-end tests sign, install and run it.

## Version 1.1 (Lua API 2)

Version 1.1 keeps the package format `edgeweir-node-extension-v1` and adds manifest members and calls for node-level extensions (metrics exporters) and for extensions that run a native helper process (sidecars, such as function runtimes). Everything in this section needs `"requires": {"lua_api": 2}`; the node feature is `extensions-v2` (a node with it runs Lua API 1 and 2 packages). The console refuses a package that uses a member of this section with `lua_api: 1`, and delivers an API 2 extension only to clusters whose active nodes all report `extensions-v2` (`NODE_CAPABILITY_REQUIRED` otherwise). Nothing here is specific to any product, and nothing checks licenses.

### Manifest members (API 2)

| Member | Rules |
| --- | --- |
| `scope` | `"sites"` (default): as in version 1. `"node"`: the extension runs on nodes, not per site: allowed hooks `init`, `log`, `listen`; no `endpoints`, `fields`, `html_inject`, `body_rewrite`, `request_headers`, `verdicts`, `sidecar`, `data`; no site configuration. Its `log` hook runs for every request of every site on the nodes it is delivered to |
| `listeners` | `scope: "node"` only. ≤ 2 entries `{ "name": <^[a-z][a-z0-9_]{0,15}$>, "default_port": 1024–65535, "methods": ["GET", "HEAD", "POST"] }`; served by the node on a port of its own, outside every site (see [Node listeners](#node-listeners)). Needs the hook `listen` |
| `secret` | `true`: the console keeps a random 32-byte secret for the extension and nodes expose it as `ew.secret()` (see [Secrets](#secrets)) |
| `sidecar` | A native helper process (see [Sidecars](#sidecars)). Needs the capability `sidecar` |
| `data` | `{ "max_bytes": ≤ 25165824, "max_items": ≤ 32, "max_total_bytes": ≤ 268435456 }`: the extension accepts per-site data items (see [Site data](#site-data)); needs `sidecar` |
| Limits | API 2 raises `fields` to ≤ 16, `log_fields` to ≤ 16 and `counters` to ≤ 32 |

Hooks gain `listen`; capabilities gain `sidecar`. A package with a sidecar may be up to 64 MiB (archive), 192 MiB unpacked, with files up to 96 MiB; `POST /extensions` and `POST /extensions/verify` accept requests up to 96 MiB for them.

### API 2 calls

| Call | Notes |
| --- | --- |
| `ew.site_name` | The site's primary domain (its first domain); `nil` in node-level hooks |
| `ew.req.http_version()` | `"1.0"`, `"1.1"`, `"2"`, `"3"` |
| `ew.req.request_length()`, `ew.req.request_time()` | Bytes received (request line, headers, body) and seconds since the first byte; `log` |
| `ew.resp.bytes_sent()` | Bytes sent to the client; `log` |
| `ew.resp.upstream_status()`, `upstream_response_time()`, `upstream_connect_time()`, `upstream_header_time()` | The last origin attempt's status and times in seconds; `nil` without an origin request (cache hits, the node's own answers); `log` |
| `ew.resp.reason()` | The node's block reason of the request and its rule id (`"rate_limit", "<rule id>"`), `""` when none; reasons as in the access logs (`ip_banned`, `ip_blocked`, `rule`, `rate_limit`, `crs`, `cc`, `challenge`, `auth`, `referer`, `user_agent`, `region`, `cors`, `websocket_origin`, `client_cert`, `maintenance`, `extension`) |
| `ew.req.verified_bot()` | The verified search engine crawler name (PTR plus forward lookup, as for the site's crawler setting) or `nil`; `access`, `access_late`; its DNS wait does not count against the budget |
| `ew.req.exempt()` | `true` when the client is on one of the site's allow lists or a platform allow list (the clients the node exempts from bans and challenges); `access`, `access_late` |
| `ew.node.id()`, `name()`, `cluster_id()`, `version()` | The node's identity and agent version |
| `ew.node.connections()` | `{ active, reading, writing, waiting }` of the nginx worker's view (stub_status), in request and listener hooks; `nil` in timers |
| `ew.node.status()` | The node's last reported host metrics `{ at, cpu_percent, load1, load5, load15, memory_used_bytes, memory_total_bytes, egress_bps, active_connections }` (`nil` before the first report); any hook |
| `ew.secret()`, `ew.secrets()` | `secret: true`: the current secret (32 raw bytes); `ew.secrets()` returns `{ current, previous }` (`previous` `nil` before the first rotation) |
| `ew.equal(a, b)` | Constant-time comparison of two strings |
| `ew.sidecar.ready()` | `sidecar`: whether the sidecar passed its health check |
| `ew.sidecar.proxy(opts)` | `sidecar`; `access_late` only: verdict that hands the request to the sidecar (see [Sidecars](#sidecars)) |

Clarifications for both API versions: `ew.req.pass_level()` is 0 (none), 1 `cookie302`, 2 `js`, 3 `pow`, 4 `captcha`; `ew.sha256` and `ew.hmac_sha256` return 32 raw bytes; `ew.req.header(name)` is case-insensitive and joins repeated headers with `", "`; `ew.respond` may set `Set-Cookie` and sends no body for `HEAD`; `ew.ctx` is one table per request and extension across all its hooks (also `endpoint` and `log`); access hooks do not run for `/.edgeweir/ext/<id>/…` requests, the `log` hook does; header filter hooks also run on responses an extension produced with `ew.respond`; a same-origin `src` with a query string counts as same origin, and assets are served regardless of the query string.

### Node listeners

A node listener is an HTTP server the node opens for a `scope: "node"` extension, outside every site: no Host lookup, rules, challenges, CC, cache or access logs.

- The operator turns a listener on in the console (extension settings, `listeners.<name>`): `port` (1024–65535; not 80, 443, the cluster's edge or layer-4 ports or 8443), `bind` (an address of the node, default `0.0.0.0` and `[::]`) and `allow` (1–64 CIDRs, required). The node renders `allow` / `deny all` into the listener, so clients outside the list never reach Lua. A listener without settings is off.
- The node calls `listen(ew, name, path)` for each request on a declared method; `path` is the request path. The hook returns `ew.respond(...)`; anything else is a 500. Budget: 1000 ms. `ew.req.*` reads the request, `ew.req.body()` (with `request_body`) up to 64 KiB.
- Authentication beyond the address list (bearer tokens in the extension's configuration, compared with `ew.equal`) is the extension's. TLS and client certificates are not offered in 1.1: put the listener on a private network or behind the allow list.
- A port the node cannot bind is reported in the extension's node state (`failed`, message), the rest of the configuration applies.

### Secrets

For `secret: true` the console generates 32 random bytes when the extension is installed and stores them envelope-encrypted. `POST /extensions/{id}/rotate-secret` makes a new current secret and keeps the old one as previous. Nodes fetch secrets over the node channel (`GetExtensionSecrets`, mTLS) only; configuration revisions carry a version number, never the secret. Use it for HMAC keys shared by all nodes (signed cookies, tokens). Configuration values marked `x-secret` are masked in the API but are part of the configuration revisions; prefer `ew.secret()` for keys.

### Sidecars

A sidecar is a native program shipped in the package and run by the node agent next to nginx. It exists for work that does not fit a request hook (a function runtime, a long-lived engine). It runs code of the trusted publisher and, depending on the extension, code the operator's users supply; the node treats it as untrusted towards itself.

Manifest:

```json
"sidecar": {
  "binary": "runtime",
  "args": ["--socket", "{socket}"],
  "env": { "RUST_LOG": "info" },
  "memory_mb": 1024,
  "tasks_max": 256,
  "cpu_percent": 200,
  "health_path": "/healthz",
  "connect_timeout_ms": 1000,
  "timeout_s": 30,
  "max_body": 10485760
}
```

| Field | Rules |
| --- | --- |
| `binary` | File name `^[a-z0-9][a-z0-9._-]{0,63}$`; the package holds `sidecar/linux-amd64/<binary>` and/or `sidecar/linux-arm64/<binary>` (static ELF executables recommended). Files under `sidecar/` are the only native code a package may contain, and only with the capability `sidecar`. A node without its architecture reports `incompatible` |
| `args` | ≤ 16 strings ≤ 256 bytes; `{socket}`, `{origin_socket}`, `{state}`, `{data}` are replaced |
| `env` | ≤ 16 variables `^[A-Z][A-Z0-9_]{0,63}$`, not `EDGEWEIR_*`, values ≤ 1024 bytes; the node also sets `EDGEWEIR_SIDECAR_SOCKET`, `EDGEWEIR_ORIGIN_SOCKET`, `EDGEWEIR_EXT_STATE`, `EDGEWEIR_EXT_DATA`, `EDGEWEIR_EXT_ID`, `EDGEWEIR_EXT_VERSION`; nothing else is inherited |
| `memory_mb` | 16–8192, the memory limit |
| `tasks_max` | 16–4096 (default 256), processes and threads |
| `cpu_percent` | 10–800 (default: none), CPU limit in percent of one core |
| `health_path` | Default `/healthz`; the node treats the sidecar as ready when `GET` on its socket answers 200 |
| `connect_timeout_ms`, `timeout_s` | 100–10000 (default 1000), 1–60 (default 30): towards the sidecar, per request (read and send timeouts between two reads or writes) |
| `max_body` | 0–104857600 (default 10 MiB): request bodies proxied to the sidecar |

Lifecycle: the agent starts the sidecar once the package is unpacked and the extension is enabled (and the kill switch off), restarts it after it exits (1 s doubling to 60 s), and stops it (SIGTERM, SIGKILL after 10 s) when the extension is disabled, uninstalled or upgraded, on the kill switch, with `--no-extensions`, or when the agent stops. Its state goes to the extension's node state (`details.sidecar`: `starting`, `running`, `unhealthy`, `crashed`, `stopped`, `unsupported`; restarts; last exit). Standard output and error are read by the agent, limited to 1 KiB lines and 20 lines per second, and appear in the node's logs (source `extension`).

Isolation (Linux only; anything less is `unsupported` and the sidecar is not started):

- **Own user.** The sidecar never runs as the agent's or nginx's user. Package installs (systemd) start it as the template unit `edgeweir-node-sidecar@<id>.service` with `DynamicUser=yes`, through a polkit rule that lets the node's user start and stop only those units; containers and other setups need the agent to run as root with `--sidecar-user USER` (the agent then switches to that user). `run --sidecar-mode auto|systemd|user|off` chooses; `off` refuses sidecars.
- **Sandbox.** `NoNewPrivileges`, no capabilities, a read-only view of the system, a private `/tmp`, writable only its state directory; a seccomp filter refusing `ptrace`, `process_vm_*`, mounts, namespaces, BPF, perf, keyrings, kernel modules, reboot and clock changes; memory, task and CPU limits from the manifest (cgroup v2; `RLIMIT_DATA` as a fallback for memory); no core dumps.
- **What it reaches.** Reads: its package's `sidecar/` and `assets/`, its data directory. Writes: its state directory `<state>/extensions/run/<id>/state`. Connects: its own socket directory and the network. It cannot read the node's state directory (keys, credentials, configuration), connect to the agent's or nginx's control sockets, or signal other processes.
- **Network.** Outbound connections are allowed (a function runtime calls APIs); the sidecar must refuse special-purpose destinations itself. To reach a site's own origin it uses the origin socket below, so private origin addresses never need to be reachable from it.

Sockets (directory `/run/edgeweir-node/ext/<id>/`, group-shared between the sidecar user and nginx only):

- `sidecar.sock`: created by the sidecar; nginx connects to it.
- `origin.sock`: served by nginx for the sidecar. A request carrying `X-Edgeweir-Ext-Site: <site id>` goes to that site's origin as the edge layer would send it (origin pools, Host, TLS verification, origin rules, origin address policy), without the cache, the CRS or any extension hook. Sites that do not turn the extension on get 403; requests without the header 400.

Routing a request: from `access_late`, `return ew.sidecar.proxy({ headers = { ["X-Edgeweir-Ext-Route"] = "r1" }, fail = "open" })` hands the request (method, URI, headers, body streamed) to `sidecar.sock` with nginx's proxy, not a cosocket, so the hook budget does not apply. `headers` set request headers whose names start with `X-Edgeweir-Ext-` (the node removes every client header with the `X-Edgeweir-` prefix, so the sidecar can trust them); the node adds `X-Edgeweir-Ext-Site` (site id), `X-Edgeweir-Ext-Request-Id`, `X-Edgeweir-Ext-Client-Ip`, `X-Edgeweir-Ext-Scheme` and `X-Edgeweir-Ext-Host`. The sidecar's response goes to the client through the node's header and body filters (including extensions' header filters, compression), logs and statistics; it is never cached. Failure:

| Case | `fail = "open"` | `fail = "closed"` (default: the extension's failure mode) |
| --- | --- | --- |
| Sidecar not ready, connection refused, timeout before the response header | The request continues on the site's normal path (CRS, cache, origin) | 502 (`X-Edgeweir-Error: extension`) |
| The sidecar answers status 599 | The request continues on the site's normal path | Same |
| Request body over `max_body` | 413 | 413 |

Requests handed to the sidecar get block reason none, access log field `ext.<id>.verdict = "sidecar"`, and count towards the extension's counter `ext.<id>.sidecar`.

### Site data

Extensions with `data` accept opaque items per site, uploaded through the console API by whoever manages the site, never signed by the publisher (function bundles, per-site secrets):

| Route | Notes |
| --- | --- |
| `GET /sites/{siteId}/extensions/{id}/data` | `[{ name, sha256, size, updatedAt }]` |
| `PUT /sites/{siteId}/extensions/{id}/data/{name}` | Body `{ "content": "<base64>" }` (requests up to 34 MiB); name `^[a-z0-9][a-z0-9._-]{0,63}$`; limits from the manifest's `data`; audited (`site.extension_data_put`), publishes a revision |
| `DELETE /sites/{siteId}/extensions/{id}/data/{name}` | Audited (`site.extension_data_delete`), publishes a revision |

Items are stored in the console's database. Configuration carries `{name, sha256, size}` per site and extension; nodes fetch missing items by digest over the node channel (`GetExtensionData`, mTLS, in chunks of 4 MiB), check the digest, and store them under `<state>/extensions/data/<id>/<site id>/<name>`, readable by the sidecar user and nginx only, deleting items no configuration references. Data changes are hot: no nginx reload.

The sidecar learns about sites, configuration and data from `$EDGEWEIR_EXT_DATA/index.json`, written atomically after every item of a revision is present, followed by `SIGHUP`:

```json
{ "revision": 42, "config": { "...": "global configuration" },
  "sites": { "<site id>": { "name": "shop.example", "domains": ["shop.example"], "config": { "...": "site configuration" },
    "data": [{ "name": "fn-main.wasm", "sha256": "…", "size": 9123456, "path": "/var/lib/edgeweir-node/extensions/data/<id>/<site id>/fn-main.wasm" }] } } }
```

Only sites that turn the extension on appear. Site configuration is visible to Lua and the console API (masked `x-secret` values aside); secrets belong in data items.

### Node state details

Each extension's node state carries `details` (JSON, ≤ 4 KiB): `sidecar` (state, restarts, last exit, since), `listeners` (`{name: {port, state, message}}`), and whatever the sidecar returns from `GET /status` on its socket under `sidecar.status` (≤ 2 KiB, polled every 30 s).

### Distribution changes in 1.1

- `GetExtensionPackage` and `GetExtensionData` transfer in chunks (`offset`, at most 4 MiB per answer, `total` size).
- `Extension` carries `lua_api`, `scope`, `listeners` (the operator's settings), `secret_version`; `SiteExtension` carries `data`; `ExtensionStatus` carries `details_json`.
- Node-scope extensions are delivered to every cluster while enabled, or to the clusters chosen in the extension's settings (`clusterIds`).

## Compatibility

- Format and Lua API versions only grow: a node that supports Lua API 1 keeps every call above; new calls come with a higher `lua_api` and the console refuses packages that need an API a target node lacks.
- Consoles reject manifests with unknown members, so a package for a later format fails verification instead of running half-understood.
