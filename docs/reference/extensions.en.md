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

## Compatibility

- Format and Lua API versions only grow: a node that supports Lua API 1 keeps every call above; new calls come with a higher `lua_api` and the console refuses packages that need an API a target node lacks.
- Consoles reject manifests with unknown members, so a package for a later format fails verification instead of running half-understood.
