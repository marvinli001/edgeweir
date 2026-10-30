# 节点扩展

节点扩展把 Lua 代码加进边缘节点的请求路径。任何人都可以编写并签名扩展；运营者决定信任哪些发布者，在控制台安装扩展包、配置，并按网站开启。控制台经节点通道把扩展包分发给节点，节点加载运行。控制台和节点都不为扩展校验许可证、不连接任何外部服务；一切操作都经过控制台的公开 API。

本页是格式与运行时契约（`edgeweir-node-extension-v1`，Lua API 1）。控制台界面见[使用指南](../guide/extensions.md)。

## 概览

| 术语 | 含义 |
| --- | --- |
| 扩展包 | `.ewx` 文件：gzip 压缩的 tar，含 `manifest.json`、Lua 模块与可选的静态资源 |
| 签名 | `.ewx.sig` 文件：对扩展包 SHA-256 与身份的紧凑 JWS（EdDSA / Ed25519） |
| 发布者公钥 | 运营者为某个发布者名称信任的 Ed25519 公钥；默认不信任任何公钥 |
| 扩展 | 已安装的扩展包 id；保留每个上传过的版本，运行其中一个（当前版本） |
| 钩子 | 节点在请求的固定位置调用的 Lua 函数 |
| 总开关 | 控制台设置，一次停止所有节点上的全部扩展 |

## 扩展包

扩展包是 POSIX ustar 归档的 gzip 流。

- 条目只能是普通文件和目录（不允许链接、设备，除 `path` 记录外不允许 PAX / GNU 扩展头）；路径为相对路径，由 `/` 分隔的 `[A-Za-z0-9._-]` 段组成，不含 `.` 或 `..` 段，至多 200 字节，且不重复。
- 上限：归档 ≤ 4 MiB，解包后 ≤ 16 MiB，≤ 512 个条目，单个文件 ≤ 4 MiB。
- 顶层只允许：`manifest.json`（必需）、`lua/`（必需，须含 `main.lua`）、`assets/`，以及名为 `LICENSE*`、`NOTICE*`、`README*` 的文件，其他一律拒绝。`lua/` 下的文件必须以 `.lua` 结尾。
- 不含原生代码：不允许 `.so` / `.dll` / `.dylib`，不理会可执行位，不允许 LuaJIT 字节码（每个 `.lua` 必须是文本，以文本模式加载）。
- 文件权限、属主与时间被忽略。`edgeweir-node extension pack` 生成可复现的归档（条目排序、mtime 0、uid/gid 0、权限 0644/0755）。

### manifest.json

UTF-8 JSON，至多 64 KiB。未知的顶层成员一律拒绝（新格式的扩展包不会被一知半解地运行）。

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

| 成员 | 规则 |
| --- | --- |
| `format` | 固定为 `edgeweir-node-extension-v1` |
| `id` | `^[a-z][a-z0-9-]{1,38}[a-z0-9]$`；不能是 `edgeweir`、`core`、`challenge`、`session`、`health`、`ext` |
| `version` | 语义化版本 2.0.0，不带构建元数据（`1.2.3`、`1.2.3-rc.1`） |
| `publisher` | `^[a-z0-9]([a-z0-9.-]{0,61}[a-z0-9])?$`，通常是发布者控制的域名；必须等于签名公钥所属的发布者 |
| `name` | 语言（`en` 必需，`zh-CN` 可选）到 ≤ 64 字符名称的映射 |
| `description` | 可选，同样的语言，≤ 512 字符 |
| `license`、`homepage` | 可选，仅供展示（SPDX 表达式 ≤ 128 字符；`https://` 地址） |
| `requires.lua_api` | 必需，`1` |
| `requires.node` | 可选，semver 范围：空格分隔的比较式（`>=1.7.0 <2.0.0`），运算符 `=`、`>`、`>=`、`<`、`<=` |
| `hooks` | `init`、`access`、`access_late`、`header_filter`、`body_filter`、`log`、`endpoint` 的非空子集；每个都要在 `main.lua` 里有同名函数 |
| `capabilities` | [能力](#能力)表中的子集；超出范围的 API 调用抛出错误 |
| `config.global`、`config.site` | 可选，全局与网站配置的 JSON Schema（子集见下）；缺省为不含属性的 `{}` |
| `fields` | ≤ 16 个规则字段，`name` 为 `^[a-z][a-z0-9_]{0,31}$`，`type` 为 `string`、`number` 或 `boolean`；规则中写作 `ext.<id>.<name>` |
| `log_fields` | ≤ 8 个名称（同上）；访问日志里为 `ext.<id>.<name>` |
| `counters` | ≤ 8 个名称（同上）；按网站的分钟计数 `ext.<id>.<name>` |
| `endpoints` | ≤ 8 项，`path` 为 `^[a-z0-9][a-z0-9._-]{0,63}$`（单段），`methods` 为 `GET HEAD POST PUT DELETE OPTIONS` 的子集，可选 `max_body` ≤ 65536（默认 4096）；在开启该扩展的每个网站上以 `/.edgeweir/ext/<id>/<path>` 提供。`assets` 不能作路径 |
| `shared_dicts` | ≤ 4 项，`name` 为 `^[a-z][a-z0-9_]{0,15}$`，`size_kb` 16–16384，合计 ≤ 32768 |

### 配置 Schema 子集

Schema 为 JSON Schema 2020-12，限于控制台能渲染和校验的部分：

- 根为 `{"type": "object", "properties": {…}}`，可带 `required` 与 `additionalProperties: false`（默认即如此；未知键一律拒绝）。
- 属性为以下之一：`string`（`enum`、`minLength`、`maxLength` ≤ 4096、`pattern`（ECMAScript 与 PCRE 共有的子集：不用后行断言、不用反向引用）、`format`：`uri` 或 `hostname`）；`integer` / `number`（`minimum`、`maximum`、`enum`）；`boolean`；字符串或整数的 `array`（`items` 用上述关键字，`maxItems` ≤ 256，`uniqueItems`）。
- 每个属性可带 `title`、`description`（纯字符串或语言映射）、`default`，以及 `x-secret: true`（字符串，在界面与 API 响应里遮蔽；按原样保存。所有值都会下发到节点，不要在这里放不能到达节点的凭据）。
- 格式 v1 不支持嵌套对象、`$ref`、`oneOf` / `anyOf` / `allOf`、`if`。
- 控制台每次写入时补齐默认值并校验；节点收到完整对象。

## 签名

`<扩展包>.ewx.sig` 是一行 JWS 紧凑序列化（RFC 7515）：

- 受保护头：恰好 `{"alg":"EdDSA","kid":"<kid>","typ":"edgeweir-ext+jws"}` 这些成员（顺序不限）；不允许 `crit`、`jku`、`jwk`、`x5u`。
- 载荷：JSON `{"format":"edgeweir-node-extension-v1","id":"…","version":"…","publisher":"…","sha256":"<.ewx 字节的 64 位小写十六进制>","size":<字节数>,"iat":<Unix 秒>}`。
- 签名：对 `BASE64URL(头) "." BASE64URL(载荷)` 的 Ed25519（RFC 8037）。
- `kid` 是发布者公钥的 RFC 7638 JWK 指纹：`BASE64URL(SHA-256('{"crv":"Ed25519","kty":"OKP","x":"<x>"}'))`。

只有同时满足以下条件才接受扩展包：头如上；`kid` 指向受信任的公钥；公钥所属发布者等于载荷与 manifest 的 `publisher`；签名有效；`sha256` 与 `size` 与上传的字节一致；`id`、`version`、`format` 与 manifest 相同。通过检查前，归档里的任何内容都不被信任。

### 发布者公钥

发布者生成 Ed25519 密钥对，在自己的渠道公布 JWK 形式的公钥（`{"kty":"OKP","crv":"Ed25519","x":"…"}`）。运营者在控制台（系统 → 扩展 → 受信任的公钥）连同发布者名称一起添加。默认不信任任何公钥，控制台不自带公钥；有已安装的版本由某把公钥签名时，不能删除这把公钥。

```bash
edgeweir-node extension keygen --out publisher.jwk          # 私钥 JWK，0600；打印公钥 JWK 与 kid
edgeweir-node extension pack --out hello-header-1.0.0.ewx ./hello-header   # 参数在前
edgeweir-node extension sign --key publisher.jwk --publisher example.org hello-header-1.0.0.ewx   # 写出 .ewx.sig
edgeweir-node extension verify --pubkey publisher.pub.jwk --publisher example.org hello-header-1.0.0.ewx
```

## 生命周期

| 操作 | API（`/api/v1`） | 效果 |
| --- | --- | --- |
| 校验 | `POST /extensions/verify` | 检查扩展包与签名，返回 manifest、摘要与公钥；不保存 |
| 安装 / 升级 | `POST /extensions` | 校验、保存该版本并设为当前版本。新 id 安装后为停用；已安装 id 的更高或更低版本成为当前版本（先按新 Schema 校验现有配置） |
| 回滚 | `POST /extensions/{id}/activate` | 把另一个已保存的版本设为当前版本 |
| 删除版本 | `DELETE /extensions/{id}/versions/{version}` | 只能删除非当前版本 |
| 启用 / 停用、配置 | `PATCH /extensions/{id}` | `enabled`、`failureMode`（`open` / `closed`）、`config`（全局） |
| 按网站 | `GET /sites/{id}/extensions`、`PUT /sites/{id}/extensions/{extensionId}` | `enabled`、`config`（网站） |
| 卸载 | `DELETE /extensions/{id}` | 删除全部版本与全局、网站设置。有规则读取它的字段时拒绝（`EXTENSION_IN_USE`） |
| 总开关 | `GET` / `PUT /extensions/settings` | `disabled: true` 停止所有节点上的全部扩展（扩展包保持安装） |
| 受信任的公钥 | `GET` / `POST /extension-keys`、`DELETE /extension-keys/{kid}` | 信任库 |
| 状态 | `GET /extensions/{id}` | manifest、版本、配置、网站与各节点的加载状态 |

每次写入都记审计（`extension.install`、`extension.upgrade`、`extension.activate`、`extension.delete_version`、`extension.update`、`extension.uninstall`、`extension.settings_update`、`extension_key.add`、`extension_key.remove`、`site.extension_update`），并在同一事务里发布新的配置版本。控制台界面经 `/rpc` 调用同样的过程。服务账号 key 不能调用。

扩展包以 JSON 中的 base64 上传（`{"package": "<base64>", "signature": "<jws>"}`）；16 MiB 的请求上限足以容纳 4 MiB 的归档。

## 分发

1. 配置带有集群中有网站开启的每个已安装扩展（当前版本、摘要、大小、签名、签名公钥、启用、失败模式、全局配置）、各网站开启的扩展及网站配置，以及总开关。
2. 节点声明 `extensions-v1`。下发了任何扩展的配置要求 `extensions-v1`；若会收到该扩展的集群里有不支持的活动节点，控制台拒绝启用扩展或在网站上开启（`NODE_CAPABILITY_REQUIRED`）。
3. 节点按摘要取回缺少的扩展包（`GetExtensionPackage`，mTLS），检查大小与 SHA-256，用下发的公钥验证 JWS（若 `--extension-keys` 指定了本地 JWK 文件，还要求公钥在其中），解包并按与控制台相同的规则校验 manifest，检查 `requires`。失败的扩展包不加载并上报；配置的其余部分照常应用。
4. 加载的扩展包集合变化（安装、升级、卸载、共享字典大小）时重新渲染 `nginx.conf` 并平滑 reload。启用 / 停用、配置、网站设置与总开关为热更新。
5. 节点上报每个扩展的状态（`loaded`、`failed`、`incompatible`、`disabled`）、最近的错误与故障计数。当前与上一份配置都不再引用的扩展包文件被删除。

`edgeweir-node run --no-extensions` 在该节点上关闭整个机制：不声明 `extensions-v1`，从不下载或加载扩展包，控制台无法覆盖。

## 运行时

### 钩子

`lua/main.lua` 返回一张表；节点以 API 对象 `ew`（每个扩展、每个请求一个）调用其中声明的函数：

| 钩子 | 时机 | 可以 |
| --- | --- | --- |
| `init(ew)` | 每个 worker（重新）加载后，扩展首次使用时一次 | 准备状态；有 `timers` 时可用 `ew.timer` |
| `access(ew)` | 主机查找、封禁与保留路径之后，访问控制、规则与挑战之前 | 设置字段、读取请求、返回裁决 |
| `access_late(ew)` | 规则与挑战通过之后，CRS、缓存与回源之前 | 返回裁决、设置回源请求头 |
| `header_filter(ew)` | 开启该扩展的网站的每个响应的响应头（含节点自己的页面，不含保留路径） | 读取 / 修改响应头、排队 HTML 注入 |
| `body_filter(ew, chunk, eof)` | 每个响应体分块，仅限 `body_rewrite` | 返回替换的分块（`nil` 为不变） |
| `log(ew)` | 日志阶段，写访问日志之前 | 设置日志字段、计数 |
| `endpoint(ew, path)` | `endpoints` 声明的 `/.edgeweir/ext/<id>/<path>` 请求 | 返回 `ew.respond(...)` |

钩子只在开启该扩展的网站上运行，按扩展的安装顺序。对未开启的网站请求 `/.edgeweir/ext/<id>/…` 得到 404。与节点的其他保留路径一样，静态资源与端点受封禁和 CC 约束（并计入 CC），不经过访问控制、规则与挑战。

### 裁决

`access` 与 `access_late` 不返回值即继续，或返回以下之一：

| 裁决 | 效果 |
| --- | --- |
| `ew.deny(status?)` | 节点错误页，状态 `status`（400–499，默认 403），`X-Edgeweir-Error: extension-denied`，原因 `extension`，规则 id `ext:<id>` |
| `ew.challenge(level)` | 核心挑战，级别 `cookie302`、`js`、`pow` 或 `captcha`；有该级别的凭证则继续 |
| `ew.allow()` | 仅 `access`：本请求跳过 Under Attack 与 CC 挑战（规则与 WAF 照常） |
| `ew.respond(status, body?, headers?)` | 直接应答（不回源） |

第一个裁决生效，之后的扩展钩子不再调用。裁决需要 `verdicts`。

### API

| 调用 | 说明 |
| --- | --- |
| `ew.id`、`ew.version`、`ew.api`（`1`） | |
| `ew.site_id`、`ew.global_config`、`ew.site_config` | 配置表（扩展自己的副本，不要修改） |
| `ew.ctx` | 本请求、本扩展在各钩子间共享的表 |
| `ew.req.method()`、`host()`、`path()`、`query()`、`uri()`、`scheme()`、`header(name)`、`headers()`、`cookie(name)`、`arg(name)`、`client_ip()`、`country()`、`asn()`、`ja4()`、`request_id()`、`pass_level()` | 请求视图（副本） |
| `ew.req.body()` | `request_body`；`access`、`access_late`、`endpoint`：带 `Content-Length` 且不超过 64 KiB（端点为其 `max_body`）的请求体，否则为 `nil, "truncated"` |
| `ew.req.set_header(name, value)`、`ew.req.clear_header(name)` | `request_headers`；发往源站的请求头 |
| `ew.resp.status()`、`header(name)`、`content_type()`、`cache_status()` | 响应视图（`header_filter`、`body_filter`、`log`） |
| `ew.resp.set_header(name, value)`、`add_header`、`clear_header` | `response_headers`；仅 `header_filter` |
| `ew.html.inject(position, html)` | `html_inject`；位置 `head_end` 或 `body_end`；每个扩展每个响应 ≤ 8 KiB |
| `ew.html.script({src=, inline=, defer=, async=, type=})` | `html_inject`；在 `head_end` 排队一个 `<script>`，nonce 规则见下 |
| `ew.field(name, value)` | 已声明的规则字段；仅 `access`；检查类型 |
| `ew.log_field(name, value)` | 已声明的日志字段；字符串（数字与布尔值会转换），超过 256 字节截断 |
| `ew.count(name, n?)` | 已声明的计数 |
| `ew.shared(name)` | 已声明的共享字典（`ngx.shared` 对象） |
| `ew.log(level, ...)` | `"err"`、`"warn"`、`"info"`；前缀 `[ext <id>]`，限频 |
| `ew.now()`、`ew.sha256(s)`、`ew.hmac_sha256(key, s)`、`ew.random_bytes(n)`、`ew.b64url_encode(s)`、`ew.b64url_decode(s)`、`ew.json_encode(v)`、`ew.json_decode(s)` | 辅助函数 |
| `ew.tcp()` | `http_client`；`ngx.socket.tcp` 协程套接字（`access`、`access_late`、`endpoint`、定时器） |
| `ew.timer(delay, fn)` | `timers`；`init` 与定时器中；`fn(ew)` 在定时器里以同样的隔离与预算运行 |

### 能力

| 能力 | 允许 |
| --- | --- |
| `verdicts` | 在 `access` / `access_late` 返回 `deny`、`challenge`、`allow`、`respond` |
| `request_headers` | 修改发往源站的请求头 |
| `request_body` | 读取请求体 |
| `response_headers` | 修改响应头 |
| `html_inject` | HTML 注入辅助函数 |
| `body_rewrite` | `body_filter` 钩子 |
| `http_client` | 对外 TCP 连接 |
| `timers` | 在 `init` 中启动后台定时器 |

控制台在校验扩展包时与扩展页面上列出能力。

### HTML 注入

节点在 body filter 中每个响应注入一次排队的片段，只针对：`GET`、状态 200、`Content-Type: text/html`、无 `Content-Encoding`、无 `Content-Range`、无 `Cache-Control: no-transform` 的响应。`head_end` 插在前 64 KiB 内第一个 `</head>` 之前（否则在 `</body>` 之前，再否则追加在末尾）；`body_end` 插在响应最后 512 字节内的最后一个 `</body>` 之前（否则追加）。节点去掉 `Content-Length`，并把强 `ETag` 改为弱 ETag。缓存里始终是源站的原文；注入发生在出口，命中与未命中都注入，边缘压缩在其后进行。

CSP：响应带 `Content-Security-Policy` 头时，`ew.html.script` 取有效的 `script-src`（无则 `default-src`）：含 `'nonce-…'` 时脚本带同一个 nonce；含 `'self'`（且 `src` 同源）而无 `'strict-dynamic'` 时直接注入；否则不注入（调用结果为 `false`）。内联脚本需要 nonce。`ew.html.inject`（原样 HTML）不做 CSP 处理。页面内 `<meta>` 声明的策略不解析。

### 静态资源

`assets/` 下的文件在开启该扩展的网站上以 `/.edgeweir/ext/<id>/assets/<path>`（GET / HEAD）提供：`Cache-Control: public, max-age=3600`，ETag 取文件摘要，按扩展名给出类型（`.js`、`.css`、`.json`、`.svg`、`.png`、`.jpg`、`.webp`、`.woff2`、`.txt`、`.html`；其他为 `application/octet-stream`），并带 `X-Content-Type-Options: nosniff`。

### 隔离与限制

- 代码运行在自己的环境里：标准 Lua 函数（`string`、`table`、`math`、`bit`、`pairs`、`pcall` 等）、`os.time` / `os.clock` / `os.date`，`require` 只能加载扩展包自己的 `lua/` 模块（`require("util")` 加载 `lua/util.lua`）以及 `cjson.safe`、`resty.sha256`、`resty.string`、`resty.random`、`resty.lrucache`、`ngx.re`。没有 `ngx` 全局变量、`io`、`os.execute`、`debug`、`ffi`、`jit`、字节码 `load`、`package`、`setfenv` / `getfenv` 和 `collectgarbage`。
- **这只是规范约束，不是安全沙箱。** 受信任发布者的代码在 nginx worker 内以 worker 的权限运行，worker 能访问的它都能访问。只信任你愿意让其代码在边缘运行的发布者。
- 每次钩子调用都在 `pcall` 中运行。出错，或超过预算（墙钟 10 毫秒；`access` / `access_late` / `endpoint` 中等待协程套接字时为 1000 毫秒）算一次故障。一个 worker 内 60 秒里 20 次故障，该扩展在这个 worker 上熔断 60 秒；熔断按失败处理。
- **失败模式**（每个扩展，默认 `open`）：`open` 忽略失败或熔断的扩展（请求如同钩子没有返回值一样继续）。`closed` 在 `access`、`access_late` 或 `endpoint` 钩子失败、熔断或扩展包无法加载时，对开启它的网站上的请求返回 503 `X-Edgeweir-Error: extension`。header filter、body filter 与 log 钩子总是失败放行。
- 故障写入日志（`[ext <id>]`，限频），按网站计入分钟统计（`ext.<id>.faults`），并按节点上报。

### 规则字段、日志与统计

- 规则字段 `ext.<id>.<name>` 可用于请求阶段（`request-transform`、`redirect`、`config`、`waf-custom`、`ratelimit`、`origin`），需要 `extensions-v1`。只有扩展已安装且声明了该字段时规则才能使用；未设置的字段读作 `""`、`0` 或 `false`。
- 访问日志带 `ext.<id>.<name>` 日志字段，以及有裁决时的 `ext.<id>.verdict`（`deny`、`challenge`、`allow`、`respond`）。
- 分钟统计带按网站的计数 `ext.<id>.<name>` 与 `ext.<id>.faults`。

## 示例

```lua
-- hello-header 的 lua/main.lua
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

edgeweir-node 仓库里的 `examples/extensions/hello-header` 就是这个扩展；节点的 Lua 测试加载它，端到端测试对它签名、安装并运行。

## 1.1 版（Lua API 2）

1.1 版沿用扩展包格式 `edgeweir-node-extension-v1`，为节点级扩展（指标导出等）和带原生辅助进程的扩展（边车，例如函数运行时）增加清单成员与调用。本节的一切都需要 `"requires": {"lua_api": 2}`；节点能力为 `extensions-v2`（具备它的节点同时运行 Lua API 1 与 2 的扩展包）。用了本节成员却声明 `lua_api: 1` 的扩展包会被控制台拒绝；API 2 扩展只下发到活跃节点都报告 `extensions-v2` 的集群（否则 `NODE_CAPABILITY_REQUIRED`）。这里没有针对任何产品的内容，也不检查许可证。

### 清单成员（API 2）

| 成员 | 规则 |
| --- | --- |
| `scope` | `"sites"`（默认）：同 1 版。`"node"`：扩展在节点上运行，不按网站开启：允许的钩子为 `init`、`log`、`listen`；不能有 `endpoints`、`fields`、`html_inject`、`body_rewrite`、`request_headers`、`verdicts`、`sidecar`、`data`，也没有网站配置。它的 `log` 钩子对下发到的节点上每个网站的每个请求运行 |
| `listeners` | 仅 `scope: "node"`。≤ 2 项 `{ "name": <^[a-z][a-z0-9_]{0,15}$>, "default_port": 1024–65535, "methods": ["GET", "HEAD", "POST"] }`；节点在独立端口上提供服务，与所有网站无关（见[节点监听器](#节点监听器)）。需要钩子 `listen` |
| `secret` | `true`：控制台为扩展保存一个随机 32 字节密钥，节点以 `ew.secret()` 提供（见[密钥](#密钥)） |
| `sidecar` | 原生辅助进程（见[边车](#边车)）。需要能力 `sidecar` |
| `data` | `{ "max_bytes": ≤ 25165824, "max_items": ≤ 32, "max_total_bytes": ≤ 268435456 }`：扩展接受按网站上传的数据项（见[网站数据](#网站数据)）；需要 `sidecar` |
| 上限 | API 2 把 `fields` 提高到 ≤ 16、`log_fields` ≤ 16、`counters` ≤ 32 |

钩子增加 `listen`；能力增加 `sidecar`。带边车的扩展包最大 64 MiB（归档）、解包后 192 MiB，单个文件 96 MiB；对这类扩展包，`POST /extensions` 与 `POST /extensions/verify` 接受最大 96 MiB 的请求。

### API 2 调用

| 调用 | 说明 |
| --- | --- |
| `ew.site_name` | 网站的主域名（第一个域名）；与 `ew.site_id` 一样，节点级扩展的 `log` 钩子中也是请求所属网站，`listen`、`init` 与定时器中为 `nil` |
| `ew.req.http_version()` | `"1.0"`、`"1.1"`、`"2"`、`"3"` |
| `ew.req.request_length()`、`ew.req.request_time()` | 收到的字节数（请求行、请求头、请求体）与自第一个字节起的秒数；`log` |
| `ew.resp.bytes_sent()` | 发给客户端的字节数；`log` |
| `ew.resp.upstream_status()`、`upstream_response_time()`、`upstream_connect_time()`、`upstream_header_time()` | 最后一次回源的状态与耗时（秒）；没有回源（缓存命中、节点自己的应答）时为 `nil`；`log` |
| `ew.resp.reason()` | 节点对请求的拦截原因及其规则 id（`"rate_limit", "<规则 id>"`），没有时为 `""`；原因同访问日志（`ip_banned`、`ip_blocked`、`rule`、`rate_limit`、`crs`、`cc`、`challenge`、`auth`、`referer`、`user_agent`、`region`、`cors`、`websocket_origin`、`client_cert`、`maintenance`、`extension`） |
| `ew.req.verified_bot()` | 经过验证的搜索引擎爬虫名称（PTR 加正向解析，与网站的爬虫设置相同），否则 `nil`；`access`、`access_late`；等待 DNS 的时间不计入预算 |
| `ew.req.exempt()` | 客户端在网站的放行名单或平台放行名单上时为 `true`（即节点免于封禁与挑战的客户端）；`access`、`access_late` |
| `ew.node.id()`、`name()`、`cluster_id()`、`version()` | 节点身份与 agent 版本 |
| `ew.node.connections()` | nginx worker 视角的 `{ active, reading, writing, waiting }`（stub_status），请求与监听器钩子中可用；定时器中为 `nil` |
| `ew.node.status()` | 节点最近一次上报的主机指标 `{ at, cpu_percent, load1, load5, load15, memory_used_bytes, memory_total_bytes, egress_bps, active_connections }`（首次上报前为 `nil`）；任何钩子 |
| `ew.secret()`、`ew.secrets()` | `secret: true`：当前密钥（32 个原始字节）；`ew.secrets()` 返回 `{ current, previous }`（首次轮换前 `previous` 为 `nil`） |
| `ew.equal(a, b)` | 常数时间比较两个字符串 |
| `ew.sidecar.ready()` | `sidecar`：边车是否通过健康检查 |
| `ew.sidecar.proxy(opts)` | `sidecar`；仅 `access_late`：把请求交给边车的裁决（见[边车](#边车)） |

两个 API 版本通用的说明：`ew.req.pass_level()` 为 0（无）、1 `cookie302`、2 `js`、3 `pow`、4 `captcha`；`ew.sha256` 与 `ew.hmac_sha256` 返回 32 个原始字节；`ew.req.header(name)` 不区分大小写，重复的请求头以 `", "` 连接；`ew.respond` 可以设置 `Set-Cookie`，`HEAD` 请求不发送正文；`ew.ctx` 对同一请求、同一扩展的所有钩子是同一个表（包括 `endpoint` 与 `log`）；`/.edgeweir/ext/<id>/…` 请求不运行访问阶段钩子，运行 `log` 钩子；响应头过滤钩子也作用于扩展自己用 `ew.respond` 生成的响应；带查询字符串的同源 `src` 仍算同源，静态资源的服务与查询字符串无关。

### 节点监听器

节点监听器是节点为 `scope: "node"` 扩展开设的 HTTP 服务，与所有网站无关：不查 Host、不走规则、挑战、CC、缓存与访问日志。

- 运营者在控制台开启监听器（`PATCH /extensions/{id}`，`{"listeners": {"<name>": {"port": 9145, "bind": "0.0.0.0", "allow": ["10.0.0.0/8"]}}, "clusterIds": [...]}`；`null` 关闭，省略 `clusterIds` 表示所有集群）：`port`（1024–65535；不能是 80、443、集群的边缘或四层端口、8443）、`bind`（节点上的地址，默认 `0.0.0.0` 与 `[::]`）与 `allow`（1–64 个 CIDR，必填）。节点把 `allow` / `deny all` 写进监听器，名单之外的客户端到不了 Lua。没有设置的监听器不开启。
- 节点对声明方法的每个请求调用 `listen(ew, name, path)`，`path` 为请求路径。钩子返回 `ew.respond(...)`，其他返回值得到 500。预算 1000 ms。`ew.req.*` 读取请求，`ew.req.body()`（需 `request_body`）最多 64 KiB。
- 地址名单之外的认证（扩展配置里的 Bearer 令牌，用 `ew.equal` 比较）由扩展负责。1.1 不提供 TLS 与客户端证书：把监听器放在私有网络上或依靠地址名单。
- 节点绑定不了的端口记在扩展的节点状态里（`failed` 与消息），其余配置照常生效。

### 密钥

`secret: true` 时，控制台在安装扩展时生成 32 个随机字节，信封加密保存。`POST /extensions/{id}/rotate-secret` 生成新的当前密钥，旧的保留为 previous。节点只通过节点通道（`GetExtensionSecrets`，mTLS）获取密钥；配置修订只带版本号，不带密钥本身。用于所有节点共享的 HMAC 密钥（签名 Cookie、令牌）。标记 `x-secret` 的配置值在 API 中打码，但属于配置修订的一部分；密钥优先用 `ew.secret()`。

### 边车

边车是随扩展包分发、由节点 agent 在 nginx 旁运行的原生程序，用于请求钩子容不下的工作（函数运行时、长驻引擎）。它运行受信任发布者的代码，并视扩展而定运行运营者的用户提供的代码；节点把它当作对自己不可信的进程。

清单：

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

| 字段 | 规则 |
| --- | --- |
| `binary` | 文件名 `^[a-z0-9][a-z0-9._-]{0,63}$`；扩展包含 `sidecar/linux-amd64/<binary>` 和/或 `sidecar/linux-arm64/<binary>`（建议静态链接的 ELF 可执行文件）。`sidecar/` 下的文件是扩展包唯一允许的原生代码，且只在声明能力 `sidecar` 时允许。缺少本机架构的节点报告 `incompatible` |
| `args` | ≤ 16 个、每个 ≤ 256 字节；替换 `{socket}`、`{origin_socket}`、`{state}`、`{data}` |
| `env` | ≤ 16 个变量 `^[A-Z][A-Z0-9_]{0,63}$`，不能是 `EDGEWEIR_*`，值 ≤ 1024 字节；节点另设 `EDGEWEIR_SIDECAR_SOCKET`、`EDGEWEIR_ORIGIN_SOCKET`、`EDGEWEIR_EXT_STATE`、`EDGEWEIR_EXT_DATA`、`EDGEWEIR_EXT_ID`、`EDGEWEIR_EXT_VERSION`；不继承其他环境变量 |
| `memory_mb` | 16–8192，内存上限 |
| `tasks_max` | 16–4096（默认 256），进程与线程数 |
| `cpu_percent` | 10–800（默认不限），以单核百分比计的 CPU 上限 |
| `health_path` | 默认 `/healthz`；对其套接字 `GET` 返回 200 时节点认为边车就绪 |
| `connect_timeout_ms`、`timeout_s` | 100–10000（默认 1000）、1–60（默认 30）：到边车的连接超时与每个请求的读写超时（两次读写之间） |
| `max_body` | 0–104857600（默认 10 MiB）：转给边车的请求体上限 |

生命周期：扩展包解开、扩展启用（且总开关关闭）后 agent 启动边车；边车退出后重启（1 秒起翻倍，最长 60 秒）；扩展停用、卸载或升级、总开关打开、`--no-extensions` 或 agent 停止时停止它（SIGTERM，10 秒后 SIGKILL）。状态写入扩展的节点状态（`details.sidecar`：`starting`、`running`、`unhealthy`、`crashed`、`stopped`、`unsupported`；重启次数；最近一次退出）。标准输出与标准错误由 agent 读取，每行限 1 KiB、每秒限 20 行，出现在节点日志中（来源 `extension`）。

隔离（仅 Linux；达不到时为 `unsupported`，不启动边车）：

- **独立用户。** 边车从不以 agent 或 nginx 的用户运行：agent 以 `--sidecar-user USER`（无特权、不同于 agent 的用户）启动它，为此 agent 须以 root 运行，或持有 `CAP_SETUID` 与 `CAP_SETGID`（容器镜像以 `--build-arg SIDECAR_CAPABILITY=true` 构建时给 agent 这两项文件 capability，并带用户 `edgeweir-sidecar`，`-e EDGEWEIR_SIDECAR_USER=edgeweir-sidecar` 即可）。非 root 的 agent 须是该用户主组的成员（镜像已如此），以把数据与套接字目录交给这个组。`run --sidecar-mode auto|user|off` 选择方式（`auto` 即 `user`）；`off` 拒绝边车。以 systemd 模板单元（`DynamicUser=yes`）启动边车的 `systemd` 方式尚未提供。
- **沙箱。** agent 经自身的辅助命令 `edgeweir-node sidecar-exec` 启动边车：加入边车的 cgroup（能建时），设置资源上限，切换用户与组（清空附加组），`PR_SET_NO_NEW_PRIVS`，载入 seccomp 过滤器，以干净的环境执行边车，不留 capability。过滤器拒绝 `ptrace`、`process_vm_*`、挂载、命名空间（`unshare`、`setns`、带命名空间标志的 `clone`，`clone3` 得到 `ENOSYS`）、BPF、perf、keyring、内核模块、重启、改时钟、swap、`userfaultfd`；其他架构的系统调用终止进程。内存、任务数与 CPU 上限取自清单（agent 所在的 cgroup v2 允许建子组时；否则内存与任务数退而用 `RLIMIT_DATA` 与 `RLIMIT_NPROC`，CPU 不限）；不生成 core dump。
- **能访问什么。** 边车目录（`--sidecar-dir`，默认节点状态目录加 `-sidecar`，容器中 `/var/lib/edgeweir-node-sidecar`）下按扩展一个目录：`package/`（扩展包的副本，只读）、`state/`（可写，`$EDGEWEIR_EXT_STATE`）、`data/`（只读，`$EDGEWEIR_EXT_DATA`）。文件权限之外没有单独的文件系统视图：节点状态目录（密钥、凭据、配置）与 agent、nginx 的控制套接字只对节点用户开放，边车读不到、连不上，也不能向其他进程发信号。
- **网络。** 允许出站连接（函数运行时要调用 API）；特殊用途地址由边车自己拒绝。访问网站自己的源站时用下面的源站套接字，私有源站地址无需对边车可达。

套接字（目录为控制套接字所在目录加 `-ext/<id>/`，容器中 `/run/edgeweir-node-ext/<id>/`；属 nginx 的用户与边车用户的组，权限 2770，只有两者可访问）：

- `sidecar.sock`：由边车创建，nginx 连接。
- `origin.sock`：nginx 为边车提供。带 `X-Edgeweir-Ext-Site: <网站 id>` 的请求按边缘层的方式发往该网站的源站（源站池、Host、TLS 校验、回源规则、源站地址策略），不经过缓存、CRS 与任何扩展钩子。没有开启该扩展的网站得到 403，没有该请求头的请求得到 400。

转发请求：在 `access_late` 中 `return ew.sidecar.proxy({ headers = { ["X-Edgeweir-Ext-Route"] = "r1" }, fail = "open" })` 用 nginx 的代理（不是 cosocket）把请求（方法、URI、请求头、流式请求体）交给 `sidecar.sock`，钩子预算不适用。`headers` 设置以 `X-Edgeweir-Ext-` 开头的请求头（节点移除客户端发来的所有 `X-Edgeweir-` 前缀请求头，所以边车可以信任它们）；节点另加 `X-Edgeweir-Ext-Site`（网站 id）、`X-Edgeweir-Ext-Request-Id`、`X-Edgeweir-Ext-Client-Ip`、`X-Edgeweir-Ext-Scheme` 与 `X-Edgeweir-Ext-Host`。边车的响应经过节点的响应头与正文过滤（包括扩展的响应头过滤、压缩）、日志与统计返回客户端，从不缓存。失败时：

| 情况 | `fail = "open"` | `fail = "closed"`（默认取扩展的失败模式） |
| --- | --- | --- |
| 边车未就绪、连接被拒、收到响应头前超时 | 请求按网站的正常路径继续（CRS、缓存、源站） | 502（`X-Edgeweir-Error: extension`） |
| 边车返回状态 599 | 请求按网站的正常路径继续 | 同上 |
| 请求体超过 `max_body` | 413 | 413 |

交给边车的请求拦截原因为无，访问日志字段 `ext.<id>.verdict = "sidecar"`，计入扩展计数器 `ext.<id>.sidecar`。

### 网站数据

声明了 `data` 的扩展接受按网站上传的不透明数据项，由管理网站的人通过控制台 API 上传，不经发布者签名（函数包、网站自己的密钥）：

| 路由 | 说明 |
| --- | --- |
| `GET /sites/{siteId}/extensions/{id}/data` | `[{ name, sha256, size, updatedAt }]` |
| `PUT /sites/{siteId}/extensions/{id}/data/{name}` | 请求体 `{ "content": "<base64>" }`（请求最大 34 MiB）；名称 `^[a-z0-9][a-z0-9._-]{0,63}$`；上限取自清单的 `data`；写入审计（`site.extension_data_put`），发布修订 |
| `DELETE /sites/{siteId}/extensions/{id}/data/{name}` | 写入审计（`site.extension_data_delete`），发布修订 |

数据项存在控制台数据库中。配置按网站与扩展带 `{name, sha256, size}`；节点通过节点通道按摘要获取缺少的数据项（`GetExtensionData`，mTLS，每块 4 MiB），校验摘要后存到边车目录的 `<id>/data/<网站 id>/<name>`，只有节点用户与边车用户的组可读，并删除不再被配置引用的数据项。数据变化热生效，不重载 nginx。

边车从 `$EDGEWEIR_EXT_DATA/index.json` 得知网站、配置与数据。修订的所有数据项就绪后，该文件原子写入，随后发送 `SIGHUP`：

```json
{ "revision": 42, "config": { "...": "全局配置" },
  "sites": { "<网站 id>": { "name": "shop.example", "domains": ["shop.example"], "config": { "...": "网站配置" },
    "data": [{ "name": "fn-main.wasm", "sha256": "…", "size": 9123456, "path": "/var/lib/edgeweir-node-sidecar/<id>/data/<网站 id>/fn-main.wasm" }] } } }
```

只出现开启了该扩展的网站。网站配置对 Lua 与控制台 API 可见（打码的 `x-secret` 值除外）；密钥应放在数据项里。

### 节点状态详情

每个扩展的节点状态带 `details`（JSON，≤ 4 KiB）：`sidecar`（状态、进程号、重启次数、最近一次退出、起始时间）、`listeners`（`{name: {port, state: "listening" | "failed", message}}`），以及边车套接字上 `GET /status` 的返回，放在 `sidecar.status` 下（≤ 2 KiB，每 30 秒轮询）。

### 1.1 版的分发变化

- `GetExtensionPackage` 与 `GetExtensionData` 分块传输（`offset`，每次应答最多 4 MiB，带 `total` 总大小）。
- `Extension` 增加 `lua_api`、`scope`、`listeners`（运营者的设置）、`secret_version`；`SiteExtension` 增加 `data`；`ExtensionStatus` 增加 `details_json`。
- 节点级扩展启用后下发到所有集群，或扩展设置中选定的集群（`clusterIds`）。

## 兼容性

- 格式与 Lua API 的版本只增不减：支持 Lua API 1 的节点保留上面的每个调用；新调用随更高的 `lua_api` 出现，扩展包需要目标节点没有的 API 时控制台拒绝。
- 控制台拒绝带未知成员的 manifest，为更新格式编写的扩展包会校验失败，而不是被一知半解地运行。
