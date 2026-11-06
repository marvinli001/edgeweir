# Node extensions

Node extensions add Lua code to the request path of edge nodes. Anyone can write and sign one; the operator decides which publishers to trust, installs packages in the console, configures them and turns them on per site. The console distributes packages to nodes over the node channel and nodes load them. Neither the console nor the node checks licenses or contacts anyone about extensions; everything goes through the console's normal API.

This page is the format and runtime contract (`edgeweir-node-extension-v1`, Lua API 1 / 2). Site extensions can be installed and run; [node scope and HTTP listeners](#node-scope-and-http-listener-contract) have a separate contract and feature requirement. A Lua API version alone does not establish support. The [guide](../guide/extensions.en.md) describes the console screens.

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
| `requires.lua_api` | Required, `1` or `2`; API 2 members are described below |
| `requires.node` | Optional semver range: space-separated comparators (`>=1.7.0 <2.0.0`), operators `=`, `>`, `>=`, `<`, `<=` |
| `scope` | Optional, `site` (default) or `node`; omission preserves old site-extension behavior. `sites` is not a valid value. See the node-scope support requirements below |
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

Changes are audited (`extension.install`, `extension.upgrade`, `extension.activate`, `extension.delete_version`, `extension.update`, `extension.uninstall`, `extension.settings_update`, `extension.node_settings_update`, `extension_key.add`, `extension_key.remove`, `site.extension_update`). Changes affecting site delivery publish the affected clusters in the same transaction. Node settings are stored without publishing a configuration revision. The same procedures serve `/rpc` for the console UI. Service account keys cannot call them.

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
| `ew.respond(status, body?, headers?)` | Answer directly (no origin). Response headers starting with `X-Edgeweir-` are the node's and extensions cannot set or clear them, except the extensions' own prefix `X-Edgeweir-Ext-` (a sidecar's response headers, for instance) and `X-Edgeweir-Challenge`, with which `ew.respond` may mark its own challenge page |

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
- Every hook call runs under `pcall`. An error or a call longer than the budget (10 ms wall time, including waits on cosockets in `access` / `access_late` / `endpoint`: 1000 ms) is a fault. The budget is checked after the call returns and cannot interrupt a synchronous infinite loop; install only trusted publishers' code. 20 faults within 60 seconds in a worker trip the extension in that worker for 60 seconds; tripped extensions are treated like failing ones.
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

Version 1.1 keeps the package format `edgeweir-node-extension-v1` and adds secrets, native helper processes (sidecars) and site data. Everything in this section needs `"requires": {"lua_api": 2}`; the node feature is `extensions-v2` (a node with it runs Lua API 1 and 2 packages). The console refuses a package that uses a member of this section with `lua_api: 1`, and delivers an API 2 extension only to clusters whose active nodes all report `extensions-v1` and `extensions-v2` (`NODE_CAPABILITY_REQUIRED` otherwise). `extensions-v2` does not establish node-scope or listener support.

`pnpm e2e --only core,extensions --up --down --serial` uses the bundled neutral `api-v2-probe` fixture to check signed delivery, Lua API 2, secret rotation, disabling and removal. No additional repository is required. `E2E_EXTENSION_PACKAGES` accepts a JSON array of additional API 2 site-extension fixture directories; the bundled fixture always runs.

### Manifest members (API 2)

| Member | Rules |
| --- | --- |
| `secret` | `true`: the console keeps a random 32-byte secret for the extension and nodes expose it as `ew.secret()` (see [Secrets](#secrets)) |
| `sidecar` | A native helper process (see [Sidecars](#sidecars)). Needs the capability `sidecar` |
| `data` | `{ "max_bytes": ≤ 25165824, "max_items": ≤ 32, "max_total_bytes": ≤ 268435456 }`: the extension accepts per-site data items (see [Site data](#site-data)); needs `sidecar` |
| Limits | API 2 raises `fields` to ≤ 16, `log_fields` to ≤ 16 and `counters` to ≤ 32 |

Capabilities gain `sidecar`. A package with a sidecar may be up to 64 MiB (archive), 192 MiB unpacked, with files up to 96 MiB; `POST /extensions` and `POST /extensions/verify` accept requests up to 96 MiB for them.

### API 2 calls

| Call | Notes |
| --- | --- |
| `ew.site_name` | The site's primary domain (its first domain) |
| `ew.req.http_version()` | `"1.0"`, `"1.1"`, `"2"`, `"3"` |
| `ew.req.request_length()`, `ew.req.request_time()` | Bytes received (request line, headers, body) and seconds since the first byte; `log` |
| `ew.resp.bytes_sent()` | Bytes sent to the client; `log` |
| `ew.resp.upstream_status()`, `upstream_response_time()`, `upstream_connect_time()`, `upstream_header_time()` | The last origin attempt's status and times in seconds; `nil` without an origin request (cache hits, the node's own answers); `log` |
| `ew.resp.reason()` | The node's block reason of the request and its rule id (`"rate_limit", "<rule id>"`), `""` when none; reasons as in the access logs (`ip_banned`, `ip_blocked`, `rule`, `rate_limit`, `crs`, `cc`, `challenge`, `auth`, `referer`, `user_agent`, `region`, `cors`, `websocket_origin`, `client_cert`, `maintenance`, `extension`) |
| `ew.req.verified_bot()` | The verified search engine crawler name (PTR plus forward lookup, as for the site's crawler setting) or `nil`; `access`, `access_late`; its DNS wait does not count against the budget |
| `ew.req.exempt()` | `true` when the client is on one of the site's allow lists or a platform allow list (the clients the node exempts from bans and challenges); `access`, `access_late` |
| `ew.node.id()`, `name()`, `cluster_id()`, `version()` | The node's identity and agent version |
| `ew.node.connections()` | `{ active, reading, writing, waiting }` of the nginx worker's view (stub_status), in request hooks; `nil` in timers |
| `ew.node.status()` | The node's last reported host metrics `{ at, cpu_percent, load1, load5, load15, memory_used_bytes, memory_total_bytes, egress_bps, active_connections }` (`nil` before the first report); any hook |
| `ew.secret()`, `ew.secrets()` | `secret: true`: the current secret (32 raw bytes); `ew.secrets()` returns `{ current, previous }` (`previous` `nil` before the first rotation) |
| `ew.equal(a, b)` | Constant-time comparison of two strings |
| `ew.sidecar.ready()` | `sidecar`: whether the sidecar passed its health check |
| `ew.sidecar.proxy(opts)` | `sidecar`; `access_late` only: verdict that hands the request to the sidecar (see [Sidecars](#sidecars)) |

Clarifications for both API versions: `ew.req.pass_level()` is 0 (none), 1 `cookie302`, 2 `js`, 3 `pow`, 4 `captcha`; `ew.sha256` and `ew.hmac_sha256` return 32 raw bytes; `ew.req.header(name)` is case-insensitive and joins repeated headers with `", "`; `ew.respond` may set `Set-Cookie` and sends no body for `HEAD`; `ew.ctx` is one table per request and extension across all its hooks (also `endpoint` and `log`); access hooks do not run for `/.edgeweir/ext/<id>/…` requests, the `log` hook does; header filter hooks also run on responses an extension produced with `ew.respond`; a same-origin `src` with a query string counts as same origin, and assets are served regardless of the query string.

### Node scope and HTTP listener contract

Node scope uses the normal package verification, installation and distribution interfaces. `PATCH /extensions/{id}` manages enablement and global configuration; the independent node settings interface manages `listeners` and `clusterIds`. Proto `Extension` carries scope and listener fields. A valid manifest must still meet the target nodes' feature requirements.

Existing nodes also reject the unknown manifest member `scope`. Package entry points therefore refuse an explicit `scope: "site"` in the original manifest, with the same code and `reason`, and `detail: "scope: explicit site scope is not supported by this console"`. Installable site packages must omit `scope`; parsing defaults it to `site` without changing package bytes.

A complete node-scope implementation must provide distribution, node configuration validation, listener rendering and Lua hooks. Every active node in a target cluster must report `extensions-v1`, `extensions-v2` and `extensions-node-v1`, and meet optional `requires.node`. Neither a version number nor `extensions-v2` alone suffices. Missing features prevent enablement (`NODE_CAPABILITY_REQUIRED`); implementations must not omit listeners or downgrade to site scope. A node may announce `extensions-node-v1` only with all of these behaviors implemented.

| Manifest | `site` (default) | `node` (requires Lua API 2) |
| --- | --- | --- |
| Hooks | `init`, `access`, `access_late`, `header_filter`, `body_filter`, `log`, `endpoint` | Only `init`, `log`, `listen` |
| Capabilities | All capabilities on this page | Only `request_body`, `http_client`, `timers` |
| Configuration | `config.global`, `config.site` | Only `config.global`; no `config.site`, even an empty schema |
| Site-only members | `fields`, `endpoints`, `sidecar`, `data` | No non-empty `fields` / `endpoints`, no `sidecar` / `data` |
| Shared members | `log_fields`, `counters`, `shared_dicts`, API 2 `secret` | Allowed with the same API 2 limits; log fields and per-site counters may be written only in `log` |
| `listeners` | Must be absent, even an empty array is refused | At most 2 HTTP listener declarations; non-empty declarations and the `listen` hook must occur together |

Node scope needs no site association. Its `log` hook runs once for each site request on a target node, after site extensions, and always fails open; dedicated listener requests do not call it again. In `log`, `ew.site_id` / `ew.site_name` identify the request's site and `ew.site_config` is `nil`; all three are `nil` in `init`, timers and `listen`. Node extensions cannot mutate site requests, return site verdicts or proxy to origins. `init`, shared dicts, logging and timers keep the existing isolation, budgets and circuit breaker.

Declaration example (extension `node-status` from publisher `example.org`):

```json
{
  "scope": "node",
  "requires": { "lua_api": 2 },
  "hooks": ["log", "listen"],
  "listeners": [{ "name": "status", "default_port": 9145, "methods": ["GET", "HEAD"], "max_body": 4096 }]
}
```

These are partial manifest members; the other identity and signature rules still apply. Names must be unique and match `^[a-z][a-z0-9_]{0,15}$`. Required `default_port` is a suggestion to the operator and never opens a port automatically: integer 1024–65535, with 8443 reserved. `methods` is a non-empty, unique subset of `GET`, `HEAD`, `POST`. `max_body` is an integer 0–65536 bytes, default 4096. Unknown declaration members are refused.

Separate operator settings are strictly validated by `extensionNodeSettings(manifest, reservedPorts)`, apart from the extension's own global configuration:

```json
{
  "listeners": { "status": { "port": 9145, "bind": "0.0.0.0", "allow": ["10.0.0.0/8"] } },
  "clusterIds": ["00000000-0000-4000-8000-000000000001"]
}
```

- `listeners` defaults to `{}`. An absent or `null` listener is off. Only declared names are allowed, at most 2. `port` is required, with the same range as `default_port`. `bind` defaults to the single IPv4 address `0.0.0.0`; an unbracketed IPv6 literal is also allowed. No host names, ranges, zone IDs or IPv4-mapped IPv6. Addresses are stored canonically. `::` binds IPv6 only, without an implicit IPv4 binding.
- Required `allow` contains 1–64 IPv4 / IPv6 addresses or CIDRs; IPv4-mapped IPv6 is refused. Bare addresses become `/32` or `/128`, host bits are cleared, entries sorted and deduplicated. There is no default allowed range. `0.0.0.0/0` or `::/0` explicitly allows all corresponding addresses. Before Lua, nodes refuse clients outside the list with 403 using the TCP peer address, ignoring forwarding headers and the sites' client-address trust settings.
- `clusterIds` may be omitted or set to `null` (all clusters), `[]` means no cluster, or up to 256 unique UUIDs may be supplied (stored sorted). The service must check cluster existence in its transaction. Unknown declaration or settings members are refused; site extensions cannot have node settings.
- Two listeners of an extension cannot share a port, even on different bind addresses. Callers must supply inclusive reserved port ranges (`{start, end}`) from every target cluster: edge HTTP(S) ports, layer-4 applications and pools, internal services and effective listeners of other enabled extensions. Any conflict is refused, regardless of bind address. Saving, enabling, selecting clusters, upgrading and rolling back must validate under the port lock. Node preflight must still discover unknown processes holding a port or an address absent on that node.

The validator returns Zod issues. Association errors use `custom`: `node settings need node scope` (root), `unknown listener` (`listeners.<name>`), `listener port conflict` (`listeners.<name>.port`). Type, count, unknown-key and address errors also carry precise paths. Implementations must not drop keys and continue or save partial settings.

#### Node settings API

| Action | API (`/api/v1`) | Effect |
| --- | --- | --- |
| Read | `GET /extensions/{id}/node-settings` | Saved settings and resolved `targetClusterIds` |
| Preflight | `POST /extensions/{id}/node-settings/check` | Validates a proposed replacement without saving or auditing |
| Save | `PUT /extensions/{id}/node-settings` | Replaces the independent operator settings and audits the change |

Preflight and save take `{"settings":{"listeners":{"status":{"port":9145,"allow":["10.0.0.0/8"]}},"clusterIds":["00000000-0000-4000-8000-000000000001"]}}`. Omitted listeners remain off; omitting `clusterIds` or setting it to `null` selects all clusters, including future clusters. Methods and body limits always come from the verified manifest; settings cannot override them. Unknown names, including names set to `null`, and unknown request members are rejected.

Node packages use normal signature-verified installation. Enabling and distribution require target nodes to report `extensions-node-v1` and the required API features. Legacy site packages continue to omit `scope`; explicit `scope: "site"` is still rejected because older nodes do not accept that manifest member. Saving node settings does not change the package bytes, digest, signature or global configuration. A successful save confirms storage; check target nodes' revisions, content hashes and failures for application results.

In System → Extensions, the list and details show **Site** or **Node**, taken from the active validated manifest. Old packages without `scope` remain site extensions. Node extensions do not appear in a site's extension bindings.

In **Node settings**, choose **All clusters (including future clusters)** (`clusterIds: null`), **Selected clusters** (an explicit non-empty subset), or **No clusters** (`clusterIds: []`). An empty selected subset must be resolved explicitly; it never becomes all clusters. Listeners start off even when the manifest declares `default_port`. Enable a listener explicitly, enter its port, then expand **Address and access** to set the bind IP and the required allow list (one IP/CIDR per line, or separated by commas). The suggested port, listener name, methods and body limit are read-only declarations. Disabling a listener retains its draft but saves that binding as `null`; the extension's enable switch controls the whole extension, including its other hooks.

**Preflight** checks the proposed settings without saving. Failed checks or saves keep the fields and draft; invalid folded fields open for correction. Retry with the same action. **Save** reports **Saved**. Target-node compatibility uses reported features, including `extensions-node-v1` as well as the required API features; Lua API 2 alone is insufficient. Offline or unreported nodes show **Unknown**. Reported application or listener failures remain visible alongside the node's revision and content hash. **Node details** opens the existing revision, application and log information. Neither a reported feature nor a node's unrelated applied revision proves these settings are live: the settings API supplies no delivery revision or per-node application correlation. Core preflight also cannot establish that the chosen address exists or that the operating system can bind the port.

Port checks cover the selected clusters' edge ports, L4 pools of either protocol, L4 application ranges, known current revision ports, the configured tiered-cache port and other enabled node extension listeners. The tiered-cache port stays reserved when the default topology is off because sites can override it. Conflicts use `PORT_BINDING_CONFLICT` (409) with `port`, `cluster`, `clusterId` and `owner`; invalid settings use `EXTENSION_NODE_SETTINGS_INVALID` (400) with `path` and `issue`. A wrong scope uses `EXTENSION_SCOPE_MISMATCH` (400); changing an installed extension's scope uses `EXTENSION_SCOPE_CHANGE` (409), even when disabled.

A cluster explicitly selected in saved node settings cannot be deleted, even when the extension is disabled. Deletion returns `CLUSTER_NODE_EXTENSION_IN_USE` (409) with the referencing extension ids in `extensions`. Remove the cluster from those settings first; `clusterIds: []` continues to mean no clusters and is never changed to all clusters automatically.

Saving, enabling, upgrading, rolling back, changing targets, changing edge/L4/tier ports and adding clusters share a transaction port lock. A failed check rolls back the change and its audit. Disabled extensions and the kill switch release their effective reservations; enabling again checks the current port snapshot. All-cluster selections are checked when a cluster is created. Core cannot inspect a node's local `--default-port`, other local configuration, operating-system processes or assigned addresses: node preflight must still check these before binding.

Listener runtime contract:

- Dedicated plain HTTP only: no site Host matching, rules, challenges, CC, cache, site access logs, static assets or origin forwarding. The extension handles authentication beyond the address list, for example a global configuration token compared with `ew.equal`. An address list does not keep tokens confidential; the operator must provide a protected network or TLS termination. Core adds no license checks or external calls.
- Declared methods call `listen(ew, name, path)` and return `ew.respond(...)`, without needing `verdicts`. Other methods return 405 before Lua. `ew.req.body()` requires `request_body` and is bounded by `max_body`, including bodies without `Content-Length`; oversized bodies return 413 before Lua. `HEAD` sends no body. The wall-time budget is 1000 ms. Errors, timeouts and circuit trips return 503; no valid response returns 500, regardless of `open` / `closed`. Never fall through to a site or origin.
- Port, bind address, allow list and listener enablement changes are structural, requiring preflight and a graceful reload. A listener that cannot bind stays off and reports `failed`; other configuration may apply. Do not silently retain that listener's old port or allow list. A failure of the overall rendering or reload rejects the revision and retains the previous complete configuration, reporting failure.
- Disabled or uninstalled extensions, unselected clusters, the kill switch and `--no-extensions` run no hooks and serve no listeners; stopping service must close its bindings. The kill switch and local node disablement take precedence over rollback. Upgrade and rollback first validate the target manifest, global configuration, listener names/settings, ports and node features. A failure changes no version and publishes no partial configuration, retaining the old package, settings and bindings. An installed extension cannot switch between `site` and `node` scope.

Signatures always cover the original `.ewx` bytes. Default scope applies only to the parsed manifest and must not rewrite an old package or change its digest. The empty-by-default trust store, publisher binding, local `--extension-keys`, mTLS package/secret retrieval and `--no-extensions` retain the site-extension boundaries. Local node disablement announces no extension features.

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

- **Own user.** The sidecar never runs as the agent's or nginx's user: the agent starts it as `--sidecar-user USER` (unprivileged, not the agent's user), for which the agent runs as root or holds `CAP_SETUID`, `CAP_SETGID` and `CAP_KILL` (to switch users and signal the sidecar; the container image built with `--build-arg SIDECAR_CAPABILITY=true` gives the agent all three as file capabilities and has the user `edgeweir-sidecar`: add `-e EDGEWEIR_SIDECAR_USER=edgeweir-sidecar`). An agent that is not root must be a member of that user's primary group (as in the image) to hand data and socket directories to the group. `run --sidecar-mode auto|user|off` chooses (`auto` is `user`); `off` refuses sidecars. A `systemd` mode starting sidecars as template units with `DynamicUser=yes` is not available yet.
- **Sandbox.** The agent starts the sidecar through its own helper `edgeweir-node sidecar-exec`: it joins the sidecar's cgroup (when one can be made), sets resource limits, switches user and group (no supplementary groups), sets `PR_SET_NO_NEW_PRIVS`, loads a seccomp filter and executes the sidecar with a clean environment and no capabilities. The filter refuses `ptrace`, `process_vm_*`, mounts, namespaces (`unshare`, `setns`, `clone` with namespace flags; `clone3` gets `ENOSYS`), BPF, perf, keyrings, kernel modules, reboot, clock changes, swap and `userfaultfd`; system calls of another architecture kill the process. Memory, task and CPU limits come from the manifest (when the agent's cgroup v2 allows a child group; otherwise `RLIMIT_DATA` and `RLIMIT_NPROC` for memory and tasks, and no CPU limit); no core dumps.
- **What it can reach.** One directory per extension under the sidecar directory (`--sidecar-dir`, by default the node's state directory plus `-sidecar`, `/var/lib/edgeweir-node-sidecar` in the container): `package/` (a copy of the package, read-only), `state/` (writable, `$EDGEWEIR_EXT_STATE`) and `data/` (read-only, `$EDGEWEIR_EXT_DATA`). There is no separate view of the file system beyond permissions: the node's state directory (keys, credentials, configuration) and the agent's and nginx's control sockets are open to the node's user only, so the sidecar cannot read or connect to them, nor signal other processes.
- **Network.** Outbound connections are allowed (a function runtime calls APIs); the sidecar must refuse special-purpose destinations itself. To reach a site's own origin it uses the origin socket below, so private origin addresses never need to be reachable from it.

Sockets (directory: the control socket's directory plus `-ext/<id>/`, `/run/edgeweir-node-ext/<id>/` in the container; owned by nginx's user and the sidecar user's group, mode 2770, so only the two reach it):

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

Items are stored in the console's database. Configuration carries `{name, sha256, size}` per site and extension; nodes fetch missing items by digest over the node channel (`GetExtensionData`, mTLS, in chunks of 4 MiB), check the digest, and store them under `<id>/data/<site id>/<name>` in the sidecar directory, readable by the node's user and the sidecar user's group only, deleting items no configuration references. Data changes are hot: no nginx reload.

The sidecar learns about sites, configuration and data from `$EDGEWEIR_EXT_DATA/index.json`, written atomically after every item of a revision is present, followed by `SIGHUP`:

```json
{ "revision": 42, "config": { "...": "global configuration" },
  "sites": { "<site id>": { "name": "shop.example", "domains": ["shop.example"], "config": { "...": "site configuration" },
    "data": [{ "name": "fn-main.wasm", "sha256": "…", "size": 9123456, "path": "/var/lib/edgeweir-node-sidecar/<id>/data/<site id>/fn-main.wasm" }] } } }
```

Only sites that turn the extension on appear. Site configuration is visible to Lua and the console API (masked `x-secret` values aside); secrets belong in data items.

### Node state details

Each extension's node state carries `details` (JSON, ≤ 4 KiB): `sidecar` (state, pid, restarts, last exit, since), and whatever the sidecar returns from `GET /status` on its socket under `sidecar.status` (≤ 2 KiB, polled every 30 s). An implementation of `extensions-node-v1` must also report `listeners` (`{name: {port, state: "listening" | "failed", message}}`); a details member alone does not establish listener support.

### Distribution changes in 1.1

- `GetExtensionPackage` and `GetExtensionData` transfer in chunks (`offset`, at most 4 MiB per answer, `total` size).
- `Extension` carries `lua_api` and `secret_version`; `SiteExtension` carries `data`; `ExtensionStatus` carries `details_json`. These fields do not distribute node scope or listeners.

## Compatibility

- Format and Lua API versions only grow: a node that supports Lua API 1 keeps every call above; new calls come with a higher `lua_api` and the console refuses packages that need an API a target node lacks.
- Consoles reject manifests with unknown members, so a package for a later format fails verification instead of running half-understood.
